import {
  addTallies,
  annotateAgainstThreshold,
  calculateHitRate,
  EMPTY_HIT_TALLY,
  tallyShorts,
  type HitRateSummary,
  type HitTally,
} from "./hit-rate";
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
 * The single entry point for "how did this channel do over this window?".
 *
 * Deliberately pure and total: hand it judged videos and a range and it returns
 * a complete metric set, with `null` wherever a statistic genuinely does not
 * exist. Every dashboard cell, KPI card and comparison row is derived from this
 * one function, so the numbers cannot drift between views.
 *
 * WHAT CHANGED WHEN A HIT GAINED A CLOCK
 * This function used to take a threshold and count the Shorts above it. It no
 * longer can: a hit is a bar reached WITHIN A WINDOW, the evidence for that is
 * a snapshot series in the database, and the answer is materialised per Short
 * on `VideoHitEvaluation`. So the rate here is a COUNT OF STORED VERDICTS —
 * `tallyShorts` then `calculateHitRate` — and this file no longer contains a
 * comparison between a view count and a threshold that means anything.
 *
 * The threshold survives as a display parameter and only that. It shades rows
 * and scales `lifetimeRatio`; a `null` one still means "nobody has chosen a bar
 * for this niche" and still refuses to borrow the organization default, which
 * is the bug that nullability exists to keep impossible.
 *
 * Everything that never depended on a threshold — uploads, views, medians,
 * consistency — is computed exactly as before, because none of it was ever in
 * doubt.
 */
export function calculateChannelMetrics(
  input: ChannelMetricsInput,
): ChannelMetrics {
  const { videos, range, threshold } = input;

  // Order matters and is the whole ballgame: Shorts only, then uploaded inside
  // the window. Long-form can never reach the lines below.
  const shortsInRange = getShortsInDateRange(videos, range);
  const evaluated = annotateAgainstThreshold(shortsInRange, threshold);

  const totalShorts = evaluated.length;
  const views = evaluated.map((s) => s.views);

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
    // Counted from the verdicts on the rows, never from `threshold`. A Short
    // with no verdict lands in `unscoreable` and is excluded from both halves
    // rather than being read as a failure — see `hitContributionOf`.
    hits: calculateHitRate(tallyShorts(shortsInRange)),

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
 * comparison tool is for. Channels with no JUDGED Shorts in the window
 * contribute no rate at all rather than a zero, and under the new rule that
 * now includes a channel whose recent Shorts are all still inside their
 * windows: it is unmeasured, not unsuccessful.
 *
 * THE POOLED FIGURE IS A POOLED TALLY, not an average of averages and not a
 * ratio of two sums taken from different populations. Tallies add — that is
 * what `addTallies` is for — so the portfolio's exclusions are the sum of the
 * channels' exclusions and the bounds widen honestly as unknowns accumulate.
 */
export interface PortfolioSummary {
  readonly channelCount: number;
  /** Channels with at least one judged Short — the ones `averageHitRate` is over. */
  readonly channelsWithData: number;
  readonly totalShorts: number;
  readonly totalViews: number;
  /**
   * Every channel's verdicts, added.
   *
   * The portfolio-level exclusions live here and are the number the dashboard
   * has to show beside the headline: "18% across 214 judged Shorts, 374
   * excluded" is a different claim from "18%", and the second one on its own is
   * the claim this product exists not to make.
   */
  readonly pooled: HitRateSummary;
  /** Mean of per-channel hit rates. `null` when no channel has a rate. */
  readonly averageHitRate: number | null;
  readonly medianHitRate: number | null;
  readonly topChannel: { id: string; name: string; hitRate: number } | null;
}

export function calculatePortfolioSummary(
  entries: readonly { id: string; name: string; metrics: ChannelMetrics }[],
): PortfolioSummary {
  let totalShorts = 0;
  let totalViews = 0;
  let pooledTally: HitTally = EMPTY_HIT_TALLY;
  const rates: number[] = [];
  let topChannel: PortfolioSummary["topChannel"] = null;

  for (const entry of entries) {
    totalShorts += entry.metrics.totalShorts;
    totalViews += entry.metrics.totalViews;
    pooledTally = addTallies(pooledTally, entry.metrics.hits.tally);

    const rate = entry.metrics.hits.rate;
    if (rate === null) continue;
    rates.push(rate);

    // Tie-break on JUDGED volume, not on uploads: between two channels at the
    // same rate, the one that proved it over more decided Shorts is the
    // stronger claim, and a channel with forty pending Shorts has proved
    // nothing extra by publishing them yet.
    if (
      topChannel === null ||
      rate > topChannel.hitRate ||
      (rate === topChannel.hitRate &&
        entry.metrics.hits.judged >
          (entries.find((e) => e.id === topChannel?.id)?.metrics.hits.judged ?? 0))
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
    totalViews,
    pooled: calculateHitRate(pooledTally),
    averageHitRate: avg === null ? null : roundTo(avg, 2),
    medianHitRate: med === null ? null : roundTo(med, 2),
    topChannel,
  };
}
