import { calculateChannelMetrics } from "./channel-metrics";
import { getShortsInDateRange } from "./filters";
import { measuredRate } from "./hit-display";
import { calculateHitRate, tallyShorts } from "./hit-rate";
import { mean, median, roundTo, sum, topFractionAverage } from "./stats";
import type { ChannelMetrics, DateRange, JudgedVideo } from "./types";

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
 * WHAT A HIT MEANS ON BOTH SIDES OF THIS TABLE
 * The same thing, and that is not automatic. Each side's hit rate is counted
 * from the stored verdicts on its own Shorts, and a verdict was reached against
 * the niche rule of the channel that published it. Our channels and the
 * competitors we track in a niche sit in the SAME niche, so both sides are
 * judged by the same bar and the same clock — which is what makes the
 * comparison a comparison. Where a competitor sits in no configured niche its
 * Shorts are `unscoreable`, drop out of both halves, and are reported in the
 * exclusions rather than counted as failures.
 *
 * WHICH CHANNELS REACH THE TWO POOLS IS DECIDED NEXT DOOR, in `market-scope`.
 * This function compares whatever it is handed and knows nothing about which
 * niches Northstar publishes into — but the paragraph above is the contract
 * that decision has to keep, so it is worth reading the two together. Both
 * pools are scoped by one predicate for exactly this reason: scoping only the
 * "ours" side would leave the two halves judged by the same rule over
 * differently-shaped populations, which is the one way to break a comparison
 * that still looks like one on screen.
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
  readonly shorts: readonly JudgedVideo[];
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
  channels: readonly { videos: readonly JudgedVideo[] }[],
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
 *
 * COUNTED FROM VERDICTS, which is what makes it worth reporting at all. Under
 * the old lifetime comparison the second half was always the younger cohort and
 * therefore always flattered downward — this metric reported a decline on every
 * channel that had not stopped publishing. With in-flight Shorts excluded from
 * both halves, a second half with nothing judged in it yields `null` and the
 * row reads as "no comparison" instead of as a fall.
 */
function growth(shorts: readonly JudgedVideo[], range: DateRange): number | null {
  const mid = range.startMs + (range.endMs - range.startMs) / 2;
  const first = shorts.filter((s) => s.publishedAt >= range.startMs && s.publishedAt < mid);
  const second = shorts.filter((s) => s.publishedAt >= mid && s.publishedAt < range.endMs);

  // Same rule as the rate itself: a half whose zero belongs to the evidence is
  // not a half that moved. Subtracting an unmeasured 0 from a measured 30 would
  // report a 30-point collapse caused entirely by nobody recording.
  const a = measuredRate(calculateHitRate(tallyShorts(first)));
  const b = measuredRate(calculateHitRate(tallyShorts(second)));
  if (a === null || b === null) return null;
  return roundTo(b - a, 2);
}

function nullRound(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

export function compareToMarket(
  ourChannels: readonly { videos: readonly JudgedVideo[] }[],
  competitorChannels: readonly { videos: readonly JudgedVideo[] }[],
  range: DateRange,
  /**
   * The display bar, or `null` when the selected niche has none configured.
   *
   * Carried through to the pooled `ChannelMetrics` for shading and ratios only.
   * It decides no hit on either side; both sides' rates come from the verdicts
   * their own Shorts carry.
   */
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
      /*
       * `measuredRate`, so an evidence-limited side is ABSENT from the
       * comparison rather than present as a zero.
       *
       * This is the one place worth fixing rather than the two that render it.
       * A pooled side whose Shorts all passed their bar unrecorded has a rate
       * of arithmetic 0, and left alone it flowed into three separate lies at
       * once: a "0.0%" cell in the metric table, a zero-length bar in the
       * headline chart, and — worst — a `delta` and an `outperforming` verdict
       * built on it, so the scoreboard would report the studio beating the
       * market by however much the market happened to score. `null` is already
       * the "this side cannot be compared" value here and every consumer
       * already handles it: an em dash, no bar, and `outperforming: null`.
       */
      measuredRate(ours.metrics.hits),
      measuredRate(market.metrics.hits),
      "percent",
      "Share of JUDGED Shorts that reached their niche's bar inside its window. Shorts still inside their window, and those nobody was recording during it, are in neither half — see the exclusions beside each side.",
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
      growth(ours.shorts, range),
      growth(market.shorts, range),
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
