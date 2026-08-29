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
import { formatHitWindow, missingHitRuleHalf, type MissingHitRuleHalf } from "@/lib/analytics/hit-rate";
import {
  calculateEmployeePayroll,
  calculatePayrollRun,
  payDateFor,
  periodContaining,
  periodForMonth,
  periodLabel,
  previousPeriod,
  type PayrollCalculation,
  type PayrollPeriodWindow,
  type QualifyingHit,
  type SkippedNiche,
  type UnresolvedShorts,
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
 * A HIT IS PAID IN THE PERIOD IT RESOLVES, NOT THE ONE IT WAS PUBLISHED IN
 * The engine's note explains why. What lands in this file is the consequence: a
 * period's records can credit Shorts published before it started — a Short
 * published on 28 December under a seven-day rule resolves on 4 January and is
 * January's to pay. That is correct, and it is surfaced rather than left to be
 * discovered: `PayrollHitDTO` carries `windowClosesAt` beside `publishedAt` so
 * the payroll screen can say "published 28 Dec, resolved 4 Jan" instead of
 * showing a December date on a January run and reading as a bug.
 *
 * NOTHING ALREADY FINALIZED MOVES UNDER THE NEW DEFINITION EITHER
 * Every period finalized before this change was computed by comparing lifetime
 * views to a bar, and every one of those figures stands exactly as it is. They
 * are documents; `buildPeriodDTO` reads them back rather than recomputing them,
 * which is the same branch that has always protected them. The windowed rule
 * applies to runs computed from here on. A frozen figure somebody decides was
 * wrong is corrected the way every other one is: an `adjustRecord` carrying a
 * reason, on one person's record.
 *
 * The single sanctioned exception is `adjustRecord`, which is why it demands a
 * reason and gets audit actions of its own — two of them, because correcting a
 * figure before it is paid and correcting one after the money left are
 * different events to have to find again.
 *
 * AN UNCONFIGURED NICHE PAYS NOTHING, AND THAT CHANGE IS NOT RETROACTIVE
 * A niche with no `hitThreshold` produces no hits, in payroll as everywhere
 * else — the engine's own note says why. Two consequences land in this file.
 *
 * First, the reduction is announced: a run reports `skippedNiches` — which
 * niches had no bar and how many Shorts that left unjudged — the draft period
 * carries it to the screen an admin reads before finalizing, and the
 * finalization's audit entry carries it into the record, in its summary and its
 * metadata. PayrollRecord has no column for it and the schema is not ours to
 * change, so the audit entry is where the reason survives the run.
 *
 * Second, NOTHING ALREADY FINALIZED MOVES. A frozen period is read back from
 * storage, and the branch in `buildPeriodDTO` is the only thing deciding that —
 * so a period finalized under the old organization-default fallback keeps every
 * figure it was finalized with, hits included. Those bonuses were paid; they
 * are documents now. The new rule applies to runs computed from here on, and a
 * frozen figure that somebody decides was wrong is corrected the way every
 * other one is: an `adjustRecord` carrying a reason, on one person's record.
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
  /**
   * The clock half of the rule these hits were judged under.
   *
   * Null on a record finalized before windows existed, and on one whose stored
   * evaluations have since been removed — see `hydrateStoredHitWindows`. Null
   * means "not recorded", never "no window": a line with a threshold and no
   * window is a line from the old lifetime rule, and printing a made-up 7 there
   * would misdescribe what was actually paid.
   */
  readonly windowHoursApplied: number | null;
  readonly hitCount: number;
  /** The employee's per-hit rate, in minor units. */
  readonly hitPaymentMinor: number;
  readonly bonusMinor: number;
}

/**
 * A niche that had Shorts in it and no usable rule to judge them by.
 *
 * The engine's `SkippedNiche` as it crosses the wire — the same four fields,
 * restated here so a client is not importing the engine's own vocabulary.
 *
 * WHY A PAYROLL RUN REPORTS THIS AT ALL. A niche without a complete rule
 * produces no hits, which is correct and is what the rest of the product
 * already says. But it also means somebody is paid less than they would have
 * been, for a reason that is a configuration gap rather than their work. A
 * reduction with no reason attached is the failure this DTO exists to prevent:
 * an admin sees which niches and how many Shorts before they finalize, and the
 * same figures go into the audit entry so the reason survives the run.
 *
 * `missing` is new and is the reason this mechanism was extended rather than
 * duplicated. A niche can now be unscoreable in three ways — no threshold, no
 * window, or neither — and they are three different fields to go and fill in.
 * A notice that said only "unconfigured" would make an admin hunt for which.
 */
export interface PayrollSkippedNicheDTO {
  readonly nicheId: string;
  readonly nicheName: string;
  /** Which half of the rule is absent: the bar, the clock, or both. */
  readonly missing: MissingHitRuleHalf;
  /** Distinct Shorts in this niche that no rule could judge. */
  readonly shortCount: number;
}

/**
 * Shorts that resolved into this period and earned nothing in it.
 *
 * The engine's `UnresolvedShorts` as it crosses the wire. The counts stay apart
 * all the way to the screen because they call for different reactions: a
 * pending Short is a wait, an unknown one is a loss, and an already-paid one is
 * neither — it is a bonus sitting on an earlier payslip. See the engine's note.
 */
export interface PayrollUnresolvedDTO {
  readonly pendingCount: number;
  readonly unknownCount: number;
  readonly alreadyPaidCount: number;
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
  /**
   * The window in force when this hit was judged, in hours.
   *
   * The other half of `thresholdAtRun`, and it exists for the same reason:
   * "500,000 views" is not a rule and "500,000 views within 7 days" is, so a
   * bonus explained by the bar alone is not explained. Null when it could not
   * be recovered — see `hydrateStoredHitWindows`.
   */
  readonly windowHoursApplied: number | null;
  /**
   * When this Short's window shut, which is when it resolved and therefore why
   * it is on THIS period's run.
   *
   * The field that makes a December publish date on a January run legible
   * rather than alarming. Null alongside a null `windowHoursApplied`, for the
   * same reason.
   */
  readonly windowClosesAt: number | null;
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
  /**
   * Niches this run could not judge, and how many Shorts that left uncounted.
   *
   * ONLY EVER POPULATED FOR A DRAFT, and deliberately so. A finalized period is
   * read back from storage rather than recalculated, and PayrollRecord has no
   * column for this — inventing one by re-running the engine over today's
   * niches would be exactly the retroactive recalculation the rest of this file
   * refuses. The reason a frozen run skipped something lives in its
   * `payroll.period_finalized` audit entry, written at the moment it was true.
   *
   * Empty is the ordinary case: every niche somebody is assigned to has a
   * complete rule, so nothing was skipped.
   */
  readonly skippedNiches: readonly PayrollSkippedNicheDTO[];
  /**
   * Shorts resolving into this period that have not earned yet, split into the
   * ones that still might and the ones that never will.
   *
   * ZEROES FOR A FROZEN PERIOD, for the same reason `skippedNiches` is empty:
   * nothing is stored and re-deriving it from today's data would be a claim
   * about a document that cannot move.
   *
   * `pendingCount` is structurally zero for any period that has ended, and that
   * is worth knowing rather than surprising: a window closing inside the period
   * has necessarily closed once the period is over, so "pending" only ever
   * appears on the month in progress. By the time an admin can finalize, every
   * wait has turned into a hit, a miss or an unknown.
   */
  readonly unresolved: PayrollUnresolvedDTO;
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
// READ: your own earnings
//
// The one thing in this file an employee can reach. Everything above is
// `payroll.view` — the whole company's pay in one table — and nothing below
// this block may ever be wired to `earnings.view_own`.
//
// THE OWNERSHIP GUARANTEE
// `getMyEarnings` takes a period and nothing else. There is no `userId`
// parameter to pass, no field on the options object to set, and no schema key
// that would accept one, so a query string or a request body has nothing to
// aim at. The subject is read once, from `getScope()`, which resolves the
// session cookie. Adding a way to ask about somebody else would mean adding a
// parameter — a visible change to a signature this comment sits on, not a
// forgotten `??` in a where clause.
// ---------------------------------------------------------------------------

/** Which window the employee asked about. Never *whose* window. */
export type EarningsPeriodKind = "current" | "previous" | "custom";

export interface EarningsPeriodSelection {
  readonly kind: EarningsPeriodKind;
  /** Custom only. Inclusive. */
  readonly startsAtMs?: number;
  /** Custom only. Exclusive, like every other window here. */
  readonly endsAtMs?: number;
}

/**
 * A custom range is capped at two years.
 *
 * The Shorts query underneath is bounded by `publishedAt`, so an unbounded
 * range is a table scan over every Short the organization has ever owned, run
 * from an endpoint every employee holds. Two years is longer than any pay
 * question anybody actually asks and short enough to stay an indexed read.
 */
const MAX_CUSTOM_RANGE_MS = 731 * 24 * 60 * 60 * 1000;

/**
 * Where the bar a hit was judged against came from.
 *
 *   "niche"        — the niche sets its own `hitThreshold`. There is a bar, and
 *                    this is it.
 *   "unconfigured" — the niche's rule is incomplete: no threshold, no window,
 *                    or neither. Nothing in it can be a hit. `thresholdApplied`
 *                    is null when the bar is what is missing, because there is
 *                    genuinely no number to print, and `ruleMissing` says which
 *                    half it is. This used to read "organization", meaning the
 *                    org default had been substituted — which paid bonuses
 *                    against a bar nobody had chosen. Worth saying out loud on
 *                    a payslip: "0 hits" and "nobody has told us what a hit
 *                    means here" look identical and are completely different
 *                    problems.
 *   "as_finalized" — a frozen record. The threshold is the number recorded at
 *                    the run; where it came from is not stored, and guessing
 *                    from today's configuration would be a lie about a document
 *                    whose whole value is that it cannot move.
 */
export type EarningsThresholdSource = "niche" | "unconfigured" | "as_finalized";

export interface MyEarningsNicheLineDTO {
  readonly nicheId: string | null;
  readonly nicheName: string;
  /**
   * Null only for "unconfigured", where there is no bar to state.
   *
   * A zero would be worse than useless here — it reads as "every Short is a
   * hit" — and the organization default would be the original bug wearing a
   * different label.
   */
  readonly thresholdApplied: number | null;
  /**
   * The clock half of the rule, in hours. Null when the niche has no window, or
   * when a frozen record could not have it recovered.
   */
  readonly windowHoursApplied: number | null;
  readonly thresholdSource: EarningsThresholdSource;
  /**
   * Which half of the rule this niche is missing, or null when it has both.
   *
   * Always null for "as_finalized": what today's configuration lacks says
   * nothing about a figure that was settled months ago.
   */
  readonly ruleMissing: MissingHitRuleHalf | null;
  readonly hitCount: number;
  /** The employee's own per-hit rate, in minor units. */
  readonly hitPaymentMinor: number;
  readonly bonusMinor: number;
}

export interface MyEarningsPeriodDTO {
  readonly kind: EarningsPeriodKind;
  /** "August 2025", or "2025-08-01 to 2025-08-14" for a custom range. */
  readonly label: string;
  readonly startsAt: number;
  /** Exclusive. */
  readonly endsAt: number;
  readonly hasEnded: boolean;
}

export interface MyEarningsDTO {
  readonly period: MyEarningsPeriodDTO;

  /**
   * Whether this figure is settled.
   *
   *   "finalized" — read verbatim from the stored PayrollRecord. This is what
   *                 was owed; nothing recalculates it.
   *   "estimate"  — the engine, run just now against view counts that are still
   *                 moving. It will change, and the UI must say so.
   */
  readonly basis: "finalized" | "estimate";
  /** Null for a custom range, which is not a payroll period and never will be. */
  readonly periodStatus: PayrollPeriodStatus | null;
  readonly paymentStatus: PayrollPaymentStatus | null;
  readonly paidAt: number | null;

  /** False when the caller has no EmployeeProfile — they are not on payroll. */
  readonly onPayroll: boolean;

  readonly baseSalaryMinor: number;
  readonly hitPaymentMinor: number;
  readonly hitCount: number;
  readonly hitBonusMinor: number;
  /**
   * An administrator's correction to a frozen figure, with its reason.
   *
   * Shown rather than hidden because the alternative is a total that does not
   * equal base + bonus and cannot be explained — the exact unaccountable number
   * the rest of this service exists to avoid. It is the employee's own pay, and
   * the reason was written to justify a change to it.
   */
  readonly adjustmentMinor: number;
  readonly adjustmentReason: string | null;
  readonly totalMinor: number;
  readonly currency: string;

  readonly byNiche: readonly MyEarningsNicheLineDTO[];
  readonly hits: readonly PayrollHitDTO[];

  /**
   * Their own Shorts that could not be counted, and the niches responsible.
   *
   * Empty on a finalized record: that figure is a document, and what today's
   * configuration would have skipped says nothing about what was owed then.
   */
  readonly skippedNiches: readonly PayrollSkippedNicheDTO[];

  /**
   * Their own Shorts resolving into this period with no bonus yet.
   *
   * `pendingCount` will still earn — the window is open and the estimate can go
   * up before the month is finalized. `unknownCount` never will: the window
   * shut while nothing was being recorded and the Short is over the bar today,
   * so there is no way to say whether it got there in time. Told apart on the
   * payslip because "wait for the 1st" and "this one is gone" are the two
   * different things a zero can mean.
   *
   * Zeroes on a finalized record, like `skippedNiches`, and for the same
   * reason.
   */
  readonly unresolved: PayrollUnresolvedDTO;

  /**
   * True when this person is on niches but NONE of them has a usable rule.
   *
   * The state requirement 3 of the brief is about. It is not "you earned
   * nothing": no hit could be counted for them at all, so the bonus is zero for
   * a reason nobody at their level can act on. Computed on the server rather
   * than derived from `byNiche` on each screen, because it decides the headline
   * sentence and a headline derived independently in two places is a headline
   * that eventually disagrees with the rows under it.
   */
  readonly noMeasurableNiche: boolean;

  /**
   * Why the figure is what it is, in plain English.
   *
   * Never empty when the bonus is zero. "0 hits" is a fact with at least five
   * different causes — no niche assignments, no per-hit rate, no threshold of
   * its own, not employed yet, genuinely nothing cleared the bar — and an
   * employee reading a zero is owed the one that applies to them rather than
   * being left to guess or to ask an admin.
   */
  readonly notices: readonly string[];
}

/**
 * The query for GET /api/me/earnings.
 *
 * `.strict()` is the load-bearing part. The route builds the object from three
 * named parameters, so nothing else can arrive — and if a future edit widened
 * it to pass the whole query object through, a stray `userId` would be a parse
 * error here rather than a field somebody downstream might read.
 */
const myEarningsQuerySchema = z
  .object({
    period: z.enum(["current", "previous", "custom"]).default("current"),
    startsAt: z.coerce.number().int().optional(),
    endsAt: z.coerce.number().int().optional(),
  })
  .strict();

/** Turns raw query parameters into a selection, or a 400. */
export function parseMyEarningsPeriod(raw: {
  readonly period?: string | null;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
}): EarningsPeriodSelection {
  // Absent parameters arrive as null from URLSearchParams; Zod's `.default()`
  // and `.optional()` both key off `undefined`, and `Number(null)` is 0, so
  // normalising here is what stops a missing parameter becoming 1 Jan 1970.
  const parsed = myEarningsQuerySchema.safeParse({
    period: raw.period ?? undefined,
    startsAt: raw.startsAt ?? undefined,
    endsAt: raw.endsAt ?? undefined,
  });

  if (!parsed.success) {
    throw errors.invalidInput("That is not a period this screen can show.");
  }

  const { period, startsAt, endsAt } = parsed.data;

  if (period !== "custom") {
    if (startsAt !== undefined || endsAt !== undefined) {
      throw errors.invalidInput(
        "A date range only applies to a custom period. Send period=custom, or drop the dates.",
      );
    }
    return { kind: period };
  }

  if (startsAt === undefined || endsAt === undefined) {
    throw errors.invalidInput("A custom period needs both a start and an end date.");
  }
  if (endsAt <= startsAt) {
    throw errors.invalidInput("The end of a custom period must come after its start.");
  }
  if (endsAt - startsAt > MAX_CUSTOM_RANGE_MS) {
    throw errors.invalidInput("A custom period can cover at most two years.");
  }

  const startYear = new Date(startsAt).getUTCFullYear();
  const endYear = new Date(endsAt).getUTCFullYear();
  if (
    !Number.isFinite(startYear) ||
    !Number.isFinite(endYear) ||
    startYear < MIN_PERIOD_YEAR ||
    endYear > MAX_PERIOD_YEAR
  ) {
    throw errors.invalidInput("That date range is outside the years this app covers.");
  }

  return { kind: "custom", startsAtMs: startsAt, endsAtMs: endsAt };
}

/**
 * What the signed-in employee earned in one period.
 *
 * Reuses the payroll engine rather than approximating it: the same
 * `calculateEmployeePayroll` the admin run calls, over inputs gathered by the
 * same `loadPayrollInputs`, narrowed to one person. So the number here and the
 * number on the payroll screen are the same number — if they could differ, one
 * of them would be wrong and the employee would have no way to tell which.
 *
 * A finalized period does not run the engine at all. It returns the stored
 * PayrollRecord, because that is what was actually owed, and a recalculation
 * against today's view counts would quietly contradict a payslip.
 */
export async function getMyEarnings(options: {
  readonly period: EarningsPeriodSelection;
}): Promise<MyEarningsDTO> {
  // The backstop behind the route's own check. `earnings.view_own`, never
  // `payroll.view` — this function must stay reachable by an ordinary employee
  // and must never become a way to read anybody else.
  await requirePermission("earnings.view_own");

  // THE SUBJECT, RESOLVED ONCE, FROM THE SESSION. `options` carries a window
  // and nothing else; there is no identity anywhere in this function's inputs.
  const { organizationId, userId } = await getScope();

  const window = resolveEarningsWindow(options.period);

  // A calendar month can be finalized. A custom range is not a payroll period
  // and cannot be, so it never looks for a row to freeze against.
  const row =
    options.period.kind === "custom" ? null : await loadPeriodRow(organizationId, window);

  if (row && isFrozen(row.status)) {
    const stored = await prisma.payrollRecord.findFirst({
      // Both halves matter. `userId` is the ownership filter; `period` re-states
      // the organization even though `row.id` was already resolved inside it,
      // so the scope survives any future refactor of how the row arrives.
      where: { periodId: row.id, userId, period: { organizationId } },
      select: RECORD_SELECT,
    });

    if (stored) {
      // The rule each of these hits was judged under, recovered for display.
      // The figures themselves are read verbatim and are not touched by it —
      // see `loadHitWindowsForRecords`.
      const windows = await loadHitWindowsForRecords(organizationId, [stored]);
      return fromStoredRecord(window, options.period.kind, row.status, stored, windows);
    }

    // Finalized, but this person has no line in it: they were not employed
    // during the month, or had no employee profile when it was frozen. Saying
    // so is the point — a silent zero would read as "you earned nothing".
    return await emptyEarnings(organizationId, window, options.period.kind, {
      basis: "finalized",
      periodStatus: toPeriodStatus(row.status),
      notices: [
        `${window.label} is finalized and you have no record in it, so nothing was owed to you for that period.`,
      ],
    });
  }

  return calculateMyEarnings(organizationId, userId, window, options.period.kind, row);
}

/** The window an employee asked for, as the engine understands windows. */
interface EarningsWindow extends PayrollPeriodWindow {
  readonly label: string;
}

function resolveEarningsWindow(selection: EarningsPeriodSelection): EarningsWindow {
  if (selection.kind === "custom") {
    // `startsAtMs`/`endsAtMs` are guaranteed present by `parseMyEarningsPeriod`;
    // the fallbacks exist only to keep this total for a hand-built selection.
    const startsAtMs = selection.startsAtMs ?? Date.now();
    const endsAtMs = selection.endsAtMs ?? Date.now();
    const start = new Date(startsAtMs);

    return {
      // Carried for shape only. NOTHING looks a period row up from a custom
      // range — `getMyEarnings` short-circuits that above — so these two fields
      // never address a month. The engine reads only the millisecond bounds.
      year: start.getUTCFullYear(),
      month: start.getUTCMonth() + 1,
      startsAtMs,
      endsAtMs,
      label: `${isoDay(startsAtMs)} to ${isoDay(endsAtMs - 1)}`,
    };
  }

  const current = periodContaining(Date.now());
  const period = selection.kind === "previous" ? previousPeriod(current) : current;
  return { ...period, label: periodLabel(period) };
}

function isoDay(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

/** The live estimate: the engine, over current view counts, for one person. */
async function calculateMyEarnings(
  organizationId: string,
  userId: string,
  window: EarningsWindow,
  kind: EarningsPeriodKind,
  row: StoredPeriod | null,
): Promise<MyEarningsDTO> {
  const periodStatus = kind === "custom" ? null : toPeriodStatus(row?.status ?? "open");

  const inputs = await loadPayrollInputs(organizationId, window, { onlyUserId: userId });
  const employee = inputs.employees[0];

  if (!employee) {
    return await emptyEarnings(organizationId, window, kind, {
      basis: "estimate",
      periodStatus,
      notices: [
        "You do not have an employee profile yet, so no pay is calculated for you. An administrator sets one up under Admin → Employees.",
      ],
    });
  }

  const calculation = calculateEmployeePayroll({
    employee,
    shorts: inputs.shorts,
    niches: inputs.niches,
    period: window,
    nowMs: Date.now(),
  });

  const byNiche = buildAssignedNicheLines(employee, inputs.niches, calculation.byNiche);

  // "On niches, and not one of them has a usable rule." Deliberately not the
  // same test as `skippedNiches.length > 0`: somebody can have one configured
  // niche and one half-configured one, which is a partial loss to mention
  // rather than the total blank this flag turns the page into.
  const noMeasurableNiche =
    byNiche.length > 0 && byNiche.every((line) => line.thresholdSource === "unconfigured");

  return {
    period: toPeriodDTO(window, kind),
    basis: "estimate",
    periodStatus,
    // A draft has no payment: there is no record to mark paid.
    paymentStatus: null,
    paidAt: null,
    onPayroll: true,
    baseSalaryMinor: calculation.baseSalaryMinor,
    hitPaymentMinor: calculation.hitPaymentMinor,
    hitCount: calculation.hitCount,
    hitBonusMinor: calculation.hitBonusMinor,
    adjustmentMinor: 0,
    adjustmentReason: null,
    totalMinor: calculation.totalMinor,
    currency: calculation.currency,
    byNiche,
    hits: calculation.hits.map((hit) => ({
      videoId: hit.videoId,
      videoTitle: hit.title,
      channelId: hit.channelId,
      channelName: hit.channelName,
      nicheId: hit.nicheId,
      nicheName: hit.nicheName,
      thresholdAtRun: hit.thresholdApplied,
      windowHoursApplied: hit.windowHoursApplied,
      windowClosesAt: hit.windowClosesAtMs,
      viewCountAtRun: hit.views,
      publishedAt: hit.publishedAtMs,
    })),
    skippedNiches: calculation.skippedNiches.map(toSkippedNicheDTO),
    unresolved: toUnresolvedDTO(calculation.unresolved),
    noMeasurableNiche,
    notices: estimateNotices(window, employee, calculation, byNiche, noMeasurableNiche),
  };
}

/** The engine's report, as it crosses the wire. Field-for-field. */
function toSkippedNicheDTO(skipped: SkippedNiche): PayrollSkippedNicheDTO {
  return {
    nicheId: skipped.nicheId,
    nicheName: skipped.nicheName,
    missing: skipped.missing,
    shortCount: skipped.shortCount,
  };
}

/** The engine's unresolved tally, as it crosses the wire. Field-for-field. */
function toUnresolvedDTO(unresolved: UnresolvedShorts): PayrollUnresolvedDTO {
  return {
    pendingCount: unresolved.pendingCount,
    unknownCount: unresolved.unknownCount,
    alreadyPaidCount: unresolved.alreadyPaidCount,
  };
}

/** A period that stored nothing about what it could not judge. */
const NO_UNRESOLVED: PayrollUnresolvedDTO = {
  pendingCount: 0,
  unknownCount: 0,
  alreadyPaidCount: 0,
};

/**
 * One line per niche the person is ASSIGNED to, not one per niche that paid.
 *
 * The engine's own breakdown lists only niches that produced a hit, which is
 * right for an admin comparing totals and wrong here: an employee looking at
 * their bonus needs to see the niche that earned them nothing, and why. A niche
 * missing from the list is indistinguishable from a niche they were never put
 * on, and those are somebody else's mistake to fix.
 *
 * A niche they are assigned to that has since been deleted is dropped: there is
 * no threshold to report and no name to show.
 */
function buildAssignedNicheLines(
  employee: { readonly nicheIds: readonly string[]; readonly hitPaymentMinor: number },
  niches: readonly {
    id: string;
    name: string;
    hitThreshold: number | null;
    hitWindowHours: number | null;
  }[],
  earned: readonly { nicheId: string; hitCount: number; bonusMinor: number }[],
): MyEarningsNicheLineDTO[] {
  const nicheById = new Map(niches.map((niche) => [niche.id, niche]));
  const earnedByNiche = new Map(earned.map((line) => [line.nicheId, line]));

  const lines: MyEarningsNicheLineDTO[] = [];

  for (const nicheId of employee.nicheIds) {
    const niche = nicheById.get(nicheId);
    if (!niche) continue;

    const line = earnedByNiche.get(nicheId);
    // The same resolution the engine performs, through the same function, so
    // the rule shown is the rule the bonus was judged against — and the nulls
    // are carried rather than filled in, because the engine judged nothing.
    const missing = missingHitRuleHalf(niche);

    lines.push({
      nicheId: niche.id,
      nicheName: niche.name,
      thresholdApplied: niche.hitThreshold,
      windowHoursApplied: niche.hitWindowHours,
      thresholdSource: missing === null ? "niche" : "unconfigured",
      ruleMissing: missing,
      hitCount: line?.hitCount ?? 0,
      hitPaymentMinor: employee.hitPaymentMinor,
      bonusMinor: line?.bonusMinor ?? 0,
    });
  }

  // Most-earning first, then by name — the ordering the admin breakdown uses,
  // so the same figures read the same way on both screens.
  return lines.sort((a, b) => b.bonusMinor - a.bonusMinor || a.nicheName.localeCompare(b.nicheName));
}

/** Why an estimate came out the way it did. */
function estimateNotices(
  window: EarningsWindow,
  employee: {
    readonly nicheIds: readonly string[];
    readonly hitPaymentMinor: number;
    readonly joinedOnMs: number | null;
    readonly employmentEndedOnMs: number | null;
  },
  calculation: PayrollCalculation,
  byNiche: readonly MyEarningsNicheLineDTO[],
  noMeasurableNiche: boolean,
): string[] {
  const notices: string[] = [];

  if (!calculation.employedDuringPeriod) {
    notices.push(
      `Your employment dates do not overlap ${window.label}, so nothing is calculated for it.`,
    );
    return notices;
  }

  notices.push(
    Date.now() >= window.endsAtMs
      ? `${window.label} has ended but has not been finalized yet, so this is still an estimate and can change.`
      : `${window.label} is still in progress. Views are still climbing, so this figure is an estimate and will change.`,
  );

  if (employee.nicheIds.length === 0) {
    notices.push(
      "You are not assigned to any niches, so no hit can be credited to you. Hit bonuses are paid per niche.",
    );
  } else if (employee.hitPaymentMinor <= 0) {
    notices.push(
      "Your per-hit rate is not set, so hits earn no bonus. An administrator sets it on your employee profile.",
    );
  }

  // A niche with half a rule is not producing an honest zero, it is producing
  // an unanswered question — and until somebody answers it, no Short in that
  // niche can be counted at all. Named per niche, with the half that is missing
  // and the number of the person's own Shorts it cost them, because "12 of your
  // Shorts" is what makes this a thing worth chasing rather than a note to skim.
  const skippedByNicheId = new Map(
    calculation.skippedNiches.map((skipped) => [skipped.nicheId, skipped.shortCount]),
  );

  for (const line of byNiche) {
    if (line.ruleMissing === null) continue;

    const shortCount = line.nicheId === null ? 0 : (skippedByNicheId.get(line.nicheId) ?? 0);
    const lacks = `has no ${missingHalfLabel(line.ruleMissing)} set`;
    notices.push(
      shortCount > 0
        ? `${line.nicheName} ${lacks}, so nothing in it can count as a hit — ${formatCount(shortCount, "of your Shorts in it was", "of your Shorts in it were")} not counted this period. An administrator completes the rule; once it is set, Shorts in this niche count from the next period onwards.`
        : `${line.nicheName} ${lacks}, so nothing in it can count as a hit. An administrator completes the rule; until then this niche cannot earn you a bonus.`,
    );
  }

  // A HIT IS PAID IN THE PERIOD IT RESOLVED, so this month's bonus can include
  // Shorts published last month. Said out loud, because somebody checking their
  // own payslip against their own upload dates would otherwise conclude the
  // figure is wrong.
  const carriedIn = calculation.hits.filter(
    (hit) => hit.publishedAtMs < window.startsAtMs,
  ).length;
  if (carriedIn > 0) {
    notices.push(
      `${formatCount(carriedIn, "of your counted Shorts was", "of your counted Shorts were")} published before ${window.label} but reached the threshold inside the window during it. A hit is paid in the period its window closed in, not the period it was published in.`,
    );
  }

  // A WAIT AND A LOSS, NEVER THE SAME SENTENCE. Both come out as "no bonus yet"
  // and only one of them is ever coming back, so an employee reading a zero is
  // told which they have. The pending line goes first because it is the one
  // with something still to happen.
  if (calculation.unresolved.pendingCount > 0) {
    notices.push(
      `${formatCount(calculation.unresolved.pendingCount, "of your Shorts is", "of your Shorts are")} still inside the window for counting as a hit. They are not misses — nothing is decided until the window closes, and this figure can still go up before the period is finalized.`,
    );
  }
  if (calculation.unresolved.unknownCount > 0) {
    notices.push(
      `${formatCount(calculation.unresolved.unknownCount, "of your Shorts passed its threshold but", "of your Shorts passed their thresholds but")} nobody was recording view counts while the window was open, so there is no way to tell whether they got there in time. They cannot be counted either way, and unlike a Short still inside its window they will not be counted later.`,
    );
  }
  // NOT A THIRD KIND OF LOSS, and the sentence has to say so. This bonus was
  // paid — in the finalized period the Short resolved into at the time — and it
  // is absent here only because a Short is paid once. Left unsaid, an employee
  // comparing this figure against their own hits would read a bonus they have
  // already banked as one that went missing.
  if (calculation.unresolved.alreadyPaidCount > 0) {
    notices.push(
      `${formatCount(calculation.unresolved.alreadyPaidCount, "of your Shorts was", "of your Shorts were")} already counted on an earlier finalized payslip and cannot be counted twice. A window moved into ${window.label} when a niche's hit rule changed, but a hit is paid in the period that counted it, and a finalized period does not change.`,
    );
  }

  // THE ORDER MATTERS. "Nothing crossed its threshold" is a true and useful
  // sentence when there IS a rule, and a lie when there is not — there was no
  // bar to cross and no clock to cross it in. Somebody whose every niche is
  // unconfigured gets the sentence that names the actual problem instead.
  if (noMeasurableNiche) {
    notices.push(
      "None of the niches you are on has a complete hit rule set — a hit needs both a view threshold and a window to reach it in — so no hit can be counted for you at all. This is a setting an administrator has to fill in; it is not a reflection of your work, and your normal pay is unaffected.",
    );
  } else if (
    calculation.hitCount === 0 &&
    employee.nicheIds.length > 0 &&
    employee.hitPaymentMinor > 0 &&
    // Already explained, more precisely, by the three lines above. Following
    // them with "nothing reached its threshold" would contradict the one that
    // just said a Short passed it — or, worse, the one that just said a Short
    // reached it and was paid for it in an earlier period.
    calculation.unresolved.pendingCount === 0 &&
    calculation.unresolved.unknownCount === 0 &&
    calculation.unresolved.alreadyPaidCount === 0
  ) {
    notices.push(
      "No Short on your niches reached its threshold inside the window in this period, so there is no hit bonus.",
    );
  }

  return notices;
}

/** "1 of your Shorts was" / "12 of your Shorts were". */
function formatCount(count: number, singular: string, plural: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : plural}`;
}

/** A finalized record, exactly as it was written. */
function fromStoredRecord(
  window: EarningsWindow,
  kind: EarningsPeriodKind,
  status: string,
  record: StoredRecord,
  windows: ReadonlyMap<string, StoredHitWindow>,
): MyEarningsDTO {
  // `toRecordDTO` is the same mapper the admin screens use — including the
  // per-niche regrouping — so a payslip and this screen cannot disagree about
  // a figure that is, by then, a fact.
  const dto = toRecordDTO(record, windows);

  const notices: string[] = [
    `${window.label} is finalized. These are the figures recorded at the time and they do not change, even as views keep climbing.`,
  ];
  if (dto.paymentStatus === "paid") {
    notices.push("This period has been marked paid.");
  }
  if (dto.adjustmentMinor !== 0) {
    notices.push(
      dto.adjustmentReason
        ? `An administrator adjusted this record: ${dto.adjustmentReason}`
        : "An administrator adjusted this record.",
    );
  }

  return {
    period: toPeriodDTO(window, kind),
    basis: "finalized",
    periodStatus: toPeriodStatus(status),
    paymentStatus: dto.paymentStatus,
    paidAt: dto.paidAt,
    onPayroll: true,
    baseSalaryMinor: dto.baseSalaryMinor,
    hitPaymentMinor: dto.hitPaymentMinor,
    hitCount: dto.hitCount,
    hitBonusMinor: dto.hitBonusMinor,
    adjustmentMinor: dto.adjustmentMinor,
    adjustmentReason: dto.adjustmentReason,
    totalMinor: dto.totalMinor,
    currency: dto.currency,
    byNiche: toFinalizedNicheLines(dto.byNiche),
    hits: dto.hits,
    // All three empty, and not by omission. A frozen record is what was owed;
    // what today's niche configuration would skip, and what is still waiting on
    // a window, are facts about today, and attaching them to a settled figure
    // would invite exactly the retroactive reading this whole service refuses.
    skippedNiches: [],
    unresolved: NO_UNRESOLVED,
    noMeasurableNiche: false,
    notices,
  };
}

/** A zero with a reason attached. Never a bare zero. */
async function emptyEarnings(
  organizationId: string,
  window: EarningsWindow,
  kind: EarningsPeriodKind,
  outcome: {
    readonly basis: "finalized" | "estimate";
    readonly periodStatus: PayrollPeriodStatus | null;
    readonly notices: readonly string[];
  },
): Promise<MyEarningsDTO> {
  // Somebody with no employee profile has no currency of their own, and a zero
  // still has to be labelled with something. The organization's base currency
  // is the only defensible answer, the same one `totalsFrom` reaches for.
  const settings = await getOrgSettings(organizationId);

  return {
    period: toPeriodDTO(window, kind),
    basis: outcome.basis,
    periodStatus: outcome.periodStatus,
    paymentStatus: null,
    paidAt: null,
    onPayroll: false,
    baseSalaryMinor: 0,
    hitPaymentMinor: 0,
    hitCount: 0,
    hitBonusMinor: 0,
    adjustmentMinor: 0,
    adjustmentReason: null,
    totalMinor: 0,
    currency: settings.baseCurrency,
    byNiche: [],
    hits: [],
    // Nobody on payroll, or no line in a frozen run. Either way there was no
    // bonus to lose to a half-written rule or an open window, and the notice
    // already says which.
    skippedNiches: [],
    unresolved: NO_UNRESOLVED,
    noMeasurableNiche: false,
    notices: outcome.notices,
  };
}

function toPeriodDTO(window: EarningsWindow, kind: EarningsPeriodKind): MyEarningsPeriodDTO {
  return {
    kind,
    label: window.label,
    startsAt: window.startsAtMs,
    endsAt: window.endsAtMs,
    hasEnded: Date.now() >= window.endsAtMs,
  };
}


// ---------------------------------------------------------------------------
// READ: your own earnings history
//
// The list of months already settled. Same subject rule as `getMyEarnings`
// above, restated here because this is the endpoint that returns MANY rows, and
// a list is exactly the shape a missing ownership filter disappears into: one
// row too many looks like a longer page, not like a breach.
//
// THE OWNERSHIP GUARANTEE, FOR A LIST
// `getMyEarningsHistory` takes a page and nothing else. `MyEarningsHistoryPage`
// has two numeric fields and no identity field, the schema behind it is
// `.strict()`, and the route reads two named query parameters — so a `?userId=`
// has nothing to bind to, a request body is never read at all, and a header is
// never consulted. The subject is resolved once, from `getScope()`, which reads
// the session cookie, and lands in the `where` clause beside the organization.
// Asking about somebody else would require adding a parameter to this
// signature, which is a visible change to the line this comment sits on.
// ---------------------------------------------------------------------------

/** Two years of months: far more than anybody scrolls, in one request. */
const HISTORY_DEFAULT_LIMIT = 24;
const HISTORY_MAX_LIMIT = 60;

/** How much history to return. Never whose. */
export interface MyEarningsHistoryPage {
  readonly limit: number;
  readonly offset: number;
}

/** One settled period, exactly as it was recorded. */
export interface MyEarningsHistoryRowDTO {
  readonly year: number;
  /** 1-12. */
  readonly month: number;
  /** "August 2026". */
  readonly label: string;

  /**
   * The period's own state. Always "finalized" or "paid" — an open period is a
   * live calculation, not history, and is filtered out before it gets here.
   */
  readonly periodStatus: PayrollPeriodStatus;

  /**
   * THIS row's payment state, taken from the caller's own record rather than
   * from the period around it.
   *
   * The two can legitimately disagree in the direction that matters:
   * `markRecordPaid` settles one person at a time and only flips the period to
   * "paid" once nobody is left pending. So a period still reading "finalized"
   * can hold a record that really was paid, and reporting the period's status
   * here would tell that person their money is still on its way.
   */
  readonly paymentStatus: PayrollPaymentStatus;

  /**
   * When the payment was actually recorded: `PayrollRecord.paidAt`, written in
   * the same transaction that set `paymentStatus` to "paid".
   *
   * Null when nothing was recorded, and then this row is pending. It is never
   * filled in from `scheduledPayOn` below — a date payroll was *due* is not
   * evidence that money moved, and "Paid on 1 September" printed because a
   * calendar said so is a claim this service has no basis for.
   */
  readonly paidAt: number | null;

  /**
   * `PayrollPeriod.payOn` — the first of the following month, fixed when the
   * period was created. A schedule, not a payment. It is here so a pending row
   * can say when the money is due without borrowing the vocabulary of a row
   * that has already been settled.
   */
  readonly scheduledPayOn: number;

  readonly baseSalaryMinor: number;
  /** The per-hit rate this record was paid at, in minor units. */
  readonly hitPaymentMinor: number;
  readonly hitCount: number;
  readonly hitBonusMinor: number;
  /** An administrator's signed correction, shown rather than folded into the total. */
  readonly adjustmentMinor: number;
  readonly adjustmentReason: string | null;
  readonly totalMinor: number;
  readonly currency: string;
}

export interface MyEarningsHistoryDTO {
  /** Newest period first. */
  readonly rows: readonly MyEarningsHistoryRowDTO[];
  readonly hasMore: boolean;
  /** The offset to ask for next, or null at the end. Never an identity. */
  readonly nextOffset: number | null;
}

/**
 * The query for GET /api/me/earnings/history.
 *
 * `.strict()` for the same reason `myEarningsQuerySchema` is strict: the route
 * builds this object from two named parameters, and if a future edit ever
 * widened it to forward the whole query object, a stray `userId` would be a
 * parse error here rather than a field somebody downstream might read.
 */
const myEarningsHistoryQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(HISTORY_MAX_LIMIT).default(HISTORY_DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

/** Turns raw query parameters into a page, or a 400. */
export function parseMyEarningsHistoryPage(raw: {
  readonly limit?: string | null;
  readonly offset?: string | null;
}): MyEarningsHistoryPage {
  // Absent parameters arrive as null from URLSearchParams, and `Number(null)`
  // is 0 — which for `limit` would silently mean "give me nothing". Normalising
  // to undefined is what lets Zod's `.default()` do its job.
  const parsed = myEarningsHistoryQuerySchema.safeParse({
    limit: raw.limit ?? undefined,
    offset: raw.offset ?? undefined,
  });

  if (!parsed.success) {
    throw errors.invalidInput("That is not a page of history this screen can show.");
  }

  return parsed.data;
}

/**
 * Every finalized period the signed-in employee has a record in, newest first.
 *
 * READ, NEVER RECOMPUTED. Each row is the stored PayrollRecord as it was
 * written at finalization. That is the whole point of the list: it is a run of
 * documents, and re-running the engine over any of them would let this month's
 * view counts quietly rewrite what March cost. Nothing here touches
 * `loadPayrollInputs`.
 *
 * Open periods are excluded rather than shown as estimates. "History" is a
 * claim about what was owed, and a month still being counted has no such
 * figure — the live estimate is what `/api/me/earnings` is for.
 */
export async function getMyEarningsHistory(
  page: MyEarningsHistoryPage = { limit: HISTORY_DEFAULT_LIMIT, offset: 0 },
): Promise<MyEarningsHistoryDTO> {
  // The backstop behind the route's own check, exactly as `getMyEarnings` has
  // one. `earnings.view_own` — never `payroll.view`.
  await requirePermission("earnings.view_own");

  // THE SUBJECT, RESOLVED ONCE, FROM THE SESSION. `page` carries two numbers.
  const { organizationId, userId } = await getScope();

  const rows = await prisma.payrollRecord.findMany({
    where: {
      // The ownership filter. From the session, never from the request.
      userId,
      // PayrollRecord has no organizationId of its own — it hangs off the
      // period, which does — so filtering on the relation IS the tenancy check,
      // the same way `loadScopedRecord` does it. And `status` is what keeps an
      // open month out: its figures are still moving, so it is not history.
      period: { organizationId, status: { in: [...FROZEN_STATUSES] } },
    },
    // Newest first, by the period's calendar month rather than by any timestamp
    // on the record: a backfill can finalize two periods in the same second,
    // and August must still come after July.
    orderBy: [{ period: { year: "desc" } }, { period: { month: "desc" } }],
    skip: page.offset,
    // One more row than asked for. Whether another page exists is then a
    // property of what came back, rather than a second COUNT over the same
    // index.
    take: page.limit + 1,
    select: HISTORY_SELECT,
  });

  const hasMore = rows.length > page.limit;

  return {
    rows: (hasMore ? rows.slice(0, page.limit) : rows).map(toHistoryRowDTO),
    hasMore,
    nextOffset: hasMore ? page.offset + page.limit : null,
  };
}

function toHistoryRowDTO(record: StoredHistoryRecord): MyEarningsHistoryRowDTO {
  const { period } = record;

  return {
    year: period.year,
    month: period.month,
    // The same label the payroll screens and the Telegram message use, so one
    // month is called one thing everywhere.
    label: periodLabel(periodForMonth(period.year, period.month)),
    periodStatus: toPeriodStatus(period.status),
    paymentStatus: settledPaymentStatus(record.paymentStatus, record.paidAt),
    paidAt: record.paidAt?.getTime() ?? null,
    scheduledPayOn: period.payOn.getTime(),
    baseSalaryMinor: record.baseSalaryMinor,
    hitPaymentMinor: record.hitPaymentMinor,
    hitCount: record.hitCount,
    hitBonusMinor: record.hitBonusMinor,
    adjustmentMinor: record.adjustmentMinor,
    adjustmentReason: record.adjustmentReason,
    totalMinor: record.totalMinor,
    currency: record.currency,
  };
}

/**
 * "Paid" only when the record says paid AND carries the date it happened.
 *
 * The flag and the timestamp are written together, in one transaction, by both
 * `markRecordPaid` and `markPeriodPaid`, so they should never disagree. If they
 * ever do — a hand-edited row, a restored backup, a future write path that
 * forgets the timestamp — this list takes the quieter reading.
 *
 * That is deliberately NOT what `toRecordDTO` does for the admin screens, and
 * the asymmetry is the point. An admin needs the raw flag in order to notice
 * the inconsistency and fix it. An employee is being told that money left the
 * company's account for them, and a status with no recorded payment behind it
 * is not evidence that it did. Showing "pending" makes somebody ask a question;
 * showing "paid" makes them stop asking.
 */
function settledPaymentStatus(status: string, paidAt: Date | null): PayrollPaymentStatus {
  return toPaymentStatus(status) === "paid" && paidAt !== null ? "paid" : "pending";
}

// ---------------------------------------------------------------------------
// READ: one settled month's per-niche breakdown
//
// The "why" behind a single row of the history list, fetched only when somebody
// opens that row. It is a separate endpoint rather than a field on the list for
// one reason: the breakdown is rebuilt from the stored PayrollHit rows, and
// hydrating those for every month at once is what `HISTORY_SELECT` was
// deliberately written to avoid. One month, on demand, is a handful of rows.
//
// SAME SUBJECT RULE AS THE LIST. The parameters are a year and a month. Neither
// names a person, and the record is found by the session's user id — so this is
// the list's ownership guarantee with a narrower window, not a second one.
// ---------------------------------------------------------------------------

/** Which month. Never whose. */
export interface MyEarningsHistoryMonth {
  readonly year: number;
  /** 1-12. */
  readonly month: number;
}

/**
 * One settled month's hit bonus, explained.
 *
 * The figures are echoed back alongside the lines so the opened panel can be
 * checked against the row that opened it without the caller holding both and
 * hoping they match.
 */
export interface MyEarningsHistoryBreakdownDTO {
  readonly year: number;
  readonly month: number;
  /** "August 2026", from the same labeller as the list row. */
  readonly label: string;
  readonly hitCount: number;
  readonly hitBonusMinor: number;
  readonly hitPaymentMinor: number;
  readonly currency: string;

  /**
   * One line per niche that actually earned a hit that month.
   *
   * A niche the person is on TODAY but earned nothing in back then does not
   * appear, and that is deliberate rather than an omission. These lines are
   * rebuilt from the hits the run recorded; adding a zero row from today's
   * assignments would describe the present in a panel about a settled document,
   * and would put a niche somebody joined in November onto their March payslip.
   * `fromStoredRecord` takes exactly the same view of a finalized period, so a
   * month opened here and the same month opened through the period picker show
   * the same lines.
   */
  readonly byNiche: readonly MyEarningsNicheLineDTO[];
}

/**
 * The query for GET /api/me/earnings/history/[year]/[month].
 *
 * The year bound is not a validation nicety — it is what keeps the route from
 * being a way to probe for rows by walking a range. Nothing outside a plausible
 * payroll calendar can even reach the database.
 */
const myEarningsHistoryMonthSchema = z
  .object({
    year: z.coerce.number().int().min(2000).max(2200),
    month: z.coerce.number().int().min(1).max(12),
  })
  .strict();

/** Turns raw route segments into a month, or a 400. */
export function parseMyEarningsHistoryMonth(raw: {
  readonly year?: string | null;
  readonly month?: string | null;
}): MyEarningsHistoryMonth {
  const parsed = myEarningsHistoryMonthSchema.safeParse({
    year: raw.year ?? undefined,
    month: raw.month ?? undefined,
  });

  if (!parsed.success) {
    throw errors.invalidInput("That is not a month this screen can show.");
  }

  return parsed.data;
}

/**
 * The per-niche hit lines behind one finalized month of the caller's own pay.
 *
 * READ, NEVER RECOMPUTED, for the same reason the list is: these are the hits
 * the run recorded, with the threshold each was judged against as it stood at
 * the time. The engine is not consulted, so today's thresholds cannot rewrite
 * what March was worth.
 *
 * Refuses an open period the same way the list excludes one. A month still
 * being counted has no settled breakdown, and the live estimate — with its
 * unconfigured-niche warnings, which only make sense about the present — is
 * what `/api/me/earnings` is for.
 */
export async function getMyEarningsHistoryBreakdown(
  month: MyEarningsHistoryMonth,
): Promise<MyEarningsHistoryBreakdownDTO> {
  // The backstop behind the route's own check, exactly as the list has one.
  await requirePermission("earnings.view_own");

  // THE SUBJECT, RESOLVED ONCE, FROM THE SESSION. `month` carries two numbers.
  const { organizationId, userId } = await getScope();

  const record = await prisma.payrollRecord.findFirst({
    where: {
      // The ownership filter. From the session, never from the request.
      userId,
      // Tenancy and freezing both ride on the period relation, as they do in
      // `getMyEarningsHistory` — PayrollRecord has no organizationId of its own.
      period: {
        organizationId,
        year: month.year,
        month: month.month,
        status: { in: [...FROZEN_STATUSES] },
      },
    },
    select: BREAKDOWN_SELECT,
  });

  if (!record) {
    // One message for "no such month", "not your month" and "not settled yet".
    // Distinguishing them would turn this into a way to learn whether a
    // colleague was paid for a month the caller was not.
    throw errors.notFound("month of pay");
  }

  return {
    year: month.year,
    month: month.month,
    label: periodLabel(periodForMonth(month.year, month.month)),
    hitCount: record.hitCount,
    hitBonusMinor: record.hitBonusMinor,
    hitPaymentMinor: record.hitPaymentMinor,
    currency: record.currency,
    byNiche: toFinalizedNicheLines(groupHitsByNiche(record.hits, record.hitPaymentMinor)),
  };
}

/**
 * A frozen period's niche lines, told apart from a live one's.
 *
 * `thresholdSource` is what the UI reads to decide whether a missing threshold
 * is worth warning about. On a settled record it never is: every line here came
 * from a hit, so a threshold was applied, and the only honest label is that this
 * is how it was finalized. Shared with `fromStoredRecord` so the two finalized
 * paths cannot drift into labelling the same record differently.
 */
function toFinalizedNicheLines(
  lines: readonly PayrollNicheLineDTO[],
): MyEarningsNicheLineDTO[] {
  return lines.map((line) => ({
    ...line,
    thresholdSource: "as_finalized" as const,
    // Never populated for a frozen line. What today's niche is missing is a
    // fact about today, and hanging it on a settled figure would invite the
    // retroactive reading the rest of this service refuses.
    ruleMissing: null,
  }));
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
    nowMs: Date.now(),
  });

  const finalizedAt = new Date();
  const nicheRules = describeNicheRules(run.calculations);

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
      //
      // The skipped niches make it into the SUMMARY as well as the metadata,
      // because the summary is the line the audit list actually renders and
      // this is the half of the event somebody would otherwise have to know to
      // go looking for.
      summary: `Finalized ${label} payroll for ${run.calculations.length} ${
        run.calculations.length === 1 ? "employee" : "employees"
      }${skippedSummarySuffix(run.skippedNiches)}`,
      targetType: "payroll_period",
      targetId: periodKey(year, month),
      targetLabel: label,
      metadata: {
        year,
        month,
        employeeCount: run.calculations.length,
        hitCount: run.calculations.reduce((sum, calculation) => sum + calculation.hitCount, 0),
        forced: options.force === true,
        // WHY THE SKIPPED NICHES ARE WRITTEN HERE, AND ONLY HERE.
        // PayrollRecord has no column for them and the schema is not ours to
        // change, so this entry is the only place the reason survives the run.
        // It has to: these figures are lower than they would have been under
        // the old organization-default fallback, and "why was August smaller?"
        // has to be answerable in November without re-deriving a period that is
        // deliberately never recalculated.
        //
        // Counts and names, never money — the rule the whole payroll audit
        // family follows. Flat primitives and a string array, because
        // `sanitizeMetadata` keeps this log to shapes that cannot smuggle a row
        // in; a nested object graph would be silently dropped.
        //
        // THE NAME LIST IS CAPPED AND THE COUNTS ARE NOT. That same sanitizer
        // slices arrays at 20 entries, so a run that skipped more niches than
        // that records the first 20 names and nothing about the rest — read a
        // 20-name list as a sample, never as the whole of it. The two counts
        // below are plain numbers and survive intact, which is what makes the
        // magnitude of the reduction recoverable in November regardless.
        skippedNicheCount: run.skippedNiches.length,
        skippedShortCount: run.skippedNiches.reduce(
          (sum, skipped) => sum + skipped.shortCount,
          0,
        ),
        skippedNiches: run.skippedNiches.map(
          (skipped) =>
            `${skipped.nicheName} (${skipped.shortCount}, no ${missingHalfLabel(skipped.missing)})`,
        ),
        // THE RULE THIS RUN WAS COMPUTED UNDER, WRITTEN DOWN WHILE IT WAS TRUE.
        //
        // `PayrollHit` records `thresholdAtRun` per Short and has no column for
        // the window, so on its own a stored hit says "500,000 views" — which
        // stopped being a rule the moment a clock was added to the definition.
        // An admin who moves GTA from seven days to fourteen next quarter would
        // otherwise leave this month's bonuses describable only against a bar
        // that is now half of a different rule.
        //
        // This is the same mechanism, and the same reasoning, as the skipped
        // niches above: the schema is not ours to change, so the audit entry is
        // where the reason survives the run. Names and rules, never money.
        //
        // Capped at 20 entries by `sanitizeMetadata`, like every array here —
        // read a 20-name list as a sample. `nicheRuleCount` is a plain number
        // and survives intact.
        nicheRuleCount: nicheRules.length,
        nicheRules,
        // What the run could not settle. Both counts, never summed: a pending
        // Short is a wait and an unknown one is a loss, and a month finalized
        // with unknowns on it has permanently forgone those bonuses.
        pendingShortCount: run.unresolved.pendingCount,
        unknownShortCount: run.unresolved.unknownCount,
      },
    },
  );

  return { periodId, alreadyFinalized: false, employeeCount: run.calculations.length };
}

/**
 * The tail of a finalization's audit summary when something was skipped.
 *
 * Empty string in the ordinary case, so a run with every niche configured reads
 * exactly as it always has.
 *
 * Each niche is named with the half it is missing. "no hit threshold" was the
 * whole story when a threshold was the whole rule; now a niche can be
 * unscoreable for having no window, and an entry that did not say which would
 * send whoever reads this log in November to the wrong field.
 */
function skippedSummarySuffix(skipped: readonly SkippedNiche[]): string {
  if (skipped.length === 0) return "";

  const shortCount = skipped.reduce((sum, niche) => sum + niche.shortCount, 0);
  const names = skipped
    .map((niche) => `${niche.nicheName} (no ${missingHalfLabel(niche.missing)})`)
    .join(", ");

  return ` — ${shortCount} ${shortCount === 1 ? "Short was" : "Shorts were"} not counted because ${
    skipped.length === 1 ? "this niche has" : "these niches have"
  } an incomplete hit rule: ${names}`;
}

/** "hit threshold" / "hit window" / "hit threshold or window". */
function missingHalfLabel(missing: MissingHitRuleHalf): string {
  if (missing === "threshold") return "hit threshold";
  if (missing === "window") return "hit window";
  return "hit threshold or window";
}

/**
 * The rules this run actually applied, one line per niche that paid.
 *
 * Drawn from the calculations rather than from today's niches, so it records
 * what was used and not what is configured now — the two are the same at this
 * instant and will not stay that way.
 *
 * Sorted and de-duplicated so the entry is stable: the same run written twice
 * produces the same list, which is what makes two audit entries comparable.
 */
function describeNicheRules(calculations: readonly PayrollCalculation[]): string[] {
  const rules = new Set<string>();
  for (const calculation of calculations) {
    for (const line of calculation.byNiche) {
      rules.add(
        `${line.nicheName}: ${line.thresholdApplied.toLocaleString("en-US")} views within ${formatHitWindow(line.windowHoursApplied)}`,
      );
    }
  }
  return [...rules].sort();
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
    //
    // THE WINDOW HAS NO COLUMN HERE and is not squeezed into one that means
    // something else. It survives in two places instead: the
    // `payroll.period_finalized` audit entry records the rule each niche was
    // paid under at the moment it was true, and `loadHitWindowsForRecords`
    // recovers the per-Short window from `VideoHitEvaluation` for the screen.
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
  if (record.paymentStatus === "paid") return scopedRecordDTO(organizationId, record);

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

  return scopedRecordDTO(organizationId, await loadScopedRecord(organizationId, recordId));
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

  return scopedRecordDTO(organizationId, await loadScopedRecord(organizationId, recordId));
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

/**
 * A history row: the money columns, plus the period they belong to.
 *
 * Deliberately NOT `RECORD_SELECT`. That one pulls every PayrollHit behind the
 * record, which is right for one payslip and wrong for a list — two years of
 * history would drag in every qualifying Short of two years to render 24
 * summary lines. The Shorts behind a month are one request away on the earnings
 * screen itself.
 */
const HISTORY_SELECT = {
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
  period: { select: { year: true, month: true, status: true, payOn: true } },
} as const;

type StoredHistoryRecord = Prisma.PayrollRecordGetPayload<{ select: typeof HISTORY_SELECT }>;

/**
 * One settled month's hits, narrowed to what a per-niche line is made of.
 *
 * The three hit columns below are exactly what `groupHitsByNiche` reads. The
 * title, channel, view count and publication date of every Short are not
 * selected: this panel says "GTA — 12 hits at 100,000 views, $120", and pulling
 * the Shorts themselves to render a summary of them would make opening a row
 * cost as much as opening the payslip.
 */
const BREAKDOWN_SELECT = {
  hitPaymentMinor: true,
  hitCount: true,
  hitBonusMinor: true,
  currency: true,
  hits: { select: { nicheId: true, nicheName: true, thresholdAtRun: true } },
} as const;

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

  // A frozen period is read, never recomputed, so there is nothing to report
  // about what today's configuration would skip or what is still waiting on a
  // window — see the notes on `PayrollPeriodDTO.skippedNiches` and `.unresolved`.
  const { records, skippedNiches, unresolved } = frozen
    ? {
        records: await loadStoredRecords(context.organizationId, row.id),
        skippedNiches: [],
        unresolved: NO_UNRESOLVED,
      }
    : await calculateRecords(context.organizationId, period);

  return {
    ...buildHeader(context, period, row, !frozen),
    totals: totalsFrom(records, context.fallbackCurrency),
    records,
    skippedNiches,
    unresolved,
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
    : // A summary is a row in a history list: totals only, no per-employee
      // detail and no skipped-niche report. The detail view is where an admin
      // reads why a run is smaller than they expected.
      (await calculateRecords(context.organizationId, period)).records;

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

/**
 * The live run: the engine, over current view counts.
 *
 * Returns what the run could NOT judge alongside what it could. The two travel
 * together because they are one answer — a total that silently omits the Shorts
 * an unconfigured niche made unjudgeable is the exact figure this round of work
 * exists to stop anybody paying from.
 */
async function calculateRecords(
  organizationId: string,
  period: PayrollPeriodWindow,
): Promise<{
  readonly records: readonly PayrollRecordDTO[];
  readonly skippedNiches: readonly PayrollSkippedNicheDTO[];
  readonly unresolved: PayrollUnresolvedDTO;
}> {
  const inputs = await loadPayrollInputs(organizationId, period);
  const run = calculatePayrollRun({
    employees: inputs.employees,
    shorts: inputs.shorts,
    niches: inputs.niches,
    period,
    // The clock the engine refuses to read for itself. It decides which Shorts
    // are still pending, so it is passed once per run rather than sampled per
    // Short — a run that straddled a window's close would otherwise report a
    // Short as pending in one line and resolved in another.
    nowMs: Date.now(),
  });
  return {
    records: run.calculations.map(toDraftRecordDTO),
    skippedNiches: run.skippedNiches.map(toSkippedNicheDTO),
    unresolved: toUnresolvedDTO(run.unresolved),
  };
}

async function loadStoredRecords(
  organizationId: string,
  periodId: string,
): Promise<readonly PayrollRecordDTO[]> {
  const rows = await prisma.payrollRecord.findMany({
    where: { periodId },
    select: RECORD_SELECT,
  });

  const windows = await loadHitWindowsForRecords(organizationId, rows);

  // The same ordering the engine produces for a draft — highest paid first,
  // then by name — so a period does not reshuffle the moment it is finalized.
  return rows
    .map((row) => toRecordDTO(row, windows))
    .sort((a, b) => b.totalMinor - a.totalMinor || a.employeeName.localeCompare(b.employeeName));
}

/**
 * The rule each stored hit was judged under, recovered from its evaluation.
 *
 * WHY THIS EXISTS. `PayrollHit` carries `thresholdAtRun` and `viewCountAtRun`
 * so a bonus stays explicable months later, and under a windowed rule the
 * threshold alone no longer explains anything — "500,000 views" is not a
 * standard, "500,000 views within 7 days" is. The table has no column for the
 * clock and the schema is not ours to change, so the window is recovered from
 * `VideoHitEvaluation`, which records `windowHoursApplied` and `windowClosesAt`
 * per (organization, video) and, by its own contract, does not rewrite them
 * once the window has shut. An admin moving GTA from seven days to fourteen in
 * March therefore cannot change what a February payslip says.
 *
 * IT IS A DISPLAY AID, NOT THE RECORD. The durable copy of the rule a run was
 * computed under is written into the `payroll.period_finalized` audit entry at
 * the moment it was true — the same mechanism the skipped niches use, and for
 * the same reason. This join is what puts it next to the hit on screen.
 *
 * GUARDED ON BOTH THE NICHE AND THE THRESHOLD. An evaluation decided under a
 * different niche, or against a different bar, is evidence about a different
 * question; printing its window beside this hit would describe a rule that was
 * never applied. When they disagree the field stays null, and the UI says the
 * window was not recorded rather than inventing one.
 */
async function loadHitWindowsForRecords(
  organizationId: string,
  records: readonly StoredRecord[],
): Promise<ReadonlyMap<string, StoredHitWindow>> {
  const videoIds = [...new Set(records.flatMap((record) => record.hits.map((hit) => hit.videoId)))];
  if (videoIds.length === 0) return new Map();

  const evaluations = await prisma.videoHitEvaluation.findMany({
    // `organizationId` first, always: `Video` is a globally deduplicated row and
    // another team's verdict is another team's bar.
    where: { organizationId, videoId: { in: videoIds } },
    select: {
      videoId: true,
      nicheId: true,
      thresholdApplied: true,
      windowHoursApplied: true,
      windowClosesAt: true,
    },
  });

  const byVideoId = new Map<string, StoredHitWindow>();
  for (const evaluation of evaluations) {
    if (evaluation.windowHoursApplied === null) continue;
    byVideoId.set(evaluation.videoId, {
      nicheId: evaluation.nicheId,
      thresholdApplied: evaluation.thresholdApplied,
      windowHoursApplied: evaluation.windowHoursApplied,
      windowClosesAt: evaluation.windowClosesAt?.getTime() ?? null,
    });
  }
  return byVideoId;
}

interface StoredHitWindow {
  readonly nicheId: string | null;
  readonly thresholdApplied: number | null;
  readonly windowHoursApplied: number;
  readonly windowClosesAt: number | null;
}

/**
 * One stored record, with its hits' windows recovered.
 *
 * The single-record path — mark paid, adjust — goes through here rather than
 * calling `toRecordDTO` with an empty map, so a record returned straight after
 * a write describes its hits exactly as the period screen does. A payment that
 * changed how a bonus reads would be indistinguishable from one that changed
 * the bonus.
 */
async function scopedRecordDTO(
  organizationId: string,
  record: StoredRecord,
): Promise<PayrollRecordDTO> {
  return toRecordDTO(record, await loadHitWindowsForRecords(organizationId, [record]));
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
      windowHoursApplied: line.windowHoursApplied,
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
      windowHoursApplied: hit.windowHoursApplied,
      // A draft knows this exactly: it just computed the verdict. Only a stored
      // record has to go looking.
      windowClosesAt: hit.windowClosesAtMs,
      viewCountAtRun: hit.views,
      publishedAt: hit.publishedAtMs,
    })),
  };
}

function toRecordDTO(
  record: StoredRecord,
  windows: ReadonlyMap<string, StoredHitWindow>,
): PayrollRecordDTO {
  const hits: PayrollHitDTO[] = record.hits.map((hit) => {
    const stored = windows.get(hit.videoId);
    // Only when the recovered evaluation is about the same rule this hit was
    // paid under. See `loadHitWindowsForRecords` for why the guard is on both
    // the niche and the bar, and why the answer when they disagree is null
    // rather than a best guess.
    const sameRule =
      stored !== undefined &&
      stored.nicheId === hit.nicheId &&
      stored.thresholdApplied === hit.thresholdAtRun;

    return {
      videoId: hit.videoId,
      videoTitle: hit.videoTitle,
      channelId: hit.channelId,
      channelName: hit.channelName,
      nicheId: hit.nicheId,
      nicheName: hit.nicheName,
      thresholdAtRun: hit.thresholdAtRun,
      windowHoursApplied: sameRule ? stored.windowHoursApplied : null,
      windowClosesAt: sameRule ? stored.windowClosesAt : null,
      // BigInt cannot be serialised to JSON. Converted once, here, at the edge.
      viewCountAtRun: Number(hit.viewCountAtRun),
      publishedAt: hit.publishedAt.getTime(),
    };
  });

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
 *
 * The parameter is the three columns a line is built from rather than a whole
 * `PayrollHitDTO`, so the employee's own breakdown can group a narrow projection
 * of the hit rows through this one routine instead of hydrating every Short to
 * reach a count. A full hit satisfies it, so the admin call site is unchanged.
 */
function groupHitsByNiche(
  hits: readonly {
    readonly nicheId: string | null;
    readonly nicheName: string;
    readonly thresholdAtRun: number;
    /** Absent on the narrow projections that only ever needed a count. */
    readonly windowHoursApplied?: number | null;
  }[],
  hitPaymentMinor: number,
): PayrollNicheLineDTO[] {
  const buckets = new Map<
    string,
    {
      nicheId: string | null;
      nicheName: string;
      thresholdApplied: number;
      windowHoursApplied: number | null;
      hitCount: number;
    }
  >();

  for (const hit of hits) {
    const key = hit.nicheId ?? `name:${hit.nicheName}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.hitCount += 1;
      // A line describes one rule. If two hits on it disagree about the window
      // — a niche re-window mid-period, or one hit whose evaluation could not be
      // recovered — the line stops claiming one rather than picking a side.
      if (existing.windowHoursApplied !== (hit.windowHoursApplied ?? null)) {
        existing.windowHoursApplied = null;
      }
    } else {
      buckets.set(key, {
        nicheId: hit.nicheId,
        nicheName: hit.nicheName,
        thresholdApplied: hit.thresholdAtRun,
        windowHoursApplied: hit.windowHoursApplied ?? null,
        hitCount: 1,
      });
    }
  }

  return [...buckets.values()]
    .map((bucket) => ({
      nicheId: bucket.nicheId,
      nicheName: bucket.nicheName,
      thresholdApplied: bucket.thresholdApplied,
      windowHoursApplied: bucket.windowHoursApplied,
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

/**
 * The statuses that mean "the figures are stored, not derived".
 *
 * One list, because `isFrozen` below and the `where` clause in
 * `getMyEarningsHistory` are the same question asked in two places. A period
 * that counted as frozen for one and not the other would be a month that either
 * vanishes from somebody's history or turns up in it as a live estimate.
 */
const FROZEN_STATUSES = ["finalized", "paid"] as const;

/** "finalized" and "paid" both mean the figures are stored, not derived. */
function isFrozen(status: string): boolean {
  return (FROZEN_STATUSES as readonly string[]).includes(status);
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
