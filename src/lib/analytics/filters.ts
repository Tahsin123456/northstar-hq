import type { AnalyticsVideo, DateRange } from "./types";

/**
 * Date-window membership.
 *
 * The window is half-open — `[startMs, endMs)` — which is the only convention
 * that makes adjacent buckets (used by the hit-rate-over-time series) tile the
 * timeline without double-counting a video that lands exactly on a boundary.
 */
export function isWithinRange(publishedAtMs: number, range: DateRange): boolean {
  return publishedAtMs >= range.startMs && publishedAtMs < range.endMs;
}

/**
 * The Shorts denominator for a period.
 *
 * Two filters, in this order and both mandatory:
 *   1. `isShort` — long-form videos must never contribute to a Shorts metric.
 *      Videos the classifier could not resolve are `isShort: false` too, so
 *      uncertainty excludes rather than inflates.
 *   2. upload date inside the window — the hit rate is always over Shorts
 *      *uploaded during the period*, never the channel's whole back catalogue.
 */
export function getShortsInDateRange(
  videos: readonly AnalyticsVideo[],
  range: DateRange,
): AnalyticsVideo[] {
  const result: AnalyticsVideo[] = [];
  for (const video of videos) {
    if (!video.isShort) continue;
    if (!isWithinRange(video.publishedAt, range)) continue;
    result.push(video);
  }
  return result;
}

/** Every Short regardless of date. */
export function getShorts(
  videos: readonly AnalyticsVideo[],
): AnalyticsVideo[] {
  return videos.filter((v) => v.isShort);
}

/**
 * Long-form videos inside the window. Surfaced only so the UI can say
 * "N long-form videos excluded" and prove the filtering is happening — these
 * never feed a Shorts statistic.
 */
export function getLongformInDateRange(
  videos: readonly AnalyticsVideo[],
  range: DateRange,
): AnalyticsVideo[] {
  return videos.filter((v) => !v.isShort && isWithinRange(v.publishedAt, range));
}

/** Newest first. Does not mutate the input. */
export function sortByPublishedDesc<T extends { publishedAt: number }>(
  videos: readonly T[],
): T[] {
  return [...videos].sort((a, b) => b.publishedAt - a.publishedAt);
}

/** Highest views first. Does not mutate the input. */
export function sortByViewsDesc<T extends { views: number }>(
  videos: readonly T[],
): T[] {
  return [...videos].sort((a, b) => b.views - a.views);
}
