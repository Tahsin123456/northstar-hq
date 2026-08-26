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
 */
export function isHit(views: number, threshold: number): boolean {
  return views >= threshold;
}

/** Counts Shorts at or above the threshold. Assumes pre-filtered Shorts. */
export function countHits(
  shorts: readonly AnalyticsVideo[],
  threshold: number,
): number {
  let count = 0;
  for (const short of shorts) {
    if (isHit(short.views, threshold)) count += 1;
  }
  return count;
}

/** Annotates each Short with its hit status and distance from the threshold. */
export function evaluateShorts(
  shorts: readonly AnalyticsVideo[],
  threshold: number,
): EvaluatedShort[] {
  const safeThreshold = threshold > 0 ? threshold : 1;
  return shorts.map((short) => ({
    ...short,
    isHit: isHit(short.views, threshold),
    thresholdRatio: short.views / safeThreshold,
  }));
}
