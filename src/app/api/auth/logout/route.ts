import { handleMutation } from "@/server/http";
import { getActor } from "@/server/auth/dal";
import { destroyCurrentSession } from "@/server/auth/session";
import { recordAudit } from "@/server/audit/audit-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/logout
 *
 * Always succeeds. Signing out when you were already signed out is not an
 * error, and returning one would leave a stale cookie in place on the only
 * path a user has to get rid of it.
 */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    const actor = await getActor();

    await destroyCurrentSession(actor?.sessionId ?? null);

    if (actor) {
      await recordAudit(
        {
          organizationId: actor.organizationId,
          actorUserId: actor.userId,
          actorLabel: actor.name ?? actor.email,
          request,
        },
        {
          action: "auth.signed_out",
          summary: `${actor.name ?? actor.email ?? "A user"} signed out`,
        },
      );
    }

    return { ok: true };
  });
}
