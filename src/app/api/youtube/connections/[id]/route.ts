import { handleMutation } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { recordAudit } from "@/server/audit/audit-service";
import { disconnect } from "@/server/services/youtube-oauth-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * DELETE /api/youtube/connections/:id — revoke the grant and forget the tokens.
 *
 * The revocation happens at Google first; see `disconnect()` for why deleting
 * our copy alone would leave a live authorisation nobody can withdraw.
 */
export function DELETE(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    const actor = await requirePermission("youtube.manage");

    const { id } = await context.params;
    // Scoped inside the service, so an id from another workspace resolves to a
    // 404 rather than deleting somebody else's connection.
    const result = await disconnect(id);

    await recordAudit(
      {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        actorLabel: actor.name ?? actor.email,
        request,
      },
      {
        action: "youtube.disconnected",
        summary: `${actor.name ?? actor.email ?? "An admin"} disconnected ${result.label}`,
        targetType: "youtube_connection",
        targetId: result.id,
        targetLabel: result.label,
        // Recorded because it is the one thing about a disconnection that can
        // silently go wrong: the local tokens are always gone, but a Google
        // outage can leave the grant standing in the account's own settings,
        // and somebody has to be able to find that out later.
        metadata: { revokedAtGoogle: result.revokedAtGoogle },
      },
    );

    return { ok: true, revokedAtGoogle: result.revokedAtGoogle };
  });
}
