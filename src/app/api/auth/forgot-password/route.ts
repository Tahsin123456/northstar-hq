import { z } from "zod";
import { handleMutation, readJson } from "@/server/http";
import { requestPasswordReset } from "@/server/services/auth-service";
import { authEnv } from "@/server/auth/auth-env";
import { isEmailConfigured, sendPasswordResetEmail } from "@/server/services/email-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().trim().min(1).max(320),
});

/**
 * POST /api/auth/forgot-password
 *
 * Always reports the same thing, whether or not the address exists. Telling an
 * anonymous caller "no account with that email" turns this endpoint into a way
 * to enumerate who works here.
 *
 * When no mail provider is configured the link is NOT returned to the caller —
 * that would let anyone reset anyone's password by asking. It goes to the
 * server log instead, where only an operator can see it.
 */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) return { ok: true };

    const result = await requestPasswordReset(parsed.data, { request });

    if (result.resetUrl) {
      if (isEmailConfigured()) {
        await sendPasswordResetEmail(parsed.data.email.trim().toLowerCase(), result.resetUrl);
      } else if (!authEnv.isProduction) {
        console.warn(
          "[auth] No email provider configured. Password reset link (development only):\n  " +
            result.resetUrl,
        );
      } else {
        console.warn(
          "[auth] Password reset requested but no email provider is configured. " +
            "Set RESEND_API_KEY or the SMTP_* variables. The link was not delivered.",
        );
      }
    }

    return { ok: true };
  });
}
