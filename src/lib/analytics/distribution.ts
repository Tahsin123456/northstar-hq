import { VIEW_BUCKETS } from "./constants";
import { EMPTY_HIT_TALLY, tallyShorts } from "./hit-rate";
import type { JudgedVideo, ViewBucket, ViewDistributionBin } from "./types";

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
 * ==========================================================================
 * HISTOGRAM OF SHORTS BY LIFETIME VIEW COUNT
 * ==========================================================================
 *
 * This is the antidote to a hit rate read in isolation: two channels can both
 * sit at 20% while one clusters just under the line and the other is carried by
 * two outliers with nothing in between. The shape tells you which.
 *
 * ---------------------------------------------------------------------------
 * WHY THE X-AXIS IS STILL LIFETIME VIEWS, AND WHY THAT IS THE HONEST CHOICE
 * ---------------------------------------------------------------------------
 * Under a windowed rule the tempting chart is views AT THE WINDOW — the number
 * the rule actually reads. That chart is not computable on this account and
 * would be a lie if drawn: `viewsAtWindow` is populated only where a snapshot
 * was captured inside the window, which is 59 of 1,904 Shorts. The other 1,845
 * were judged either by direct evidence they cleared the bar or by the
 * inference that a Short still under it today was under it then — sound
 * verdicts, but neither one hands back a NUMBER to put on an axis.
 *
 * So a views-at-window histogram would be a picture of 3% of the library shown
 * with the library's name on it. Drawing the same distribution over a set of 59
 * would also be dominated by the ones somebody happened to sample early, which
 * is exactly the sampling the snapshot cadence work has only just started
 * fixing. That chart becomes worth building when the cadence has been running
 * for a few months; today it is not, and a plausible-looking chart is worse
 * than an absent one.
 *
 * WHAT CHANGED HERE INSTEAD, since a chart that claimed to show hits had to
 * stop claiming it:
 *
 *   1. `isHitBucket` is now `isAboveThreshold`. It marks where the BAR falls on
 *      a lifetime axis. It never meant "these are hits" and now cannot be read
 *      that way: a Short in the top bucket may have taken three years to get
 *      there, which is a miss under the rule and would have been shaded as a
 *      win under the old name.
 *
 *   2. Each bin carries the VERDICTS of the Shorts in it. That is the part of
 *      "where do the hits actually sit" that IS answerable from what the
 *      database knows, and it is the interesting half: a bucket of forty Shorts
 *      well over the bar, of which two are judged hits and thirty-eight are
 *      unknowns, is a specific and important thing to be able to say, and the
 *      height of the bar cannot say it.
 *
 * The distribution itself is unchanged and remains entirely real: it is a
 * description of the library, not a verdict on it.
 */
export function calculateViewDistribution(
  shorts: readonly JudgedVideo[],
  threshold: number | null,
  buckets: readonly ViewBucket[] = VIEW_BUCKETS,
): ViewDistributionBin[] {
  const grouped: JudgedVideo[][] = buckets.map(() => []);

  for (const short of shorts) {
    const index = findBucketIndex(short.views, buckets);
    if (index >= 0) grouped[index].push(short);
  }

  const total = shorts.length;

  return buckets.map((bucket, i) => ({
    ...bucket,
    count: grouped[i].length,
    share: total === 0 ? 0 : grouped[i].length / total,
    // The bar's position on the axis, with no verdict attached. A `null`
    // threshold marks nothing: there is no bar to be above.
    isAboveThreshold: threshold !== null && bucket.min >= threshold,
    // Empty buckets get the empty tally rather than being skipped, so a caller
    // can read `tally` on every bin without a null check and an empty bucket
    // reports zeroes rather than an absence.
    tally: grouped[i].length === 0 ? EMPTY_HIT_TALLY : tallyShorts(grouped[i]),
  }));
}
