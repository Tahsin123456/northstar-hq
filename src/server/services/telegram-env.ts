import "server-only";

import { z } from "zod";
import { AppError } from "@/server/errors";

/**
 * The Telegram bot token.
 *
 * Mirrors `src/server/auth/google-oauth-env.ts` exactly, including its
 * strictness: optional, because notifications are one feature of the product
 * and refusing to boot over a variable most deployments never set would turn an
 * optional integration into a hard dependency. Every path that actually needs
 * the token calls `requireTelegramBotToken()` and gets a 503 with a setup
 * message, the same shape the YouTube API key uses in `server/env.ts`.
 *
 * `server-only` because this module reads a credential at import time. A Server
 * Component may import it to ask what is missing; it must never be reachable
 * from a client bundle, and the import guard enforces that rather than trusting
 * review to catch it.
 *
 * WHAT A BOT TOKEN IS
 * It is not a password for one action — it IS the bot. Anyone holding it can
 * read every message the bot receives and post as the bot to every chat it is
 * in, and it cannot be scoped down. That is why it lives here rather than in
 * `NotificationSettings`: the destination chat id is configurable data an admin
 * types into a form, the token is a secret that must never enter the database,
 * a DTO, an API response, an audit entry or a log line.
 */

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().optional(),
});

// Cannot fail — the only field is optional — but parsing rather than reading
// `process.env` directly keeps the trimming and the shape in one place.
const raw = schema.parse(process.env);

/** An unset variable and one set to the empty string mean the same thing here. */
function present(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

const botToken = present(raw.TELEGRAM_BOT_TOKEN);

/** True when a message could actually be sent right now. */
export function isTelegramTokenConfigured(): boolean {
  return botToken !== null;
}

/**
 * Narrowing accessor for the one function that talks to Telegram.
 *
 * Deliberately the ONLY export that returns the value, and nothing in the
 * codebase calls it except `telegram-service.ts`. Keeping the surface this
 * narrow is what makes "the token never leaks" a property you can verify by
 * grepping for one identifier rather than by auditing every caller.
 */
export function requireTelegramBotToken(): string {
  if (botToken === null) {
    throw new AppError(
      "NOT_CONFIGURED",
      "Telegram notifications are not configured on this deployment. Add TELEGRAM_BOT_TOKEN " +
        "to .env.local (see .env.example) and restart the server.",
      { details: { variable: "TELEGRAM_BOT_TOKEN" } },
    );
  }
  return botToken;
}

/**
 * Removes the token from anything on its way to a log, a database column or a
 * response body.
 *
 * The token appears in the request URL — that is how Telegram's API is shaped —
 * so an error message built from a failed request can carry it without anybody
 * intending to. `lastError` on PayrollNotification is shown to an admin and
 * stored indefinitely, which makes this the difference between a diagnostic and
 * a credential leak. Applied as a final backstop even where the message is
 * constructed by hand, because "no caller will ever do that" is not a control.
 */
export function scrubToken(text: string): string {
  if (botToken === null) return text;
  return text.split(botToken).join("[redacted]");
}
