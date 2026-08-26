import "server-only";

import { z } from "zod";
import { BRAND } from "@/lib/brand";

/**
 * Transactional email.
 *
 * WHAT THIS IS FOR
 * Exactly two messages: "you have been invited" and "here is your password
 * reset link". Northstar HQ sends nothing else — no digests, no notifications —
 * so this is deliberately a small, dependency-free HTTP client rather than a
 * mail framework.
 *
 * WORKING WITHOUT A PROVIDER
 * Email is OPTIONAL and the product is fully usable without it. When nothing is
 * configured:
 *   • Invitations still work. `createInvitation` returns the link once, and the
 *     admin copies it out of the UI and sends it however they like. This is the
 *     default path and it is not a degraded one.
 *   • Password resets fall back to writing the link to the SERVER LOG, never to
 *     the HTTP response — returning it to the requester would let anybody reset
 *     anybody's password just by asking.
 *
 * TO ENABLE DELIVERY
 * Set these in .env.local (or your host's environment):
 *
 *   RESEND_API_KEY   API key from https://resend.com — chosen because it is a
 *                    plain HTTPS POST, so no SMTP library and no native
 *                    dependency enters the build.
 *   EMAIL_FROM       The verified sender, e.g. "Northstar HQ <hq@northstarhq.com>".
 *                    The domain must be verified with the provider or delivery
 *                    will be rejected.
 *   APP_URL          Already required in production; the links are built from it.
 *
 * Adding another provider means implementing one more `deliver` branch. The
 * call sites do not change.
 */

const schema = z.object({
  RESEND_API_KEY: z.string().trim().optional(),
  EMAIL_FROM: z.string().trim().optional(),
});

const parsed = schema.safeParse(process.env);
const config = parsed.success ? parsed.data : { RESEND_API_KEY: undefined, EMAIL_FROM: undefined };

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export function isEmailConfigured(): boolean {
  return Boolean(config.RESEND_API_KEY && config.EMAIL_FROM);
}

/** What an operator has to set, surfaced in the admin UI rather than a README. */
export function emailConfigurationStatus(): {
  configured: boolean;
  provider: string | null;
  missing: readonly string[];
} {
  const missing: string[] = [];
  if (!config.RESEND_API_KEY) missing.push("RESEND_API_KEY");
  if (!config.EMAIL_FROM) missing.push("EMAIL_FROM");
  return {
    configured: missing.length === 0,
    provider: missing.length === 0 ? "resend" : null,
    missing,
  };
}

interface Message {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/**
 * Sends, or reports why it could not.
 *
 * Never throws. A mail outage must not roll back the invitation that was
 * already created — the admin can still copy the link — and it must not turn a
 * password-reset request into an error that tells the caller whether the
 * address exists.
 */
async function deliver(message: Message): Promise<{ sent: boolean; reason?: string }> {
  if (!isEmailConfigured()) {
    return { sent: false, reason: "No email provider configured." };
  }

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // The provider's body can echo the recipient; log the status only.
      console.error(`[email] provider rejected the message: HTTP ${response.status}`);
      return { sent: false, reason: `Provider returned ${response.status}` };
    }
    return { sent: true };
  } catch (error) {
    console.error("[email] delivery failed", error instanceof Error ? error.message : error);
    return { sent: false, reason: "Delivery failed" };
  }
}

export async function sendInvitationEmail(
  to: string,
  inviteUrl: string,
  context: { inviterName: string | null; roleLabel: string; organizationName: string },
): Promise<{ sent: boolean; reason?: string }> {
  const inviter = context.inviterName ? `${context.inviterName} has` : "You have been";
  return deliver({
    to,
    subject: `Join ${context.organizationName} on ${BRAND.product}`,
    text: [
      `${inviter} invited you to ${BRAND.product}, the internal Shorts intelligence dashboard for ${context.organizationName}.`,
      "",
      `Your role: ${context.roleLabel}`,
      "",
      "Set your password and sign in here:",
      inviteUrl,
      "",
      "This link works once and expires in 72 hours.",
      "If you were not expecting this, you can ignore it — no account is created until the link is used.",
    ].join("\n"),
  });
}

export async function sendPasswordResetEmail(
  to: string,
  resetUrl: string,
): Promise<{ sent: boolean; reason?: string }> {
  return deliver({
    to,
    subject: `Reset your ${BRAND.product} password`,
    text: [
      `Someone asked to reset the ${BRAND.product} password for this address.`,
      "",
      "Choose a new password here:",
      resetUrl,
      "",
      "This link works once and expires in 60 minutes.",
      "If it was not you, no action is needed — your current password still works and nobody has been given access.",
    ].join("\n"),
  });
}
