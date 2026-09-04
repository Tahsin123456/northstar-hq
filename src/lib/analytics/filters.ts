import { isVideoOfFormat, type NicheFormat } from "@/lib/niches/niche-format";
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
 * One format's denominator for a period.
 *
 * Two filters, both mandatory:
 *   1. format membership, per `isVideoOfFormat` — the one place the
 *      shorts/longform rule lives. Shorts is `isShort === true`; longform is
 *      `classification === "not_short"`; a video the classifier could not
 *      resolve matches NEITHER, so uncertainty shrinks either sample rather
 *      than inflating one.
 *   2. upload date inside the window — every metric is over videos *uploaded
 *      during the period*, never the channel's whole back catalogue.
 *
 * Generic over the element, exactly like `sortByViewsDesc` below: this narrows
 * without reshaping, so a caller that passes richer rows — a `VideoDTO` with
 * its content-type ids, say — gets those rows back rather than having to cast
 * the engine's minimum shape back up to what it just handed in.
 */
export function videosInDateRange<T extends AnalyticsVideo>(
  videos: readonly T[],
  range: DateRange,
  format: NicheFormat,
): T[] {
  const result: T[] = [];
  for (const video of videos) {
    if (!isVideoOfFormat(video, format)) continue;
    if (!isWithinRange(video.publishedAt, range)) continue;
    result.push(video);
  }
  return result;
}

/**
 * The Shorts denominator for a period.
 *
 * A delegating alias of `videosInDateRange(…, "shorts")`, kept under its own
 * name because its ten-odd call sites are the whole Shorts product and they
 * all mean exactly this. The predicate is unchanged from what it always was —
 * `isShort === true`, then the window — it just lives in `isVideoOfFormat`
 * now, beside the longform rule it must never be confused with.
 */
export function getShortsInDateRange<T extends AnalyticsVideo>(
  videos: readonly T[],
  range: DateRange,
): T[] {
  return videosInDateRange(videos, range, "shorts");
}

/** Every Short regardless of date. */
export function getShorts(
  videos: readonly AnalyticsVideo[],
): AnalyticsVideo[] {
  return videos.filter((v) => v.isShort);
}

/**
 * Long-form videos inside the window — the STRICT selector.
 *
 * `classification === "not_short"`, via `isVideoOfFormat`, and no longer
 * `!isShort`. The old complement quietly counted every video the classifier
 * could not resolve as long-form; the strict rule keeps uncertain videos out
 * of BOTH formats, which is the only reading under which "long-form" names a
 * population somebody measured rather than a leftover.
 *
 * NOTE FOR THE ONE DISPLAY THAT COUNTS EXCLUSIONS: `excludedLongform` in
 * `channel-metrics.ts` deliberately does NOT use this selector — its number is
 * "in-range videos that are not Shorts", which includes uncertain videos, and
 * changing that displayed figure is out of bounds. See the comment there.
 */
export function getLongformInDateRange(
  videos: readonly AnalyticsVideo[],
  range: DateRange,
): AnalyticsVideo[] {
  return videosInDateRange(videos, range, "longform");
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
