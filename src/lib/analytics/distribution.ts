import { VIEW_BUCKETS } from "./constants";
import type { AnalyticsVideo, ViewBucket, ViewDistributionBin } from "./types";

/** Which bucket does a view count fall into? `null` if none matches. */
function findBucketIndex(views: number, buckets: readonly ViewBucket[]): number {
  for (let i = 0; i < buckets.length; i += 1) {
    const bucket = buckets[i];
    const aboveMin = views >= bucket.min;
    const belowMax = bucket.max === null || views < bucket.max;
    if (aboveMin && belowMax) return i;
  }
  return -1;
}

/**
 * Histogram of Shorts by view count.
 *
 * This is the antidote to hit rate being read in isolation: two channels can
 * both sit at 20% while one clusters just under the line and the other is
 * carried by two outliers with nothing in between. The shape tells you which.
 *
 * `isHitBucket` marks buckets that sit entirely at or above the threshold, so
 * the chart can shade the "hit zone" without re-deriving it.
 */
export function calculateViewDistribution(
  shorts: readonly AnalyticsVideo[],
  threshold: number,
  buckets: readonly ViewBucket[] = VIEW_BUCKETS,
): ViewDistributionBin[] {
  const counts = new Array<number>(buckets.length).fill(0);

  for (const short of shorts) {
    const index = findBucketIndex(short.views, buckets);
    if (index >= 0) counts[index] += 1;
  }

  const total = shorts.length;

  return buckets.map((bucket, i) => ({
    ...bucket,
    count: counts[i],
    share: total === 0 ? 0 : counts[i] / total,
    isHitBucket: bucket.min >= threshold,
  }));
}
