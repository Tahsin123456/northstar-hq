import { handle } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { listPeriods } from "@/server/services/payroll-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/payroll/periods — payroll history, newest first.
 *
 * Totals and status per period, without the per-employee detail: that lives at
 * /api/admin/payroll/periods/:year/:month, which is one click away and is the
 * only place a colleague's individual salary needs to be sent.
 */
export function GET() {
  return handle(async () => {
    await requirePermission("payroll.view");
    return { periods: await listPeriods() };
  });
}
