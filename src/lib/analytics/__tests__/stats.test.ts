import { describe, expect, it } from "vitest";
import {
  consistencyScore,
  mean,
  median,
  percentile,
  roundTo,
  standardDeviation,
  sum,
  topFractionAverage,
} from "../stats";

describe("mean", () => {
  it("returns null for empty input, never 0", () => {
    expect(mean([])).toBeNull();
  });
  it("averages correctly", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([100_000, 300_000])).toBe(200_000);
  });
});

describe("median", () => {
  it("returns null for empty input", () => {
    expect(median([])).toBeNull();
  });
  it("returns the middle value for odd counts", () => {
    expect(median([5, 1, 3])).toBe(3);
  });
  it("averages the two middle values for even counts", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("does not mutate the input array", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
  it("is robust to a single extreme outlier, unlike the mean", () => {
    const views = [1_000_000, 1_100_000, 1_200_000, 1_050_000, 90_000_000];
    expect(median(views)).toBe(1_100_000);
    expect(mean(views)).toBeGreaterThan(18_000_000);
  });
});

describe("percentile", () => {
  it("returns null for empty input and the sole value for one item", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.9)).toBe(7);
  });
  it("interpolates between neighbours", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 1)).toBe(4);
  });
  it("clamps out-of-bounds fractions", () => {
    expect(percentile([1, 2, 3], -5)).toBe(1);
    expect(percentile([1, 2, 3], 5)).toBe(3);
  });
});

describe("topFractionAverage", () => {
  it("returns null for empty input", () => {
    expect(topFractionAverage([], 0.1)).toBeNull();
  });
  it("always includes at least one value", () => {
    expect(topFractionAverage([5], 0.1)).toBe(5);
  });
  it("averages the top decile", () => {
    const values = Array.from({ length: 10 }, (_, i) => (i + 1) * 100);
    expect(topFractionAverage(values, 0.1)).toBe(1000);
    expect(topFractionAverage(values, 0.5)).toBe(800);
  });
});

describe("standardDeviation", () => {
  it("returns null for empty and 0 for a single value", () => {
    expect(standardDeviation([])).toBeNull();
    expect(standardDeviation([42])).toBe(0);
  });
  it("computes the population standard deviation", () => {
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
  });
});

describe("consistencyScore", () => {
  it("returns null below three values, where the number would be noise", () => {
    expect(consistencyScore([])).toBeNull();
    expect(consistencyScore([1_000_000])).toBeNull();
    expect(consistencyScore([1_000_000, 1_100_000])).toBeNull();
  });

  it("scores a perfectly uniform channel at 100", () => {
    expect(consistencyScore([1_000_000, 1_000_000, 1_000_000, 1_000_000])).toBe(100);
  });

  it("rates a steady channel above a spiky one with the same or higher total", () => {
    const spiky = [10_000_000, 8_000_000, 7_000_000, 200_000, 150_000];
    const steady = [1_200_000, 1_400_000, 1_100_000, 1_300_000, 1_600_000];
    const spikyScore = consistencyScore(spiky);
    const steadyScore = consistencyScore(steady);

    expect(spikyScore).not.toBeNull();
    expect(steadyScore).not.toBeNull();
    expect(steadyScore!).toBeGreaterThan(spikyScore!);
  });

  it("is not destroyed by one outlier, unlike a variance-based measure", () => {
    // Quartile-based dispersion is the reason this holds: four tightly grouped
    // values plus one 100x spike should still read as broadly consistent.
    const withOutlier = [1_000_000, 1_050_000, 1_100_000, 1_020_000, 100_000_000];
    expect(consistencyScore(withOutlier)!).toBeGreaterThan(80);
  });

  it("stays within 0..100", () => {
    for (const sample of [
      [1, 1_000_000_000, 5],
      [0, 0, 0, 1],
      [500, 400, 600, 550],
    ]) {
      const score = consistencyScore(sample);
      if (score !== null) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("sum and roundTo", () => {
  it("sums to 0 for empty input", () => {
    expect(sum([])).toBe(0);
  });
  it("rounds without float dust", () => {
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(roundTo(31.578947, 2)).toBe(31.58);
    expect(roundTo(2.5, 0)).toBe(3);
  });
});
