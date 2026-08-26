import { z } from "zod";
import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { authenticate } from "@/server/services/auth-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loginSchema = z.object({
  email: z.string().trim().min(1, "Enter your email address.").max(320),
  password: z.string().min(1, "Enter your password.").max(256),
});

/**
 * POST /api/auth/login
 *
 * Deliberately says nothing useful on failure. A wrong password, an unknown
 * address, an account that was never activated and a deactivated account all
 * produce the same message, and `authenticate` spends the same CPU on each, so
 * neither the response body nor its timing reveals who has an account here.
 *
 * Rate limiting lives in the service rather than the route because it must
 * cover both the per-IP and the per-account dimension, and the account is only
 * known after the body is parsed.
 */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    const parsed = loginSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      // Same wording as a genuine credential failure: a validation error that
      // said "no account with that email" would reintroduce the oracle.
      throw errors.invalidInput("That email and password combination is not recognised.");
    }

    await authenticate(parsed.data, { request });

    // No user data in the response. The client calls /api/auth/me, which is
    // the one place the actor DTO is assembled.
    return { ok: true };
  });
}
