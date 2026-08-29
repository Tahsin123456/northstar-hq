import { describe, expect, it } from "vitest";
import { calculateViewDistribution } from "../distribution";
import { VIEW_BUCKETS } from "../constants";
import { makeHit, makeMiss, makePending, makeShort, makeUnknown } from "./factories";

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

  /*
   * THIS USED TO ASSERT "hit buckets", AND THAT WAS THE BUG.
   *
   * The x-axis is lifetime views. A Short reaches the 10M+ bucket whether it
   * took two days or two years, and only one of those is a hit — so a flag
   * called `isHitBucket` was shading a region of a lifetime axis and calling it
   * a verdict. The flag now says what it actually marks: where the bar falls.
   * The test below is the same arithmetic under a name that is true.
   */
  it("marks buckets entirely at or above the bar — a position, not a verdict", () => {
    const bins = calculateViewDistribution([], 1_000_000);
    expect(bins.find((b) => b.id === "500k-1m")?.isAboveThreshold).toBe(false);
    expect(bins.find((b) => b.id === "1m-2m")?.isAboveThreshold).toBe(true);
    expect(bins.find((b) => b.id === "10m+")?.isAboveThreshold).toBe(true);
  });

  it("a Short in the top bucket can be a miss, and the bin says both", () => {
    // The case the old flag could not express: 40M lifetime views against a 1M
    // bar, and a stored miss because it took years to get there.
    const bins = calculateViewDistribution(
      [makeMiss({ views: 40_000_000 })],
      1_000_000,
    );
    const top = bins.find((b) => b.id === "10m+");

    expect(top?.isAboveThreshold).toBe(true);
    expect(top?.count).toBe(1);
    expect(top?.tally.hits).toBe(0);
    expect(top?.tally.misses).toBe(1);
  });

  it("carries each bucket's verdicts, which the bar's height cannot show", () => {
    const bins = calculateViewDistribution(
      [
        makeHit({ views: 3_000_000 }),
        makeMiss({ views: 3_500_000 }),
        makeUnknown({ views: 4_000_000 }),
        makePending({ views: 2_500_000 }),
        makeShort({ views: 2_100_000 }),
      ],
      1_000_000,
    );
    const bucket = bins.find((b) => b.id === "2m-5m");

    expect(bucket?.count).toBe(5);
    expect(bucket?.tally).toEqual({
      hits: 1,
      misses: 1,
      pending: 1,
      unknown: 1,
      // The Short with no stored verdict at all.
      unscoreable: 1,
    });
  });

  it("re-marks the bar when the threshold changes, without new data", () => {
    const shorts = [makeShort({ views: 600_000 })];
    const at1M = calculateViewDistribution(shorts, 1_000_000);
    const at500K = calculateViewDistribution(shorts, 500_000);

    expect(at1M.find((b) => b.id === "500k-1m")?.isAboveThreshold).toBe(false);
    expect(at500K.find((b) => b.id === "500k-1m")?.isAboveThreshold).toBe(true);
    // The underlying counts are identical — only the shading moves.
    expect(at1M.map((b) => b.count)).toEqual(at500K.map((b) => b.count));
    // And so are the verdicts. Moving the bar decides nothing.
    expect(at1M.map((b) => b.tally)).toEqual(at500K.map((b) => b.tally));
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
    // Both are 20%: one hit and four misses each. The distribution is what
    // tells them apart, which is the reason this chart exists at all.
    const clustered = [900_000, 950_000, 980_000, 940_000, 1_100_000].map((views, i) =>
      i === 4 ? makeHit({ views }) : makeMiss({ views }),
    );
    const barbell = [2_000, 3_000, 1_500, 4_000, 40_000_000].map((views, i) =>
      i === 4 ? makeHit({ views }) : makeMiss({ views }),
    );

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
