import { calculateHitRate } from "./hit-rate";
import { getShortsInDateRange } from "./filters";
import { median, sum } from "./stats";
import type {
  AnalyticsVideo,
  DateRange,
  HitRateSeriesPoint,
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
 * Hit rate over time.
 *
 * Buckets are emitted even when empty, and an empty bucket carries
 * `hitRate: null` rather than `0`. That is what lets the chart draw a *gap*
 * for a week with no uploads instead of a plunge to zero — the difference
 * between "this channel paused" and "this channel published and missed", which
 * is exactly the signal someone judging consistency needs to see.
 */
export function calculateHitRateSeries(
  videos: readonly AnalyticsVideo[],
  range: DateRange,
  threshold: number,
  granularity: SeriesGranularity = pickGranularity(range),
): HitRateSeriesPoint[] {
  const shorts = getShortsInDateRange(videos, range);

  const byBucket = new Map<number, AnalyticsVideo[]>();
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
    const hitCount = bucketVideos.filter((v) => v.views >= threshold).length;

    points.push({
      bucketStartMs: cursor,
      bucketEndMs: end,
      label: formatBucketLabel(cursor, granularity),
      totalShorts: bucketVideos.length,
      hitCount,
      hitRate: calculateHitRate(hitCount, bucketVideos.length),
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
 * `null` when either half has no Shorts to compare.
 */
export function calculateHitRateTrend(
  videos: readonly AnalyticsVideo[],
  range: DateRange,
  threshold: number,
): { delta: number; firstHalf: number; secondHalf: number } | null {
  const midpoint = range.startMs + (range.endMs - range.startMs) / 2;

  const first = getShortsInDateRange(videos, { startMs: range.startMs, endMs: midpoint });
  const second = getShortsInDateRange(videos, { startMs: midpoint, endMs: range.endMs });

  const firstRate = calculateHitRate(
    first.filter((v) => v.views >= threshold).length,
    first.length,
  );
  const secondRate = calculateHitRate(
    second.filter((v) => v.views >= threshold).length,
    second.length,
  );

  if (firstRate === null || secondRate === null) return null;

  return {
    delta: Math.round((secondRate - firstRate) * 100) / 100,
    firstHalf: firstRate,
    secondHalf: secondRate,
  };
}
