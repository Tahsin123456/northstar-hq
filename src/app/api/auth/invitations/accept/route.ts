import { z } from "zod";
import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { acceptInvitation } from "@/server/services/auth-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  token: z.string().min(1).max(512),
  name: z.string().trim().min(1, "Enter your name.").max(120),
  password: z.string().min(1, "Choose a password.").max(256),
});

/**
 * POST /api/auth/invitations/accept
 *
 * The employee sets their own password here, which is the entire point of the
 * invitation flow: no administrator ever handles somebody else's credentials.
 * The token is consumed inside the same transaction that creates the account,
 * so a replayed link cannot mint a second one.
 */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "Check the form and try again.",
      );
    }
    await acceptInvitation(parsed.data, { request });
    return { ok: true };
  });
}
