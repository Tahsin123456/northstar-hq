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
 * AN UNCONFIGURED NICHE CANNOT PRODUCE A HIT
 * A niche whose `hitThreshold` is null has never had a bar chosen for it. Every
 * other consumer reads that as "not measurable" — the dashboard prints "Hit
 * rate threshold: Not configured", the report dialog refuses to generate — and
 * payroll reads it the same way. `isHit` is already false for a null threshold,
 * so no bonus can arise from a bar nobody set.
 *
 * This module used to substitute the organization default here, and that made
 * payroll the one place in the product where an unset threshold still produced
 * a number. The number it produced was money: an admin who created a niche and
 * never configured it was told on screen that its hit rate could not be
 * measured, and was then billed on the 1st for hits measured against 1,000,000
 * anyway. The fallback is gone, and `thresholdFor` returns null rather than
 * coercing so that no caller can quietly put it back.
 *
 * BECAUSE THAT SUBSTITUTION PAID REAL MONEY, ITS REMOVAL IS NOT SILENT
 * Dropping it reduces somebody's pay for Shorts that used to count. So the
 * calculation reports what it could not judge as well as what it could:
 * `skippedNiches` names every unconfigured niche that had Shorts in it and
 * counts them, and the payroll screen shows that to an admin BEFORE they
 * finalize. A bonus that quietly disappears and a bonus that disappears with a
 * named reason are different events, and only the second one can be fixed.
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
  /**
   * Null means NOBODY HAS SET ONE, and therefore that nothing in this niche can
   * be a hit — not "inherit the organization default". See the note at the top:
   * substituting a number here is what paid bonuses the product had already
   * said it could not measure.
   */
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

/**
 * A niche that had Shorts in it and no threshold to judge them by.
 *
 * The counterpart to `NicheBreakdown`: that one says what was paid, this one
 * says what could not even be asked. Both are needed to read a payroll run,
 * because a niche missing from the breakdown looks exactly like a niche where
 * nothing happened, and one of those is an admin's job to fix.
 *
 * `shortCount` counts DISTINCT Shorts that were not considered — published in
 * the period, on an owned channel, filed under this niche, and not credited
 * through some other niche that did have a bar. A Short that earned a bonus
 * elsewhere was considered; counting it here would overstate what the missing
 * threshold cost.
 *
 * One Short filed under two unconfigured niches is counted once in each, so
 * summing `shortCount` across niches can exceed the number of Shorts involved.
 * The per-niche figure is the one that means something — it is what changes
 * when somebody configures THAT niche.
 */
export interface SkippedNiche {
  readonly nicheId: string;
  readonly nicheName: string;
  readonly shortCount: number;
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
  /**
   * What this figure could NOT take into account, and why.
   *
   * Empty for anybody whose niches all have a threshold, which is the ordinary
   * case. Non-empty means this person's bonus is smaller than it looks like it
   * should be, for a reason that is a configuration gap rather than their work.
   */
  readonly skippedNiches: readonly SkippedNiche[];
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

/**
 * The threshold in force for a niche, or null when nobody has set one.
 *
 * The null is the answer, not a gap to paper over. There is deliberately no
 * organization-default parameter to fall back to: a caller that wants a number
 * out of this has to decide what a missing bar means, in the open, rather than
 * inheriting one with a `??`.
 */
function thresholdFor(niche: PayrollNiche): number | null {
  return niche.hitThreshold;
}

/**
 * Could this person earn a hit bonus at all, before any Short is looked at?
 *
 * Employment, an assignment and a rate are the three preconditions, and they
 * are checked in one place because the skipped-niche report has to use exactly
 * the same test as the bonus itself. Reporting "14 Shorts were not counted for
 * Alex" about somebody who has no per-hit rate — and would therefore have been
 * paid nothing either way — would raise an alarm about money that was never at
 * stake.
 */
function canEarnBonus(employee: PayrollEmployee, period: PayrollPeriodWindow): boolean {
  return (
    employedDuring(employee, period) &&
    employee.nicheIds.length > 0 &&
    employee.hitPaymentMinor > 0
  );
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
 *
 * A niche with no threshold is not in the running at all — it has no bar to
 * clear and no bar to rank. What that costs is reported separately, by
 * `collectSkippedNiches`, rather than smuggled in here as a zero.
 */
function attributeShort(
  short: PayrollShort,
  assignedNicheIds: ReadonlySet<string>,
  nicheById: ReadonlyMap<string, PayrollNiche>,
): { niche: PayrollNiche; threshold: number } | null {
  let best: { niche: PayrollNiche; threshold: number } | null = null;

  for (const nicheId of short.nicheIds) {
    if (!assignedNicheIds.has(nicheId)) continue;

    const niche = nicheById.get(nicheId);
    if (!niche) continue;

    const threshold = thresholdFor(niche);
    // Narrowed before `isHit` rather than left to it. `isHit` answers false for
    // null too, but returning early is what keeps `threshold` a number for the
    // ranking below — there is no sane way to order "no bar" against 500,000.
    if (threshold === null) continue;
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
 * The Shorts a missing threshold left unjudged, grouped by the niche that is
 * missing it.
 *
 * IN SCOPE means exactly what the bonus loop means by it — own channel, inside
 * the period — because a report about what a payroll run skipped has to be
 * drawn from the same population the run considered. Anything else and the
 * count on the screen would answer a question nobody asked.
 *
 * `creditedVideoIds` is what the caller actually paid for. Those Shorts WERE
 * considered, through a niche that had a bar, so they are not evidence of
 * anything missing. The same rule serves both scopes: for one employee it is
 * that person's hits, and for a whole run it is every hit on it.
 */
function collectSkippedNiches(
  shorts: readonly PayrollShort[],
  relevantNicheIds: ReadonlySet<string>,
  nicheById: ReadonlyMap<string, PayrollNiche>,
  creditedVideoIds: ReadonlySet<string>,
  period: PayrollPeriodWindow,
): SkippedNiche[] {
  if (relevantNicheIds.size === 0) return [];

  const buckets = new Map<string, { name: string; videoIds: Set<string> }>();

  for (const short of shorts) {
    if (!short.isOwnChannel) continue;
    if (short.publishedAtMs < period.startsAtMs) continue;
    if (short.publishedAtMs >= period.endsAtMs) continue;
    if (creditedVideoIds.has(short.videoId)) continue;

    for (const nicheId of short.nicheIds) {
      if (!relevantNicheIds.has(nicheId)) continue;

      const niche = nicheById.get(nicheId);
      if (!niche || thresholdFor(niche) !== null) continue;

      const bucket = buckets.get(nicheId);
      // A Set rather than a counter, for the same reason the bonus loop keeps
      // one: a duplicated row in the input must not inflate the report either.
      if (bucket) bucket.videoIds.add(short.videoId);
      else buckets.set(nicheId, { name: niche.name, videoIds: new Set([short.videoId]) });
    }
  }

  return [...buckets.entries()]
    .map(([nicheId, bucket]) => ({
      nicheId,
      nicheName: bucket.name,
      shortCount: bucket.videoIds.size,
    }))
    // Worst first, then by name so equal rows do not shuffle — the ordering
    // `summariseByNiche` uses, so the two lists read the same way.
    .sort((a, b) => b.shortCount - a.shortCount || a.nicheName.localeCompare(b.nicheName));
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
}): PayrollCalculation {
  const { employee, shorts, niches, period } = options;

  const employed = employedDuring(employee, period);
  const assignedNicheIds = new Set(employee.nicheIds);
  const nicheById = new Map(niches.map((niche) => [niche.id, niche]));

  const hits: QualifyingHit[] = [];
  // Guards against a duplicated row in the input reaching the total twice. The
  // database's unique constraint is the real backstop; this makes the pure
  // function safe on its own terms too.
  const countedVideoIds = new Set<string>();

  const eligible = canEarnBonus(employee, period);

  if (eligible) {
    for (const short of shorts) {
      if (!short.isOwnChannel) continue;
      if (countedVideoIds.has(short.videoId)) continue;
      if (short.publishedAtMs < period.startsAtMs) continue;
      if (short.publishedAtMs >= period.endsAtMs) continue;

      const attribution = attributeShort(short, assignedNicheIds, nicheById);
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

  // Only for somebody who could have been paid. For anybody else the bonus is
  // zero for a reason that has nothing to do with a threshold, and saying
  // "Shorts were skipped" would point at the wrong problem.
  const skippedNiches = eligible
    ? collectSkippedNiches(shorts, assignedNicheIds, nicheById, countedVideoIds, period)
    : [];

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
    skippedNiches,
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
}): {
  period: PayrollPeriodWindow;
  calculations: readonly PayrollCalculation[];
  totalMinor: number;
  currency: string;
  /** What the run could not judge. See `SkippedNiche`. */
  skippedNiches: readonly SkippedNiche[];
} {
  const calculations = options.employees
    .map((employee) =>
      calculateEmployeePayroll({
        employee,
        shorts: options.shorts,
        niches: options.niches,
        period: options.period,
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
    skippedNiches: runSkippedNiches(options, calculations),
  };
}

/**
 * The run's own skipped-niche report, counted over DISTINCT Shorts.
 *
 * Not the sum of the per-employee lists. Two editors assigned to the same
 * unconfigured niche see the same Shorts go uncounted, and adding their figures
 * would tell an admin that twice as many Shorts were affected as exist. What
 * this answers is "how many Shorts in this niche could nobody be paid for",
 * which is the number that changes when the threshold is set.
 *
 * Scoped to niches somebody could actually have earned from. A niche nobody is
 * assigned to costs no money whether or not it has a bar, and this banner is
 * about pay — the niches list is where an unassigned one gets chased.
 */
function runSkippedNiches(
  options: {
    employees: readonly PayrollEmployee[];
    shorts: readonly PayrollShort[];
    niches: readonly PayrollNiche[];
    period: PayrollPeriodWindow;
  },
  calculations: readonly PayrollCalculation[],
): SkippedNiche[] {
  const bonusEligibleNicheIds = new Set<string>();
  for (const employee of options.employees) {
    if (!canEarnBonus(employee, options.period)) continue;
    for (const nicheId of employee.nicheIds) bonusEligibleNicheIds.add(nicheId);
  }

  const creditedVideoIds = new Set<string>();
  for (const calculation of calculations) {
    for (const hit of calculation.hits) creditedVideoIds.add(hit.videoId);
  }

  return collectSkippedNiches(
    options.shorts,
    bonusEligibleNicheIds,
    new Map(options.niches.map((niche) => [niche.id, niche])),
    creditedVideoIds,
    options.period,
  );
}
