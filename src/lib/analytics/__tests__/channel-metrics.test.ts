import { describe, expect, it } from "vitest";
import { calculateChannelMetrics, calculatePortfolioSummary } from "../channel-metrics";
import type { DateRange, JudgedVideo } from "../types";
import {
  DAY_MS,
  daysAgo,
  makeHit,
  makeLongform,
  makeMiss,
  makePending,
  makeShort,
  makeShortsWithHits,
  makeUncertain,
  makeUnknown,
  makeUnscoreable,
} from "./factories";

const NOW = Date.UTC(2026, 5, 1);
const range = (days: number): DateRange => ({
  startMs: NOW - days * DAY_MS,
  endMs: NOW,
});

/**
 * The threshold argument is a DISPLAY BAR everywhere in this file.
 *
 * It shades rows and scales `lifetimeRatio`; it decides no outcome. Every hit
 * expectation below comes from the verdicts on the fixtures, which is why
 * several tests pass a bar the fixtures deliberately disagree with.
 */
const BAR = 1_000_000;

describe("calculateChannelMetrics — the spec's worked example", () => {
  it("40 decided Shorts in 30 days, 12 of them hits -> 30%", () => {
    const videos = makeShortsWithHits(40, 12, BAR, daysAgo(10, NOW));
    const metrics = calculateChannelMetrics({ videos, range: range(30), threshold: BAR });

    expect(metrics.totalShorts).toBe(40);
    expect(metrics.hits.hits).toBe(12);
    expect(metrics.hits.judged).toBe(40);
    expect(metrics.hits.rate).toBe(30);
    // Nothing was excluded, so the range collapses onto the point estimate.
    expect(metrics.hits.excluded).toBe(0);
    expect(metrics.hits.lowerBound).toBe(30);
    expect(metrics.hits.upperBound).toBe(30);
  });
});

/**
 * =========================================================================
 * THE BUG THE WINDOW EXISTS TO FIX
 * =========================================================================
 * These four tests are the ones that would have failed under the old rule, and
 * they are the reason the rest of this file changed shape. Under
 * `isHit(views, threshold)` the rate was a function of two numbers on the row,
 * so a Short's age leaked into the metric and there was no way to say "not
 * yet".
 */
describe("calculateChannelMetrics — lifetime views no longer decide anything", () => {
  it("a Short far over the bar that took too long to get there is a MISS", () => {
    // 5,000,000 lifetime views against a 1,000,000 bar. Every version of the
    // old rule called this a hit. The window says it crawled there.
    const metrics = calculateChannelMetrics({
      videos: [makeMiss({ views: 5_000_000, publishedAt: daysAgo(200, NOW) })],
      range: range(365),
      threshold: BAR,
    });

    expect(metrics.hits.hits).toBe(0);
    expect(metrics.hits.judged).toBe(1);
    expect(metrics.hits.rate).toBe(0);
    // The display annotation still reports the bar comparison honestly — that
    // is what shades the row — and it is not the verdict.
    expect(metrics.bestShort?.clearsThreshold).toBe(true);
  });

  it("a Short under the bar today that cleared it inside its window is a HIT", () => {
    // The inverse case, which happens when YouTube purges inflated views after
    // the window has already shut. It was over the bar on the day; that does
    // not stop being true.
    const metrics = calculateChannelMetrics({
      videos: [makeHit({ views: 900_000, publishedAt: daysAgo(90, NOW) })],
      range: range(365),
      threshold: BAR,
    });

    expect(metrics.hits.rate).toBe(100);
    expect(metrics.bestShort?.clearsThreshold).toBe(false);
  });

  it("moving the display bar cannot move the hit rate", () => {
    const videos = makeShortsWithHits(10, 4, BAR, daysAgo(30, NOW));

    const atMillion = calculateChannelMetrics({ videos, range: range(90), threshold: BAR });
    const atFiftyMillion = calculateChannelMetrics({
      videos,
      range: range(90),
      threshold: 50_000_000,
    });
    const atNothing = calculateChannelMetrics({ videos, range: range(90), threshold: null });

    expect(atMillion.hits.rate).toBe(40);
    expect(atFiftyMillion.hits.rate).toBe(40);
    // Not even an unconfigured bar suppresses it. The rate belongs to the
    // stored verdicts; the bar belongs to the screen.
    expect(atNothing.hits.rate).toBe(40);
  });

  it("a young cohort is pending, not failing — the age bias, removed", () => {
    /*
     * Twenty Shorts published in the last three days, none of which has had
     * time to reach anything. The old rule counted every one of them in the
     * denominator with nothing in the numerator and reported 0%: a channel was
     * punished for publishing, which is the exact behaviour that made the
     * metric unusable.
     */
    const inFlight = Array.from({ length: 20 }, (_, i) =>
      makePending({ views: 40_000, publishedAt: daysAgo(1 + (i % 3), NOW) }),
    );
    const settled = [
      makeHit({ views: 2_000_000, publishedAt: daysAgo(40, NOW) }),
      makeMiss({ views: 300_000, publishedAt: daysAgo(41, NOW) }),
    ];

    const metrics = calculateChannelMetrics({
      videos: [...inFlight, ...settled],
      range: range(90),
      threshold: BAR,
    });

    expect(metrics.totalShorts).toBe(22);
    // The 20 unfinished Shorts are in neither half.
    expect(metrics.hits.judged).toBe(2);
    expect(metrics.hits.rate).toBe(50);
    expect(metrics.hits.tally.pending).toBe(20);
    expect(metrics.hits.excluded).toBe(20);
  });
});

describe("calculateChannelMetrics — the excluded populations", () => {
  it("unknowns are excluded from the rate and widen the bounds", () => {
    const metrics = calculateChannelMetrics({
      videos: [
        makeHit({ views: 3_000_000, publishedAt: daysAgo(30, NOW) }),
        makeMiss({ views: 100_000, publishedAt: daysAgo(31, NOW) }),
        makeMiss({ views: 100_000, publishedAt: daysAgo(32, NOW) }),
        makeUnknown({ views: 4_000_000, publishedAt: daysAgo(33, NOW) }),
        makeUnknown({ views: 6_000_000, publishedAt: daysAgo(34, NOW) }),
      ],
      range: range(90),
      threshold: BAR,
    });

    expect(metrics.hits.rate).toBe(33.33);
    expect(metrics.hits.tally.unknown).toBe(2);
    // Every unknown DID eventually pass the bar, so each is a potential hit
    // whose timing nobody recorded. 1/5 if they were all too slow, 3/5 if they
    // were all hits.
    expect(metrics.hits.lowerBound).toBe(20);
    expect(metrics.hits.upperBound).toBe(60);
  });

  it("a Short with no rule is unscoreable — never a miss, and never in the bounds", () => {
    const metrics = calculateChannelMetrics({
      videos: [
        makeHit({ views: 2_000_000, publishedAt: daysAgo(20, NOW) }),
        makeUnscoreable({ views: 50_000, publishedAt: daysAgo(21, NOW) }),
        makeUnscoreable({ views: 9_000_000, publishedAt: daysAgo(22, NOW) }),
      ],
      range: range(90),
      threshold: BAR,
    });

    expect(metrics.hits.judged).toBe(1);
    expect(metrics.hits.rate).toBe(100);
    expect(metrics.hits.tally.unscoreable).toBe(2);
    expect(metrics.hits.tally.misses).toBe(0);
    // A Short with no rule is not a potential hit, so it must not widen the
    // upper bound the way an unknown does.
    expect(metrics.hits.upperBound).toBe(100);
  });

  it("Shorts published but none decided gives null, never 0%", () => {
    const metrics = calculateChannelMetrics({
      videos: [
        makePending({ views: 10_000, publishedAt: daysAgo(1, NOW) }),
        makePending({ views: 20_000, publishedAt: daysAgo(2, NOW) }),
      ],
      range: range(30),
      threshold: BAR,
    });

    expect(metrics.totalShorts).toBe(2);
    // 0% would claim these were judged and failed. They have not been judged.
    expect(metrics.hits.rate).toBeNull();
  });

  it("a Short with no stored verdict at all is unscoreable, not a miss", () => {
    // `hit: null` — the evaluator has not reached this Short yet, which is a
    // real state because it runs on the sync cron.
    const metrics = calculateChannelMetrics({
      videos: [makeShort({ views: 12_000_000, publishedAt: daysAgo(9, NOW) })],
      range: range(30),
      threshold: BAR,
    });

    expect(metrics.hits.tally.unscoreable).toBe(1);
    expect(metrics.hits.tally.misses).toBe(0);
    expect(metrics.hits.rate).toBeNull();
  });
});

describe("Example 5 — date filtering", () => {
  const videos: JudgedVideo[] = [
    makeHit({ views: 2_000_000, publishedAt: daysAgo(3, NOW) }),
    makeHit({ views: 2_000_000, publishedAt: daysAgo(20, NOW) }),
    makeHit({ views: 2_000_000, publishedAt: daysAgo(60, NOW) }),
    makeMiss({ views: 500_000, publishedAt: daysAgo(120, NOW) }),
    // Well outside every preset window.
    makeHit({ views: 9_000_000, publishedAt: daysAgo(300, NOW) }),
  ];

  it("counts only Shorts uploaded inside the window", () => {
    expect(calculateChannelMetrics({ videos, range: range(7), threshold: BAR }).totalShorts).toBe(1);
    expect(calculateChannelMetrics({ videos, range: range(30), threshold: BAR }).totalShorts).toBe(2);
    expect(calculateChannelMetrics({ videos, range: range(90), threshold: BAR }).totalShorts).toBe(3);
    expect(calculateChannelMetrics({ videos, range: range(180), threshold: BAR }).totalShorts).toBe(4);
  });

  it("never lets an out-of-window Short reach the numerator", () => {
    // The 9M Short from 300 days ago would dominate every metric if the date
    // filter leaked. At 30 days it must be invisible.
    const metrics = calculateChannelMetrics({ videos, range: range(30), threshold: BAR });
    expect(metrics.hits.hits).toBe(2);
    expect(metrics.bestShort?.views).toBe(2_000_000);
    expect(metrics.totalViews).toBe(4_000_000);
  });

  it("produces independent rates per period, as the spec requires", () => {
    const rates = [7, 30, 90, 180].map(
      (d) => calculateChannelMetrics({ videos, range: range(d), threshold: BAR }).hits.rate,
    );
    expect(rates).toEqual([100, 100, 100, 75]);
  });

  it("treats the window as half-open: the start boundary is in, the end is out", () => {
    const r = range(30);
    const atStart = makeShort({ views: 5_000_000, publishedAt: r.startMs });
    const atEnd = makeShort({ views: 5_000_000, publishedAt: r.endMs });

    expect(calculateChannelMetrics({ videos: [atStart], range: r, threshold: 1 }).totalShorts).toBe(1);
    expect(calculateChannelMetrics({ videos: [atEnd], range: r, threshold: 1 }).totalShorts).toBe(0);
  });
});

describe("Example 7 — long-form exclusion", () => {
  it("long-form videos never contribute to any Shorts metric", () => {
    const videos = [
      makeHit({ views: 1_500_000, publishedAt: daysAgo(5, NOW) }),
      makeMiss({ views: 400_000, publishedAt: daysAgo(6, NOW) }),
      // Two long-form uploads with enormous view counts, inside the window.
      makeLongform({ views: 50_000_000, publishedAt: daysAgo(7, NOW) }),
      makeLongform({ views: 30_000_000, publishedAt: daysAgo(8, NOW) }),
    ];

    const metrics = calculateChannelMetrics({ videos, range: range(30), threshold: BAR });

    expect(metrics.totalShorts).toBe(2);
    expect(metrics.hits.hits).toBe(1);
    expect(metrics.hits.rate).toBe(50);
    // 80M of long-form views must be entirely absent from the totals.
    expect(metrics.totalViews).toBe(1_900_000);
    expect(metrics.bestShort?.views).toBe(1_500_000);
    expect(metrics.excludedLongform).toBe(2);
    // And long-form must not land in the exclusions either: it is not an
    // unjudged Short, it is not a Short.
    expect(metrics.hits.excluded).toBe(0);
  });

  it("counts UNCERTAIN videos in excludedLongform — the displayed number must not change", () => {
    /*
     * `excludedLongform` has always been the complement of the Shorts filter:
     * everything in the window that is not a positively-identified Short,
     * which sweeps in videos the classifier could not resolve. The strict
     * long-form selector (`classification === "not_short"`) now exists and
     * deliberately does NOT feed this figure — it would report 2 here, and
     * this number is rendered on the KPI cards today. The pin is the exact
     * pre-format value: 2 long-form + 1 uncertain = 3.
     */
    const videos = [
      makeHit({ views: 1_500_000, publishedAt: daysAgo(5, NOW) }),
      makeLongform({ views: 9_000_000, publishedAt: daysAgo(6, NOW) }),
      makeLongform({ views: 8_000_000, publishedAt: daysAgo(7, NOW) }),
      makeUncertain({ views: 7_000_000, publishedAt: daysAgo(8, NOW) }),
      // Outside the window: contributes to nothing, in either direction.
      makeUncertain({ views: 6_000_000, publishedAt: daysAgo(90, NOW) }),
    ];

    const metrics = calculateChannelMetrics({ videos, range: range(30), threshold: BAR });

    expect(metrics.totalShorts).toBe(1);
    expect(metrics.excludedLongform).toBe(3);
    // And the uncertain video's views stay out of every Shorts figure, exactly
    // as they always did.
    expect(metrics.totalViews).toBe(1_500_000);
  });

  it("a channel with only long-form uploads has no hit rate, not 0%", () => {
    const metrics = calculateChannelMetrics({
      videos: [makeLongform({ views: 10_000_000, publishedAt: daysAgo(3, NOW) })],
      range: range(30),
      threshold: BAR,
    });
    expect(metrics.totalShorts).toBe(0);
    expect(metrics.hits.rate).toBeNull();
    expect(metrics.averageViews).toBeNull();
    expect(metrics.medianViews).toBeNull();
    expect(metrics.bestShort).toBeNull();
  });
});

describe("calculateChannelMetrics — descriptive statistics", () => {
  it("computes mean, median and best over the window's Shorts", () => {
    const videos = [
      makeShort({ views: 100_000, publishedAt: daysAgo(1, NOW) }),
      makeShort({ views: 300_000, publishedAt: daysAgo(2, NOW) }),
      makeShort({ views: 500_000, publishedAt: daysAgo(3, NOW) }),
      makeShort({ views: 1_100_000, publishedAt: daysAgo(4, NOW) }),
    ];
    const metrics = calculateChannelMetrics({ videos, range: range(30), threshold: BAR });

    expect(metrics.totalViews).toBe(2_000_000);
    expect(metrics.averageViews).toBe(500_000);
    expect(metrics.medianViews).toBe(400_000);
    expect(metrics.viewsPerUpload).toBe(500_000);
    expect(metrics.bestShort?.views).toBe(1_100_000);
    expect(metrics.worstShort?.views).toBe(100_000);
  });

  it("mean and median diverge on a skewed channel — the product's core insight", () => {
    // "Carried by outliers": huge total, unreliable typical performance.
    const spiky = [10_000_000, 8_000_000, 7_000_000, 200_000, 150_000].map((views, i) =>
      views >= BAR
        ? makeHit({ views, publishedAt: daysAgo(i + 1, NOW) })
        : makeMiss({ views, publishedAt: daysAgo(i + 1, NOW) }),
    );
    // "Consistent": lower total, far more dependable.
    const steady = [1_200_000, 1_400_000, 1_100_000, 1_300_000, 1_600_000].map((views, i) =>
      makeHit({ views, publishedAt: daysAgo(i + 1, NOW) }),
    );

    const spikyMetrics = calculateChannelMetrics({ videos: spiky, range: range(30), threshold: BAR });
    const steadyMetrics = calculateChannelMetrics({ videos: steady, range: range(30), threshold: BAR });

    // Total views favour the spiky channel by a wide margin...
    expect(spikyMetrics.totalViews).toBeGreaterThan(steadyMetrics.totalViews);
    // ...while hit rate and consistency correctly favour the steady one.
    expect(spikyMetrics.hits.rate).toBe(60);
    expect(steadyMetrics.hits.rate).toBe(100);
    expect(steadyMetrics.consistencyScore).toBeGreaterThan(
      spikyMetrics.consistencyScore ?? 0,
    );
  });

  it("reports the top-decile average, always including at least one Short", () => {
    const videos = Array.from({ length: 20 }, (_, i) =>
      makeShort({ views: (i + 1) * 100_000, publishedAt: daysAgo(1, NOW) }),
    );
    const metrics = calculateChannelMetrics({ videos, range: range(30), threshold: BAR });
    // Top 10% of 20 videos = the best 2: 2.0M and 1.9M.
    expect(metrics.topDecileAverageViews).toBe(1_950_000);
  });

  it("computes uploads per week from the window length", () => {
    const videos = Array.from({ length: 28 }, (_, i) =>
      makeShort({ views: 1000, publishedAt: daysAgo(i + 1, NOW) }),
    );
    const metrics = calculateChannelMetrics({ videos, range: range(28), threshold: BAR });
    expect(metrics.uploadsPerWeek).toBe(7);
  });

  it("returns an entirely empty-but-valid metric set for a channel with no data", () => {
    const metrics = calculateChannelMetrics({ videos: [], range: range(30), threshold: BAR });
    expect(metrics.totalShorts).toBe(0);
    expect(metrics.hits.hits).toBe(0);
    expect(metrics.hits.rate).toBeNull();
    expect(metrics.hits.excluded).toBe(0);
    expect(metrics.totalViews).toBe(0);
    expect(metrics.consistencyScore).toBeNull();
  });
});

describe("calculatePortfolioSummary", () => {
  const channelWith = (id: string, views: number[], days = 5, countsTowardHitRate = true) => ({
    id,
    name: id,
    countsTowardHitRate,
    metrics: calculateChannelMetrics({
      videos: views.map((v, i) =>
        v >= BAR
          ? makeHit({ views: v, publishedAt: daysAgo(days + i, NOW) })
          : makeMiss({ views: v, publishedAt: daysAgo(days + i, NOW) }),
      ),
      range: range(30),
      threshold: BAR,
    }),
  });

  it("averages per-channel hit rates and names the leader", () => {
    const summary = calculatePortfolioSummary([
      channelWith("A", [2_000_000, 2_000_000, 100_000, 100_000]), // 50%
      channelWith("B", [2_000_000, 2_000_000, 2_000_000, 2_000_000]), // 100%
    ]);

    expect(summary.channelCount).toBe(2);
    expect(summary.totalShorts).toBe(8);
    expect(summary.pooled.hits).toBe(6);
    expect(summary.averageHitRate).toBe(75);
    expect(summary.pooled.rate).toBe(75);
    expect(summary.topChannel?.name).toBe("B");
  });

  it("adds the channels' exclusions rather than losing them in the pool", () => {
    const withWaiting = {
      id: "C",
      name: "C",
      countsTowardHitRate: true,
      metrics: calculateChannelMetrics({
        videos: [
          makeHit({ views: 2_000_000, publishedAt: daysAgo(20, NOW) }),
          makePending({ views: 5_000, publishedAt: daysAgo(1, NOW) }),
          makeUnknown({ views: 8_000_000, publishedAt: daysAgo(21, NOW) }),
        ],
        range: range(30),
        threshold: BAR,
      }),
    };

    const summary = calculatePortfolioSummary([
      channelWith("A", [2_000_000, 100_000]),
      withWaiting,
    ]);

    expect(summary.pooled.judged).toBe(3);
    expect(summary.pooled.tally.pending).toBe(1);
    expect(summary.pooled.tally.unknown).toBe(1);
    expect(summary.pooled.excluded).toBe(2);
  });

  it("excludes channels with no decided Shorts from the average rather than scoring them 0", () => {
    const summary = calculatePortfolioSummary([
      channelWith("A", [2_000_000, 2_000_000]), // 100%
      {
        id: "B",
        name: "B",
        countsTowardHitRate: true,
        metrics: calculateChannelMetrics({ videos: [], range: range(30), threshold: BAR }),
      },
    ]);

    expect(summary.channelCount).toBe(2);
    expect(summary.channelsWithData).toBe(1);
    // Averaging in a phantom 0% would report 50% and defame an idle channel.
    expect(summary.averageHitRate).toBe(100);
  });

  it("a channel whose Shorts are all still in flight is unmeasured, not last", () => {
    const inFlight = {
      id: "B",
      name: "B",
      countsTowardHitRate: true,
      metrics: calculateChannelMetrics({
        videos: Array.from({ length: 12 }, (_, i) =>
          makePending({ views: 30_000, publishedAt: daysAgo(i + 1, NOW) }),
        ),
        range: range(30),
        threshold: BAR,
      }),
    };

    const summary = calculatePortfolioSummary([channelWith("A", [2_000_000, 100_000]), inFlight]);

    expect(summary.channelsWithData).toBe(1);
    expect(summary.averageHitRate).toBe(50);
    expect(summary.totalShorts).toBe(14);
    expect(summary.pooled.tally.pending).toBe(12);
  });

  it("returns null averages when nothing has data at all", () => {
    const summary = calculatePortfolioSummary([]);
    expect(summary.averageHitRate).toBeNull();
    expect(summary.pooled.rate).toBeNull();
    expect(summary.topChannel).toBeNull();
  });

  /**
   * THE MEASUREMENT PROBLEM `countsTowardHitRate` EXISTS TO FIX.
   *
   * A watchlist niche is full of channels nobody at Northstar is trying to be.
   * Averaging them into the portfolio produces a number describing work the
   * studio does not do — arithmetic that is correct over a population nobody
   * chose. The volume figures keep counting them, because those describe the
   * tracker rather than the studio, and the table under the headline shows the
   * same rows.
   */
  describe("the scorecard split", () => {
    it("leaves watchlist channels out of the rate and keeps them in the volume", () => {
      const summary = calculatePortfolioSummary([
        // Ours: 50%.
        channelWith("A", [2_000_000, 100_000]),
        // Watched: 100%, and it must not drag the headline up to 75%.
        channelWith("W", [2_000_000, 2_000_000], 5, false),
      ]);

      expect(summary.averageHitRate).toBe(50);
      expect(summary.pooled.hits).toBe(1);
      expect(summary.pooled.judged).toBe(2);

      // Volume counts everything. "Tracked channels: 2" has to mean the two
      // rows in the table, or the header is lying about the page it sits on.
      expect(summary.channelCount).toBe(2);
      expect(summary.totalShorts).toBe(4);

      // And the gap between the two populations is reportable, so a caption can
      // say what the rate is actually over.
      expect(summary.scorecardChannelCount).toBe(1);
    });

    it("cannot be won by a watchlist channel", () => {
      const summary = calculatePortfolioSummary([
        channelWith("A", [2_000_000, 100_000]), // 50%
        channelWith("W", [2_000_000, 2_000_000], 5, false), // 100%, watched
      ]);

      // "Best performing" is read as "the strongest thing we have". A channel
      // nobody is trying to be must not top the studio's own list.
      expect(summary.topChannel?.name).toBe("A");
    });

    it("reports no rate at all when everything in scope is watched", () => {
      const summary = calculatePortfolioSummary([
        channelWith("W", [2_000_000, 2_000_000], 5, false),
      ]);

      // Null, never 0 — nothing was measured, which is a different claim from
      // "measured and none of it hit".
      expect(summary.averageHitRate).toBeNull();
      expect(summary.pooled.rate).toBeNull();
      expect(summary.scorecardChannelCount).toBe(0);
      // The Shorts are still there. They are simply not the studio's scorecard.
      expect(summary.totalShorts).toBe(2);
    });
  });
});
