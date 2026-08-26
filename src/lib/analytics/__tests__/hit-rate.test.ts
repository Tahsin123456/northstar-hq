import { describe, expect, it } from "vitest";
import { calculateHitRate, countHits, evaluateShorts, isHit } from "../hit-rate";
import { makeShort } from "./factories";

/**
 * The acceptance cases from the specification, verbatim, plus the boundary
 * conditions around them. If any of these break, the product's headline number
 * is wrong.
 */
describe("calculateHitRate — specification acceptance cases", () => {
  it("Example 1: 40 Shorts, 12 hits -> 30%", () => {
    expect(calculateHitRate(12, 40)).toBe(30);
  });

  it("Example 2: 0 Shorts -> null, never 0%", () => {
    expect(calculateHitRate(0, 0)).toBeNull();
  });

  it("Example 3: 100 Shorts, 0 hits -> 0%", () => {
    expect(calculateHitRate(0, 100)).toBe(0);
  });

  it("Example 4: 100 Shorts, 100 hits -> 100%", () => {
    expect(calculateHitRate(100, 100)).toBe(100);
  });

  it("distinguishes 'no Shorts' (null) from 'no hits' (0)", () => {
    // The whole reason the return type is nullable. These must never be equal.
    expect(calculateHitRate(0, 0)).toBeNull();
    expect(calculateHitRate(0, 5)).toBe(0);
    expect(calculateHitRate(0, 0)).not.toBe(calculateHitRate(0, 5));
  });

  it("matches the spec's worked example: 12 of 38 -> 31.58%", () => {
    expect(calculateHitRate(12, 38)).toBe(31.58);
  });

  it("rounds to two decimal places", () => {
    expect(calculateHitRate(1, 3)).toBe(33.33);
    expect(calculateHitRate(2, 3)).toBe(66.67);
  });

  it("returns null for nonsensical denominators rather than Infinity or NaN", () => {
    expect(calculateHitRate(5, -1)).toBeNull();
    expect(calculateHitRate(5, Number.NaN)).toBeNull();
    expect(calculateHitRate(Number.NaN, 10)).toBeNull();
  });
});

describe("isHit — threshold boundary", () => {
  it("Example 6: exactly 1,000,000 views is a hit at a 1M threshold", () => {
    expect(isHit(1_000_000, 1_000_000)).toBe(true);
  });

  it("Example 6: 999,999 views is not a hit at a 1M threshold", () => {
    expect(isHit(999_999, 1_000_000)).toBe(false);
  });

  it("is inclusive at every preset threshold", () => {
    for (const threshold of [100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000]) {
      expect(isHit(threshold, threshold)).toBe(true);
      expect(isHit(threshold - 1, threshold)).toBe(false);
      expect(isHit(threshold + 1, threshold)).toBe(true);
    }
  });
});

describe("countHits", () => {
  it("counts only Shorts at or above the threshold", () => {
    const shorts = [
      makeShort({ views: 2_400_000 }),
      makeShort({ views: 870_000 }),
      makeShort({ views: 4_100_000 }),
      makeShort({ views: 1_000_000 }),
      makeShort({ views: 999_999 }),
    ];
    expect(countHits(shorts, 1_000_000)).toBe(3);
  });

  it("recomputes correctly when the threshold changes, with no refetch", () => {
    const shorts = [
      makeShort({ views: 120_000 }),
      makeShort({ views: 600_000 }),
      makeShort({ views: 1_500_000 }),
      makeShort({ views: 5_500_000 }),
    ];
    // This is the "1M -> 500K must not hit YouTube" requirement expressed as a
    // property: the same in-memory array yields every answer.
    expect(countHits(shorts, 10_000_000)).toBe(0);
    expect(countHits(shorts, 5_000_000)).toBe(1);
    expect(countHits(shorts, 1_000_000)).toBe(2);
    expect(countHits(shorts, 500_000)).toBe(3);
    expect(countHits(shorts, 100_000)).toBe(4);
  });

  it("returns 0 for an empty list", () => {
    expect(countHits([], 1_000_000)).toBe(0);
  });
});

describe("evaluateShorts", () => {
  it("annotates hit status and the ratio to the threshold", () => {
    const [a, b] = evaluateShorts(
      [makeShort({ views: 2_400_000 }), makeShort({ views: 500_000 })],
      1_000_000,
    );
    expect(a.isHit).toBe(true);
    expect(a.thresholdRatio).toBeCloseTo(2.4);
    expect(b.isHit).toBe(false);
    expect(b.thresholdRatio).toBeCloseTo(0.5);
  });

  it("does not divide by zero when the threshold is zero", () => {
    const [only] = evaluateShorts([makeShort({ views: 100 })], 0);
    expect(Number.isFinite(only.thresholdRatio)).toBe(true);
  });
});
