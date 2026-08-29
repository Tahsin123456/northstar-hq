import { handle } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { getMyEarnings, parseMyEarningsPeriod } from "@/server/services/payroll-service";

// Prisma needs the Node.js runtime. An open period is a live calculation over
// view counts that are still moving, so nothing here may be cached: a stale
// figure about somebody's own pay carries an authority it has not earned.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/me/earnings — what the signed-in employee earned.
 *
 * IT TAKES A PERIOD, NEVER A PERSON.
 * The three parameters below are the complete set this handler reads, and none
 * of them names anybody. `getMyEarnings` resolves the subject from the session
 * on its own; it has no parameter that could carry a user id, so there is no
 * `?userId=` to try, no body to smuggle one in, and nothing for a stray value
 * to override. Adding somebody else's earnings to this endpoint would require
 * adding an argument, which is a change to a signature rather than a slip in a
 * `where` clause.
 *
 *   period=current   (default) the month in progress — a live estimate
 *   period=previous  last month — the stored figure once it is finalized
 *   period=custom&startsAt=<ms>&endsAt=<ms>   an arbitrary range, always an
 *                    estimate: a range that is not a calendar month is not a
 *                    payroll period and can never be finalized.
 *
 * `earnings.view_own` is held by every role and is deliberately NOT
 * `payroll.view`, which is the whole company's pay and belongs to admins. It is
 * checked here before anything touches the database, and again inside the
 * service as the backstop for any future non-route caller.
 */
export function GET(request: Request) {
  return handle(async () => {
    await requirePermission("earnings.view_own");

    const params = new URL(request.url).searchParams;
    const period = parseMyEarningsPeriod({
      period: params.get("period"),
      startsAt: params.get("startsAt"),
      endsAt: params.get("endsAt"),
    });

    return { earnings: await getMyEarnings({ period }) };
  });
}
