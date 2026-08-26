import "server-only";

import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { recordAudit } from "@/server/audit/audit-service";
import type { AuditAction } from "@/lib/audit/actions";
import { roleDefinition } from "@/lib/auth/permissions";
import { MAX_MONEY_MINOR } from "@/lib/finance/money";
import {
  calculatePayrollRun,
  payDateFor,
  periodContaining,
  periodForMonth,
  periodLabel,
  previousPeriod,
  type PayrollCalculation,
  type PayrollPeriodWindow,
  type QualifyingHit,
} from "@/lib/payroll/payroll-engine";
import { loadPayrollInputs } from "./payroll-data";
import { getOrgSettings, getScope } from "./user-service";

/**
 * =========================================================================
 * PAYROLL — LIVE CALCULATION, FINALIZATION AND PAYMENT
 * =========================================================================
 *
 * THE ONE IDEA THIS FILE IMPLEMENTS
 * A payroll period is a calculation right up until the moment it is finalized,
 * and a stored document from then on. Those are genuinely different things and
 * this service refuses to blur them:
 *
 *   • OPEN — no PayrollRecord rows exist. Every read re-runs the engine against
 *     current view counts, so the figure moves as Shorts accumulate views. That
 *     is correct: mid-month, "what will we owe" has no fixed answer.
 *   • FINALIZED — the rows exist and are returned verbatim. Nothing recalculates
 *     them, ever. A Short that crosses a million views in September must not
 *     retroactively change what August cost, and an admin editing a salary
 *     today must not rewrite what was actually paid in March. Reproducibility
 *     is the entire point of the transition, so `getPeriod` reads stored rows
 *     rather than recomputing and hoping the answer still matches.
 *
 * The single sanctioned exception is `adjustRecord`, which is why it demands a
 * reason and gets audit actions of its own — two of them, because correcting a
 * figure before it is paid and correcting one after the money left are
 * different events to have to find again.
 *
 * EVERY RESPONSE CARRIES THE BREAKDOWN
 * No function here returns a bare total. A payroll figure that cannot be taken
 * apart into "base salary + this many hits in this niche, judged against this
 * threshold, at this rate, plus this adjustment" is not something an employee
 * can check or an admin can defend. The DTOs below are shaped so the parts are
 * always present and the total is visibly their sum.
 *
 * WHERE THE MONEY MAY GO
 * Payroll is admin-only. These DTOs carry salaries; they are returned solely
 * from routes that have cleared `payroll.view`. Nothing in this file writes a
 * figure into an audit entry or a log line — see the note in
 * src/lib/audit/actions.ts for why the audit trail records events and reasons
 * but never amounts.
 */

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

/** Mirrors `PayrollPeriod.status`; "open" is also what an absent row means. */
export type PayrollPeriodStatus = "open" | "finalized" | "paid";

/** Mirrors `PayrollRecord.paymentStatus`. */
export type PayrollPaymentStatus = "pending" | "paid";

/**
 * One niche's contribution to somebody's bonus.
 *
 * `thresholdApplied` and `hitPaymentMinor` travel with the count on purpose:
 * "12 hits" means nothing without "at 500,000 views, $10 each". This is the
 * line the brief has in mind when it says a total on its own is not acceptable.
 */
export interface PayrollNicheLineDTO {
  readonly nicheId: string | null;
  readonly nicheName: string;
  readonly thresholdApplied: number;
  readonly hitCount: number;
  /** The employee's per-hit rate, in minor units. */
  readonly hitPaymentMinor: number;
  readonly bonusMinor: number;
}

/** One Short that earned a bonus, as it stood when it was counted. */
export interface PayrollHitDTO {
  readonly videoId: string;
  readonly videoTitle: string;
  readonly channelId: string | null;
  readonly channelName: string;
  readonly nicheId: string | null;
  readonly nicheName: string;
  readonly thresholdAtRun: number;
  readonly viewCountAtRun: number;
  readonly publishedAt: number;
}

/**
 * The fields a total is made of.
 *
 * Extracted so the history list can sum a narrow projection — money columns
 * only, no hits — through the exact same function that sums a full detail view.
 * Two summing routines for one number is how a header and its rows begin to
 * disagree.
 */
interface PayrollTotalsSource {
  readonly hitCount: number;
  readonly baseSalaryMinor: number;
  readonly hitBonusMinor: number;
  readonly adjustmentMinor: number;
  readonly totalMinor: number;
  readonly currency: string;
  readonly paymentStatus: PayrollPaymentStatus;
}

export interface PayrollRecordDTO extends PayrollTotalsSource {
  /**
   * Null while the period is a live calculation — there is no row to point at
   * yet. The presence of an id is exactly what tells the client whether this
   * figure can be adjusted or marked paid.
   */
  readonly id: string | null;
  readonly userId: string;
  readonly employeeName: string;
  readonly employeeEmail: string;
  readonly role: string;
  readonly roleLabel: string;

  // --- The breakdown, in the order it should be read ------------------------
  readonly baseSalaryMinor: number;
  readonly hitPaymentMinor: number;
  readonly hitCount: number;
  readonly hitBonusMinor: number;
  readonly adjustmentMinor: number;
  readonly adjustmentReason: string | null;
  readonly totalMinor: number;
  readonly currency: string;

  readonly paymentStatus: PayrollPaymentStatus;
  readonly paidAt: number | null;

  readonly byNiche: readonly PayrollNicheLineDTO[];
  readonly hits: readonly PayrollHitDTO[];
}

export interface PayrollTotalsDTO {
  readonly employeeCount: number;
  readonly hitCount: number;
  readonly baseSalaryMinor: number;
  readonly hitBonusMinor: number;
  readonly adjustmentMinor: number;
  readonly totalMinor: number;
  readonly paidMinor: number;
  readonly pendingMinor: number;
  readonly currency: string;
  /**
   * True when the run mixes currencies.
   *
   * Summing minor units across currencies produces a number that is not any
   * amount of money. Rather than silently converting — payroll has no rate
   * table, and inventing one would fabricate a figure — the sum is reported
   * as-is and flagged, so the UI can label it honestly instead of stamping it
   * with one currency's symbol.
   */
  readonly currencyMixed: boolean;
}

/** The shared head of a period: identity, window, state. */
export interface PayrollPeriodHeaderDTO {
  readonly year: number;
  /** 1-12. */
  readonly month: number;
  /** "August 2025". */
  readonly label: string;
  readonly startsAt: number;
  /** Exclusive. */
  readonly endsAt: number;
  readonly payOn: number;
  readonly status: PayrollPeriodStatus;
  /**
   * True when these figures were calculated just now rather than read from
   * storage. A draft is honest about moving; a finalized period never moves.
   */
  readonly isDraft: boolean;
  readonly hasEnded: boolean;
  readonly finalizedAt: number | null;
  readonly finalizedByName: string | null;
}

/** A period with every employee's line — the detail view. */
export interface PayrollPeriodDTO extends PayrollPeriodHeaderDTO {
  readonly totals: PayrollTotalsDTO;
  readonly records: readonly PayrollRecordDTO[];
}

/** A period without the per-employee detail — the history list. */
export interface PayrollPeriodSummaryDTO extends PayrollPeriodHeaderDTO {
  readonly totals: PayrollTotalsDTO;
}

/**
 * The payroll dashboard payload.
 *
 * `period.totals` is the summary: the headline figures and the rows they are
 * made of come from one object rather than two, so a client cannot render a
 * total that disagrees with what is underneath it. `previous` is last month —
 * normally the run waiting to be finalized or paid — and is null when no period
 * was ever opened for it.
 */
export interface PayrollDashboardDTO {
  readonly period: PayrollPeriodDTO;
  readonly previous: PayrollPeriodSummaryDTO | null;
}

// ---------------------------------------------------------------------------
// SCHEMAS AND PARAMETER PARSING
// ---------------------------------------------------------------------------

/**
 * Periods outside this range are a typo, not a payroll run.
 *
 * A stray `:year` would otherwise be able to create a real PayrollPeriod row
 * for the year 9999 that somebody then has to go and delete by hand.
 */
const MIN_PERIOD_YEAR = 2000;
const MAX_PERIOD_YEAR = 2100;

export interface PeriodParams {
  readonly year: number;
  readonly month: number;
}

/**
 * `:year` / `:month` out of a URL, or a 400.
 *
 * Shared by all four period routes so the bounds cannot drift between them.
 * Route parameters are strings by definition: `Number("08")` is 8, and
 * `Number("8abc")` is NaN — both handled here rather than in each handler.
 */
export function parsePeriodParams(year: string, month: string): PeriodParams {
  const parsedYear = Number(year);
  const parsedMonth = Number(month);

  if (
    !Number.isInteger(parsedYear) ||
    parsedYear < MIN_PERIOD_YEAR ||
    parsedYear > MAX_PERIOD_YEAR
  ) {
    throw errors.invalidInput(
      `“${year}” is not a payroll year. Use a four-digit year between ${MIN_PERIOD_YEAR} and ${MAX_PERIOD_YEAR}.`,
    );
  }

  if (!Number.isInteger(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
    throw errors.invalidInput(`“${month}” is not a month. Use 1 to 12.`);
  }

  return { year: parsedYear, month: parsedMonth };
}

export const finalizePeriodSchema = z.object({
  /**
   * Finalize a month that has not finished yet.
   *
   * Off by default because freezing a period while the Shorts in it are still
   * gaining views records a figure that was never the right one. It exists
   * because "pay everyone out early, we are closing the books" is a real
   * instruction, and refusing it outright would only push somebody towards
   * editing the database by hand.
   */
  force: z.boolean().optional(),
});

const adjustmentMinorSchema = z
  .number()
  .int("Adjustments are whole minor units (cents), never fractions of one.")
  // Signed on purpose: a correction can go either way, and clawing back an
  // overpayment is as legitimate as adding a bonus.
  .min(-MAX_MONEY_MINOR, "That adjustment is too large to record.")
  .max(MAX_MONEY_MINOR, "That adjustment is too large to record.");

const adjustmentReasonSchema = z
  .string()
  .trim()
  .min(3, "Say why this payroll figure is being changed.")
  .max(500, "Keep the reason to 500 characters or fewer.");

/**
 * The two things a PATCH on a record may do, and never both at once.
 *
 * Combining "correct the amount" and "mark it paid" into one request would
 * leave the audit trail ambiguous about which the admin meant — and one of the
 * two is the only sanctioned way to change a frozen figure.
 *
 * There is deliberately no "pending": un-marking a payment would rewrite
 * history to say money never moved. A payment recorded in error is corrected
 * the way every other finalized figure is, with an adjustment carrying a
 * reason.
 */
export const payrollRecordPatchSchema = z
  .object({
    adjustmentMinor: adjustmentMinorSchema.optional(),
    adjustmentReason: adjustmentReasonSchema.optional(),
    paymentStatus: z.literal("paid").optional(),
  })
  .refine(
    (value) => (value.adjustmentMinor !== undefined) !== (value.paymentStatus !== undefined),
    {
      message:
        "Send either an adjustment (with a reason) or a payment status — one of the two, not both.",
    },
  )
  .refine(
    (value) => value.adjustmentMinor === undefined || value.adjustmentReason !== undefined,
    {
      message: "An adjustment needs a reason.",
      path: ["adjustmentReason"],
    },
  );

export type PayrollRecordPatchInput = z.infer<typeof payrollRecordPatchSchema>;

// ---------------------------------------------------------------------------
// READ
// ---------------------------------------------------------------------------

/**
 * The current month, calculated live.
 *
 * Never stored. Asking "what is payroll right now" is asking about view counts
 * that are still moving, and writing that answer down would produce a document
 * that looks authoritative and is stale within the hour.
 *
 * THE FIGURES ARE NOT STORED; THE PERIOD ROW IS. `ensureCurrentPeriodExists`
 * writes an empty, open PayrollPeriod — no records, no totals, nothing that
 * could go stale — so the month in progress appears in the history and the
 * notification job has a row to hang a `PayrollNotification` off. Doing it on
 * this read as well as in the cron is what covers the month a scheduler missed
 * and the workspace that was created after the 1st. It is a no-op every time
 * but the first in a month.
 */
export async function getCurrentPayroll(): Promise<PayrollDashboardDTO> {
  await requirePermission("payroll.view");
  const { organizationId } = await getScope();

  await ensureCurrentPeriodExists({ organizationId });

  const current = periodContaining(Date.now());
  const prior = previousPeriod(current);

  const [currentRow, priorRow] = await Promise.all([
    loadPeriodRow(organizationId, current),
    loadPeriodRow(organizationId, prior),
  ]);

  const context = await buildContext(organizationId, [currentRow, priorRow]);

  const period = await buildPeriodDTO(context, current, currentRow);
  // Only when a period was actually opened or finalized for last month. A month
  // nobody ever ran is not "zero payroll" — it is not part of the history at
  // all, and showing it as a total would say something untrue.
  const previous = priorRow ? await buildPeriodSummary(context, prior, priorRow) : null;

  return { period, previous };
}

/**
 * One period: stored if it has been finalized, calculated if it has not.
 *
 * The branch that decides which lives in `buildPeriodDTO`, in one place, so
 * there is no path that recalculates a finalized month by accident.
 */
export async function getPeriod(year: number, month: number): Promise<PayrollPeriodDTO> {
  await requirePermission("payroll.view");
  const { organizationId } = await getScope();
  return getPeriodForOrganization(organizationId, periodForMonth(year, month));
}

/**
 * The same read, for a caller that has no session.
 *
 * The scheduled job and the notification service need the exact figures the
 * admin screens show — for a finalized period that means the STORED records,
 * which is what stops a Telegram summary reporting a total that a moving view
 * count has since changed. Reusing this function rather than re-querying is
 * what guarantees the message and the screen agree.
 *
 * NO PERMISSION CHECK, BY DESIGN. There is no session to check one against.
 * `organizationId` comes from the job's own sweep or from a caller that has
 * already cleared `payroll.view` — it must NEVER come from a request body, and
 * this function must never be wired directly to a route.
 */
export async function getPeriodForOrganization(
  organizationId: string,
  period: PayrollPeriodWindow,
): Promise<PayrollPeriodDTO> {
  const row = await loadPeriodRow(organizationId, period);
  const context = await buildContext(organizationId, [row]);
  return buildPeriodDTO(context, period, row);
}

/**
 * Payroll history, newest first.
 *
 * Only periods with a row: one exists once a month has been finalized, or once
 * the scheduled job opened it. Months nobody ever ran are absent rather than
 * listed as empty — "we owed nothing in July" and "July was never run" are
 * different claims, and the second is not this list's to make.
 *
 * An open period's totals are calculated rather than read, because stored
 * totals for a period with no records would be a fabricated zero. That costs
 * one engine run per un-finalized month, which is the incentive working as
 * intended: finalizing is what turns a calculation into a lookup.
 */
export async function listPeriods(): Promise<readonly PayrollPeriodSummaryDTO[]> {
  await requirePermission("payroll.view");
  const { organizationId } = await getScope();

  const rows = await prisma.payrollPeriod.findMany({
    where: { organizationId },
    orderBy: [{ year: "desc" }, { month: "desc" }],
    select: PERIOD_SELECT,
  });

  const context = await buildContext(organizationId, rows);

  const summaries: PayrollPeriodSummaryDTO[] = [];
  for (const row of rows) {
    // Sequential on purpose. Every open period in this list is a full engine
    // run over a month of Shorts; firing them all at once would put a dozen
    // heavy queries on the connection pool to render one table.
    summaries.push(await buildPeriodSummary(context, periodForMonth(row.year, row.month), row));
  }

  return summaries;
}

// ---------------------------------------------------------------------------
// WRITE: finalization
// ---------------------------------------------------------------------------

/**
 * Freezes a month.
 *
 * Writes a PayrollRecord per employee and a PayrollHit per qualifying Short in
 * one transaction, and flips the period to "finalized". From then on the
 * figures are read back rather than recomputed.
 *
 * IDEMPOTENT, TWO LAYERS DEEP
 *  1. An already-finalized period returns immediately, untouched. That is not
 *     an optimisation — it is what protects adjustments. Re-running the engine
 *     over a finalized month would silently discard a correction an admin made
 *     last week, which is exactly what finalization exists to prevent.
 *  2. Where writes do happen they go through the unique constraints —
 *     (period, user) and (record, video) — via upsert, so a retry, a double
 *     click or two overlapping requests converge on the same rows instead of
 *     duplicating them.
 *
 * The calculation happens OUTSIDE the transaction. It reads a month of videos
 * and must not hold a write transaction open while it does.
 */
export async function finalizePeriod(
  year: number,
  month: number,
  options: { force?: boolean } = {},
  request?: Request,
): Promise<PayrollPeriodDTO> {
  const actor = await requirePermission("payroll.manage");
  const { organizationId } = await getScope();

  const period = periodForMonth(year, month);

  await finalizePeriodForOrganization({
    organizationId,
    period,
    force: options.force,
    actorUserId: actor.userId,
    actorLabel: actor.name ?? actor.email,
    request,
  });

  return getPeriodForOrganization(organizationId, period);
}

export interface OrganizationFinalizeResult {
  readonly periodId: string;
  /** True when the period was already frozen and this call changed nothing. */
  readonly alreadyFinalized: boolean;
  /** Headcount on the run. Never an amount. */
  readonly employeeCount: number;
}

/**
 * The finalization itself, for a caller that has no session.
 *
 * This is where the work actually happens; `finalizePeriod` is the
 * session-checked wrapper around it. The scheduled monthly job calls this
 * directly, once per organization.
 *
 * NO PERMISSION CHECK, BY DESIGN — there is no session to check one against.
 * The scheduler proves itself with `authenticateScheduler` before it gets here,
 * and `organizationId` comes from its own sweep of the table. It must NEVER
 * come from a request body, and this function must never be wired directly to a
 * route a browser can reach.
 */
export async function finalizePeriodForOrganization(options: {
  organizationId: string;
  period: PayrollPeriodWindow;
  force?: boolean;
  /** Null for the scheduler: a process is not a person. */
  actorUserId?: string | null;
  actorLabel?: string | null;
  request?: Request;
}): Promise<OrganizationFinalizeResult> {
  const { organizationId, period, request } = options;
  const { year, month } = period;
  const label = periodLabel(period);
  const actorUserId = options.actorUserId ?? null;

  const existing = await loadPeriodRow(organizationId, period);

  if (existing && isFrozen(existing.status)) {
    // Already done, and left strictly alone. Recalculating here would discard
    // any adjustment made since — which is exactly what finalization exists to
    // prevent — so the only thing this branch does is report the headcount.
    const employeeCount = await prisma.payrollRecord.count({
      where: { periodId: existing.id },
    });
    return { periodId: existing.id, alreadyFinalized: true, employeeCount };
  }

  if (Date.now() < period.endsAtMs && !options.force) {
    throw errors.invalidInput(
      `${label} has not ended yet. Finalizing now would freeze a figure that is still moving as Shorts gain views. Send force to do it anyway.`,
    );
  }

  const inputs = await loadPayrollInputs(organizationId, period);
  const run = calculatePayrollRun({
    employees: inputs.employees,
    shorts: inputs.shorts,
    niches: inputs.niches,
    period,
    organizationDefaultThreshold: inputs.organizationDefaultThreshold,
  });

  const finalizedAt = new Date();

  const periodId = await prisma.$transaction(
    async (tx) => {
      const periodRow = await tx.payrollPeriod.upsert({
        where: { organizationId_year_month: { organizationId, year, month } },
        create: {
          organizationId,
          year,
          month,
          startsAt: new Date(period.startsAtMs),
          endsAt: new Date(period.endsAtMs),
          payOn: new Date(payDateFor(period)),
          status: "finalized",
          finalizedAt,
          finalizedById: actorUserId,
        },
        update: {
          // The window is rewritten too: a row opened earlier must not keep
          // boundaries that disagree with the ones these figures were actually
          // calculated against.
          startsAt: new Date(period.startsAtMs),
          endsAt: new Date(period.endsAtMs),
          payOn: new Date(payDateFor(period)),
          status: "finalized",
          finalizedAt,
          finalizedById: actorUserId,
        },
        select: { id: true },
      });

      await writeRecords(tx, periodRow.id, run.calculations);
      return periodRow.id;
    },
    {
      // A month of hits for a whole team is a lot of small writes. Prisma's
      // five-second default is comfortable for a small team and uncomfortably
      // close for a large one, and a payroll run that times out half-written is
      // the worst available outcome.
      timeout: 60_000,
      maxWait: 15_000,
    },
  );

  await auditPayroll(
    { organizationId, actorUserId, actorLabel: options.actorLabel ?? null },
    request,
    {
      action: "payroll.period_finalized",
      // Headcount and hits, never money. See src/lib/audit/actions.ts.
      summary: `Finalized ${label} payroll for ${run.calculations.length} ${
        run.calculations.length === 1 ? "employee" : "employees"
      }`,
      targetType: "payroll_period",
      targetId: periodKey(year, month),
      targetLabel: label,
      metadata: {
        year,
        month,
        employeeCount: run.calculations.length,
        hitCount: run.calculations.reduce((sum, calculation) => sum + calculation.hitCount, 0),
        forced: options.force === true,
      },
    },
  );

  return { periodId, alreadyFinalized: false, employeeCount: run.calculations.length };
}

/**
 * Writes one record per employee, and one hit per qualifying Short.
 *
 * Adjustments and payment state from a previous run are read first and carried
 * forward. In the ordinary path there is nothing to carry — records exist only
 * after a finalization, and a finalized period never reaches here — but the
 * alternative is an upsert that quietly resets somebody's correction on the one
 * occasion the ordinary path does not hold.
 */
async function writeRecords(
  tx: Prisma.TransactionClient,
  periodId: string,
  calculations: readonly PayrollCalculation[],
): Promise<void> {
  const existingRecords = await tx.payrollRecord.findMany({
    where: { periodId },
    select: {
      userId: true,
      adjustmentMinor: true,
      adjustmentReason: true,
      paymentStatus: true,
      paidAt: true,
    },
  });
  const existingByUserId = new Map(existingRecords.map((record) => [record.userId, record]));

  const userIds = calculations.map((calculation) => calculation.userId);

  // Somebody who was on a previous run and is not on this one — a leaver whose
  // end date was corrected, say — must not be left behind as a stale row that
  // still sums into the total. Their hits go with them, by cascade.
  await tx.payrollRecord.deleteMany({ where: { periodId, userId: { notIn: userIds } } });

  for (const calculation of calculations) {
    const previous = existingByUserId.get(calculation.userId);
    const adjustmentMinor = previous?.adjustmentMinor ?? 0;

    const baseSalaryMinor = assertStorable(calculation.baseSalaryMinor, "salary");
    const hitBonusMinor = assertStorable(calculation.hitBonusMinor, "hit bonus");
    const totalMinor = assertStorable(
      baseSalaryMinor + hitBonusMinor + adjustmentMinor,
      "payroll total",
    );

    const record = await tx.payrollRecord.upsert({
      where: { periodId_userId: { periodId, userId: calculation.userId } },
      create: {
        periodId,
        userId: calculation.userId,
        // Copied in rather than joined. A payroll record is a financial
        // document and has to keep reading correctly after the account behind
        // it is renamed, deactivated or deleted.
        employeeName: calculation.name,
        employeeEmail: calculation.email,
        roleAtRun: calculation.role,
        baseSalaryMinor,
        hitPaymentMinor: calculation.hitPaymentMinor,
        hitCount: calculation.hitCount,
        hitBonusMinor,
        adjustmentMinor,
        adjustmentReason: previous?.adjustmentReason ?? null,
        totalMinor,
        currency: calculation.currency,
        paymentStatus: previous?.paymentStatus ?? "pending",
        paidAt: previous?.paidAt ?? null,
      },
      update: {
        employeeName: calculation.name,
        employeeEmail: calculation.email,
        roleAtRun: calculation.role,
        baseSalaryMinor,
        hitPaymentMinor: calculation.hitPaymentMinor,
        hitCount: calculation.hitCount,
        hitBonusMinor,
        totalMinor,
        currency: calculation.currency,
        // adjustment* and payment* are absent on purpose: they belong to the
        // admin, not to the engine, and this branch must never overwrite them.
      },
      select: { id: true },
    });

    // Replaced wholesale rather than merged. The hits are a derived list, and
    // deleting first is what stops a Short that no longer qualifies — a view
    // count corrected downwards by a re-sync — from lingering as evidence for a
    // bonus that is no longer in the total.
    await tx.payrollHit.deleteMany({ where: { recordId: record.id } });

    if (calculation.hits.length > 0) {
      await tx.payrollHit.createMany({
        data: calculation.hits.map((hit) => toHitRow(record.id, hit)),
      });
    }
  }
}

function toHitRow(recordId: string, hit: QualifyingHit): Prisma.PayrollHitCreateManyInput {
  return {
    recordId,
    videoId: hit.videoId,
    videoTitle: hit.title,
    channelId: hit.channelId,
    channelName: hit.channelName,
    nicheId: hit.nicheId,
    nicheName: hit.nicheName,
    // The threshold and the count as they stood at this instant. Both move
    // afterwards — a niche's bar can be edited, a view counter only climbs —
    // and without the snapshot a bonus becomes unexplainable a month later.
    thresholdAtRun: hit.thresholdApplied,
    viewCountAtRun: BigInt(Math.max(0, Math.trunc(hit.views))),
    publishedAt: new Date(hit.publishedAtMs),
  };
}

// ---------------------------------------------------------------------------
// WRITE: payment
// ---------------------------------------------------------------------------

/**
 * Marks every pending record in a finalized period as paid.
 *
 * Refuses an open period. "Paid" is a claim that money left the account for a
 * particular set of figures, and a period that has not been frozen has no
 * figures to make that claim about.
 */
export async function markPeriodPaid(
  year: number,
  month: number,
  request?: Request,
): Promise<PayrollPeriodDTO> {
  await requirePermission("payroll.manage");
  const { organizationId } = await getScope();

  const period = periodForMonth(year, month);
  const label = periodLabel(period);

  const existing = await loadPeriodRow(organizationId, period);
  if (!existing) throw errors.notFound("payroll period");
  if (!isFrozen(existing.status)) {
    throw errors.invalidInput(
      `${label} has not been finalized yet. Finalize it first — marking an open period paid would record a payment against figures that are still moving.`,
    );
  }

  const paidAt = new Date();

  const marked = await prisma.$transaction(async (tx) => {
    const result = await tx.payrollRecord.updateMany({
      where: { periodId: existing.id, paymentStatus: "pending" },
      data: { paymentStatus: "paid", paidAt },
    });

    if (existing.status !== "paid") {
      await tx.payrollPeriod.update({ where: { id: existing.id }, data: { status: "paid" } });
    }

    return result.count;
  });

  // A repeat call finds nothing pending and no status to change. Staying silent
  // beats a log entry claiming an admin paid the same period twice.
  if (marked > 0 || existing.status !== "paid") {
    await auditPayroll(await actingAdmin(), request, {
      action: "payroll.period_paid",
      summary: `Marked ${label} payroll as paid (${marked} ${
        marked === 1 ? "payment" : "payments"
      })`,
      targetType: "payroll_period",
      targetId: periodKey(year, month),
      targetLabel: label,
      metadata: { year, month, recordsMarked: marked },
    });
  }

  return getPeriodForOrganization(organizationId, period);
}

/** One person's payment, for teams that pay in batches rather than all at once. */
export async function markRecordPaid(
  recordId: string,
  request?: Request,
): Promise<PayrollRecordDTO> {
  await requirePermission("payroll.manage");
  const { organizationId } = await getScope();

  const record = await loadScopedRecord(organizationId, recordId);
  const label = periodLabel(periodForMonth(record.period.year, record.period.month));

  // Already paid. Idempotent for the same reason finalize is: the caller gets
  // the state they asked for, without a second payment being recorded.
  if (record.paymentStatus === "paid") return toRecordDTO(record);

  await prisma.$transaction(async (tx) => {
    await tx.payrollRecord.update({
      where: { id: record.id },
      data: { paymentStatus: "paid", paidAt: new Date() },
    });

    // The period's status is a summary of its records, so it is derived here
    // rather than left for an admin to remember. A period whose last pending
    // record was just settled IS paid, and a history still calling it
    // "finalized" would send somebody hunting for a payment they already made.
    const stillPending = await tx.payrollRecord.count({
      where: { periodId: record.periodId, paymentStatus: "pending" },
    });
    if (stillPending === 0) {
      await tx.payrollPeriod.update({
        where: { id: record.periodId },
        data: { status: "paid" },
      });
    }
  });

  await auditPayroll(await actingAdmin(), request, {
    action: "payroll.record_paid",
    summary: `Marked ${record.employeeName}'s ${label} payroll as paid`,
    targetType: "payroll_record",
    targetId: record.id,
    targetLabel: record.employeeName,
    metadata: { year: record.period.year, month: record.period.month, userId: record.userId },
  });

  return toRecordDTO(await loadScopedRecord(organizationId, recordId));
}

// ---------------------------------------------------------------------------
// WRITE: adjustment
// ---------------------------------------------------------------------------

/**
 * The only way a finalized figure changes.
 *
 * Not an edit of the calculation: the base salary, the hit count and the bonus
 * stay exactly as the engine produced them, and the correction sits beside them
 * as its own signed line. That is what keeps the record legible — anyone
 * reading it later sees what was computed, what was added or removed by hand,
 * and why.
 *
 * The reason is mandatory and it is the substance of the audit entry. The
 * amount deliberately is not: audit entries are readable by anyone holding
 * `audit.view`, which is a wider group than the admins who may see pay.
 *
 * A RECORD ALREADY MARKED PAID MAY STILL BE ADJUSTED, UNDER ITS OWN KEY.
 * Refusing would be the tidier rule and the wrong one: "we underpaid them in
 * August, here is the correction" is a real business event, and a system that
 * refuses it only pushes the correction somewhere nobody can audit. But it is
 * not the same event as adjusting a figure that has not been paid yet. The
 * total moves after the money left, so the period's `paidMinor` moves with it
 * while `paidAt` goes on pointing at the transfer that actually happened, and
 * the difference has to be settled outside this system. That asymmetry is
 * recorded rather than smoothed over: the entry gets the distinct
 * `payroll.paid_record_adjusted` action, so "what changed after we paid it?" is
 * one filter rather than a reading of every adjustment's metadata.
 *
 * `paymentStatus` and `paidAt` are deliberately left alone. Rewinding either
 * would claim the payment never happened, and the schema note on
 * `payrollRecordPatchSchema` says why that is never this service's move.
 */
export async function adjustRecord(
  recordId: string,
  input: { adjustmentMinor: number; adjustmentReason: string },
  request?: Request,
): Promise<PayrollRecordDTO> {
  await requirePermission("payroll.manage");
  const { organizationId } = await getScope();

  const record = await loadScopedRecord(organizationId, recordId);
  const label = periodLabel(periodForMonth(record.period.year, record.period.month));

  // Re-checked here rather than trusted from the route's schema: this function
  // is exported, and a reasonless adjustment is the one thing it must not do.
  const reason = input.adjustmentReason.trim();
  if (reason.length < 3) {
    throw errors.invalidInput("Say why this payroll figure is being changed.");
  }

  // Read BEFORE the write, because the write does not change it — the record
  // stays paid — and this is what decides which of the two audit actions the
  // correction is recorded under.
  const afterPayment = record.paymentStatus === "paid";

  // Recomputed from the stored parts, never from the previous total: reading
  // the old total and nudging it would compound every earlier adjustment.
  const totalMinor = assertStorable(
    record.baseSalaryMinor + record.hitBonusMinor + input.adjustmentMinor,
    "payroll total",
  );

  await prisma.payrollRecord.update({
    where: { id: record.id },
    data: {
      adjustmentMinor: input.adjustmentMinor,
      adjustmentReason: reason,
      totalMinor,
    },
  });

  await auditPayroll(await actingAdmin(), request, {
    action: afterPayment ? "payroll.paid_record_adjusted" : "payroll.record_adjusted",
    // The summary is the line the audit list renders, so the post-payment case
    // says so there rather than only in a metadata flag nobody expands.
    summary: afterPayment
      ? `Adjusted ${record.employeeName}'s ${label} payroll AFTER it was marked paid — ${reason}`
      : `Adjusted ${record.employeeName}'s ${label} payroll — ${reason}`,
    targetType: "payroll_record",
    targetId: record.id,
    targetLabel: record.employeeName,
    metadata: {
      year: record.period.year,
      month: record.period.month,
      userId: record.userId,
      reason,
      // Not money, and not a duplicate of the action key either: `paidAt` is
      // when the transfer this correction now disagrees with was recorded.
      afterPayment,
      paidAt: record.paidAt?.toISOString() ?? null,
      // The amount is not here, and its absence is deliberate. It lives on the
      // PayrollRecord, behind payroll.view, next to the figures it changes.
    },
  });

  return toRecordDTO(await loadScopedRecord(organizationId, recordId));
}

// ---------------------------------------------------------------------------
// WRITE: the scheduled job's helper
// ---------------------------------------------------------------------------

export interface EnsuredPeriod {
  readonly year: number;
  readonly month: number;
  readonly status: PayrollPeriodStatus;
  readonly created: boolean;
}

/**
 * Makes sure the current month has a PayrollPeriod row, open.
 *
 * The row is not what makes a month calculable — an absent row already reads as
 * an open period everywhere in this service. It exists so the month appears in
 * the history the moment it starts, and so the notification job has something
 * stable to hang a `PayrollNotification` off.
 *
 * `organizationId` is an argument because the scheduled job runs without a
 * session. It comes from the job's own list of organizations, or from
 * `getScope()` — NEVER from a request body, which would let a caller open a
 * period in somebody else's workspace.
 *
 * CALLED FROM TWO PLACES, AND BOTH ARE NEEDED. The monthly cron opens the new
 * month the moment the old one is finalized, which is the path that matters for
 * a workspace nobody visits. `getCurrentPayroll` opens it too, because the cron
 * is not the only way a month starts: an organization created on the 3rd, a
 * scheduler that was down on the 1st, or a first deployment mid-month would all
 * otherwise leave the current period with no row until the following month.
 */
export async function ensureCurrentPeriodExists(
  options: {
    organizationId?: string;
    atMs?: number;
    request?: Request;
    /**
     * Who to name in the audit entry. Never a person, whichever caller wins the
     * race: opening a period is an automatic consequence of the calendar, and
     * attributing it to whichever admin's page load happened to notice would be
     * a lie in the one record that exists to prevent them. The default says so.
     */
    actorLabel?: string;
  } = {},
): Promise<EnsuredPeriod> {
  const organizationId = options.organizationId ?? (await getScope()).organizationId;
  const period = periodContaining(options.atMs ?? Date.now());
  const { year, month } = period;

  const existing = await loadPeriodRow(organizationId, period);
  if (existing) {
    return { year, month, status: toPeriodStatus(existing.status), created: false };
  }

  try {
    await prisma.payrollPeriod.create({
      data: {
        organizationId,
        year,
        month,
        startsAt: new Date(period.startsAtMs),
        endsAt: new Date(period.endsAtMs),
        payOn: new Date(payDateFor(period)),
        status: "open",
      },
    });
  } catch (error) {
    // The unique constraint on (organization, year, month) is the real guard
    // against two overlapping cron invocations. Losing that race means the row
    // exists — which is precisely what this function was asked to guarantee, so
    // it is a success rather than a failure.
    //
    // Anything else is rethrown. Reporting "the period is open" after a write
    // that genuinely failed would tell the scheduler a lie it has no way to
    // check, so the row is re-read before that claim is made.
    const raced = await loadPeriodRow(organizationId, period);
    if (!raced) throw error;
    return { year, month, status: toPeriodStatus(raced.status), created: false };
  }

  await recordAudit(
    {
      organizationId,
      // No actor, from either caller. Saying so is better than attributing a
      // system action to whoever happened to be signed in when it fired.
      actorUserId: null,
      actorLabel: options.actorLabel ?? "System",
      request: options.request ?? null,
    },
    {
      action: "payroll.period_opened",
      summary: `Opened the ${periodLabel(period)} payroll period`,
      targetType: "payroll_period",
      targetId: periodKey(year, month),
      targetLabel: periodLabel(period),
      metadata: { year, month },
    },
  );

  return { year, month, status: "open", created: true };
}

// ---------------------------------------------------------------------------
// INTERNALS: selects
// ---------------------------------------------------------------------------

const PERIOD_SELECT = {
  id: true,
  year: true,
  month: true,
  status: true,
  finalizedAt: true,
  finalizedById: true,
} as const;

type StoredPeriod = Prisma.PayrollPeriodGetPayload<{ select: typeof PERIOD_SELECT }>;

/** Money columns only — what a total is made of, without the hits behind it. */
const RECORD_TOTALS_SELECT = {
  hitCount: true,
  baseSalaryMinor: true,
  hitBonusMinor: true,
  adjustmentMinor: true,
  totalMinor: true,
  currency: true,
  paymentStatus: true,
} as const;

const RECORD_SELECT = {
  id: true,
  periodId: true,
  userId: true,
  employeeName: true,
  employeeEmail: true,
  roleAtRun: true,
  baseSalaryMinor: true,
  hitPaymentMinor: true,
  hitCount: true,
  hitBonusMinor: true,
  adjustmentMinor: true,
  adjustmentReason: true,
  totalMinor: true,
  currency: true,
  paymentStatus: true,
  paidAt: true,
  hits: {
    select: {
      videoId: true,
      videoTitle: true,
      channelId: true,
      channelName: true,
      nicheId: true,
      nicheName: true,
      thresholdAtRun: true,
      viewCountAtRun: true,
      publishedAt: true,
    },
    // Biggest first: the Shorts that earned the money are what somebody
    // querying their payslip opens the list to see.
    orderBy: { viewCountAtRun: "desc" },
  },
  period: { select: { year: true, month: true } },
} as const;

type StoredRecord = Prisma.PayrollRecordGetPayload<{ select: typeof RECORD_SELECT }>;

// ---------------------------------------------------------------------------
// INTERNALS: assembling a period
// ---------------------------------------------------------------------------

/**
 * Everything needed to render periods that is the same for all of them.
 *
 * Built once per request and threaded through, so listing two years of history
 * costs one query for the finalizers' names and one for the organization's
 * currency, rather than two per row.
 */
interface PeriodContext {
  readonly organizationId: string;
  /** Labels a run with no employees, where there is no record to take it from. */
  readonly fallbackCurrency: string;
  readonly actorNames: ReadonlyMap<string, string>;
}

async function buildContext(
  organizationId: string,
  rows: readonly (StoredPeriod | null)[],
): Promise<PeriodContext> {
  const finalizerIds = [
    ...new Set(rows.flatMap((row) => (row?.finalizedById ? [row.finalizedById] : []))),
  ];

  const [settings, actorNames] = await Promise.all([
    getOrgSettings(organizationId),
    resolveActorNames(organizationId, finalizerIds),
  ]);

  return { organizationId, fallbackCurrency: settings.baseCurrency, actorNames };
}

async function loadPeriodRow(
  organizationId: string,
  period: PayrollPeriodWindow,
): Promise<StoredPeriod | null> {
  return prisma.payrollPeriod.findUnique({
    where: {
      organizationId_year_month: {
        organizationId,
        year: period.year,
        month: period.month,
      },
    },
    select: PERIOD_SELECT,
  });
}

/**
 * The period with its per-employee rows: stored if frozen, calculated if not.
 *
 * This branch is what the whole service is built around, and every read passes
 * through it.
 */
async function buildPeriodDTO(
  context: PeriodContext,
  period: PayrollPeriodWindow,
  row: StoredPeriod | null,
): Promise<PayrollPeriodDTO> {
  const frozen = row !== null && isFrozen(row.status);

  const records = frozen
    ? await loadStoredRecords(row.id)
    : await calculateRecords(context.organizationId, period);

  return {
    ...buildHeader(context, period, row, !frozen),
    totals: totalsFrom(records, context.fallbackCurrency),
    records,
  };
}

/**
 * The same period without the per-employee rows.
 *
 * A frozen period's totals come from a narrow projection — money columns, no
 * hits — because a history list has no use for thousands of hit rows. An open
 * one still has to run the engine; there is nothing stored to sum.
 */
async function buildPeriodSummary(
  context: PeriodContext,
  period: PayrollPeriodWindow,
  row: StoredPeriod | null,
): Promise<PayrollPeriodSummaryDTO> {
  const frozen = row !== null && isFrozen(row.status);

  const sources: readonly PayrollTotalsSource[] = frozen
    ? (
        await prisma.payrollRecord.findMany({
          where: { periodId: row.id },
          select: RECORD_TOTALS_SELECT,
        })
      ).map((record) => ({ ...record, paymentStatus: toPaymentStatus(record.paymentStatus) }))
    : await calculateRecords(context.organizationId, period);

  return {
    ...buildHeader(context, period, row, !frozen),
    totals: totalsFrom(sources, context.fallbackCurrency),
  };
}

function buildHeader(
  context: PeriodContext,
  period: PayrollPeriodWindow,
  row: StoredPeriod | null,
  isDraft: boolean,
): PayrollPeriodHeaderDTO {
  return {
    year: period.year,
    month: period.month,
    label: periodLabel(period),
    // The window comes from the engine, not from the row. `periodForMonth` is
    // the definition of a period; a stored row only records that one was run.
    startsAt: period.startsAtMs,
    endsAt: period.endsAtMs,
    payOn: payDateFor(period),
    status: toPeriodStatus(row?.status ?? "open"),
    isDraft,
    hasEnded: Date.now() >= period.endsAtMs,
    finalizedAt: row?.finalizedAt?.getTime() ?? null,
    finalizedByName: row?.finalizedById
      ? (context.actorNames.get(row.finalizedById) ?? null)
      : null,
  };
}

/** The live run: the engine, over current view counts. */
async function calculateRecords(
  organizationId: string,
  period: PayrollPeriodWindow,
): Promise<readonly PayrollRecordDTO[]> {
  const inputs = await loadPayrollInputs(organizationId, period);
  const run = calculatePayrollRun({
    employees: inputs.employees,
    shorts: inputs.shorts,
    niches: inputs.niches,
    period,
    organizationDefaultThreshold: inputs.organizationDefaultThreshold,
  });
  return run.calculations.map(toDraftRecordDTO);
}

async function loadStoredRecords(periodId: string): Promise<readonly PayrollRecordDTO[]> {
  const rows = await prisma.payrollRecord.findMany({
    where: { periodId },
    select: RECORD_SELECT,
  });

  // The same ordering the engine produces for a draft — highest paid first,
  // then by name — so a period does not reshuffle the moment it is finalized.
  return rows
    .map(toRecordDTO)
    .sort((a, b) => b.totalMinor - a.totalMinor || a.employeeName.localeCompare(b.employeeName));
}

/**
 * A calculated line, which has no row behind it yet.
 *
 * `id: null` is what tells the client this figure cannot be adjusted or marked
 * paid: both address a stored record, and there is not one.
 */
function toDraftRecordDTO(calculation: PayrollCalculation): PayrollRecordDTO {
  return {
    id: null,
    userId: calculation.userId,
    employeeName: calculation.name,
    employeeEmail: calculation.email,
    role: calculation.role,
    roleLabel: roleDefinition(calculation.role).label,
    baseSalaryMinor: calculation.baseSalaryMinor,
    hitPaymentMinor: calculation.hitPaymentMinor,
    hitCount: calculation.hitCount,
    hitBonusMinor: calculation.hitBonusMinor,
    // A draft has no adjustment by definition: an adjustment corrects a frozen
    // figure, and nothing here is frozen yet.
    adjustmentMinor: 0,
    adjustmentReason: null,
    totalMinor: calculation.totalMinor,
    currency: calculation.currency,
    paymentStatus: "pending",
    paidAt: null,
    byNiche: calculation.byNiche.map((line) => ({
      nicheId: line.nicheId,
      nicheName: line.nicheName,
      thresholdApplied: line.thresholdApplied,
      hitCount: line.hitCount,
      // The rate lives on the employee, not the niche line. Attached here so
      // the client never has to reach back up the object to explain a bonus.
      hitPaymentMinor: calculation.hitPaymentMinor,
      bonusMinor: line.bonusMinor,
    })),
    hits: calculation.hits.map((hit) => ({
      videoId: hit.videoId,
      videoTitle: hit.title,
      channelId: hit.channelId,
      channelName: hit.channelName,
      nicheId: hit.nicheId,
      nicheName: hit.nicheName,
      thresholdAtRun: hit.thresholdApplied,
      viewCountAtRun: hit.views,
      publishedAt: hit.publishedAtMs,
    })),
  };
}

function toRecordDTO(record: StoredRecord): PayrollRecordDTO {
  const hits: PayrollHitDTO[] = record.hits.map((hit) => ({
    videoId: hit.videoId,
    videoTitle: hit.videoTitle,
    channelId: hit.channelId,
    channelName: hit.channelName,
    nicheId: hit.nicheId,
    nicheName: hit.nicheName,
    thresholdAtRun: hit.thresholdAtRun,
    // BigInt cannot be serialised to JSON. Converted once, here, at the edge.
    viewCountAtRun: Number(hit.viewCountAtRun),
    publishedAt: hit.publishedAt.getTime(),
  }));

  return {
    id: record.id,
    userId: record.userId,
    employeeName: record.employeeName,
    employeeEmail: record.employeeEmail,
    role: record.roleAtRun,
    // Labelled from the role as it was at the run, not as it is now. A promoted
    // editor's August record should still say what they were paid as.
    roleLabel: roleDefinition(record.roleAtRun).label,
    baseSalaryMinor: record.baseSalaryMinor,
    hitPaymentMinor: record.hitPaymentMinor,
    hitCount: record.hitCount,
    hitBonusMinor: record.hitBonusMinor,
    adjustmentMinor: record.adjustmentMinor,
    adjustmentReason: record.adjustmentReason,
    totalMinor: record.totalMinor,
    currency: record.currency,
    paymentStatus: toPaymentStatus(record.paymentStatus),
    paidAt: record.paidAt?.getTime() ?? null,
    // Rebuilt from the stored hits rather than stored separately. The hits are
    // the evidence; a per-niche summary that could drift from them would be a
    // second, weaker source of truth for the same number.
    byNiche: groupHitsByNiche(hits, record.hitPaymentMinor),
    hits,
  };
}

/**
 * Per-niche lines from a list of hits.
 *
 * Deliberately mirrors the engine's own grouping — same shape, same ordering —
 * so a finalized period and a draft render identically. A stored hit's niche id
 * can be null (the niche was deleted since), which is why the name is the
 * fallback key: two hits credited to a since-deleted "GTA" still belong on one
 * line.
 */
function groupHitsByNiche(
  hits: readonly PayrollHitDTO[],
  hitPaymentMinor: number,
): PayrollNicheLineDTO[] {
  const buckets = new Map<
    string,
    { nicheId: string | null; nicheName: string; thresholdApplied: number; hitCount: number }
  >();

  for (const hit of hits) {
    const key = hit.nicheId ?? `name:${hit.nicheName}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.hitCount += 1;
    } else {
      buckets.set(key, {
        nicheId: hit.nicheId,
        nicheName: hit.nicheName,
        thresholdApplied: hit.thresholdAtRun,
        hitCount: 1,
      });
    }
  }

  return [...buckets.values()]
    .map((bucket) => ({
      nicheId: bucket.nicheId,
      nicheName: bucket.nicheName,
      thresholdApplied: bucket.thresholdApplied,
      hitCount: bucket.hitCount,
      hitPaymentMinor,
      bonusMinor: bucket.hitCount * hitPaymentMinor,
    }))
    .sort((a, b) => b.bonusMinor - a.bonusMinor || a.nicheName.localeCompare(b.nicheName));
}

function totalsFrom(
  records: readonly PayrollTotalsSource[],
  fallbackCurrency: string,
): PayrollTotalsDTO {
  let hitCount = 0;
  let baseSalaryMinor = 0;
  let hitBonusMinor = 0;
  let adjustmentMinor = 0;
  let totalMinor = 0;
  let paidMinor = 0;
  let pendingMinor = 0;
  const currencies = new Set<string>();

  for (const record of records) {
    hitCount += record.hitCount;
    baseSalaryMinor += record.baseSalaryMinor;
    hitBonusMinor += record.hitBonusMinor;
    adjustmentMinor += record.adjustmentMinor;
    totalMinor += record.totalMinor;
    if (record.paymentStatus === "paid") paidMinor += record.totalMinor;
    else pendingMinor += record.totalMinor;
    currencies.add(record.currency);
  }

  return {
    employeeCount: records.length,
    hitCount,
    baseSalaryMinor,
    hitBonusMinor,
    adjustmentMinor,
    totalMinor,
    paidMinor,
    pendingMinor,
    // An empty run still needs a currency to label its zero with, and the
    // organization's base currency is the only defensible answer.
    currency: records[0]?.currency ?? fallbackCurrency,
    currencyMixed: currencies.size > 1,
  };
}

// ---------------------------------------------------------------------------
// INTERNALS: scoped reads, guards, audit
// ---------------------------------------------------------------------------

/** "finalized" and "paid" both mean the figures are stored, not derived. */
function isFrozen(status: string): boolean {
  return status === "finalized" || status === "paid";
}

function toPeriodStatus(status: string): PayrollPeriodStatus {
  // Anything unrecognised reads as open, which is the state that recalculates.
  // A stale status string must never be mistaken for a frozen document.
  return status === "finalized" || status === "paid" ? status : "open";
}

function toPaymentStatus(status: string): PayrollPaymentStatus {
  return status === "paid" ? "paid" : "pending";
}

/** Stable, sortable identifier for a period in the audit log: "2025-08". */
function periodKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * A record, reached only through its period's organization.
 *
 * PayrollRecord carries no `organizationId` of its own — it hangs off the
 * period, which does. Filtering on that relation is therefore the entire
 * tenancy check, and an id belonging to another workspace has to read as "not
 * found" rather than as somebody else's salary.
 */
async function loadScopedRecord(
  organizationId: string,
  recordId: string,
): Promise<StoredRecord> {
  const record = await prisma.payrollRecord.findFirst({
    where: { id: recordId, period: { organizationId } },
    select: RECORD_SELECT,
  });
  if (!record) throw errors.notFound("payroll record");
  return record;
}

/**
 * Names for the people who finalized periods.
 *
 * `finalizedById` is a plain column rather than a relation — the same choice
 * PayrollRecord makes about `userId`, for the same reason — so the names are
 * looked up separately and fall back to null when the account is gone. Scoped
 * to the organization, so an id from elsewhere resolves to nothing instead of
 * disclosing a name.
 */
async function resolveActorNames(
  organizationId: string,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (userIds.length === 0) return new Map();

  const members = await prisma.organizationMember.findMany({
    where: { organizationId, userId: { in: [...userIds] } },
    select: { userId: true, user: { select: { name: true, email: true } } },
  });

  const names = new Map<string, string>();
  for (const member of members) {
    const name = member.user.name ?? member.user.email;
    if (name) names.set(member.userId, name);
  }
  return names;
}

/**
 * Keeps a figure inside the column it is about to be written to.
 *
 * PayrollRecord's money columns are Prisma `Int` — signed 32-bit on both
 * supported databases, so roughly ±$21.5m per row. A salary that large is a
 * typo, but without this the driver would either throw something unreadable
 * or, on SQLite, quietly store a different number. Failing with a sentence
 * beats both.
 */
function assertStorable(minor: number, what: string): number {
  if (!Number.isSafeInteger(minor) || Math.abs(minor) > MAX_MONEY_MINOR) {
    throw errors.invalidInput(
      `That ${what} is too large to record. Check the pay configuration for this employee.`,
    );
  }
  return minor;
}

/**
 * Who did it, for the log.
 *
 * Taken as a parameter rather than read from the session, because the scheduled
 * run has no session and attributing its work to whichever admin signed in last
 * would be a lie in the one record that exists to prevent them.
 */
interface AuditingActor {
  readonly organizationId: string;
  readonly actorUserId: string | null;
  readonly actorLabel: string | null;
}

/** The auditing actor for a request that came from a signed-in admin. */
async function actingAdmin(): Promise<AuditingActor> {
  const { organizationId, actor } = await getScope();
  return {
    organizationId,
    actorUserId: actor.userId,
    actorLabel: actor.name ?? actor.email,
  };
}

async function auditPayroll(
  who: AuditingActor,
  request: Request | undefined,
  payload: {
    action: AuditAction;
    summary: string;
    targetType: string;
    targetId: string;
    targetLabel?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await recordAudit(
    {
      organizationId: who.organizationId,
      actorUserId: who.actorUserId,
      actorLabel: who.actorLabel,
      // Passed on every payroll write. Which actions deserve an IP is the audit
      // module's decision, not this file's — adding one to that list must not
      // require coming back here.
      request,
    },
    payload,
  );
}
