import { authenticateScheduler } from "@/server/auth/cron-auth";
import { recordAudit } from "@/server/audit/audit-service";
import { prisma } from "@/server/db";
import { toAppError } from "@/server/errors";
import { handleMutation } from "@/server/http";
import { periodContaining, periodLabel, previousPeriod } from "@/lib/payroll/payroll-engine";
import {
  ensureCurrentPeriodExists,
  finalizePeriodForOrganization,
} from "@/server/services/payroll-service";
import { sendPayrollNotification } from "@/server/services/notification-service";
import type { NotificationAttemptDTO } from "@/lib/dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Finalizing a month reads every Short published in it and writes a record per
 * employee plus a row per qualifying hit. That is seconds of database work, not
 * milliseconds, and the default serverless budget would kill it partway through
 * — leaving a period claimed as "finalized" with only some of its records
 * written, which is the one outcome this job must never produce.
 */
export const maxDuration = 300;

/**
 * ===========================================================================
 * POST/GET /api/cron/payroll — the monthly payroll run
 * ===========================================================================
 *
 * Runs on the 1st of the month at 00:00 (see `vercel.json`). It does three
 * things, in this order, for every organization:
 *
 *   1. Works out the period that just ended — `previousPeriod` of the one we
 *      are standing in. On 1 September that is August, the month whose work is
 *      being paid for.
 *   2. Finalizes it. Idempotent: a period already frozen is left exactly as it
 *      is, which is what protects an adjustment an admin made last week.
 *   3. Sends the summary to Telegram, claiming the `PayrollNotification` row
 *      before it sends so a job that fires twice announces everybody's pay
 *      once.
 *   4. Opens the month that has just begun. An empty PayrollPeriod row, no
 *      figures — those are still a live calculation and stay one. It exists so
 *      the running month is in the history from day one rather than appearing
 *      four weeks later, and so the next notification has a row to hang off.
 *      Last, because it is the only step nothing else depends on: a failure
 *      here must not cost a finalization that already succeeded.
 *
 * WHY THIS ROUTE IS EXEMPT FROM THE SESSION GATE
 * A scheduler has no cookie. The reasoning and the timing-safe secret
 * comparison live in `src/server/auth/cron-auth.ts`, shared with
 * `/api/cron/sync` so there is one implementation rather than one per endpoint.
 *
 * WHY ONE ORGANIZATION'S FAILURE DOES NOT ABORT THE SWEEP
 * The same shape `runScheduledSyncForAllOrganizations` uses: a thrown error is
 * caught, recorded against the organization it belongs to, and the loop
 * continues. A single tenant with a broken Telegram configuration must not stop
 * everybody else's payroll being finalized — and "the job crashed on the first
 * org, alphabetically" is a failure mode that hides itself.
 *
 * WHY NOTHING HERE LOGS A FIGURE
 * Payroll is admin-only, and a serverless log is read by whoever holds the
 * hosting account rather than by whoever holds `payroll.view`. Every line this
 * route writes carries an organization id, a month and a headcount. The money
 * stays in the database and in the Telegram message.
 */

interface OrganizationRunResult {
  readonly organizationId: string;
  readonly finalized: boolean;
  readonly alreadyFinalized: boolean;
  /** Headcount on the run. Never an amount. */
  readonly employeeCount: number;
  readonly notification: NotificationAttemptDTO | null;
  /** True when this run is what opened the month that has just begun. */
  readonly currentPeriodOpened: boolean;
  /** Present only when this organization's run threw. */
  readonly error?: string;
}

async function runMonthlyPayroll(request: Request) {
  // First statement of the handler, exactly as `requirePermission` is
  // everywhere else: nothing is read, parsed or queried before the caller has
  // been proven.
  authenticateScheduler(request, "Scheduled payroll");

  const startedAt = Date.now();

  // The month that just ended. Derived from the clock rather than taken from
  // the request: a scheduler must not be able to ask for a different month, and
  // a body parameter naming a period is exactly how a replayed request would
  // finalize and announce the wrong one.
  const period = previousPeriod(periodContaining(startedAt));
  const label = periodLabel(period);

  const organizations = await prisma.organization.findMany({
    select: { id: true },
    // Stable order so a run cut short by a platform timeout does not starve the
    // same tenant every time — oldest first is at least predictable.
    orderBy: { createdAt: "asc" },
  });

  const results: OrganizationRunResult[] = [];

  for (const organization of organizations) {
    try {
      const finalized = await finalizePeriodForOrganization({
        organizationId: organization.id,
        period,
        request,
      });

      const notification = await sendPayrollNotification({
        organizationId: organization.id,
        periodId: finalized.periodId,
        period,
        // No actor: the scheduler is a process. Attributing this to whichever
        // admin happened to sign in last would be a lie in the one log that
        // exists to prevent them.
        actorUserId: null,
        actorLabel: "Scheduled payroll",
        // Never forced. Re-sending a summary already delivered is a deliberate
        // admin action, not something a retry may decide to do.
        force: false,
        request,
      });

      // The month that has just begun, not the one just finalized. `atMs` is
      // the run's own start rather than the clock, so this and step 1 are two
      // readings of one instant: a sweep that crosses midnight on the 1st must
      // not finalize August and then open October.
      const opened = await ensureCurrentPeriodExists({
        organizationId: organization.id,
        atMs: startedAt,
        actorLabel: "Scheduled payroll",
        request,
      });

      results.push({
        organizationId: organization.id,
        finalized: !finalized.alreadyFinalized,
        alreadyFinalized: finalized.alreadyFinalized,
        employeeCount: finalized.employeeCount,
        notification,
        currentPeriodOpened: opened.created,
      });
    } catch (caught) {
      const appError = toAppError(caught);
      console.error(
        `[payroll] organization ${organization.id} run for ${label} failed: ` +
          `${appError.code} — ${appError.message}`,
      );

      // Visible to an admin, not just to a log nobody reads. Silence on the 1st
      // is indistinguishable from "nothing was owed", and this is the entry
      // that tells the two apart.
      await recordAudit(
        {
          organizationId: organization.id,
          actorUserId: null,
          actorLabel: "Scheduled payroll",
          request,
        },
        {
          action: "payroll.run_failed",
          summary: `The scheduled ${label} payroll run could not complete: ${appError.userMessage}`,
          targetType: "payroll_period",
          targetId: `${period.year}-${String(period.month).padStart(2, "0")}`,
          targetLabel: label,
          metadata: { year: period.year, month: period.month, code: appError.code },
        },
      );

      results.push({
        organizationId: organization.id,
        finalized: false,
        alreadyFinalized: false,
        employeeCount: 0,
        notification: null,
        currentPeriodOpened: false,
        error: appError.userMessage,
      });
    }
  }

  return {
    ok: true as const,
    period: { year: period.year, month: period.month, label },
    organizationsConsidered: organizations.length,
    finalized: results.filter((result) => result.finalized).length,
    notificationsSent: results.filter((result) => result.notification?.status === "sent").length,
    currentPeriodsOpened: results.filter((result) => result.currentPeriodOpened).length,
    failed: results.filter((result) => result.error !== undefined).length,
    durationMs: Date.now() - startedAt,
    results,
  };
}

/**
 * POST is the conventional verb for something that changes state, and what most
 * schedulers send.
 */
export function POST(request: Request) {
  return handleMutation(request, () => runMonthlyPayroll(request));
}

/**
 * GET does the same thing, because schedulers disagree about which verb a cron
 * target should use — Vercel Cron issues GET, most queue workers POST, and a
 * plain `curl` in a crontab defaults to GET. Refusing one of them would make
 * this endpoint depend on the scheduler's taste.
 *
 * It uses `handleMutation` rather than `handle` despite being a GET, which is
 * against this codebase's usual convention and deliberate: the convention
 * exists so state-changing routes cannot forget the origin check, and this GET
 * changes state. Following the letter of the rule here would mean applying the
 * weaker wrapper to the request that needs the stronger one. (The check is a
 * no-op for a scheduler, which sends no Origin header — see `assertSameOrigin`
 * — so this costs nothing and closes the browser-driven case.)
 */
export function GET(request: Request) {
  return handleMutation(request, () => runMonthlyPayroll(request));
}
