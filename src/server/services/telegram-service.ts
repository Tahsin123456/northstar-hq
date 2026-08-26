import "server-only";

import { z } from "zod";
import { BRAND } from "@/lib/brand";
import type { TelegramStatusDTO } from "@/lib/dto";
import {
  isTelegramTokenConfigured,
  requireTelegramBotToken,
  scrubToken,
} from "./telegram-env";

/**
 * =========================================================================
 * TELEGRAM — THE TRANSPORT
 * =========================================================================
 *
 * A plain HTTPS POST to `sendMessage`, exactly how this codebase already talks
 * to YouTube and Resend. No SDK: the Bot API is one endpoint with three fields,
 * and a dependency that wraps it would add a supply-chain surface and a version
 * to keep current in exchange for saving twenty lines.
 *
 * WHAT THIS MODULE IS AND IS NOT
 * It sends a string to a chat. It does not know what payroll is, does not read
 * the database, and does not decide whether a message *should* go out — that
 * lives in `notification-service.ts`. Keeping the transport ignorant means the
 * payroll wording can be tested with no network (see
 * `src/lib/payroll/payroll-message.ts`) and this file can be reasoned about
 * purely as "did the HTTP call work".
 *
 * IT NEVER THROWS
 * Every function here reports failure as a value. A notification is not the
 * thing the caller came to do — the payroll period was finalized whether or not
 * Telegram was reachable — so a delivery failure must be recordable rather than
 * an exception that unwinds work already committed. That is the same contract
 * `email-service.ts` follows, for the same reason.
 *
 * THE TOKEN IS IN THE URL
 * The Bot API puts the credential in the path, so an unguarded error message
 * built from a failed request would carry it straight into `lastError`, an
 * admin screen and the server log. Nothing here ever interpolates the URL into
 * an error, and `scrubToken` runs over every returned string as a backstop.
 */

const API_ORIGIN = "https://api.telegram.org";

/** Telegram is generally quick; a hung request must not hold a cron job open. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The subset of Telegram's response this code acts on.
 *
 * Permissive on purpose: `.catchall`-style strictness would turn a new field in
 * a future API version into a delivery failure, and the only thing that matters
 * here is whether `ok` is true.
 */
const responseSchema = z.object({
  ok: z.boolean(),
  description: z.string().optional(),
  error_code: z.number().optional(),
});

export interface SendResult {
  readonly sent: boolean;
  /** Human-readable, token-free, safe to store and show to an admin. */
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// CONFIGURATION STATUS
// ---------------------------------------------------------------------------

/**
 * True when the deployment holds a bot token.
 *
 * Deliberately reports existence, never the value — the same contract
 * `hasYouTubeApiKey` and `isGoogleOAuthConfigured` follow, so a status endpoint
 * can say "Telegram is wired up" without handing anybody the credential.
 */
export function isTelegramConfigured(): boolean {
  return isTelegramTokenConfigured();
}

/**
 * What is still missing, for an admin screen that has to explain itself.
 *
 * Takes the chat id as an argument rather than reading it: the token is
 * deployment configuration and the destination is organization data, and this
 * module has no business querying a database. Ordered the way the setup is
 * actually done — create the bot, then point it at a chat — so the list reads
 * as instructions rather than an inventory.
 */
export function telegramStatus(chatId: string | null): TelegramStatusDTO {
  const missing: string[] = [];
  if (!isTelegramTokenConfigured()) missing.push("TELEGRAM_BOT_TOKEN");
  if (!chatId) missing.push("telegramChatId");

  return {
    tokenConfigured: isTelegramTokenConfigured(),
    chatConfigured: Boolean(chatId),
    configured: missing.length === 0,
    missing,
  };
}

// ---------------------------------------------------------------------------
// SENDING
// ---------------------------------------------------------------------------

/**
 * Posts one message, or reports why it could not.
 *
 * `parse_mode` is deliberately omitted, so the body is delivered as literal
 * text. Telegram's Markdown and HTML modes both reject a message whose special
 * characters are not escaped, which would make an employee named "Anna_Smith"
 * or a niche called "C++" a hard delivery failure on payday. Plain text has no
 * escaping rules to get wrong.
 *
 * `disable_web_page_preview` keeps a link in a niche name from unfurling into a
 * preview card that buries the figures below it.
 */
export async function sendMessage(chatId: string, text: string): Promise<SendResult> {
  if (!isTelegramTokenConfigured()) {
    return { sent: false, error: "TELEGRAM_BOT_TOKEN is not configured." };
  }
  if (!chatId) {
    return { sent: false, error: "No Telegram chat id is configured." };
  }
  if (text.length === 0) {
    return { sent: false, error: "Refusing to send an empty message." };
  }

  try {
    const response = await fetch(`${API_ORIGIN}/bot${requireTelegramBotToken()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const parsed = responseSchema.safeParse(await response.json().catch(() => null));

    if (!response.ok || !parsed.success || !parsed.data.ok) {
      // Built from the status and Telegram's own description only. The request
      // URL — which carries the token — is never part of this string.
      const description = parsed.success ? parsed.data.description : undefined;
      const error = describeFailure(response.status, description);
      console.error(`[telegram] send rejected: HTTP ${response.status}`);
      return { sent: false, error };
    }

    return { sent: true };
  } catch (caught) {
    // A thrown fetch error can embed the request URL in its message, so the
    // caught value is never interpolated — only classified.
    const error = describeThrow(caught);
    console.error(`[telegram] send failed: ${error}`);
    return { sent: false, error };
  }
}

/**
 * THERE IS DELIBERATELY NO `sendMessages`.
 *
 * A batch helper used to live here, posting a numbered sequence and stopping at
 * the first failure. It could not be made safe from the outside: a send is not
 * revocable, so a batch that fails halfway has already published part of its
 * payload, and every caller then needs somewhere durable to record how far it
 * got or a retry re-posts what already arrived. For the payroll summary that
 * meant announcing everybody's pay to the whole team twice.
 *
 * The fix was to stop generating sequences: `buildPayrollMessage` renders any
 * run down to a single body, so one call to `sendMessage` is the whole
 * delivery and "sent" is atomic. Anything tempted to reintroduce a batch here
 * should answer first where the resume point would be persisted.
 */

/**
 * Proves the wiring before payday.
 *
 * The single most useful thing an admin can do with this integration is confirm
 * it works on a day when nothing depends on it. Without this they would find out
 * on the 1st of the month, from a message that did not arrive.
 */
export async function sendTestMessage(chatId: string): Promise<SendResult> {
  return sendMessage(
    chatId,
    [
      `${BRAND.product} — test message`,
      "",
      "Telegram notifications are wired up correctly.",
      "The monthly payroll summary will arrive in this chat on the 1st of each month.",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// ERROR DESCRIPTIONS
// ---------------------------------------------------------------------------

/**
 * Turns an API rejection into something an admin can act on.
 *
 * Telegram's descriptions are terse and its two commonest failures both mean
 * "you did the setup wrong" rather than "something broke", so they are
 * translated into the fix. The description is clipped and scrubbed because it
 * is echoed back from an upstream service into a stored column.
 */
function describeFailure(status: number, description: string | undefined): string {
  const detail = description ? scrubToken(description).slice(0, 300) : null;

  if (status === 401) {
    return "Telegram rejected the bot token. Check TELEGRAM_BOT_TOKEN and restart the server.";
  }
  if (status === 400 && detail && /chat not found/i.test(detail)) {
    return "Telegram could not find that chat. Send the bot a message first, then confirm the chat id.";
  }
  if (status === 403) {
    return "The bot is blocked or was removed from that chat. Re-add it and try again.";
  }
  if (status === 429) {
    return "Telegram is rate-limiting the bot. Try again in a few minutes.";
  }

  return detail ? `Telegram returned ${status}: ${detail}` : `Telegram returned ${status}.`;
}

/** Classifies a thrown fetch error without quoting it — the message can hold the URL. */
function describeThrow(caught: unknown): string {
  if (caught instanceof Error) {
    if (caught.name === "TimeoutError" || caught.name === "AbortError") {
      return `Telegram did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds.`;
    }
    if (caught.name === "TypeError") {
      return "Could not reach Telegram. Check the server's outbound network access.";
    }
  }
  return "Delivery to Telegram failed.";
}
