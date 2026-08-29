import { describe, expect, it } from "vitest";
import { compareToMarket } from "../market";
import {
  DAY_MS,
  daysAgo,
  makeHit,
  makeLongform,
  makeMiss,
  makePending,
  makeShort,
} from "./factories";

const NOW = Date.UTC(2026, 5, 1);
const range = (days: number) => ({ startMs: NOW - days * DAY_MS, endMs: NOW });

/**
 * A channel whose Shorts are DECIDED, hit where they cleared a million.
 *
 * The mapping from views to verdict is a fixture convenience and not the rule —
 * the two are independent, which the "same views, different verdicts" case at
 * the bottom of this file proves. What it preserves is the intent of every
 * comparison here: both sides are judged by the same complete rule, which is
 * what makes a comparison a comparison.
 */
const channelWith = (views: number[]) => ({
  videos: views.map((v, i) =>
    v >= 1_000_000
      ? makeHit({ views: v, publishedAt: daysAgo(i + 1, NOW) })
      : makeMiss({ views: v, publishedAt: daysAgo(i + 1, NOW) }),
  ),
});

describe("compareToMarket", () => {
  it("pools each side rather than averaging per-channel averages", () => {
    // Two of our channels: one posted once at 1M, one posted three times at 100K.
    // Pooled median across the four Shorts is 100K, whereas averaging the two
    // channel medians would give 550K and overstate a channel that barely posts.
    const comparison = compareToMarket(
      [channelWith([1_000_000]), channelWith([100_000, 100_000, 100_000])],
      [channelWith([200_000, 200_000])],
      range(30),
      1_000_000,
    );

    const median = comparison.metrics.find((m) => m.key === "medianViews");
    expect(median?.ours).toBe(100_000);
    expect(comparison.ours.shorts).toHaveLength(4);
  });

  it("excludes long-form from both pools", () => {
    const comparison = compareToMarket(
      [
        {
          videos: [
            makeHit({ views: 1_000_000, publishedAt: daysAgo(2, NOW) }),
            makeLongform({ views: 90_000_000, publishedAt: daysAgo(2, NOW) }),
          ],
        },
      ],
      [channelWith([500_000])],
      range(30),
      1_000_000,
    );
    expect(comparison.ours.shorts).toHaveLength(1);
    const avg = comparison.metrics.find((m) => m.key === "averageViews");
    expect(avg?.ours).toBe(1_000_000);
  });

  it("marks upload frequency as neutral and keeps it out of the tally", () => {
    const comparison = compareToMarket(
      [channelWith([2_000_000, 2_000_000])],
      [channelWith([100_000, 100_000, 100_000, 100_000, 100_000, 100_000])],
      range(30),
      1_000_000,
    );

    const uploads = comparison.metrics.find((m) => m.key === "uploadsPerWeek");
    expect(uploads?.direction).toBe("neutral");
    // We post far less, but that must not be scored as losing.
    expect(uploads?.outperforming).toBeNull();

    // Every metric counted in the tally must be a directional one.
    expect(comparison.comparableCount).toBeLessThan(comparison.metrics.length);
  });

  it("counts a directional win only when we genuinely lead", () => {
    const comparison = compareToMarket(
      [channelWith([2_000_000, 2_000_000, 2_000_000])],
      [channelWith([100_000, 100_000, 100_000])],
      range(30),
      1_000_000,
    );

    const hitRate = comparison.metrics.find((m) => m.key === "hitRate");
    expect(hitRate?.ours).toBe(100);
    expect(hitRate?.market).toBe(0);
    expect(hitRate?.outperforming).toBe(true);
    expect(comparison.outperformingCount).toBeGreaterThan(0);
  });

  it("reports percentage-point deltas for rates and relative deltas for magnitudes", () => {
    const comparison = compareToMarket(
      [channelWith([2_000_000, 2_000_000, 100_000, 100_000])],
      [channelWith([2_000_000, 100_000, 100_000, 100_000])],
      range(30),
      1_000_000,
    );

    const hitRate = comparison.metrics.find((m) => m.key === "hitRate");
    // 50% vs 25% is 25 percentage points, not "100% better".
    expect(hitRate?.delta).toBe(25);

    const median = comparison.metrics.find((m) => m.key === "medianViews");
    expect(median?.deltaPercent).not.toBeNull();
  });

  it("flags insufficient data when a side has no Shorts, without throwing", () => {
    const comparison = compareToMarket([channelWith([])], [channelWith([100_000])], range(30), 1_000_000);
    expect(comparison.insufficientData).toBe(true);
    expect(comparison.metrics.find((m) => m.key === "medianViews")?.ours).toBeNull();
    // Nothing can be scored when one side is empty.
    expect(comparison.comparableCount).toBe(0);
  });

  it("normalises upload frequency per channel, so a bigger pool is not automatically faster", () => {
    const comparison = compareToMarket(
      [channelWith([1, 1, 1, 1, 1, 1, 1])],
      [
        channelWith([1, 1, 1, 1, 1, 1, 1]),
        channelWith([1, 1, 1, 1, 1, 1, 1]),
        channelWith([1, 1, 1, 1, 1, 1, 1]),
      ],
      range(7),
      1_000_000,
    );

    const uploads = comparison.metrics.find((m) => m.key === "uploadsPerWeek");
    // Same cadence per channel on both sides, despite 3x the total volume.
    expect(uploads?.ours).toBe(uploads?.market);
  });
});

/**
 * =========================================================================
 * WHAT THE WINDOW CHANGED ABOUT THIS COMPARISON
 * =========================================================================
 * Both sides used to be scored by counting Shorts above the threshold passed
 * in, which meant the comparison was really "whose back catalogue has had
 * longer". A competitor who had stopped publishing a year ago beat a channel
 * publishing weekly, every time, on nothing but maturity.
 */
describe("compareToMarket under the windowed rule", () => {
  it("identical view counts can produce opposite rates, and the verdicts decide", () => {
    // Both sides: three Shorts at two million. Ours reached it inside the
    // window; theirs took months. Same numbers, opposite answers.
    const oursFast = {
      videos: [2_000_000, 2_100_000, 2_200_000].map((v, i) =>
        makeHit({ views: v, publishedAt: daysAgo(i + 1, NOW) }),
      ),
    };
    const theirsSlow = {
      videos: [2_000_000, 2_100_000, 2_200_000].map((v, i) =>
        makeMiss({ views: v, publishedAt: daysAgo(i + 1, NOW) }),
      ),
    };

    const comparison = compareToMarket([oursFast], [theirsSlow], range(30), 1_000_000);
    const hitRate = comparison.metrics.find((m) => m.key === "hitRate");

    expect(hitRate?.ours).toBe(100);
    expect(hitRate?.market).toBe(0);
    // And the pooled view totals are identical, which is the point.
    expect(comparison.ours.metrics.totalViews).toBe(
      comparison.market.metrics.totalViews,
    );
  });

  it("a side whose Shorts are all in flight has no rate, and does not lose by default", () => {
    const oursInFlight = {
      videos: Array.from({ length: 5 }, (_, i) =>
        makePending({ views: 20_000, publishedAt: daysAgo(i + 1, NOW) }),
      ),
    };
    const comparison = compareToMarket(
      [oursInFlight],
      [channelWith([2_000_000, 100_000])],
      range(30),
      1_000_000,
    );

    const hitRate = comparison.metrics.find((m) => m.key === "hitRate");
    expect(hitRate?.ours).toBeNull();
    // `outperforming` is null rather than false: there is nothing to compare,
    // which is not the same as losing, and the scoreboard must not count it.
    expect(hitRate?.outperforming).toBeNull();
  });

  it("growth is null rather than a fabricated fall when the recent half is unfinished", () => {
    // The old `growth` metric compared lifetime rates between halves of the
    // window, so the second half — always the younger cohort — was flattered
    // downward and this row reported a decline on every channel still
    // publishing.
    const ours = {
      videos: [
        makeHit({ views: 2_000_000, publishedAt: daysAgo(25, NOW) }),
        makeHit({ views: 2_000_000, publishedAt: daysAgo(24, NOW) }),
        makePending({ views: 30_000, publishedAt: daysAgo(3, NOW) }),
        makePending({ views: 40_000, publishedAt: daysAgo(2, NOW) }),
      ],
    };
    const comparison = compareToMarket(
      [ours],
      [channelWith([500_000, 600_000])],
      range(30),
      1_000_000,
    );

    expect(comparison.metrics.find((m) => m.key === "growth")?.ours).toBeNull();
  });

  it("a competitor in an unconfigured niche is excluded, never counted as failing", () => {
    const theirs = {
      videos: Array.from({ length: 4 }, (_, i) =>
        // No verdict at all: nothing has judged these Shorts.
        makeShort({ views: 3_000_000, publishedAt: daysAgo(i + 1, NOW) }),
      ),
    };
    const comparison = compareToMarket(
      [channelWith([2_000_000, 100_000])],
      [theirs],
      range(30),
      1_000_000,
    );

    const hitRate = comparison.metrics.find((m) => m.key === "hitRate");
    expect(hitRate?.market).toBeNull();
    expect(comparison.market.metrics.hits.tally.misses).toBe(0);
    expect(comparison.market.metrics.hits.tally.unscoreable).toBe(4);
  });
});
