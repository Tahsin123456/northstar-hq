/**
 * Small, dependency-free descriptive statistics.
 *
 * Every function here returns `null` rather than `0` or `NaN` for the empty
 * input case. That distinction matters throughout this product: "no data" and
 * "a measured zero" are different claims and the UI renders them differently.
 */

/** Arithmetic mean, or `null` for an empty input. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/**
 * Median using the standard "average the two middle values" convention for
 * even-length inputs. Does not mutate the caller's array.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Linear-interpolation percentile (the "R-7"/Excel convention).
 * `p` is 0..1.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  const clamped = Math.min(1, Math.max(0, p));
  const sorted = [...values].sort((a, b) => a - b);
  const pos = clamped * (sorted.length - 1);
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower];
  const weight = pos - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Mean of the top `fraction` of values by magnitude.
 *
 * Always includes at least one value when the input is non-empty, so
 * `topFractionAverage([5], 0.1)` is `5` and not `null`. Used for the
 * "Top 10% average" metric, which shows how much of a channel's total is
 * carried by its ceiling.
 */
export function topFractionAverage(
  values: readonly number[],
  fraction: number,
): number | null {
  if (values.length === 0) return null;
  const clamped = Math.min(1, Math.max(0, fraction));
  const take = Math.max(1, Math.ceil(values.length * clamped));
  const sorted = [...values].sort((a, b) => b - a);
  return mean(sorted.slice(0, take));
}

/** Population standard deviation. `null` for empty input, `0` for one value. */
export function standardDeviation(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  if (values.length === 1) return 0;
  const avg = mean(values);
  if (avg === null) return null;
  let acc = 0;
  for (const v of values) {
    const d = v - avg;
    acc += d * d;
  }
  return Math.sqrt(acc / values.length);
}

/**
 * Consistency score, 0..100.
 *
 * Built on the *quartile coefficient of dispersion* — (Q3 − Q1) / (Q3 + Q1) —
 * rather than the coefficient of variation, because view counts are heavily
 * right-skewed and a single 40M outlier would otherwise dominate the standard
 * deviation and drag an otherwise-steady channel's score to the floor. A
 * quartile-based spread measure asks the more useful question: how wide is the
 * middle half of this channel's output?
 *
 * 100 = every Short lands in the same place. 0 = wildly erratic.
 * Returns `null` below 3 Shorts, where the number would be noise.
 */
export function consistencyScore(values: readonly number[]): number | null {
  if (values.length < 3) return null;
  const q1 = percentile(values, 0.25);
  const q3 = percentile(values, 0.75);
  if (q1 === null || q3 === null) return null;
  const denominator = q3 + q1;
  if (denominator <= 0) return null;
  const dispersion = (q3 - q1) / denominator; // 0 (identical) .. 1 (extreme)
  return Math.round(Math.min(100, Math.max(0, (1 - dispersion) * 100)) * 10) / 10;
}

/** Rounds to `decimals` places without float dust (`1.005 -> 1.01`). */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * `numerator / denominator` as a percentage, rounded to two places.
 *
 * `null` — never `0` — for an empty or nonsensical denominator. Zero out of
 * zero is not zero percent, it is the absence of a measurement, and every rate
 * in this product renders that absence as an em dash rather than as a bad
 * score. Negative or non-finite inputs are treated the same way: there is no
 * meaningful percentage to report, so none is reported.
 *
 * Lives with the statistics rather than with the hit rule because it is
 * ordinary arithmetic. `calculateHitRate` is the one that knows what a hit is;
 * this is the one that knows how to divide.
 */
export function ratePercent(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  if (!Number.isFinite(numerator) || numerator < 0) return null;
  return roundTo((numerator / denominator) * 100, 2);
}
