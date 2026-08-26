/**
 * =========================================================================
 * PAYROLL CALCULATION
 * =========================================================================
 *
 * Pure and isomorphic, like the analytics engine it sits beside: no I/O, no
 * Prisma, no clock. Everything it needs arrives as arguments, so the same
 * function that renders a live preview in the browser produces the figure that
 * gets finalized on the server, and the two cannot disagree.
 *
 * ONE DEFINITION OF A HIT
 * This module does not decide what a hit is. `isHit` from the analytics engine
 * does, against the niche's own `hitThreshold` — the identical number the
 * dashboard, the charts and the PDF report read. Payroll asks the same question
 * the rest of the product asks; it just attaches money to the answer.
 *
 * WHAT COUNTS, AND WHY
 *   • Only Shorts from channels Northstar OWNS. Paying an editor a bonus
 *     because a competitor went viral would be absurd, and the ownership flag
 *     that decides it is the one already on TrackedChannel.
 *   • Only Shorts published inside the period, on the same half-open
 *     [start, end) convention every other date range here uses.
 *   • Only niches the person is assigned to.
 *   • Each Short at most once per person, per period — see `attributeShort`.
 *
 * A Short CAN pay two different people. If a Head of Shorts and an editor are
 * both assigned to GTA, one GTA hit earns both of them their own rate. That is
 * the intended reading of the brief, and the reason "no double counting" is
 * scoped to one person's record rather than to the Short globally.
 */

import { isHit } from "@/lib/analytics/hit-rate";

// ---------------------------------------------------------------------------
// INPUTS
// ---------------------------------------------------------------------------

export interface PayrollNiche {
  readonly id: string;
  readonly name: string;
  /** Null means "inherit the organization default", exactly as elsewhere. */
  readonly hitThreshold: number | null;
}

export interface PayrollEmployee {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly salaryMinor: number;
  readonly hitPaymentMinor: number;
  readonly currency: string;
  /** Niches this person is assigned to. No assignments means no bonuses. */
  readonly nicheIds: readonly string[];
  readonly joinedOnMs: number | null;
  readonly employmentEndedOnMs: number | null;
}

export interface PayrollShort {
  readonly videoId: string;
  readonly title: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly views: number;
  readonly publishedAtMs: number;
  /** Every niche this Short's channel belongs to. */
  readonly nicheIds: readonly string[];
  /** False for competitor channels, which never earn a bonus. */
  readonly isOwnChannel: boolean;
}

export interface PayrollPeriodWindow {
  readonly year: number;
  /** 1-12. */
  readonly month: number;
  readonly startsAtMs: number;
  /** Exclusive. */
  readonly endsAtMs: number;
}

// ---------------------------------------------------------------------------
// OUTPUTS
// ---------------------------------------------------------------------------

export interface QualifyingHit {
  readonly videoId: string;
  readonly title: string;
  readonly channelId: string;
  readonly channelName: string;
  /** The niche the hit was credited to — see `attributeShort`. */
  readonly nicheId: string;
  readonly nicheName: string;
  readonly thresholdApplied: number;
  readonly views: number;
  readonly publishedAtMs: number;
}

export interface NicheBreakdown {
  readonly nicheId: string;
  readonly nicheName: string;
  readonly thresholdApplied: number;
  readonly hitCount: number;
  readonly bonusMinor: number;
}

export interface PayrollCalculation {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly currency: string;

  readonly employedDuringPeriod: boolean;

  readonly baseSalaryMinor: number;
  readonly hitPaymentMinor: number;
  readonly hitCount: number;
  readonly hitBonusMinor: number;
  readonly totalMinor: number;

  /** Per-niche, so the breakdown reads "GTA 120 × $10" rather than one number. */
  readonly byNiche: readonly NicheBreakdown[];
  /** Every Short that earned a bonus, for the audit trail. */
  readonly hits: readonly QualifyingHit[];
}

// ---------------------------------------------------------------------------
// PERIODS
// ---------------------------------------------------------------------------

/**
 * The calendar month containing `atMs`, in UTC.
 *
 * UTC rather than local time so a period's boundaries do not shift with the
 * viewer's timezone — August has to mean the same thing to everyone looking at
 * the same payroll run.
 */
export function periodForMonth(year: number, month: number): PayrollPeriodWindow {
  const startsAtMs = Date.UTC(year, month - 1, 1);
  const endsAtMs = Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1);
  return { year, month, startsAtMs, endsAtMs };
}

export function periodContaining(atMs: number): PayrollPeriodWindow {
  const date = new Date(atMs);
  return periodForMonth(date.getUTCFullYear(), date.getUTCMonth() + 1);
}

/** The month before this one. */
export function previousPeriod(period: PayrollPeriodWindow): PayrollPeriodWindow {
  return period.month === 1
    ? periodForMonth(period.year - 1, 12)
    : periodForMonth(period.year, period.month - 1);
}

/** Payment lands on the first day of the following month. */
export function payDateFor(period: PayrollPeriodWindow): number {
  return period.endsAtMs;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function periodLabel(period: PayrollPeriodWindow): string {
  return `${MONTHS[period.month - 1]} ${period.year}`;
}

// ---------------------------------------------------------------------------
// CALCULATION
// ---------------------------------------------------------------------------

/**
 * Was this person employed at any point during the period?
 *
 * Salary is a flat monthly figure and is deliberately NOT pro-rated — the brief
 * describes it as fixed, and inventing a daily rate would produce numbers
 * nobody agreed to. Somebody employed for part of the month is paid in full;
 * somebody who had left before it started, or joins after it ends, is not on
 * the run at all.
 */
function employedDuring(employee: PayrollEmployee, period: PayrollPeriodWindow): boolean {
  if (employee.joinedOnMs !== null && employee.joinedOnMs >= period.endsAtMs) return false;
  if (employee.employmentEndedOnMs !== null && employee.employmentEndedOnMs < period.startsAtMs) {
    return false;
  }
  return true;
}

/** The threshold in force for a niche, falling back to the org default. */
function thresholdFor(niche: PayrollNiche, organizationDefault: number): number {
  return niche.hitThreshold ?? organizationDefault;
}

/**
 * Decides which niche a Short is credited to, or null if it earns nothing.
 *
 * THE AMBIGUITY THIS RESOLVES
 * A channel can sit in several niches, and those niches can disagree about what
 * a hit is — a channel filed under both GTA (1M) and The Last of Us (500K)
 * makes a 600,000-view Short a hit under one and not the other. Something has
 * to choose, and the choice has to be the same every time the figure is
 * recalculated or the payroll is not reproducible.
 *
 * The rule: among the niches that this Short's channel belongs to AND the
 * employee is assigned to, take those the Short actually clears, and credit it
 * to the one with the LOWEST threshold. Ties break on niche id so the result is
 * stable regardless of input ordering.
 *
 * Lowest wins because the alternative is stranger: a Short that genuinely is a
 * Last of Us hit would earn nothing purely because the channel is also filed
 * under a niche with a higher bar. The credited niche is recorded on the hit,
 * so every bonus can be traced back to the exact threshold it was judged
 * against.
 */
function attributeShort(
  short: PayrollShort,
  assignedNicheIds: ReadonlySet<string>,
  nicheById: ReadonlyMap<string, PayrollNiche>,
  organizationDefault: number,
): { niche: PayrollNiche; threshold: number } | null {
  let best: { niche: PayrollNiche; threshold: number } | null = null;

  for (const nicheId of short.nicheIds) {
    if (!assignedNicheIds.has(nicheId)) continue;

    const niche = nicheById.get(nicheId);
    if (!niche) continue;

    const threshold = thresholdFor(niche, organizationDefault);
    if (!isHit(short.views, threshold)) continue;

    if (
      best === null ||
      threshold < best.threshold ||
      (threshold === best.threshold && niche.id < best.niche.id)
    ) {
      best = { niche, threshold };
    }
  }

  return best;
}

/**
 * What one person earned in one period.
 *
 * Deterministic: the same inputs always produce the same figure, which is what
 * lets a finalized period be re-derived and checked rather than taken on trust.
 */
export function calculateEmployeePayroll(options: {
  employee: PayrollEmployee;
  shorts: readonly PayrollShort[];
  niches: readonly PayrollNiche[];
  period: PayrollPeriodWindow;
  organizationDefaultThreshold: number;
}): PayrollCalculation {
  const { employee, shorts, niches, period, organizationDefaultThreshold } = options;

  const employed = employedDuring(employee, period);
  const assignedNicheIds = new Set(employee.nicheIds);
  const nicheById = new Map(niches.map((niche) => [niche.id, niche]));

  const hits: QualifyingHit[] = [];
  // Guards against a duplicated row in the input reaching the total twice. The
  // database's unique constraint is the real backstop; this makes the pure
  // function safe on its own terms too.
  const countedVideoIds = new Set<string>();

  if (employed && assignedNicheIds.size > 0 && employee.hitPaymentMinor > 0) {
    for (const short of shorts) {
      if (!short.isOwnChannel) continue;
      if (countedVideoIds.has(short.videoId)) continue;
      if (short.publishedAtMs < period.startsAtMs) continue;
      if (short.publishedAtMs >= period.endsAtMs) continue;

      const attribution = attributeShort(
        short,
        assignedNicheIds,
        nicheById,
        organizationDefaultThreshold,
      );
      if (!attribution) continue;

      countedVideoIds.add(short.videoId);
      hits.push({
        videoId: short.videoId,
        title: short.title,
        channelId: short.channelId,
        channelName: short.channelName,
        nicheId: attribution.niche.id,
        nicheName: attribution.niche.name,
        thresholdApplied: attribution.threshold,
        views: short.views,
        publishedAtMs: short.publishedAtMs,
      });
    }
  }

  // Integer arithmetic throughout — minor units, never a float.
  const baseSalaryMinor = employed ? employee.salaryMinor : 0;
  const hitCount = hits.length;
  const hitBonusMinor = hitCount * employee.hitPaymentMinor;

  const byNiche = summariseByNiche(hits, employee.hitPaymentMinor);

  return {
    userId: employee.userId,
    name: employee.name,
    email: employee.email,
    role: employee.role,
    currency: employee.currency,
    employedDuringPeriod: employed,
    baseSalaryMinor,
    hitPaymentMinor: employee.hitPaymentMinor,
    hitCount,
    hitBonusMinor,
    totalMinor: baseSalaryMinor + hitBonusMinor,
    byNiche,
    hits,
  };
}

function summariseByNiche(
  hits: readonly QualifyingHit[],
  hitPaymentMinor: number,
): NicheBreakdown[] {
  const buckets = new Map<string, { name: string; threshold: number; count: number }>();

  for (const hit of hits) {
    const existing = buckets.get(hit.nicheId);
    if (existing) {
      existing.count += 1;
    } else {
      buckets.set(hit.nicheId, {
        name: hit.nicheName,
        threshold: hit.thresholdApplied,
        count: 1,
      });
    }
  }

  return [...buckets.entries()]
    .map(([nicheId, bucket]) => ({
      nicheId,
      nicheName: bucket.name,
      thresholdApplied: bucket.threshold,
      hitCount: bucket.count,
      bonusMinor: bucket.count * hitPaymentMinor,
    }))
    // Most-earning first, then by name so equal rows do not shuffle.
    .sort((a, b) => b.bonusMinor - a.bonusMinor || a.nicheName.localeCompare(b.nicheName));
}

/** The whole team's payroll for a period. */
export function calculatePayrollRun(options: {
  employees: readonly PayrollEmployee[];
  shorts: readonly PayrollShort[];
  niches: readonly PayrollNiche[];
  period: PayrollPeriodWindow;
  organizationDefaultThreshold: number;
}): {
  period: PayrollPeriodWindow;
  calculations: readonly PayrollCalculation[];
  totalMinor: number;
  currency: string;
} {
  const calculations = options.employees
    .map((employee) =>
      calculateEmployeePayroll({
        employee,
        shorts: options.shorts,
        niches: options.niches,
        period: options.period,
        organizationDefaultThreshold: options.organizationDefaultThreshold,
      }),
    )
    .filter((calculation) => calculation.employedDuringPeriod)
    .sort((a, b) => b.totalMinor - a.totalMinor || a.name.localeCompare(b.name));

  return {
    period: options.period,
    calculations,
    totalMinor: calculations.reduce((sum, calculation) => sum + calculation.totalMinor, 0),
    // Mixed currencies across a team would need converting before summing; the
    // caller is expected to keep one currency per organization, and the first
    // employee's is reported so the UI can label the total honestly.
    currency: calculations[0]?.currency ?? "USD",
  };
}
