import { calculateChannelMetrics } from "./channel-metrics";
import { calculateHitRate } from "./hit-rate";
import { getShortsInDateRange } from "./filters";
import { mean, median, roundTo, sum, topFractionAverage } from "./stats";
import type { AnalyticsVideo, ChannelMetrics, DateRange } from "./types";

/**
 * =========================================================================
 * OUR CHANNELS vs THE MARKET
 * =========================================================================
 *
 * Compares a pool of the user's own channels against the competitor pool
 * inside one niche.
 *
 * POOLING RULE
 * Metrics are computed over the *combined Shorts* of each side, not by
 * averaging per-channel figures. Averaging channel averages would let a
 * channel that posted twice count as heavily as one that posted eighty times,
 * which is the wrong answer to "how does our output compare to the market".
 *
 * DIRECTIONALITY
 * Every metric declares whether higher is better — and upload frequency
 * declares that it is neither. Posting more is a strategy, not an achievement:
 * a team deliberately running a lower-volume, higher-craft format would be
 * marked as "losing" by any scoreboard that treats volume as a win. Metrics
 * with a "neutral" direction are shown and compared but never counted in the
 * scoreboard tally.
 */

export type MetricDirection = "higherIsBetter" | "neutral";

export interface MarketMetric {
  readonly key: string;
  readonly label: string;
  /** "neutral" metrics are displayed but excluded from the win/loss tally. */
  readonly direction: MetricDirection;
  readonly ours: number | null;
  readonly market: number | null;
  /** Absolute difference (ours minus market), in the metric's own unit. */
  readonly delta: number | null;
  /** Relative difference as a percentage. `null` when market is 0 or absent. */
  readonly deltaPercent: number | null;
  /** How to render the value. */
  readonly format: "percent" | "count" | "views" | "decimal";
  /** True when ours beats market on a directional metric. `null` if neutral. */
  readonly outperforming: boolean | null;
  readonly hint?: string;
}

export interface MarketPool {
  readonly channelCount: number;
  readonly shorts: readonly AnalyticsVideo[];
  readonly metrics: ChannelMetrics;
}

export interface MarketComparison {
  readonly ours: MarketPool;
  readonly market: MarketPool;
  readonly metrics: readonly MarketMetric[];
  /** Directional metrics where we lead. */
  readonly outperformingCount: number;
  /** Total directional metrics that could actually be judged. */
  readonly comparableCount: number;
  /** True when either side has no Shorts in the period. */
  readonly insufficientData: boolean;
}

const MS_PER_WEEK = 604_800_000;

function poolFor(
  channels: readonly { videos: readonly AnalyticsVideo[] }[],
  range: DateRange,
  threshold: number | null,
): MarketPool {
  // Flatten first, then measure once. The pooled set is the unit of comparison.
  const allVideos = channels.flatMap((c) => [...c.videos]);
  return {
    channelCount: channels.length,
    shorts: getShortsInDateRange(allVideos, range),
    metrics: calculateChannelMetrics({ videos: allVideos, range, threshold }),
  };
}

function uploadsPerWeek(
  shortsCount: number,
  channelCount: number,
  range: DateRange,
): number | null {
  const weeks = (range.endMs - range.startMs) / MS_PER_WEEK;
  if (weeks <= 0 || channelCount === 0) return null;
  // Per channel, so a side with more channels is not automatically "faster".
  return roundTo(shortsCount / weeks / channelCount, 2);
}

function pctDelta(ours: number | null, market: number | null): number | null {
  if (ours === null || market === null || market === 0) return null;
  return roundTo(((ours - market) / market) * 100, 1);
}

function absDelta(ours: number | null, market: number | null): number | null {
  if (ours === null || market === null) return null;
  return roundTo(ours - market, 2);
}

/**
 * Growth: hit rate in the second half of the window minus the first half, in
 * percentage points. Same construction as the channel-level trend, so the two
 * numbers always agree.
 */
function growth(
  shorts: readonly AnalyticsVideo[],
  range: DateRange,
  threshold: number | null,
): number | null {
  // Growth *of the hit rate*, so with no configured threshold there is nothing
  // to have grown. Every other metric on the comparison survives; this one does
  // not exist rather than reading as flat.
  if (threshold === null) return null;
  const mid = range.startMs + (range.endMs - range.startMs) / 2;
  const first = shorts.filter((s) => s.publishedAt >= range.startMs && s.publishedAt < mid);
  const second = shorts.filter((s) => s.publishedAt >= mid && s.publishedAt < range.endMs);

  const a = calculateHitRate(first.filter((s) => s.views >= threshold).length, first.length);
  const b = calculateHitRate(second.filter((s) => s.views >= threshold).length, second.length);
  if (a === null || b === null) return null;
  return roundTo(b - a, 2);
}

function nullRound(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

export function compareToMarket(
  ourChannels: readonly { videos: readonly AnalyticsVideo[] }[],
  competitorChannels: readonly { videos: readonly AnalyticsVideo[] }[],
  range: DateRange,
  /** `null` when the selected niche has no configured hit threshold. */
  threshold: number | null,
): MarketComparison {
  const ours = poolFor(ourChannels, range, threshold);
  const market = poolFor(competitorChannels, range, threshold);

  const ourViews = ours.shorts.map((s) => s.views);
  const marketViews = market.shorts.map((s) => s.views);

  const build = (
    key: string,
    label: string,
    direction: MetricDirection,
    a: number | null,
    b: number | null,
    format: MarketMetric["format"],
    hint?: string,
  ): MarketMetric => ({
    key,
    label,
    direction,
    ours: a,
    market: b,
    delta: absDelta(a, b),
    deltaPercent: pctDelta(a, b),
    format,
    outperforming: direction === "neutral" || a === null || b === null ? null : a > b,
    hint,
  });

  const metrics: MarketMetric[] = [
    build(
      "hitRate",
      "Hit rate",
      "higherIsBetter",
      ours.metrics.hitRate,
      market.metrics.hitRate,
      "percent",
    ),
    build(
      "medianViews",
      "Median views",
      "higherIsBetter",
      median(ourViews),
      median(marketViews),
      "views",
      "The typical Short on each side. Resistant to a single viral outlier.",
    ),
    build(
      "averageViews",
      "Average views",
      "higherIsBetter",
      nullRound(mean(ourViews)),
      nullRound(mean(marketViews)),
      "views",
    ),
    build(
      "viewsPerUpload",
      "Views per upload",
      "higherIsBetter",
      ours.shorts.length ? Math.round(sum(ourViews) / ours.shorts.length) : null,
      market.shorts.length ? Math.round(sum(marketViews) / market.shorts.length) : null,
      "views",
    ),
    build(
      "topDecile",
      "Top 10% average",
      "higherIsBetter",
      nullRound(topFractionAverage(ourViews, 0.1)),
      nullRound(topFractionAverage(marketViews, 0.1)),
      "views",
      "How high each side's ceiling reaches.",
    ),
    build(
      "growth",
      "Growth",
      "higherIsBetter",
      growth(ours.shorts, range, threshold),
      growth(market.shorts, range, threshold),
      "percent",
      "Change in hit rate between the first and second half of the period, in percentage points.",
    ),
    build(
      "uploadsPerWeek",
      "Uploads per week",
      "neutral",
      uploadsPerWeek(ours.shorts.length, ours.channelCount, range),
      uploadsPerWeek(market.shorts.length, market.channelCount, range),
      "decimal",
      "Per channel. Shown for context but deliberately not scored: posting more is a strategy choice, not inherently better performance.",
    ),
  ];

  const directional = metrics.filter((m) => m.direction === "higherIsBetter");
  const comparable = directional.filter((m) => m.outperforming !== null);

  return {
    ours,
    market,
    metrics,
    outperformingCount: comparable.filter((m) => m.outperforming === true).length,
    comparableCount: comparable.length,
    insufficientData: ours.shorts.length === 0 || market.shorts.length === 0,
  };
}
