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
 * THREE PERMISSIONS, NOT ONE. `users.manage` gates the tiles; the activity list
 * is audit data and is gated separately on `audit.view`, the same capability
 * /api/admin/audit requires; and the payroll headline is gated again on
 * `payroll.view`. Today every holder of one holds the others, because
 * `users.manage` is not grantable and so arrives only with the Admin role — but
 * that is a property of the current role table, not a check. Relying on it
 * would mean a future role gains the audit trail, with its IP and user-agent
 * columns, or the team's salary bill, as an invisible side effect of being
 * allowed to invite people.
 *
 * THE TWO GATES WORK DIFFERENTLY, ON PURPOSE. Audit entries are fetched and
 * then dropped: they are cheap, and the read is scoped to this organization
 * either way. Payroll is decided BEFORE the read — the flag goes in, and
 * without it the engine never runs, no `EmployeeProfile` row is selected and no
 * salary enters this process's memory at all. Money is not something to fetch
 * and remember to strip.
 *
 * WHICH IS WHY `payroll.view` IS ASKED TWICE. `recentActivity` is the one place
 * where money arrives through the other door: an `employee.pay_updated` entry
 * carries the old and new salary in its metadata, and that entry reaches this
 * response on the strength of `audit.view` alone. So the same permission is put
 * to the audit read as well, and without it the amounts are stripped before the
 * rows are returned — see listAuditEvents. Dropping `recentActivity` wholesale
 * would also work and would cost every admin without payroll the activity feed,
 * which is a real capability to lose over four numbers.
 */
export function GET() {
  return handle(async () => {
    await requirePermission("users.manage");

    const canViewPayroll = await actorCan("payroll.view");
    const overview = await getAdminOverview({
      includePayroll: canViewPayroll,
      includeSensitiveAuditMetadata: canViewPayroll,
    });

    if (await actorCan("audit.view")) return overview;
    return { ...overview, recentActivity: [] };
  });
}
