import { handle } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import {
  getMyEarningsHistoryBreakdown,
  parseMyEarningsHistoryMonth,
} from "@/server/services/payroll-service";

// Prisma needs the Node.js runtime. Nothing here may be cached either: the
// figures in a settled month cannot move, but this response is about one
// person's pay and a cached copy is a copy that could be served to the next
// caller. The parent history route takes the same two lines for the same reason.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ year: string; month: string }> };

/**
 * GET /api/me/earnings/history/:year/:month — the per-niche hit lines behind one
 * settled month of the signed-in employee's own pay.
 *
 * IT TAKES A MONTH, NEVER A PERSON.
 * The two segments below are the complete set this handler reads, and neither
 * names anybody. `getMyEarningsHistoryBreakdown` resolves the subject from the
 * session and has no parameter that could carry a user id — so there is no
 * `?userId=` to try, the rest of the query string is never looked at, the body
 * is never read, and no header is consulted. A month the caller has no record in
 * is a 404 with the same wording as a month that does not exist, so the response
 * cannot be used to learn what a colleague was paid for.
 *
 * THERE IS NO WRITE PATH HERE, BY CONSTRUCTION.
 * This module exports `GET` and nothing else, so Next answers a POST, PATCH or
 * DELETE with a 405 before any of our code runs — there is no handler that could
 * forget a permission check. Payroll is written only by `payroll.manage` holders
 * through the admin routes under /api/admin/payroll.
 */
export function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    await requirePermission("earnings.view_own");

    const { year, month } = await context.params;

    return {
      breakdown: await getMyEarningsHistoryBreakdown(
        parseMyEarningsHistoryMonth({ year, month }),
      ),
    };
  });
}
