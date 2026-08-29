import { getShortsInDateRange } from "./filters";
import { calculateHitRate, EMPTY_HIT_TALLY, tallyShorts } from "./hit-rate";
import { median, roundTo, sum } from "./stats";
import type {
  DateRange,
  HitRateSeriesPoint,
  JudgedVideo,
  SeriesGranularity,
} from "./types";

const MS_PER_DAY = 86_400_000;

/**
 * Chooses a bucket size that yields a readable number of points (roughly
 * 6–30) for the given window, so the chart never degenerates into a single bar
 * or a thousand-point hairball.
 */
export function pickGranularity(range: DateRange): SeriesGranularity {
  const days = (range.endMs - range.startMs) / MS_PER_DAY;
  if (days <= 21) return "day";
  if (days <= 180) return "week";
  return "month";
}

/** Start of the bucket containing `ms`, in local time. */
function bucketStart(ms: number, granularity: SeriesGranularity): number {
  const date = new Date(ms);
  if (granularity === "day") {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  }
  if (granularity === "week") {
    // ISO-style weeks starting Monday.
    const day = date.getDay();
    const daysSinceMonday = (day + 6) % 7;
    const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysSinceMonday);
    return monday.getTime();
  }
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

function nextBucket(ms: number, granularity: SeriesGranularity): number {
  const date = new Date(ms);
  if (granularity === "day") {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  }
  if (granularity === "week") {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 7).getTime();
  }
  return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
}

function formatBucketLabel(ms: number, granularity: SeriesGranularity): string {
  const date = new Date(ms);
  if (granularity === "month") {
    return date.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * =========================================================================
 * HIT RATE OVER TIME
 * =========================================================================
 *
 * Buckets are emitted even when empty, and an empty bucket carries a summary
 * whose `rate` is `null` rather than `0`. That is what lets the chart draw a
 * GAP for a week with no uploads instead of a plunge to zero — the difference
 * between "this channel paused" and "this channel published and missed", which
 * is exactly the signal someone judging consistency needs to see.
 *
 * THE RIGHT-HAND END OF THIS CHART USED TO BE A LIE, and fixing it is most of
 * the reason the rule changed. Buckets are keyed on UPLOAD DATE, so the last
 * few always held the youngest Shorts — and under a lifetime comparison the
 * youngest Shorts had had the least time to reach the bar. The line therefore
 * sagged on the right on every channel, always, whatever the work was like: on
 * this corpus 5.9% under seven days old against 18.8% at 30–90 days. Somebody
 * reading it saw a decline they had not caused and could not fix.
 *
 * Now a Short inside its window is `pending` and sits in NEITHER half of its
 * bucket's ratio. A bucket of Shorts that are all still in flight reports
 * `rate: null` and draws as a gap — the honest statement, "not decided yet" —
 * and it fills in as the windows shut. The line stops sloping down because time
 * ran out on the right-hand side.
 *
 * `totalShorts` is still every Short uploaded in the bucket, so the tooltip can
 * say how much of a bucket is waiting rather than making the gap mysterious.
 */
export function calculateHitRateSeries(
  videos: readonly JudgedVideo[],
  range: DateRange,
  granularity: SeriesGranularity = pickGranularity(range),
): HitRateSeriesPoint[] {
  const shorts = getShortsInDateRange(videos, range);

  const byBucket = new Map<number, JudgedVideo[]>();
  for (const short of shorts) {
    const key = bucketStart(short.publishedAt, granularity);
    const existing = byBucket.get(key);
    if (existing) existing.push(short);
    else byBucket.set(key, [short]);
  }

  const points: HitRateSeriesPoint[] = [];
  let cursor = bucketStart(range.startMs, granularity);
  // Guard against a pathological range producing an unbounded loop.
  let iterations = 0;

  while (cursor < range.endMs && iterations < 1000) {
    iterations += 1;
    const end = nextBucket(cursor, granularity);
    const bucketVideos = byBucket.get(cursor) ?? [];
    const views = bucketVideos.map((v) => v.views);

    points.push({
      bucketStartMs: cursor,
      bucketEndMs: end,
      label: formatBucketLabel(cursor, granularity),
      totalShorts: bucketVideos.length,
      hits: calculateHitRate(
        bucketVideos.length === 0 ? EMPTY_HIT_TALLY : tallyShorts(bucketVideos),
      ),
      totalViews: sum(views),
      medianViews: median(views),
    });

    cursor = end;
  }

  return points;
}

/**
 * Trend of the hit rate across the window: the difference between the second
 * half and the first half, in percentage points.
 *
 * Halves rather than a regression line because the audience question is blunt
 * — "is this channel getting better or worse lately?" — and a slope in
 * percent-per-week is harder to read than "+6.2 pts vs the first half".
 *
 * `null` when either half has no JUDGED Shorts to compare, which is a stricter
 * condition than it used to be and deliberately so. The second half of any
 * window is the recent one, so under the old lifetime rule this number was
 * biased downward by construction and reported a decline on healthy channels.
 * With in-flight Shorts excluded, a second half that is entirely pending has no
 * rate at all and the answer is "nothing to say yet" rather than a fabricated
 * fall.
 *
 * The two halves' EXCLUSIONS come back with it. A trend computed over 4 judged
 * Shorts against 90 is not the same statement as one over 200 against 210, and
 * the caller needs to be able to tell.
 */
export function calculateHitRateTrend(
  videos: readonly JudgedVideo[],
  range: DateRange,
): {
  delta: number;
  firstHalf: number;
  secondHalf: number;
  firstJudged: number;
  secondJudged: number;
} | null {
  const midpoint = range.startMs + (range.endMs - range.startMs) / 2;

  const first = getShortsInDateRange(videos, { startMs: range.startMs, endMs: midpoint });
  const second = getShortsInDateRange(videos, { startMs: midpoint, endMs: range.endMs });

  const firstSummary = calculateHitRate(tallyShorts(first));
  const secondSummary = calculateHitRate(tallyShorts(second));

  if (firstSummary.rate === null || secondSummary.rate === null) return null;

  return {
    delta: roundTo(secondSummary.rate - firstSummary.rate, 2),
    firstHalf: firstSummary.rate,
    secondHalf: secondSummary.rate,
    firstJudged: firstSummary.judged,
    secondJudged: secondSummary.judged,
  };
}

