import { z } from "zod";
import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { resetPassword } from "@/server/services/auth-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  token: z.string().min(1).max(512),
  password: z.string().min(1, "Choose a password.").max(256),
});

/** POST /api/auth/reset-password — complete a reset with a single-use token. */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That reset link is not valid.",
      );
    }
    await resetPassword(parsed.data, { request });
    return { ok: true };
  });
}
