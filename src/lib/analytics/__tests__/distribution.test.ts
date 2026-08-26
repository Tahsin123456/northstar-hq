import { describe, expect, it } from "vitest";
import { calculateViewDistribution } from "../distribution";
import { VIEW_BUCKETS } from "../constants";
import { makeShort } from "./factories";

describe("calculateViewDistribution", () => {
  it("returns every bucket, including empty ones", () => {
    const bins = calculateViewDistribution([], 1_000_000);
    expect(bins).toHaveLength(VIEW_BUCKETS.length);
    expect(bins.every((b) => b.count === 0)).toBe(true);
    expect(bins.every((b) => b.share === 0)).toBe(true);
  });

  it("places each Short in exactly one bucket", () => {
    const shorts = [
      makeShort({ views: 5_000 }),
      makeShort({ views: 25_000 }),
      makeShort({ views: 75_000 }),
      makeShort({ views: 150_000 }),
      makeShort({ views: 300_000 }),
      makeShort({ views: 750_000 }),
      makeShort({ views: 1_500_000 }),
      makeShort({ views: 3_000_000 }),
      makeShort({ views: 7_000_000 }),
      makeShort({ views: 25_000_000 }),
    ];
    const bins = calculateViewDistribution(shorts, 1_000_000);
    expect(bins.every((b) => b.count === 1)).toBe(true);
    expect(bins.reduce((total, b) => total + b.count, 0)).toBe(shorts.length);
  });

  it("uses half-open buckets so boundary values land in the higher bucket", () => {
    const bins = calculateViewDistribution([makeShort({ views: 1_000_000 })], 1_000_000);
    expect(bins.find((b) => b.id === "500k-1m")?.count).toBe(0);
    expect(bins.find((b) => b.id === "1m-2m")?.count).toBe(1);
  });

  it("marks buckets entirely at or above the threshold as hit buckets", () => {
    const bins = calculateViewDistribution([], 1_000_000);
    expect(bins.find((b) => b.id === "500k-1m")?.isHitBucket).toBe(false);
    expect(bins.find((b) => b.id === "1m-2m")?.isHitBucket).toBe(true);
    expect(bins.find((b) => b.id === "10m+")?.isHitBucket).toBe(true);
  });

  it("re-marks hit buckets when the threshold changes, without new data", () => {
    const shorts = [makeShort({ views: 600_000 })];
    const at1M = calculateViewDistribution(shorts, 1_000_000);
    const at500K = calculateViewDistribution(shorts, 500_000);

    expect(at1M.find((b) => b.id === "500k-1m")?.isHitBucket).toBe(false);
    expect(at500K.find((b) => b.id === "500k-1m")?.isHitBucket).toBe(true);
    // The underlying counts are identical — only the shading moves.
    expect(at1M.map((b) => b.count)).toEqual(at500K.map((b) => b.count));
  });

  it("computes shares that sum to 1", () => {
    const shorts = [
      makeShort({ views: 5_000 }),
      makeShort({ views: 5_000 }),
      makeShort({ views: 1_500_000 }),
      makeShort({ views: 25_000_000 }),
    ];
    const bins = calculateViewDistribution(shorts, 1_000_000);
    expect(bins.reduce((total, b) => total + b.share, 0)).toBeCloseTo(1);
    expect(bins.find((b) => b.id === "lt10k")?.share).toBeCloseTo(0.5);
  });

  it("separates two channels with an identical hit rate but different shapes", () => {
    // Both are 20% at 1M — the distribution is what tells them apart.
    const clustered = [900_000, 950_000, 980_000, 940_000, 1_100_000].map((views) =>
      makeShort({ views }),
    );
    const barbell = [2_000, 3_000, 1_500, 4_000, 40_000_000].map((views) => makeShort({ views }));

    const clusteredBins = calculateViewDistribution(clustered, 1_000_000);
    const barbellBins = calculateViewDistribution(barbell, 1_000_000);

    expect(clusteredBins.find((b) => b.id === "500k-1m")?.count).toBe(4);
    expect(barbellBins.find((b) => b.id === "lt10k")?.count).toBe(4);
    expect(barbellBins.find((b) => b.id === "10m+")?.count).toBe(1);
  });

  it("counts a zero-view Short in the lowest bucket", () => {
    const bins = calculateViewDistribution([makeShort({ views: 0 })], 1_000_000);
    expect(bins[0].count).toBe(1);
  });
});
