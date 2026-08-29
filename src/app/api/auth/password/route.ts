import { z } from "zod";
import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requireActor } from "@/server/auth/dal";
import { changeOwnPassword } from "@/server/services/auth-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  currentPassword: z.string().min(1, "Enter your current password.").max(256),
  newPassword: z.string().min(1, "Choose a new password.").max(256),
});

/**
 * PATCH /api/auth/password — change your own password.
 *
 * SUPERSEDED BY `PATCH /api/me/profile`, which handles the name, the email and
 * the password together and is what the Settings page calls. This route is kept
 * because it is a live endpoint on a live deployment and nothing in-app calls
 * it, so removing it would only risk breaking a caller we cannot see. Both
 * delegate to the same `changeOwnPassword`, so there is one password path in
 * the codebase and two doors onto it — not two implementations that can drift.
 * Retire this once the logs show nothing is using it.
 *
 * Requires the current password even though the caller is already
 * authenticated: it is what stops an unattended, unlocked browser being turned
 * into permanent access.
 *
 * There is deliberately no route anywhere that sets somebody ELSE's password.
 * An admin can invite, or trigger a reset link, and that is all.
 */
export function PATCH(request: Request) {
  return handleMutation(request, async () => {
    const actor = await requireActor();

    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "Check the form and try again.",
      );
    }

    await changeOwnPassword(
      parsed.data,
      {
        userId: actor.userId,
        organizationId: actor.organizationId,
        actorLabel: actor.name ?? actor.email,
        sessionId: actor.sessionId,
      },
      { request },
    );

    return { ok: true };
  });
}
