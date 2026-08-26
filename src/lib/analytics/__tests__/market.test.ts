import { describe, expect, it } from "vitest";
import { compareToMarket } from "../market";
import { DAY_MS, daysAgo, makeLongform, makeShort } from "./factories";

const NOW = Date.UTC(2026, 5, 1);
const range = (days: number) => ({ startMs: NOW - days * DAY_MS, endMs: NOW });

const channelWith = (views: number[]) => ({
  videos: views.map((v, i) => makeShort({ views: v, publishedAt: daysAgo(i + 1, NOW) })),
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
            makeShort({ views: 1_000_000, publishedAt: daysAgo(2, NOW) }),
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
