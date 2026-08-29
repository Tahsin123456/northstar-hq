/**
 * Analytics engine — shared types.
 *
 * Everything in `src/lib/analytics` is a pure function over these shapes. No
 * Prisma types, no React types, no I/O. That is what lets the *identical* code
 * run on the server (when persisting or exporting) and in the browser (when the
 * user drags the threshold slider), and what makes the whole thing unit
 * testable without a database.
 */

import type { HitRateSummary, HitTally, StoredHitVerdict } from "./hit-rate";

/**
 * The minimal projection of a video the engine needs.
 *
 * `publishedAt` is epoch milliseconds rather than a Date so the shape survives
 * a JSON round-trip to the client without a revive step, and so date comparison
 * is an integer compare in the hot path.
 */
export interface AnalyticsVideo {
  readonly id: string;
  readonly youtubeVideoId: string;
  readonly title: string;
  /** Epoch milliseconds (UTC). */
  readonly publishedAt: number;
  readonly views: number;
  readonly likes: number | null;
  readonly comments: number | null;
  readonly durationSeconds: number;
  /**
   * True only for videos the classifier positively identified as Shorts.
   * Long-form and unclassifiable videos are both false — see
   * `server/services/youtube/shorts-detector`.
   */
  readonly isShort: boolean;
}

/**
 * A video plus the verdict the evaluator reached about it.
 *
 * THE SHAPE EVERY HIT METRIC NOW TAKES. A hit is views-within-a-window, and no
 * amount of arithmetic over `views` and a threshold can reconstruct one — the
 * evidence is a snapshot series that lives in the database and the answer is
 * materialised on `VideoHitEvaluation`. So the verdict travels with the row,
 * from the evaluator through the DTO to the browser, and the pure functions in
 * this directory COUNT verdicts rather than deciding them.
 *
 * `null` means no evaluation has been stored for this Short yet, which is a
 * real state rather than a defect: the evaluator runs on the sync cron, so a
 * Short discovered ten minutes ago genuinely has no answer. See
 * `hitContributionOf`, which is where that null is turned into a contribution.
 */
export interface JudgedVideo extends AnalyticsVideo {
  readonly hit: StoredHitVerdict | null;
}

/** A closed-open date window: `[startMs, endMs)`. */
export interface DateRange {
  readonly startMs: number;
  readonly endMs: number;
}

/** Canonical trailing-window presets offered in the UI. */
export type PeriodPresetId = "7d" | "30d" | "90d" | "180d" | "custom";

export interface PeriodSelection {
  readonly preset: PeriodPresetId;
  /** Only meaningful when `preset === "custom"`. Epoch ms. */
  readonly customStartMs?: number;
  readonly customEndMs?: number;
}

/** One bucket of the views histogram. */
export interface ViewBucket {
  readonly id: string;
  readonly label: string;
  /** Inclusive lower bound. */
  readonly min: number;
  /** Exclusive upper bound; `null` means unbounded. */
  readonly max: number | null;
}

export interface ViewDistributionBin extends ViewBucket {
  readonly count: number;
  /** Share of the analysed Shorts in this bucket, 0..1. `0` when no Shorts. */
  readonly share: number;
  /**
   * Every video in this bucket has lifetime views at or above the active bar.
   *
   * NOT "this is the hit zone", which is what the field used to be called and
   * what the shading used to imply. The x-axis is lifetime views; a hit is a
   * bar reached inside a window, and a Short can sit in the top bucket having
   * taken three years to get there. This flag marks where the bar falls on the
   * axis and nothing more.
   */
  readonly isAboveThreshold: boolean;
  /**
   * The verdicts of the Shorts in this bucket.
   *
   * Carried because the shape of the distribution and the shape of the RATE are
   * different questions and this is the one place both are in hand: a bucket of
   * forty Shorts sitting well over the bar of which two are judged hits and
   * thirty-eight are unknowns is a specific and important thing to be able to
   * say, and it is invisible from the height of the bar alone.
   */
  readonly tally: HitTally;
}

/**
 * Where a Short sits relative to a bar. Two ratios, because there are two bars.
 *
 * Applied by `annotateAgainstThreshold`, which is a DISPLAY helper: shading a
 * table row, sorting near-misses, drawing a histogram. None of it is a verdict.
 */
export interface ThresholdAnnotation {
  /**
   * Lifetime views are at or above the threshold the screen is exploring with.
   *
   * NOT "this Short is a hit", which is why the field is no longer called that.
   * A hit is the bar reached inside the niche's window; it is decided by
   * `evaluateHit`, stored on `VideoHitEvaluation`, and read from `hit` on the
   * row. It is not derivable from the two numbers this flag compares.
   */
  readonly clearsThreshold: boolean;
  /**
   * views ÷ threshold, against the bar the SCREEN is using. Lifetime, and named
   * so — the field it replaces was `thresholdRatio`, which was read as "how
   * close did it come to being a hit" while measuring something else entirely.
   *
   * `null` when there is no configured threshold to be relative *to*. A ratio
   * against a borrowed default would read as a measurement somebody made.
   */
  readonly lifetimeRatio: number | null;
  /**
   * viewsAtWindow ÷ the threshold that judged it. How close it came where the
   * rule actually looks.
   *
   * `null` for the large majority of Shorts on this account, because a miss
   * inferred from "lifetime is still under the bar" never observed anything
   * inside the window. That null is the honest answer and the reason both
   * ratios exist rather than one.
   */
  readonly windowRatio: number | null;
}

/** A single Short, its verdict, and where it sits relative to the active bar. */
export interface EvaluatedShort extends JudgedVideo, ThresholdAnnotation {}

/**
 * The complete metric set for one channel over one period.
 *
 * NO LONGER "over one (period, threshold) pair". The threshold is a lens the
 * screen looks through, not a definition any more: hits come from the stored
 * verdicts on the rows, decided per niche against a bar AND a window, so
 * changing the control changes what is shaded and sorted and changes nothing
 * about the rate.
 */
export interface ChannelMetrics {
  readonly range: DateRange;
  /**
   * The bar the DISPLAY is exploring with, or `null` when the active niche has
   * none configured.
   *
   * Drives `clearsThreshold`, `lifetimeRatio` and the histogram shading. It
   * does NOT decide a single hit — read `hits` for that, and note that the two
   * can honestly disagree: a Short over this bar today may be a stored miss
   * because it got there in three months.
   */
  readonly threshold: number | null;

  /** Shorts uploaded inside the window. Every outcome, judged or not. */
  readonly totalShorts: number;

  /**
   * THE HEADLINE NUMBER, and everything it excluded to get there.
   *
   * An object rather than a bare `hitRate` scalar, and that is deliberate
   * friction: the rate is computed over judged Shorts only, and on this account
   * the excluded population is large enough that a surface quoting the
   * percentage without it would be making a materially different claim from the
   * one the data supports. There is no shortcut field to reach past it with.
   */
  readonly hits: HitRateSummary;

  readonly totalViews: number;
  readonly averageViews: number | null;
  readonly medianViews: number | null;
  /** Total Shorts views divided by Shorts uploaded. Equal to averageViews. */
  readonly viewsPerUpload: number | null;
  /** Mean views of the best-performing 10% of Shorts (at least 1 video). */
  readonly topDecileAverageViews: number | null;

  readonly bestShort: EvaluatedShort | null;
  readonly worstShort: EvaluatedShort | null;

  /** Mean uploads per week across the window. */
  readonly uploadsPerWeek: number | null;

  /**
   * Consistency score 0..100. Higher means the channel's Shorts cluster
   * tightly around their median rather than being carried by a few outliers.
   * This is the numeric expression of "consistency beats isolated virality".
   * `null` when fewer than 3 Shorts — not enough signal to be meaningful.
   */
  readonly consistencyScore: number | null;

  /** Long-form videos in the window. Reported for transparency only; these
   *  never enter any Shorts metric above. */
  readonly excludedLongform: number;
}

/**
 * One bucket of the hit rate over time.
 *
 * Bucketed by UPLOAD DATE, as before — "of the Shorts we published that week,
 * what share hit?" — but the share is now over judged Shorts only. That is what
 * makes the series comparable end to end: the most recent buckets used to sag
 * because their Shorts had had less time to accumulate views, and now those
 * Shorts are `pending` and sit in neither half of the ratio until their windows
 * shut. The line no longer slopes down just because time runs out on the right.
 */
export interface HitRateSeriesPoint {
  /** Bucket start, epoch ms. */
  readonly bucketStartMs: number;
  /** Bucket end (exclusive), epoch ms. */
  readonly bucketEndMs: number;
  readonly label: string;
  /** Shorts uploaded in the bucket, whatever their verdict. */
  readonly totalShorts: number;
  /**
   * The rate and its exclusions.
   *
   * `hits.rate` is `null` for a bucket with nothing judged in it — which now
   * includes a bucket whose Shorts are all still inside their windows. The
   * chart draws a GAP there, exactly as it always did for a week with no
   * uploads, and the tooltip has `hits.tally.pending` to say which of the two
   * it is looking at.
   */
  readonly hits: HitRateSummary;
  readonly totalViews: number;
  readonly medianViews: number | null;
}

export type SeriesGranularity = "day" | "week" | "month";

export interface ChannelMetricsInput {
  /**
   * Rows carrying their stored verdicts.
   *
   * `JudgedVideo`, not `AnalyticsVideo`, and the narrowing is the point: this
   * function cannot compute a hit rate from views and a threshold any more, and
   * making that a compile error is what stopped every call site from quietly
   * going on measuring lifetime. A caller with no verdicts to hand has to say
   * so by passing `hit: null`, which lands the Shorts in `unscoreable` where a
   * reader can see them.
   */
  readonly videos: readonly JudgedVideo[];
  readonly range: DateRange;
  /**
   * The bar the display is exploring with, or `null` when the active niche has
   * none configured.
   *
   * NOT the definition of a hit and no longer able to become one. It shades the
   * table and scales `lifetimeRatio`; the rate is counted from the verdicts on
   * the rows. The nullability survives because "nobody has chosen a bar here"
   * still must not silently become the organization default.
   */
  readonly threshold: number | null;
}
