import { handleMutation } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { revokeInvitation } from "@/server/services/admin-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * DELETE /api/admin/invitations/:id — call off a pending invitation.
 *
 * Sets `revokedAt` rather than deleting the row. The invitation is the record
 * that somebody was offered access and by whom; deleting it would erase that
 * from the one place it is written down, and the acceptance path checks
 * `revokedAt` anyway, so the outstanding link stops working either way.
 */
export function DELETE(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    await requirePermission("users.manage");

    const { id } = await context.params;
    return { invitation: await revokeInvitation(id, request) };
  });
}
