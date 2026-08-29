import { z } from "zod";
import { handle, handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requireActor } from "@/server/auth/dal";
import { changeOwnPassword, updateOwnProfile } from "@/server/services/auth-service";
import { MAX_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import type { MyProfileDTO } from "@/lib/dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/me/profile — the signed-in person's own account.
 *
 * Name, email address and password: personal state, and the whole of what an
 * employee may change about themselves. Organization configuration is a
 * different endpoint behind a different permission — see
 * /api/settings/organization.
 *
 * NO PERMISSION IS REQUIRED BEYOND BEING SIGNED IN, and that is not a gap.
 * There is no capability called "edit your own name": the subject is the
 * caller, resolved from the session, and every write below is scoped to
 * `actor.userId`. There is deliberately no route anywhere in this application
 * that edits somebody else's profile or sets somebody else's password — an
 * admin can invite, deactivate or trigger a reset link, and that is all.
 */

const schema = z
  .object({
    name: z.string().trim().min(1, "Enter your name.").max(120).optional(),
    email: z.string().trim().min(1, "Enter an email address.").max(320).optional(),
    /**
     * Serves two purposes and is required for both: it re-authenticates an
     * email change, and it is the old password when setting a new one. One
     * field rather than two because a form asking for the current password
     * twice on one submit would be answered inconsistently.
     */
    currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH).optional(),
    newPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.email !== undefined ||
      value.newPassword !== undefined,
    { message: "Nothing to change." },
  );

/** GET /api/me/profile — your own name and email. */
export function GET() {
  return handle(async (): Promise<{ profile: MyProfileDTO }> => {
    const actor = await requireActor();
    return {
      profile: { id: actor.userId, name: actor.name, email: actor.email },
    };
  });
}

/** PATCH /api/me/profile — change your own name, email or password. */
export function PATCH(request: Request) {
  return handleMutation(request, async () => {
    const actor = await requireActor();

    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "Check the form and try again.",
      );
    }
    const { name, email, currentPassword, newPassword } = parsed.data;

    /**
     * A password change travels alone.
     *
     * There is no transaction spanning the two writes — one rewrites the hash
     * and signs out every other device, the other rewrites the account row — so
     * a request carrying both has a real failure mode where the first lands and
     * the second is rejected, leaving the person told "no" about a change that
     * half happened. Refusing the combination removes the case entirely, and
     * costs nothing: the two live in separate forms, and nobody changes their
     * surname and their password in the same thought.
     */
    if (newPassword !== undefined && (name !== undefined || email !== undefined)) {
      throw errors.invalidInput(
        "Change your password on its own, then your name or email address.",
      );
    }

    if (newPassword !== undefined) {
      if (currentPassword === undefined) {
        throw errors.invalidInput("Enter your current password to set a new one.");
      }
      // Delegated rather than reimplemented, so this endpoint inherits the
      // existing strength policy, the scrypt parameters, the current-password
      // check and the sign-out of every other session — one password path in
      // the codebase, not two that can drift.
      await changeOwnPassword(
        { currentPassword, newPassword },
        {
          userId: actor.userId,
          organizationId: actor.organizationId,
          actorLabel: actor.name ?? actor.email,
          sessionId: actor.sessionId,
        },
        { request },
      );

      return {
        profile: { id: actor.userId, name: actor.name, email: actor.email },
        emailChanged: false,
        passwordChanged: true,
      };
    }

    const updated = await updateOwnProfile(
      { name, email, currentPassword },
      {
        userId: actor.userId,
        organizationId: actor.organizationId,
        actorLabel: actor.name ?? actor.email,
      },
      { request },
    );

    return {
      profile: { id: updated.id, name: updated.name, email: updated.email },
      emailChanged: updated.emailChanged,
      passwordChanged: false,
    };
  });
}
