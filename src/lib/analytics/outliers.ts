import { median } from "./stats";
import { getShortsInDateRange } from "./filters";
import type { AnalyticsVideo, DateRange } from "./types";

/**
 * =========================================================================
 * OUTLIER DETECTION
 * =========================================================================
 *
 * WHY NOT ABSOLUTE VIEWS
 * A 5M-view Short from a channel that routinely does 4M is unremarkable. A
 * 4M-view Short from a channel whose typical Short does 100K is the single
 * most interesting thing in the dataset. Ranking by raw views surfaces big
 * channels; ranking by performance *relative to the channel's own baseline*
 * surfaces breakouts, which is what a creative director is actually hunting
 * for.
 *
 *     outlier multiple = short views / channel median short views
 *
 * WHY MEDIAN, NOT MEAN
 * The mean is contaminated by the very thing being measured. One 40M Short
 * drags a channel's average up so far that the next breakout looks ordinary
 * against it — the metric hides exactly what it exists to find. The median is
 * unmoved by outliers, so the baseline stays an honest description of a
 * channel's *typical* Short.
 *
 * WHY A MINIMUM SAMPLE
 * A median over two Shorts is not a baseline, it is a coin flip. If one of
 * them happened to flop, every subsequent upload reads as a 30x "breakout".
 * Below `MIN_SHORTS_FOR_BASELINE` no multiple is reported at all — the honest
 * answer is "not enough data", not a large and meaningless number.
 */

/**
 * Minimum Shorts a channel must have in the baseline window before a multiple
 * is trustworthy.
 *
 * Five is the smallest sample where a median has a genuine majority behind it
 * (three of five values sit at or below it) and one flop cannot move it far.
 * Set higher and channels that post weekly are excluded for months; set lower
 * and the metric starts manufacturing 30x outliers out of noise.
 */
export const MIN_SHORTS_FOR_BASELINE = 5;

/** A channel's typical-Short benchmark over some window. */
export interface ChannelBaseline {
  readonly channelId: string;
  /** Median views of the channel's Shorts in the baseline window. */
  readonly medianViews: number | null;
  readonly sampleSize: number;
  /** False when `sampleSize < MIN_SHORTS_FOR_BASELINE`. */
  readonly isReliable: boolean;
}

export interface OutlierShort {
  readonly video: AnalyticsVideo;
  readonly channelId: string;
  /** views / channel median. `null` when the baseline is unreliable. */
  readonly outlierMultiple: number | null;
  readonly channelMedianViews: number | null;
  readonly baselineSampleSize: number;
  /** Views per day since upload. `null` for videos under a day old. */
  readonly viewsPerDay: number | null;
  readonly ageDays: number;
}

/**
 * Computes a channel's baseline from its Shorts in a window.
 *
 * The baseline window is intentionally a *parameter* rather than the analysis
 * period. Judging a 3-day-old Short against a 3-day median would compare it to
 * one or two siblings; the caller passes a wider window so "typical" means
 * something.
 */
export function calculateChannelBaseline(
  channelId: string,
  videos: readonly AnalyticsVideo[],
  baselineRange: DateRange,
): ChannelBaseline {
  const shorts = getShortsInDateRange(videos, baselineRange);
  const views = shorts.map((s) => s.views);
  const sampleSize = views.length;

  return {
    channelId,
    medianViews: median(views),
    sampleSize,
    isReliable: sampleSize >= MIN_SHORTS_FOR_BASELINE,
  };
}

const MS_PER_DAY = 86_400_000;

/**
 * Views per day since upload.
 *
 * `null` under one full day: a Short two hours old with 40K views is not
 * "480K/day", and presenting that extrapolation as a rate would rank brand-new
 * uploads above genuinely successful ones.
 */
export function calculateViewsPerDay(
  video: AnalyticsVideo,
  now: number,
): { viewsPerDay: number | null; ageDays: number } {
  const ageMs = Math.max(0, now - video.publishedAt);
  const ageDays = ageMs / MS_PER_DAY;
  if (ageDays < 1) return { viewsPerDay: null, ageDays };
  return { viewsPerDay: Math.round(video.views / ageDays), ageDays };
}

/**
 * Scores every Short in `range` against its own channel's baseline.
 *
 * Shorts whose channel has too small a sample are still returned, with
 * `outlierMultiple: null`, so the UI can show them as "Insufficient data"
 * rather than dropping them silently — a director should be able to see that a
 * channel exists but cannot yet be benchmarked.
 */
export function calculateOutliers(
  channels: readonly {
    channelId: string;
    videos: readonly AnalyticsVideo[];
  }[],
  range: DateRange,
  baselineRange: DateRange,
  now: number,
): OutlierShort[] {
  const results: OutlierShort[] = [];

  for (const channel of channels) {
    const baseline = calculateChannelBaseline(
      channel.channelId,
      channel.videos,
      baselineRange,
    );

    for (const video of getShortsInDateRange(channel.videos, range)) {
      const { viewsPerDay, ageDays } = calculateViewsPerDay(video, now);

      // A zero or absent median cannot produce a meaningful ratio.
      const usableMedian =
        baseline.isReliable && baseline.medianViews !== null && baseline.medianViews > 0
          ? baseline.medianViews
          : null;

      results.push({
        video,
        channelId: channel.channelId,
        outlierMultiple:
          usableMedian === null
            ? null
            : Math.round((video.views / usableMedian) * 100) / 100,
        channelMedianViews: baseline.medianViews,
        baselineSampleSize: baseline.sampleSize,
        viewsPerDay,
        ageDays,
      });
    }
  }

  return results;
}

export type OutlierSortKey = "outlierMultiple" | "views" | "viewsPerDay" | "publishedAt";

/**
 * Sorts scored Shorts, always keeping unbenchmarkable ones last.
 *
 * A `null` multiple means "we don't know", which must never outrank a measured
 * result in either direction — the same rule the dashboard uses for channels
 * with no hit rate.
 */
export function sortOutliers(
  shorts: readonly OutlierShort[],
  key: OutlierSortKey,
): OutlierShort[] {
  const valueOf = (s: OutlierShort): number | null => {
    switch (key) {
      case "views":
        return s.video.views;
      case "viewsPerDay":
        return s.viewsPerDay;
      case "publishedAt":
        return s.video.publishedAt;
      case "outlierMultiple":
      default:
        return s.outlierMultiple;
    }
  };

  return [...shorts].sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    if (av === null && bv === null) return b.video.views - a.video.views;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (bv !== av) return bv - av;
    return b.video.views - a.video.views;
  });
}
