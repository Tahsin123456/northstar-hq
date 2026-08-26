import { handle } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { getCurrentPayroll } from "@/server/services/payroll-service";

// Prisma needs the Node.js runtime. Payroll must never be cached anywhere: the
// current period is a live calculation, and a stale salary figure that looks
// authoritative is worse than an error.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/payroll — the current period, plus last month's run.
 *
 * The current month is calculated on every request rather than stored: it is a
 * question about view counts that are still moving. `period.totals` is the
 * summary — headline figures and the rows they are made of come from one
 * object, so the two cannot disagree.
 *
 * `payroll.view` is held only by admins. It is checked here, before anything
 * touches the database, and again inside the service — the route is the
 * boundary, the service check is the backstop for any future caller that is
 * not a route.
 */
export function GET() {
  return handle(async () => {
    await requirePermission("payroll.view");
    return getCurrentPayroll();
  });
}
