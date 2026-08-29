import type { AnalyticsVideo, EvaluatedShort } from "./types";
import { roundTo } from "./stats";

/**
 * THE core calculation of this product.
 *
 * @returns percentage in 0..100, or `null` when there were no Shorts.
 *
 * The `null` is not a nicety. Returning `0` for an empty denominator would
 * assert "this channel uploaded Shorts and none of them hit", which is a
 * completely different — and false — claim than "this channel uploaded nothing
 * in this window". The UI renders `null` as an em dash for exactly this reason.
 */
export function calculateHitRate(
  hitCount: number,
  totalShorts: number,
): number | null {
  if (!Number.isFinite(totalShorts) || totalShorts <= 0) return null;
  if (!Number.isFinite(hitCount) || hitCount < 0) return null;
  return roundTo((hitCount / totalShorts) * 100, 2);
}

/**
 * A Short is a hit when its *current* view count is greater than or equal to
 * the threshold. Inclusive on purpose: exactly 1,000,000 views counts as a
 * 1M hit; 999,999 does not.
 *
 * A `null` threshold is not a threshold of zero. It means the active niche has
 * never had one configured, so nothing can be called a hit — the honest answer
 * is false for every Short, and the caller renders "Not configured" rather than
 * a rate.
 */
export function isHit(views: number, threshold: number | null): boolean {
  if (threshold === null) return false;
  return views >= threshold;
}

/** Counts Shorts at or above the threshold. Assumes pre-filtered Shorts. */
export function countHits(
  shorts: readonly AnalyticsVideo[],
  threshold: number | null,
): number {
  if (threshold === null) return 0;
  let count = 0;
  for (const short of shorts) {
    if (isHit(short.views, threshold)) count += 1;
  }
  return count;
}

/** Annotates each Short with its hit status and distance from the threshold. */
export function evaluateShorts(
  shorts: readonly AnalyticsVideo[],
  threshold: number | null,
): EvaluatedShort[] {
  // No threshold, no ratio. `0` would sort every Short as an equal, maximal
  // miss; `null` says there is nothing to be a ratio of.
  const safeThreshold = threshold !== null && threshold > 0 ? threshold : null;
  return shorts.map((short) => ({
    ...short,
    isHit: isHit(short.views, threshold),
    thresholdRatio: safeThreshold === null ? null : short.views / safeThreshold,
  }));
}
