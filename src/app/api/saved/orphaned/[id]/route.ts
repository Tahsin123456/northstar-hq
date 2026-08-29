import { handleMutation } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { removeOrphanedSavedShort } from "@/server/services/research-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * DELETE /api/saved/orphaned/:id — clear a save left behind by a deleted account.
 *
 * A sibling of `/api/saved/:videoId` rather than a mode of it, because it is
 * addressed differently and answers to a different permission. `videoId`
 * identifies the caller's own save; an orphan has no owner to key on, so it is
 * named by its row id — see `removeOrphanedSavedShort`.
 *
 * TWO PERMISSIONS. `research.write` because this deletes research, and
 * `users.manage` because the row being deleted is not the caller's: it is the
 * residue of somebody who has left, and clearing up after a departed colleague
 * is administration, not personal filing. `users.manage` is also already the
 * permission that makes an orphan visible at all — `listSavedShorts` widens to
 * the team for exactly that reader — so this is the same boundary on the write
 * that the read already draws.
 */
export function DELETE(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    await requirePermission("research.write");
    await requirePermission("users.manage");

    const { id } = await context.params;
    await removeOrphanedSavedShort(id);
    return { ok: true };
  });
}
