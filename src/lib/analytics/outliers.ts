import { median } from "./stats";
import { videosInDateRange } from "./filters";
import { hitContributionOf } from "./hit-rate";
import type { NicheFormat } from "@/lib/niches/niche-format";
import type { DateRange, JudgedVideo } from "./types";

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
 * WHY AGE IS NOW A PRECONDITION AND NOT MERELY A COLUMN
 * This is the one module that ever reasoned about age at all — it has carried
 * `ageDays` and `viewsPerDay` since the beginning — and under the old rule it
 * had the same bug as everything else, pointing the other way. The multiple
 * compares a Short's LIFETIME views against a median built from its channel's
 * back catalogue, which is overwhelmingly mature. A Short published two days
 * ago is therefore measured against Shorts that have had months, and it reads
 * as an under-performer for no reason but the calendar. The very breakouts this
 * module exists to surface are the ones it was hiding.
 *
 * The fix that would be right is views-at-equal-age: compare a 48-hour-old
 * Short to what its channel's other Shorts had at 48 hours. THAT IS NOT
 * COMPUTABLE HERE, and it is worth being precise about why rather than
 * approximating it. It needs a view count for every baseline Short at the
 * target age, which means the snapshot series — 3,196 rows over 2,594 videos in
 * two capture events three days apart, with 59 Shorts sampled inside a week of
 * publishing. A median over that is a median over whichever handful somebody
 * happened to catch. The stored `viewsAtWindow` has the same coverage problem
 * for the same reason. Building an age-matched baseline on it today would be
 * inventing precision, so this module does the honest half instead:
 *
 *   A SHORT WHOSE WINDOW IS STILL OPEN GETS NO MULTIPLE AT ALL, and it is kept
 *   out of the baseline. `null` with a stated reason — the same treatment the
 *   too-small-sample case already gets — beats a number that is wrong in a
 *   known direction. `viewsPerDay` is still reported for those Shorts, and it
 *   is the age-neutral thing to rank a fresh breakout by.
 *
 * The verdict is what says "still open": a `pending` outcome IS the niche's own
 * clock, per channel, which is a better answer than any constant this file
 * could pick. The constant below is only for Shorts whose niche has no rule to
 * ask.
 *
 * WHEN THE CADENCE HAS RUN FOR A FEW MONTHS the age-matched baseline becomes
 * real and belongs here, replacing the exclusion rather than sitting beside it.
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

/**
 * How old a Short must be to be comparable when there is no rule to ask.
 *
 * Only reached for a Short whose channel sits in no configured niche, so there
 * is no window to consult and no verdict to read. Seven days because it is the
 * shortest window anybody on this account is likely to set, and the point at
 * which a Short's lifetime total stops being dominated by the first push. It is
 * a fallback, not a second definition of anything, and a Short with a real rule
 * never touches it.
 */
export const MIN_AGE_DAYS_WITHOUT_RULE = 7;

/** A channel's typical-Short benchmark over some window. */
export interface ChannelBaseline {
  readonly channelId: string;
  /** Median views of the channel's SETTLED Shorts in the baseline window. */
  readonly medianViews: number | null;
  /** Settled Shorts behind the median — the number that has to clear the floor. */
  readonly sampleSize: number;
  /**
   * Shorts in the window left out of the median because they are still in
   * flight.
   *
   * Excluded because a Short three days into a seven-day window has a lifetime
   * total that is not yet what it will be, and averaging it in drags the
   * baseline down — which would manufacture outliers out of every mature Short
   * beside it. Reported rather than silently dropped: a channel whose baseline
   * rests on 6 settled Shorts out of 30 is one an editor should read sceptically.
   */
  readonly inFlightExcluded: number;
  /** False when `sampleSize < MIN_SHORTS_FOR_BASELINE`. */
  readonly isReliable: boolean;
}

/**
 * Why a Short has no multiple. `null` when it has one.
 *
 *   "insufficient-baseline"  the channel has too few settled Shorts to have a
 *                            typical one.
 *   "in-flight"              the Short itself is not finished. Comparing it to
 *                            mature siblings would understate it by exactly the
 *                            amount of time it has left.
 */
export type UnbenchmarkableReason = "insufficient-baseline" | "in-flight";

export interface OutlierShort {
  readonly video: JudgedVideo;
  readonly channelId: string;
  /**
   * views ÷ channel median. `null` when the comparison would not be honest —
   * `unbenchmarkable` says which of the two reasons applies.
   */
  readonly outlierMultiple: number | null;
  /** Why there is no multiple, or `null` when there is one. */
  readonly unbenchmarkable: UnbenchmarkableReason | null;
  readonly channelMedianViews: number | null;
  readonly baselineSampleSize: number;
  /**
   * Views per day since upload. `null` for videos under a day old.
   *
   * THE AGE-NEUTRAL RANKING, and the reason an in-flight Short is still worth
   * returning without a multiple. A Short doing 400K/day on day two is visibly
   * a breakout; what cannot honestly be said yet is how it compares to its
   * channel's finished work.
   */
  readonly viewsPerDay: number | null;
  readonly ageDays: number;
}

const MS_PER_DAY_FOR_MATURITY = 86_400_000;

/**
 * Is this Short finished enough to be compared against mature ones?
 *
 * The niche's own clock decides wherever there is one: a `pending` verdict
 * means the window is still open, which is exactly the question being asked and
 * is per-niche rather than a number this file invented. Only a Short with no
 * rule — no niche, or an unconfigured one — falls back to the age floor.
 */
export function isSettledForComparison(video: JudgedVideo, now: number): boolean {
  const contribution = hitContributionOf(video.hit);
  if (contribution === "pending") return false;
  if (contribution !== "unscoreable") return true;
  return (now - video.publishedAt) / MS_PER_DAY_FOR_MATURITY >= MIN_AGE_DAYS_WITHOUT_RULE;
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
  videos: readonly JudgedVideo[],
  baselineRange: DateRange,
  now: number,
  // The format whose "typical video" this baseline describes. Defaulted so the
  // whole existing Shorts product keeps calling exactly what it always called;
  // the same format MUST be used here and in `calculateOutliers`' candidate
  // selection, or a long-form video would be measured against a median of
  // Shorts — a ratio with no meaning in either direction.
  format: NicheFormat = "shorts",
): ChannelBaseline {
  const shorts = videosInDateRange(videos, baselineRange, format);

  // Settled Shorts only. A "typical Short" built partly from Shorts that are
  // not finished is not a description of the channel, it is a description of
  // when the page happened to be loaded.
  const settled = shorts.filter((short) => isSettledForComparison(short, now));
  const views = settled.map((s) => s.views);
  const sampleSize = views.length;

  return {
    channelId,
    medianViews: median(views),
    sampleSize,
    inFlightExcluded: shorts.length - settled.length,
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
  video: { readonly views: number; readonly publishedAt: number },
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
 * NOTHING IS DROPPED. A Short with too small a baseline behind it, and a Short
 * that is not finished, are both returned with `outlierMultiple: null` and a
 * reason — so the UI can say "not enough history" or "still inside its hit
 * window" rather than either omitting the row or printing a number that is
 * wrong in a known direction. A director should be able to see that a channel
 * exists and cannot yet be benchmarked.
 */
export function calculateOutliers(
  channels: readonly {
    channelId: string;
    videos: readonly JudgedVideo[];
  }[],
  range: DateRange,
  baselineRange: DateRange,
  now: number,
  // One format for BOTH the candidates and their baselines — see the note on
  // `calculateChannelBaseline`. A long-form video with no niche rule still
  // falls back to the 7-day age floor via `isSettledForComparison`, which is
  // short for the format but honest: it is a floor, not a claim of maturity,
  // and any channel with a configured longform niche uses its own window.
  format: NicheFormat = "shorts",
): OutlierShort[] {
  const results: OutlierShort[] = [];

  for (const channel of channels) {
    const baseline = calculateChannelBaseline(
      channel.channelId,
      channel.videos,
      baselineRange,
      now,
      format,
    );

    for (const video of videosInDateRange(channel.videos, range, format)) {
      const { viewsPerDay, ageDays } = calculateViewsPerDay(video, now);

      // A zero or absent median cannot produce a meaningful ratio.
      const usableMedian =
        baseline.isReliable && baseline.medianViews !== null && baseline.medianViews > 0
          ? baseline.medianViews
          : null;

      // The Short's own maturity is tested before the channel's sample size,
      // because it is the more specific answer: "this one is not finished" tells
      // an editor to come back on Thursday, while "this channel has too little
      // history" tells them something about the channel.
      const unbenchmarkable: UnbenchmarkableReason | null = !isSettledForComparison(
        video,
        now,
      )
        ? "in-flight"
        : usableMedian === null
          ? "insufficient-baseline"
          : null;

      results.push({
        video,
        channelId: channel.channelId,
        outlierMultiple:
          unbenchmarkable !== null || usableMedian === null
            ? null
            : Math.round((video.views / usableMedian) * 100) / 100,
        unbenchmarkable,
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
 * A `null` multiple means "we don't know" — either the channel has too little
 * settled history, or the Short itself is still in flight — and it must never
 * outrank a measured result in either direction. Same rule the dashboard uses
 * for a channel with no hit rate, and the same rule the hit rule itself uses
 * for `pending`: an unfinished thing is not a bad thing.
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
