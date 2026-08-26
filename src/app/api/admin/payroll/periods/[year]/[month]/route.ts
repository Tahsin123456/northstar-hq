import { handle } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { getPeriod, parsePeriodParams } from "@/server/services/payroll-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PeriodRouteContext = { params: Promise<{ year: string; month: string }> };

/**
 * GET /api/admin/payroll/periods/:year/:month — one period, in full.
 *
 * Every employee's line with its whole breakdown: base salary, the per-niche
 * hit counts with the threshold each was judged against and the rate each paid,
 * the bonus, any adjustment and its reason, and the total they sum to. The
 * Shorts behind the bonus come with it, each carrying the view count and the
 * threshold as they stood when the period was finalized.
 *
 * A finalized period is read from storage and never recalculated; an open one
 * is calculated live and flagged `isDraft`. The service owns that branch — see
 * the note at the top of payroll-service.ts.
 */
export function GET(_request: Request, context: PeriodRouteContext) {
  return handle(async () => {
    await requirePermission("payroll.view");

    const params = await context.params;
    const { year, month } = parsePeriodParams(params.year, params.month);

    return { period: await getPeriod(year, month) };
  });
}
