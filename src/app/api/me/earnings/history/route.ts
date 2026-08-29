import { handle } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import {
  getMyEarningsHistory,
  parseMyEarningsHistoryPage,
} from "@/server/services/payroll-service";

// Prisma needs the Node.js runtime. Nothing here may be cached either: a
// finalized figure cannot move, but whether it has been PAID can change the
// moment an admin closes the run, and a stale "still pending" about somebody's
// own salary is exactly the kind of wrong that starts a conversation with HR.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/me/earnings/history — the months the signed-in employee has already
 * been paid for, newest first.
 *
 * IT TAKES A PAGE, NEVER A PERSON.
 * The two parameters below are the complete set this handler reads, and neither
 * names anybody. `getMyEarningsHistory` resolves the subject from the session
 * on its own and has no parameter that could carry a user id — so there is no
 * `?userId=` to try, nothing else in the query string is even looked at, the
 * body is never read, and no header is consulted. Returning somebody else's
 * history would require adding an argument, which is a change to a signature
 * rather than a slip in a `where` clause.
 *
 *   limit   how many periods, 1-60, default 24
 *   offset  how many to skip, default 0
 *
 * THERE IS NO WRITE PATH HERE, BY CONSTRUCTION.
 * This module exports `GET` and nothing else. Next only routes the HTTP methods
 * a route module actually exports, so a POST, PATCH or DELETE to this path is a
 * 405 before any of our code runs — there is no handler to forget a permission
 * check in. Payroll is written only by `payroll.manage` holders, through the
 * admin routes under /api/admin/payroll, and an employee holds `earnings.view_own`
 * alone: a permission whose whole definition is a read of their own figures.
 *
 * `earnings.view_own` is checked here before anything touches the database, and
 * again inside the service as the backstop for any future non-route caller.
 */
export function GET(request: Request) {
  return handle(async () => {
    await requirePermission("earnings.view_own");

    const params = new URL(request.url).searchParams;
    const page = parseMyEarningsHistoryPage({
      limit: params.get("limit"),
      offset: params.get("offset"),
    });

    return { history: await getMyEarningsHistory(page) };
  });
}
