/**
 * Analytics engine — shared types.
 *
 * Everything in `src/lib/analytics` is a pure function over these shapes. No
 * Prisma types, no React types, no I/O. That is what lets the *identical* code
 * run on the server (when persisting or exporting) and in the browser (when the
 * user drags the threshold slider), and what makes the whole thing unit
 * testable without a database.
 */

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
  /** True when every video in this bucket clears the active threshold. */
  readonly isHitBucket: boolean;
}

/** A single Short annotated with its hit status against the active threshold. */
export interface EvaluatedShort extends AnalyticsVideo {
  readonly isHit: boolean;
  /**
   * views / threshold. 1.0 means exactly at the threshold. Useful for the
   * "views relative to threshold" column and for sorting near-misses.
   *
   * `null` when there is no configured threshold to be relative *to*. A ratio
   * against a borrowed default would read as a measurement somebody made.
   */
  readonly thresholdRatio: number | null;
}

/**
 * The complete metric set for one channel over one (period, threshold) pair.
 *
 * `hitRate` is `null` — never `0` — when the channel published no Shorts in the
 * window. 0% would claim "Shorts existed and none hit", which is a materially
 * different and misleading statement. The UI renders `null` as an em dash.
 */
export interface ChannelMetrics {
  readonly range: DateRange;
  /**
   * The threshold these figures were judged at, or `null` when the active niche
   * has none configured. In that case `hitCount` is 0 and `hitRate` is `null` —
   * not because nothing hit, but because nobody ever said what a hit is.
   */
  readonly threshold: number | null;

  /** Shorts uploaded inside the window. Denominator of the hit rate. */
  readonly totalShorts: number;
  /** Shorts inside the window whose *current* views >= threshold. */
  readonly hitCount: number;
  /**
   * Percentage 0..100. `null` when `totalShorts === 0`, and also `null` when
   * `threshold` is `null` — a hit rate with no threshold behind it is not a
   * smaller number, it is not a number at all.
   */
  readonly hitRate: number | null;

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

export interface HitRateSeriesPoint {
  /** Bucket start, epoch ms. */
  readonly bucketStartMs: number;
  /** Bucket end (exclusive), epoch ms. */
  readonly bucketEndMs: number;
  readonly label: string;
  readonly totalShorts: number;
  readonly hitCount: number;
  /** `null` when the bucket contains no Shorts. */
  readonly hitRate: number | null;
  readonly totalViews: number;
  readonly medianViews: number | null;
}

export type SeriesGranularity = "day" | "week" | "month";

export interface ChannelMetricsInput {
  readonly videos: readonly AnalyticsVideo[];
  readonly range: DateRange;
  /**
   * `null` means "the selected niche has no configured hit threshold". The
   * engine then reports no hit rate at all rather than quietly measuring
   * against the organization default, which is the bug this nullability exists
   * to make impossible to reintroduce.
   */
  readonly threshold: number | null;
}
