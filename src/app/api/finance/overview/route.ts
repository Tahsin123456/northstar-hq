import { handle } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import {
  getFinanceOverview,
  parseFinanceQuery,
  resolveFinanceRange,
} from "@/server/services/finance-service";

// Prisma needs the Node.js runtime, and a financial payload must never be
// cached anywhere: the numbers are the point, and a stale total that looks
// authoritative is worse than an error.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/finance/overview
 *
 * The whole Finance dashboard in one response: totals, both charts, the
 * per-channel comparison table, and the entries behind them. Narrowing the
 * range client-side re-runs the same pure engine on the same array, so the
 * screen and this payload cannot disagree about a total.
 */
export function GET(request: Request) {
  return handle(async () => {
    // Revenue, expenses and margins — the permission that exists to keep this
    // page away from everyone who is not meant to see the company's money.
    await requirePermission("finance.view");

    const query = parseFinanceQuery(request);
    const range = await resolveFinanceRange(query);

    return getFinanceOverview({ range });
  });
}
