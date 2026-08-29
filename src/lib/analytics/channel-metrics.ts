import { calculateHitRate, evaluateShorts } from "./hit-rate";
import { getLongformInDateRange, getShortsInDateRange } from "./filters";
import {
  consistencyScore,
  mean,
  median,
  roundTo,
  sum,
  topFractionAverage,
} from "./stats";
import type {
  ChannelMetrics,
  ChannelMetricsInput,
  EvaluatedShort,
} from "./types";

const MS_PER_WEEK = 604_800_000;

/**
 * The single entry point for "how did this channel do over this window at this
 * threshold?".
 *
 * Deliberately pure and total: hand it videos, a range and a threshold and it
 * returns a complete metric set, with `null` wherever a statistic genuinely
 * does not exist. Every dashboard cell, KPI card and comparison row is derived
 * from this one function, so the numbers cannot drift between views.
 *
 * A `null` threshold is one of those "genuinely does not exist" cases, and it
 * is handled here rather than at each call site for the same reason: this is
 * the one place hit rate is computed, so it is the one place that can guarantee
 * an unconfigured niche never produces a rate. Everything that does not depend
 * on a threshold — uploads, views, medians, consistency — is still computed in
 * full, because none of it was ever in doubt.
 */
export function calculateChannelMetrics(
  input: ChannelMetricsInput,
): ChannelMetrics {
  const { videos, range, threshold } = input;

  // Order matters and is the whole ballgame: Shorts only, then uploaded inside
  // the window. Long-form can never reach the lines below.
  const shortsInRange = getShortsInDateRange(videos, range);
  const evaluated = evaluateShorts(shortsInRange, threshold);

  const totalShorts = evaluated.length;
  const views = evaluated.map((s) => s.views);

  const hits = evaluated.filter((s) => s.isHit);
  const hitCount = hits.length;

  const totalViews = sum(views);
  const averageViews = mean(views);
  const medianViews = median(views);

  const { best, worst } = findExtremes(evaluated);

  const windowMs = Math.max(0, range.endMs - range.startMs);
  const weeks = windowMs / MS_PER_WEEK;

  return {
    range,
    threshold,

    totalShorts,
    hitCount,
    // `calculateHitRate(0, 38)` is a perfectly good 0% — which is exactly the
    // wrong answer here. With no threshold configured, 38 Shorts did not all
    // miss; there was no line for them to miss.
    hitRate: threshold === null ? null : calculateHitRate(hitCount, totalShorts),

    totalViews,
    averageViews: averageViews === null ? null : roundTo(averageViews, 0),
    medianViews: medianViews === null ? null : roundTo(medianViews, 0),
    // Identical to the mean by definition; surfaced separately because the
    // spec asks for both names and users read them differently.
    viewsPerUpload: averageViews === null ? null : roundTo(averageViews, 0),
    topDecileAverageViews: nullableRound(topFractionAverage(views, 0.1), 0),

    bestShort: best,
    worstShort: worst,

    uploadsPerWeek:
      weeks > 0 && totalShorts > 0 ? roundTo(totalShorts / weeks, 2) : totalShorts > 0 ? null : 0,

    consistencyScore: consistencyScore(views),

    excludedLongform: getLongformInDateRange(videos, range).length,
  };
}

function nullableRound(value: number | null, decimals: number): number | null {
  return value === null ? null : roundTo(value, decimals);
}

/** Single pass for both extremes — these lists can be thousands of items. */
function findExtremes(shorts: readonly EvaluatedShort[]): {
  best: EvaluatedShort | null;
  worst: EvaluatedShort | null;
} {
  if (shorts.length === 0) return { best: null, worst: null };
  let best = shorts[0];
  let worst = shorts[0];
  for (const short of shorts) {
    if (short.views > best.views) best = short;
    if (short.views < worst.views) worst = short;
  }
  return { best, worst };
}

/**
 * Aggregate metrics across every tracked channel, for the dashboard summary.
 *
 * `averageHitRate` is the mean of each channel's own hit rate, not
 * `totalHits / totalShorts`. Those answer different questions: the pooled ratio
 * is dominated by whichever channel uploads most, while the mean of rates
 * answers "how does a typical tracked channel perform?" — which is what a
 * comparison tool is for. Channels with no Shorts in the window contribute no
 * rate at all rather than a zero.
 */
export interface PortfolioSummary {
  readonly channelCount: number;
  readonly channelsWithData: number;
  readonly totalShorts: number;
  readonly totalHits: number;
  readonly totalViews: number;
  /** Mean of per-channel hit rates. `null` when no channel has Shorts. */
  readonly averageHitRate: number | null;
  /** Pooled hits ÷ pooled Shorts. `null` when there are no Shorts at all. */
  readonly pooledHitRate: number | null;
  readonly medianHitRate: number | null;
  readonly topChannel: { id: string; name: string; hitRate: number } | null;
}

export function calculatePortfolioSummary(
  entries: readonly { id: string; name: string; metrics: ChannelMetrics }[],
): PortfolioSummary {
  let totalShorts = 0;
  let totalHits = 0;
  let totalViews = 0;
  const rates: number[] = [];
  let topChannel: PortfolioSummary["topChannel"] = null;

  for (const entry of entries) {
    totalShorts += entry.metrics.totalShorts;
    totalHits += entry.metrics.hitCount;
    totalViews += entry.metrics.totalViews;

    const rate = entry.metrics.hitRate;
    if (rate === null) continue;
    rates.push(rate);

    // Tie-break on volume: between two channels at the same rate, the one that
    // has proven it over more uploads is the stronger claim.
    if (
      topChannel === null ||
      rate > topChannel.hitRate ||
      (rate === topChannel.hitRate &&
        entry.metrics.totalShorts >
          (entries.find((e) => e.id === topChannel?.id)?.metrics.totalShorts ?? 0))
    ) {
      topChannel = { id: entry.id, name: entry.name, hitRate: rate };
    }
  }

  const avg = mean(rates);
  const med = median(rates);

  return {
    channelCount: entries.length,
    channelsWithData: rates.length,
    totalShorts,
    totalHits,
    totalViews,
    averageHitRate: avg === null ? null : roundTo(avg, 2),
    pooledHitRate: calculateHitRate(totalHits, totalShorts),
    medianHitRate: med === null ? null : roundTo(med, 2),
    topChannel,
  };
}
