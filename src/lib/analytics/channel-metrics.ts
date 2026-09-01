import {
  addTallies,
  annotateAgainstThreshold,
  calculateHitRate,
  EMPTY_HIT_TALLY,
  tallyShorts,
  type HitRateSummary,
  type HitTally,
} from "./hit-rate";
import { isWithinRange, videosInDateRange } from "./filters";
import { measuredRate } from "./hit-display";
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
  const { videos, range, threshold, format = "shorts" } = input;

  // Order matters and is the whole ballgame: this format's videos only, then
  // uploaded inside the window. The other format — and everything the
  // classifier could not resolve — can never reach the lines below. For
  // shorts (every existing caller) this is `getShortsInDateRange` verbatim.
  const shortsInRange = videosInDateRange(videos, range, format);
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

    /*
     * Everything in the window that is NOT a Short — deliberately NOT the
     * strict `getLongformInDateRange` selector.
     *
     * The strict selector counts only `classification === "not_short"`; this
     * figure has always been the complement of the Shorts filter, which also
     * sweeps in videos the classifier could not resolve. Those are different
     * numbers on any channel with uncertain videos, and this one is DISPLAYED
     * — "N long-form videos were excluded" on the KPI cards — so switching it
     * would change a rendered value for users whose product must not move.
     * The complement is also the honest claim for this caption: it exists to
     * prove that everything outside the Shorts metric was excluded, and an
     * uncertain video IS excluded. Counted as in-range minus format-matched
     * rather than with a second predicate, so it cannot drift from the filter
     * it is the complement of.
     */
    excludedLongform:
      videos.filter((v) => isWithinRange(v.publishedAt, range)).length - totalShorts,
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
 *
 * ---------------------------------------------------------------------------
 * TWO POPULATIONS IN ONE OBJECT, AND THE SPLIT IS THE POINT
 * ---------------------------------------------------------------------------
 * Not every field here is over the same set of channels, and pretending
 * otherwise is what produced the number this split exists to fix.
 *
 *   VOLUME — `channelCount`, `totalShorts`, `totalViews` — is over EVERY entry.
 *     These describe the tracker, not the studio. "48 tracked channels" has to
 *     mean the 48 rows in the table underneath it, or the header is lying about
 *     the page it sits on.
 *
 *   THE SCORECARD — `pooled`, `averageHitRate`, `medianHitRate`,
 *     `channelsWithData`, `channelsEvidenceLimited`, `scorecardTotalShorts`,
 *     `topChannel` — is over entries flagged
 *     `countsTowardHitRate`. A watchlist niche is full of channels nobody at
 *     Northstar is trying to be, so averaging them into "our hit rate" produces
 *     a number describing work the studio does not do: arithmetic that is
 *     perfectly correct over a population nobody chose. The caller decides which
 *     entries belong — see `isStudioChannel` — because only the caller knows
 *     whether the viewer asked about the studio or about one particular niche.
 *
 * The flag is REQUIRED rather than defaulted. A default would let a new call
 * site pool watchlist channels back into the headline by omission, which is the
 * single failure mode this whole field exists to prevent; making it a compile
 * error is what forces the decision to be made once, out loud, per surface.
 */
export interface PortfolioEntry {
  readonly id: string;
  readonly name: string;
  readonly metrics: ChannelMetrics;
  /**
   * Whether this channel belongs in the studio's own scorecard.
   *
   * Volume counts it either way; the rate only counts it when this is true.
   */
  readonly countsTowardHitRate: boolean;
}

export interface PortfolioSummary {
  /** Every channel in scope, whatever kind of niche it sits in. */
  readonly channelCount: number;
  /**
   * Channels the rate is ALLOWED to be measured over.
   *
   * Equal to `channelCount` on an ordinary view; smaller when watchlist
   * channels are in scope. The gap between the two is what a caption has to
   * say out loud — a rate over 30 of 48 tracked channels is a different claim
   * from a rate over all of them, and only one of them is "how are WE doing".
   */
  readonly scorecardChannelCount: number;
  /** Scorecard channels with a MEASURED rate — what `averageHitRate` is over. */
  readonly channelsWithData: number;
  /**
   * Scorecard channels held out of the average because their zero is an
   * artefact of the evidence. See `HitRateSummary.evidenceLimited`.
   *
   * Counted rather than merely skipped, because a mean that silently drops
   * entries is the same class of quiet claim as the zero it is dropping. The
   * caption states the exclusion beside the figure.
   */
  readonly channelsEvidenceLimited: number;
  readonly totalShorts: number;
  readonly totalViews: number;
  /**
   * Shorts published by SCORECARD channels only — the denominator `pooled` is
   * actually about.
   *
   * `totalShorts` counts every entry, watchlist included, and the two are
   * different populations by design (see the note above). Any predicate that
   * reads a tally against a Shorts count has to use the count from the SAME
   * population, and the portfolio one did not: with watchlist channels
   * publishing and studio channels quiet, `pooled` is an all-zero tally while
   * `totalShorts` is positive, which resolves to "no hit rule set for these
   * niches" and puts a full-width banner about broken configuration over
   * niches that are configured perfectly.
   */
  readonly scorecardTotalShorts: number;
  /**
   * The SCORECARD channels' verdicts, added.
   *
   * The portfolio-level exclusions live here and are the number the dashboard
   * has to show beside the headline: "18% across 214 judged Shorts, 374
   * excluded" is a different claim from "18%", and the second one on its own is
   * the claim this product exists not to make.
   */
  readonly pooled: HitRateSummary;
  /** Mean of per-channel hit rates. `null` when no scorecard channel has a rate. */
  readonly averageHitRate: number | null;
  readonly medianHitRate: number | null;
  /**
   * The strongest channel, ranked among SCORECARD channels only.
   *
   * Same population as the rate above it, deliberately. "Best performing" is
   * read as "the strongest thing we have", and a watchlist channel winning it
   * would put a channel nobody is trying to be at the top of the studio's own
   * list. What the competition is doing is what Outliers and Winners are for.
   */
  readonly topChannel: { id: string; name: string; hitRate: number } | null;
}

export function calculatePortfolioSummary(
  entries: readonly PortfolioEntry[],
): PortfolioSummary {
  let totalShorts = 0;
  let totalViews = 0;
  let scorecardTotalShorts = 0;
  let scorecardChannelCount = 0;
  let channelsEvidenceLimited = 0;
  let pooledTally: HitTally = EMPTY_HIT_TALLY;
  const rates: number[] = [];
  let topChannel: PortfolioSummary["topChannel"] = null;

  for (const entry of entries) {
    // Volume first, over everything: these describe the tracker.
    totalShorts += entry.metrics.totalShorts;
    totalViews += entry.metrics.totalViews;

    // And everything below describes the studio.
    if (!entry.countsTowardHitRate) continue;
    scorecardChannelCount += 1;
    scorecardTotalShorts += entry.metrics.totalShorts;
    pooledTally = addTallies(pooledTally, entry.metrics.hits.tally);

    if (entry.metrics.hits.evidenceLimited) channelsEvidenceLimited += 1;

    /*
     * `measuredRate`, NOT `.rate`.
     *
     * The `rate === null` skip below has always been the right instinct — an
     * unmeasured channel must not be averaged in as a zero — and it stopped one
     * case short. An evidence-limited channel's rate is arithmetically `0`,
     * not null, so it walked straight past this guard and into the mean. The
     * result was Overview's headline reading "Average hit rate 0.0%" over a
     * table in which every row correctly read "0%–20%": the same object,
     * contradicting itself two inches apart, on the one screen the owner opens
     * first. Same object, same predicate, one import.
     *
     * It is held out of the `topChannel` contest for the same reason. "Top
     * channel: 0.0% hit rate" is a sentence about a winner that never won
     * anything, and the entry it names might be the strongest channel on the
     * account or the weakest — nobody recorded which.
     */
    const rate = measuredRate(entry.metrics.hits);
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
    scorecardChannelCount,
    channelsWithData: rates.length,
    channelsEvidenceLimited,
    totalShorts,
    totalViews,
    scorecardTotalShorts,
    pooled: calculateHitRate(pooledTally),
    averageHitRate: avg === null ? null : roundTo(avg, 2),
    medianHitRate: med === null ? null : roundTo(med, 2),
    topChannel,
  };
}
