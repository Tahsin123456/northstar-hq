import { describe, expect, it } from "vitest";
import { calculateChannelMetrics, calculatePortfolioSummary } from "../channel-metrics";
import type { DateRange } from "../types";
import {
  DAY_MS,
  daysAgo,
  makeLongform,
  makeShort,
  makeShortsWithHits,
} from "./factories";

const NOW = Date.UTC(2026, 5, 1);
const range = (days: number): DateRange => ({
  startMs: NOW - days * DAY_MS,
  endMs: NOW,
});

describe("calculateChannelMetrics — the spec's worked example", () => {
  it("40 Shorts uploaded in 30 days, 12 at or above 1M -> 30%", () => {
    const videos = makeShortsWithHits(40, 12, 1_000_000, daysAgo(10, NOW));
    const metrics = calculateChannelMetrics({
      videos,
      range: range(30),
      threshold: 1_000_000,
    });

    expect(metrics.totalShorts).toBe(40);
    expect(metrics.hitCount).toBe(12);
    expect(metrics.hitRate).toBe(30);
  });
});

describe("Example 5 — date filtering", () => {
  const videos = [
    makeShort({ views: 2_000_000, publishedAt: daysAgo(3, NOW) }),
    makeShort({ views: 2_000_000, publishedAt: daysAgo(20, NOW) }),
    makeShort({ views: 2_000_000, publishedAt: daysAgo(60, NOW) }),
    makeShort({ views: 500_000, publishedAt: daysAgo(120, NOW) }),
    // Well outside every preset window.
    makeShort({ views: 9_000_000, publishedAt: daysAgo(300, NOW) }),
  ];

  it("counts only Shorts uploaded inside the window", () => {
    expect(calculateChannelMetrics({ videos, range: range(7), threshold: 1_000_000 }).totalShorts).toBe(1);
    expect(calculateChannelMetrics({ videos, range: range(30), threshold: 1_000_000 }).totalShorts).toBe(2);
    expect(calculateChannelMetrics({ videos, range: range(90), threshold: 1_000_000 }).totalShorts).toBe(3);
    expect(calculateChannelMetrics({ videos, range: range(180), threshold: 1_000_000 }).totalShorts).toBe(4);
  });

  it("never lets an out-of-window Short reach the numerator", () => {
    // The 9M Short from 300 days ago would dominate every metric if the date
    // filter leaked. At 30 days it must be invisible.
    const metrics = calculateChannelMetrics({
      videos,
      range: range(30),
      threshold: 1_000_000,
    });
    expect(metrics.hitCount).toBe(2);
    expect(metrics.bestShort?.views).toBe(2_000_000);
    expect(metrics.totalViews).toBe(4_000_000);
  });

  it("produces independent rates per period, as the spec requires", () => {
    const rates = [7, 30, 90, 180].map(
      (d) => calculateChannelMetrics({ videos, range: range(d), threshold: 1_000_000 }).hitRate,
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
      makeShort({ views: 1_500_000, publishedAt: daysAgo(5, NOW) }),
      makeShort({ views: 400_000, publishedAt: daysAgo(6, NOW) }),
      // Two long-form uploads with enormous view counts, inside the window.
      makeLongform({ views: 50_000_000, publishedAt: daysAgo(7, NOW) }),
      makeLongform({ views: 30_000_000, publishedAt: daysAgo(8, NOW) }),
    ];

    const metrics = calculateChannelMetrics({
      videos,
      range: range(30),
      threshold: 1_000_000,
    });

    expect(metrics.totalShorts).toBe(2);
    expect(metrics.hitCount).toBe(1);
    expect(metrics.hitRate).toBe(50);
    // 80M of long-form views must be entirely absent from the totals.
    expect(metrics.totalViews).toBe(1_900_000);
    expect(metrics.bestShort?.views).toBe(1_500_000);
    expect(metrics.excludedLongform).toBe(2);
  });

  it("a channel with only long-form uploads has no hit rate, not 0%", () => {
    const metrics = calculateChannelMetrics({
      videos: [makeLongform({ views: 10_000_000, publishedAt: daysAgo(3, NOW) })],
      range: range(30),
      threshold: 1_000_000,
    });
    expect(metrics.totalShorts).toBe(0);
    expect(metrics.hitRate).toBeNull();
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
    const metrics = calculateChannelMetrics({ videos, range: range(30), threshold: 1_000_000 });

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
      makeShort({ views, publishedAt: daysAgo(i + 1, NOW) }),
    );
    // "Consistent": lower total, far more dependable.
    const steady = [1_200_000, 1_400_000, 1_100_000, 1_300_000, 1_600_000].map((views, i) =>
      makeShort({ views, publishedAt: daysAgo(i + 1, NOW) }),
    );

    const spikyMetrics = calculateChannelMetrics({ videos: spiky, range: range(30), threshold: 1_000_000 });
    const steadyMetrics = calculateChannelMetrics({ videos: steady, range: range(30), threshold: 1_000_000 });

    // Total views favour the spiky channel by a wide margin...
    expect(spikyMetrics.totalViews).toBeGreaterThan(steadyMetrics.totalViews);
    // ...while hit rate and consistency correctly favour the steady one.
    expect(spikyMetrics.hitRate).toBe(60);
    expect(steadyMetrics.hitRate).toBe(100);
    expect(steadyMetrics.consistencyScore).toBeGreaterThan(
      spikyMetrics.consistencyScore ?? 0,
    );
  });

  it("reports the top-decile average, always including at least one Short", () => {
    const videos = Array.from({ length: 20 }, (_, i) =>
      makeShort({ views: (i + 1) * 100_000, publishedAt: daysAgo(1, NOW) }),
    );
    const metrics = calculateChannelMetrics({ videos, range: range(30), threshold: 1_000_000 });
    // Top 10% of 20 videos = the best 2: 2.0M and 1.9M.
    expect(metrics.topDecileAverageViews).toBe(1_950_000);
  });

  it("computes uploads per week from the window length", () => {
    const videos = Array.from({ length: 28 }, (_, i) =>
      makeShort({ views: 1000, publishedAt: daysAgo(i + 1, NOW) }),
    );
    const metrics = calculateChannelMetrics({ videos, range: range(28), threshold: 1_000_000 });
    expect(metrics.uploadsPerWeek).toBe(7);
  });

  it("returns an entirely empty-but-valid metric set for a channel with no data", () => {
    const metrics = calculateChannelMetrics({ videos: [], range: range(30), threshold: 1_000_000 });
    expect(metrics.totalShorts).toBe(0);
    expect(metrics.hitCount).toBe(0);
    expect(metrics.hitRate).toBeNull();
    expect(metrics.totalViews).toBe(0);
    expect(metrics.consistencyScore).toBeNull();
  });
});

describe("calculatePortfolioSummary", () => {
  const channelWith = (id: string, views: number[], days = 5) => ({
    id,
    name: id,
    metrics: calculateChannelMetrics({
      videos: views.map((v, i) => makeShort({ views: v, publishedAt: daysAgo(days + i, NOW) })),
      range: range(30),
      threshold: 1_000_000,
    }),
  });

  it("averages per-channel hit rates and names the leader", () => {
    const summary = calculatePortfolioSummary([
      channelWith("A", [2_000_000, 2_000_000, 100_000, 100_000]), // 50%
      channelWith("B", [2_000_000, 2_000_000, 2_000_000, 2_000_000]), // 100%
    ]);

    expect(summary.channelCount).toBe(2);
    expect(summary.totalShorts).toBe(8);
    expect(summary.totalHits).toBe(6);
    expect(summary.averageHitRate).toBe(75);
    expect(summary.pooledHitRate).toBe(75);
    expect(summary.topChannel?.name).toBe("B");
  });

  it("excludes channels with no Shorts from the average rather than scoring them 0", () => {
    const summary = calculatePortfolioSummary([
      channelWith("A", [2_000_000, 2_000_000]), // 100%
      { id: "B", name: "B", metrics: calculateChannelMetrics({ videos: [], range: range(30), threshold: 1_000_000 }) },
    ]);

    expect(summary.channelCount).toBe(2);
    expect(summary.channelsWithData).toBe(1);
    // Averaging in a phantom 0% would report 50% and defame an idle channel.
    expect(summary.averageHitRate).toBe(100);
  });

  it("returns null averages when nothing has data at all", () => {
    const summary = calculatePortfolioSummary([]);
    expect(summary.averageHitRate).toBeNull();
    expect(summary.pooledHitRate).toBeNull();
    expect(summary.topChannel).toBeNull();
  });
});
