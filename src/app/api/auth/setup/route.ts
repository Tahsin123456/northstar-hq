import { z } from "zod";
import { handle, handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { completeSetup, needsSetup } from "@/server/services/auth-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const setupSchema = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(120),
  email: z.string().trim().email("Enter a valid email address.").max(320),
  password: z.string().min(1, "Choose a password.").max(256),
});

/** GET /api/auth/setup — is the first-run window still open? */
export function GET() {
  return handle(async () => ({ needsSetup: await needsSetup() }));
}

/**
 * POST /api/auth/setup — claim the first administrator account.
 *
 * The window is re-checked server-side inside completeSetup on every call, so
 * it closes the moment an admin exists. There is no flag to forget to flip and
 * no way to reopen it from outside.
 */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    const parsed = setupSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "Check the form and try again.",
      );
    }
    await completeSetup(parsed.data, { request });
    return { ok: true };
  });
}
