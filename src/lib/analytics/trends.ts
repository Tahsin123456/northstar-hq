import { roundTo } from "./stats";
import type { DateRange } from "./types";

/**
 * =========================================================================
 * TREND INDICATORS
 * =========================================================================
 *
 * Turns "this period vs the previous equivalent period" into something a
 * reader can act on at a glance.
 *
 * THREE RULES THIS ENCODES
 *
 * 1. Percentage points are not percentages.
 *    A hit rate moving 20% -> 25% is "+5 pp", never "+5%" (which would be
 *    25 -> 26.25) and never "+25%" (the relative change). Conflating the two
 *    is the single most common way a metrics dashboard misleads, so the unit
 *    is part of the type rather than a formatting afterthought.
 *
 * 2. Direction is a property of the metric, not of the arrow.
 *    Higher hit rate is good. Higher median views is good. Higher upload
 *    frequency is neither — a team running a deliberate low-volume,
 *    high-craft format is not "losing" for posting less. Metrics declared
 *    `neutral` still show movement but are never coloured as good or bad.
 *
 * 3. No baseline, no trend.
 *    If the previous period has no data to compare against, the answer is an
 *    em dash. Inventing a direction from a missing denominator is worse than
 *    admitting there is nothing to say.
 *
 * A CAVEAT THAT NOW APPLIES TO SOME METRICS AND NOT OTHERS
 * View-based comparisons — total views, median, average, top decile — use
 * *current* view counts. Shorts uploaded during the previous window have had a
 * full extra period to accumulate views, so the older period is systematically
 * flattered on those. Removing that bias needs a view count captured at matched
 * ages, which requires snapshot history spanning both windows.
 *
 * THE HIT RATE IS NO LONGER ONE OF THEM, and that is the whole reason the rule
 * changed. A hit is a bar reached inside a fixed window of each Short's own
 * life, so both periods are measured over the same stretch of maturity by
 * construction; a Short whose window is still open is `pending` and sits in
 * neither period's ratio rather than dragging the recent one down. A hit-rate
 * trend is now a statement about the work.
 *
 * The caveat is documented in the UI rather than hidden, and `unit` is what
 * decides whether it applies — see `TREND_MATURATION_CAVEAT` and
 * `trendCaveatFor`.
 */

export type TrendDirection = "higherIsBetter" | "lowerIsBetter" | "neutral";

export type TrendMovement = "up" | "down" | "flat";

/** How a delta should be read and rendered. */
export type TrendUnit =
  /** The metric is itself a percentage; the delta is in percentage points. */
  | "percentagePoints"
  /** The metric is a magnitude; the delta is a relative percentage. */
  | "relativePercent";

export interface Trend {
  readonly current: number | null;
  readonly previous: number | null;
  /** Absolute difference in the metric's own unit. */
  readonly delta: number | null;
  /** Relative change as a percentage. `null` when previous is 0 or absent. */
  readonly deltaPercent: number | null;
  readonly movement: TrendMovement;
  readonly unit: TrendUnit;
  readonly direction: TrendDirection;
  /**
   * True when the movement is good, false when bad, `null` when the metric is
   * directionally neutral or there is nothing to compare. Drives colour.
   */
  readonly isImprovement: boolean | null;
  /** False when there is no usable baseline — render an em dash. */
  readonly hasComparison: boolean;
}

/**
 * Movement smaller than this is reported as flat.
 *
 * Without a dead zone a 0.03pp wobble renders as a green arrow, which trains
 * the reader to ignore arrows entirely. Expressed in each unit's own terms.
 */
export const FLAT_THRESHOLD_POINTS = 0.5;
export const FLAT_THRESHOLD_PERCENT = 1;

export const TREND_MATURATION_CAVEAT =
  "This comparison uses current view counts. Shorts uploaded in the earlier window have had longer to accumulate views, so the previous period is slightly flattered and the current one understated. Age-matched comparison requires view snapshots spanning both windows.";

/**
 * Why a hit-rate trend does NOT carry the caveat above.
 *
 * Worth stating rather than merely omitting: a reader who has seen the
 * maturation warning on the views tiles will reasonably assume it applies here
 * too, and quietly discount a real improvement.
 */
export const TREND_WINDOWED_NOTE =
  "Both periods are measured the same way: each Short is judged over the same fixed window of its own life, and Shorts still inside their window are in neither period. The comparison carries no age bias.";

/**
 * The caveat that belongs beside a trend, or `null` when none does.
 *
 * Keyed on the unit rather than on a per-call-site flag, because the unit is
 * already the thing that says what kind of number this is: `percentagePoints`
 * means the metric is itself a rate — a hit rate, on every surface that draws
 * one — and rates are windowed now. `relativePercent` means a magnitude, and
 * magnitudes are lifetime totals that the older period has had longer to grow.
 */
export function trendCaveatFor(unit: TrendUnit): string {
  return unit === "percentagePoints" ? TREND_WINDOWED_NOTE : TREND_MATURATION_CAVEAT;
}

/**
 * The equivalent window immediately before `range`.
 *
 * Same duration, ending exactly where the current window starts — so 30D
 * compares against the 30 days before it, with no gap and no overlap.
 */
export function previousRange(range: DateRange): DateRange {
  const span = range.endMs - range.startMs;
  return { startMs: range.startMs - span, endMs: range.startMs };
}

export function calculateTrend(
  current: number | null,
  previous: number | null,
  options: { direction: TrendDirection; unit: TrendUnit },
): Trend {
  const { direction, unit } = options;

  const base: Omit<Trend, "delta" | "deltaPercent" | "movement" | "isImprovement" | "hasComparison"> = {
    current,
    previous,
    unit,
    direction,
  };

  // No baseline: say nothing rather than guess a direction.
  if (current === null || previous === null) {
    return {
      ...base,
      delta: null,
      deltaPercent: null,
      movement: "flat",
      isImprovement: null,
      hasComparison: false,
    };
  }

  const delta = roundTo(current - previous, 2);
  const deltaPercent =
    previous === 0 ? null : roundTo(((current - previous) / Math.abs(previous)) * 100, 1);

  // Compare against the dead zone in whichever unit will actually be shown.
  const magnitude =
    unit === "percentagePoints" ? Math.abs(delta) : Math.abs(deltaPercent ?? 0);
  const threshold =
    unit === "percentagePoints" ? FLAT_THRESHOLD_POINTS : FLAT_THRESHOLD_PERCENT;

  const movement: TrendMovement =
    magnitude < threshold ? "flat" : delta > 0 ? "up" : "down";

  const isImprovement =
    direction === "neutral" || movement === "flat"
      ? null
      : direction === "higherIsBetter"
        ? movement === "up"
        : movement === "down";

  return {
    ...base,
    delta,
    deltaPercent,
    movement,
    isImprovement,
    hasComparison: true,
  };
}

/**
 * Renders a trend as text: "+4.2 pp", "−8.3%", "0%".
 *
 * The unit suffix is driven by `Trend.unit`, so a rate can never accidentally
 * be printed as a relative percentage.
 */
export function formatTrendDelta(trend: Trend): string {
  if (!trend.hasComparison) return "—";

  if (trend.unit === "percentagePoints") {
    const value = trend.delta ?? 0;
    if (trend.movement === "flat") return "0 pp";
    const sign = value > 0 ? "+" : "−";
    return `${sign}${Math.abs(value).toFixed(1)} pp`;
  }

  if (trend.deltaPercent === null) return "—";
  if (trend.movement === "flat") return "0%";
  const sign = trend.deltaPercent > 0 ? "+" : "−";
  return `${sign}${Math.abs(trend.deltaPercent).toFixed(1)}%`;
}

/** Arrow glyph for the movement. Kept here so text and UI never disagree. */
export function trendGlyph(movement: TrendMovement): string {
  return movement === "up" ? "↑" : movement === "down" ? "↓" : "→";
}
