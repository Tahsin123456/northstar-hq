import { handle } from "@/server/http";
import { actorCan, requirePermission } from "@/server/auth/dal";
import { getAdminOverview } from "@/server/services/admin-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/overview — the numbers on the admin dashboard.
 *
 * One request rather than six, because the page shows the tiles together and
 * six round trips would let them disagree: a user count from before a
 * deactivation next to a session count from after it is a screenshot nobody can
 * act on.
 *
 * TWO PERMISSIONS, NOT ONE. `users.manage` gates the tiles; the activity list
 * is audit data and is gated separately on `audit.view`, the same capability
 * /api/admin/audit requires. Today every holder of one holds the other, because
 * `users.manage` is not grantable and so arrives only with the Admin role — but
 * that is a property of the current role table, not a check. Relying on it
 * would mean a future role gains the audit trail, with its IP and user-agent
 * columns, as an invisible side effect of being allowed to invite people.
 */
export function GET() {
  return handle(async () => {
    await requirePermission("users.manage");

    const overview = await getAdminOverview();

    if (await actorCan("audit.view")) return overview;
    return { ...overview, recentActivity: [] };
  });
}
