import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { calculateChannelMetrics, calculatePortfolioSummary } from "../channel-metrics";
import { measuredRate, resolveHitDisplayState } from "../hit-display";
import { calculateHitRate } from "../hit-rate";
import { compareToMarket } from "../market";
import type { DateRange, JudgedVideo } from "../types";
import {
  DAY_MS,
  daysAgo,
  makeMiss,
  makeShortsWithHits,
  makeUnknown,
  makeUnscoreable,
} from "./factories";

/**
 * =========================================================================
 * THE ZERO THAT SURVIVED THE FIRST PASS
 * =========================================================================
 *
 * `hit-display.test.ts` pins the states themselves and the three surfaces that
 * were migrated first. This file exists because a review of that change found
 * the same fabricated zero still being printed on six more, and every one of
 * them was reached the same way: `HitRateSummary.rate` is `0` and not `null` in
 * the evidence-limited state, so a guard written as `rate === null` — which is
 * every guard in this codebase older than that state — falls straight through
 * to the branch that prints a confident percentage.
 *
 * The rule those surfaces now share, and what this file pins:
 *
 *   A LABEL asks `resolveHitDisplayState` which of five things to say.
 *   EVERYTHING ELSE — a plotted point, a comparator, a mean, a delta, a PDF
 *   cell — asks `measuredRate`, and gets `null` where there is no measurement.
 *
 * The second half is the one that was missing. Overview's headline averaged an
 * unmeasured zero into the tool's number-one KPI while the table underneath it
 * correctly showed a range on every row: one object, two screens, two answers.
 */

const NOW = Date.UTC(2026, 5, 1);
const range: DateRange = { startMs: NOW - 30 * DAY_MS, endMs: NOW };
const BAR = 1_000_000;
const published = daysAgo(15, NOW);

/** 0 of 6 decided, 5 Shorts past the bar with nobody recording when. */
function blindVideos(): JudgedVideo[] {
  return [
    ...Array.from({ length: 6 }, () => makeMiss({ publishedAt: published })),
    ...Array.from({ length: 5 }, () =>
      makeUnknown({ views: 5_000_000, publishedAt: published }),
    ),
  ];
}

/** 0 of 12 decided, nothing unrecorded. A zero that was actually earned. */
function weakVideos(): JudgedVideo[] {
  return Array.from({ length: 12 }, () =>
    makeMiss({ views: 40_000, publishedAt: published }),
  );
}

function metricsFor(videos: readonly JudgedVideo[]) {
  return calculateChannelMetrics({ videos: [...videos], range, threshold: BAR });
}

// ---------------------------------------------------------------------------
// THE ONE EXPRESSION
// ---------------------------------------------------------------------------

describe("measuredRate is the null every consumer needed", () => {
  it("withholds the rate exactly when the zero belongs to the evidence", () => {
    const blind = metricsFor(blindVideos()).hits;
    expect(blind.rate).toBe(0);
    expect(blind.evidenceLimited).toBe(true);
    expect(measuredRate(blind)).toBeNull();
  });

  it("does not touch a zero that was earned", () => {
    // The mirror assertion, and the more important one: this function must not
    // become a way of never printing a bad number.
    const weak = metricsFor(weakVideos()).hits;
    expect(weak.rate).toBe(0);
    expect(weak.evidenceLimited).toBe(false);
    expect(measuredRate(weak)).toBe(0);
  });

  it("passes a real rate through unchanged", () => {
    const strong = metricsFor(makeShortsWithHits(40, 12, BAR, published)).hits;
    expect(measuredRate(strong)).toBe(strong.rate);
    expect(measuredRate(strong)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// OVERVIEW'S HEADLINE — THE BLOCKER
// ---------------------------------------------------------------------------

describe("the portfolio mean does not average in an unmeasured zero", () => {
  const entry = (id: string, videos: readonly JudgedVideo[], scorecard = true) => ({
    id,
    name: id,
    metrics: metricsFor(videos),
    countsTowardHitRate: scorecard,
  });

  it("leaves an evidence-limited channel out of the mean, and says how many", () => {
    const strong = entry("strong", makeShortsWithHits(40, 12, BAR, published));
    const blind = entry("blind", blindVideos());

    const summary = calculatePortfolioSummary([strong, blind]);

    // `strong`'s rate alone, not the mean of it and a zero.
    expect(summary.averageHitRate).toBe(strong.metrics.hits.rate);
    expect(summary.channelsWithData).toBe(1);
    expect(summary.channelsEvidenceLimited).toBe(1);
  });

  it("still averages a genuine zero in, because that one is a measurement", () => {
    const strong = entry("strong", makeShortsWithHits(40, 12, BAR, published));
    const weak = entry("weak", weakVideos());

    const summary = calculatePortfolioSummary([strong, weak]);

    expect(summary.channelsEvidenceLimited).toBe(0);
    expect(summary.channelsWithData).toBe(2);
    expect(summary.averageHitRate).toBeCloseTo((strong.metrics.hits.rate ?? 0) / 2, 5);
  });

  it("does not crown an unmeasured channel as the top one", () => {
    // "Top channel: 0.0% hit rate" is a sentence about a winner that never won
    // anything — and the channel it names might be the best on the account.
    const summary = calculatePortfolioSummary([entry("blind", blindVideos())]);

    expect(summary.averageHitRate).toBeNull();
    expect(summary.topChannel).toBeNull();
  });

  it("gives the headline a range to print instead of a mean", () => {
    // What the tile renders when every scorecard channel is in this state —
    // which is what this deployment enters the moment the hit windows are set.
    const summary = calculatePortfolioSummary([entry("blind", blindVideos())]);
    const state = resolveHitDisplayState(summary.pooled, summary.scorecardTotalShorts);

    expect(state).toBe("evidenceLimited");
    expect(summary.pooled.lowerBound).toBe(0);
    expect(summary.pooled.upperBound).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// THE BANNER'S TWO POPULATIONS
// ---------------------------------------------------------------------------

describe("the Overview banner compares one population with itself", () => {
  /*
   * `pooled` is built from scorecard entries; `totalShorts` counts every entry
   * including watchlist ones. Reading the first against the second resolves to
   * "notConfigured" whenever the watchlist published and the studio did not —
   * and puts a full-width banner reading "No hit rule set for these niches"
   * over niches that are configured perfectly and simply had nothing to judge.
   */
  /*
   * The watchlist channel is FIRST on purpose. With the quiet studio channel
   * ahead of it, a `scorecardTotalShorts = totalShorts` running total is 0 at
   * the moment it is read and the fixture cannot tell the two apart — the
   * ordering is what makes the assertion discriminate.
   */
  const watchlistOnlyPublished = [
    {
      id: "watchlist",
      name: "watchlist",
      metrics: metricsFor(makeShortsWithHits(20, 8, BAR, published)),
      countsTowardHitRate: false,
    },
    {
      id: "studio",
      name: "studio",
      metrics: metricsFor([]),
      countsTowardHitRate: true,
    },
  ];

  it("does not claim a niche is unconfigured because a watchlist channel posted", () => {
    const summary = calculatePortfolioSummary(watchlistOnlyPublished);

    expect(summary.totalShorts).toBeGreaterThan(0);
    expect(summary.scorecardTotalShorts).toBe(0);

    // The old pairing, and the sentence it produced.
    expect(resolveHitDisplayState(summary.pooled, summary.totalShorts)).toBe(
      "notConfigured",
    );
    // The populations matched: there is nothing of ours to judge, which is a
    // shrug rather than a configuration error.
    expect(resolveHitDisplayState(summary.pooled, summary.scorecardTotalShorts)).toBe(
      "noShorts",
    );
  });

  it("still fires when the studio's own Shorts have no rule to be judged by", () => {
    const summary = calculatePortfolioSummary([
      {
        id: "watchlist",
        name: "watchlist",
        metrics: metricsFor(makeShortsWithHits(20, 8, BAR, published)),
        countsTowardHitRate: false,
      },
      {
        id: "studio",
        name: "studio",
        metrics: metricsFor(
          Array.from({ length: 4 }, () => makeUnscoreable({ publishedAt: published })),
        ),
        countsTowardHitRate: true,
      },
    ]);

    // Both counts positive and different, so neither can stand in for the other.
    expect(summary.scorecardTotalShorts).toBe(4);
    expect(summary.totalShorts).toBe(24);
    expect(resolveHitDisplayState(summary.pooled, summary.scorecardTotalShorts)).toBe(
      "notConfigured",
    );
  });
});

// ---------------------------------------------------------------------------
// OURS vs THE MARKET
// ---------------------------------------------------------------------------

describe("an unmeasured side is absent from the comparison, not losing it", () => {
  const hitRateOf = (ours: JudgedVideo[], market: JudgedVideo[]) =>
    compareToMarket([{ videos: ours }], [{ videos: market }], range, BAR).metrics.find(
      (m) => m.key === "hitRate",
    );

  it("reports no figure, no delta and no verdict for an evidence-limited side", () => {
    const metric = hitRateOf(blindVideos(), makeShortsWithHits(40, 12, BAR, published));

    expect(metric?.ours).toBeNull();
    // The worst of the three: a scoreboard reporting the market beating us by
    // exactly its own rate, built entirely on a zero nobody measured.
    expect(metric?.delta).toBeNull();
    expect(metric?.outperforming).toBeNull();
  });

  it("keeps reporting a side that genuinely scored nothing", () => {
    const metric = hitRateOf(weakVideos(), makeShortsWithHits(40, 12, BAR, published));

    expect(metric?.ours).toBe(0);
    expect(metric?.outperforming).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE FLOOR, IN BOTH DIRECTIONS
// ---------------------------------------------------------------------------

describe("the evidence floor is a ratio, deliberately", () => {
  /*
   * The reverse-error case, pinned so the intent is not lost to a later reader
   * who reads the flag as over-eager. `EVIDENCE_LIMITED_MIN_UPPER_BOUND`
   * ignores judged volume ON PURPOSE: an unknown is a Short that DID clear its
   * bar at an unrecorded time, so a thousand extra misses say nothing at all
   * about the ones nobody watched. Only recording their timing can.
   */
  it("suppresses a zero the unrecorded pile could still overturn, at any volume", () => {
    const heavy = calculateHitRate({
      hits: 0,
      misses: 1530,
      pending: 0,
      unknown: 374,
      unscoreable: 0,
    });

    expect(heavy.rate).toBe(0);
    expect(heavy.upperBound).toBeGreaterThan(5);
    expect(heavy.evidenceLimited).toBe(true);
    // If even a tenth of those 374 cleared the bar in time, the truth is 2%.
    expect(measuredRate(heavy)).toBeNull();
  });

  it("prints a real 0.0% as soon as the unrecorded share is small", () => {
    // The guarantee the floor exists to keep, and the answer to "no channel
    // will ever show zero": the condition is few unrecorded Shorts, which is
    // the only condition under which a zero is worth trusting.
    const clean = calculateHitRate({
      hits: 0,
      misses: 100,
      pending: 0,
      unknown: 1,
      unscoreable: 0,
    });

    expect(clean.evidenceLimited).toBe(false);
    expect(measuredRate(clean)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE SURFACES THE REVIEW FOUND STILL PRINTING IT
// ---------------------------------------------------------------------------

const readSource = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), "utf8");

/**
 * Source checks, for the same reason `hit-display.test.ts` uses them: this
 * runner has no DOM, and every one of these defects was a component printing
 * the wrong field. A pure test cannot see a JSX branch that does not exist.
 */
describe("no surface is left reading .rate where it needs a measurement", () => {
  it("the hit-rate chart plots a gap rather than a dip to zero", () => {
    const source = readSource("components/charts/hit-rate-chart.tsx");
    // The line, and the axis it is scaled against.
    expect(source).toContain("value: measuredRate(point.hits)");
    expect(source).toContain("measuredRate(p.hits)");
    expect(source).not.toContain("value: point.hits.rate");
  });

  it("the channel page passes a reference line only where there is an average", () => {
    const source = readSource("app/(app)/channels/[id]/page.tsx");
    expect(source).toContain("averageHitRate={measuredRate(metrics.hits)}");
    expect(source).not.toContain("averageHitRate={metrics.hits.rate}");
  });

  it("the channel page resolves one state for the whole page", () => {
    const source = readSource("app/(app)/channels/[id]/page.tsx");
    expect(source).toContain("resolveHitDisplayState");
    // "0 hit of 6 decided" in success green, four inches under a KpiCards tile
    // showing an em dash for the same number.
    expect(source).not.toMatch(/\{metrics\.hits\.judged === 0 \? \(/);
  });

  it("the content-type table has the fifth branch", () => {
    const source = readSource("components/dashboard/content-type-performance-table.tsx");
    expect(source).toContain("resolveHitDisplayState(row.hits, row.shortsCount)");
    expect(source).toContain('state === "evidenceLimited"');
    // The private copy of the notConfigured predicate.
    expect(source).not.toContain(
      "row.hits.tally.pending === 0 && row.hits.tally.unknown === 0",
    );
  });

  it("the Overview summary strip gates its headline on all five states", () => {
    const source = readSource("components/dashboard/summary-cards.tsx");
    expect(source).toContain("summary.scorecardTotalShorts");
    expect(source).toContain('const evidenceLimited = pooledState === "evidenceLimited"');
    // The caption's "0 hits · 0.0% pooled over 1530 decided".
    expect(source).toMatch(/evidenceLimited \? \(/);
  });

  it("the Overview page banner reads the scorecard's own Shorts count", () => {
    const source = readSource("app/(app)/page.tsx");
    expect(source).toContain("summary.scorecardTotalShorts");
    expect(source).not.toContain(
      "resolveHitDisplayState(summary.pooled, summary.totalShorts)",
    );
  });

  it("our-vs-market has no private copy of the predicate left", () => {
    const source = readSource("app/(app)/our-vs-market/page.tsx");
    expect(source).toContain("resolveHitDisplayState");
    expect(source).not.toContain(
      "hits.judged === 0 && hits.tally.pending === 0 && hits.tally.unknown === 0",
    );
    // The docblock's claim that this was "the same three-way test".
    expect(source).not.toContain("The same three-way test");
    // And it answers for the fifth state rather than falling through to
    // "Nothing decided yet", which would be the wrong instruction: the windows
    // here have closed and the verdicts landed.
    expect(source).toContain('case "evidenceLimited":');
  });

  it("the PDF prints a range rather than a per-channel 0.0%", () => {
    const source = readSource("lib/report/report-document.tsx");
    expect(source).toContain("row.metrics.hits.evidenceLimited");
    // And the cover's HIT RATE BASIS, which otherwise makes the figure beside
    // it look strongly evidenced precisely when it is not.
    expect(source).toContain("report.hits.evidenceLimited");
    // The caveat a metric carries is actually drawn.
    expect(source).toContain("metric.note");
  });

  it("the PDF carries the upload-views name and its caveat", () => {
    const source = readSource("lib/report/build-report.ts");
    expect(source).toContain("label: UPLOAD_VIEWS_LABEL_LONG");
    // ATTACHED to the metric, not merely imported: the whole point is that a
    // PDF reader cannot hover anything, so the caveat has to be printed.
    expect(source).toContain("note: TOTAL_VIEWS_VS_STUDIO");
    expect(source).not.toMatch(/label: "Views of period uploads"/);
    // And no unmeasured zero in the headline metric or its trend.
    expect(source).toContain("measuredRate(currentScorecard.hits)");
  });
});
