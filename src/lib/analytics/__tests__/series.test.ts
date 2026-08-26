import { describe, expect, it } from "vitest";
import { calculateHitRateSeries, calculateHitRateTrend, pickGranularity } from "../series";
import { DAY_MS, makeLongform, makeShort } from "./factories";

/**
 * Series buckets are aligned in *local* time so the chart matches the dates a
 * user sees elsewhere in the UI. Fixtures therefore use local-time
 * constructors rather than Date.UTC, which keeps these assertions true in any
 * timezone the suite runs in.
 */
const NOW = new Date(2026, 5, 1, 12, 0, 0).getTime();
const range = (days: number) => ({ startMs: NOW - days * DAY_MS, endMs: NOW });
const daysBefore = (days: number) => NOW - days * DAY_MS;

describe("pickGranularity", () => {
  it("scales the bucket size to the window", () => {
    expect(pickGranularity(range(7))).toBe("day");
    expect(pickGranularity(range(21))).toBe("day");
    expect(pickGranularity(range(30))).toBe("week");
    expect(pickGranularity(range(180))).toBe("week");
    expect(pickGranularity(range(365))).toBe("month");
  });
});

describe("calculateHitRateSeries", () => {
  it("emits a contiguous run of buckets across the window", () => {
    const points = calculateHitRateSeries([], range(7), 1_000_000, "day");
    expect(points.length).toBeGreaterThanOrEqual(7);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i].bucketStartMs).toBe(points[i - 1].bucketEndMs);
    }
  });

  it("reports null — not 0% — for a bucket with no uploads", () => {
    // This is the difference between "paused" and "published and missed". A
    // chart that plots 0 for an idle week tells the user a falsehood.
    const points = calculateHitRateSeries([], range(7), 1_000_000, "day");
    expect(points.every((p) => p.hitRate === null)).toBe(true);
    expect(points.every((p) => p.totalShorts === 0)).toBe(true);
  });

  it("computes per-bucket hit rates", () => {
    const videos = [
      makeShort({ views: 2_000_000, publishedAt: daysBefore(1) }),
      makeShort({ views: 500_000, publishedAt: daysBefore(1) }),
      makeShort({ views: 3_000_000, publishedAt: daysBefore(3) }),
    ];
    const points = calculateHitRateSeries(videos, range(7), 1_000_000, "day");

    const populated = points.filter((p) => p.totalShorts > 0);
    expect(populated).toHaveLength(2);
    // Numeric comparator: a bare .sort() would compare these as strings.
    expect(populated.map((p) => p.hitRate).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([50, 100]);
  });

  it("excludes long-form from every bucket", () => {
    const videos = [
      makeShort({ views: 2_000_000, publishedAt: daysBefore(2) }),
      makeLongform({ views: 90_000_000, publishedAt: daysBefore(2) }),
    ];
    const points = calculateHitRateSeries(videos, range(7), 1_000_000, "day");
    const populated = points.filter((p) => p.totalShorts > 0);
    expect(populated).toHaveLength(1);
    expect(populated[0].totalShorts).toBe(1);
    expect(populated[0].totalViews).toBe(2_000_000);
  });

  it("ignores Shorts outside the window", () => {
    const videos = [makeShort({ views: 5_000_000, publishedAt: daysBefore(60) })];
    const points = calculateHitRateSeries(videos, range(7), 1_000_000, "day");
    expect(points.every((p) => p.totalShorts === 0)).toBe(true);
  });

  it("responds to a threshold change without new data", () => {
    const videos = [
      makeShort({ views: 600_000, publishedAt: daysBefore(2) }),
      makeShort({ views: 1_200_000, publishedAt: daysBefore(2) }),
    ];
    const at1M = calculateHitRateSeries(videos, range(7), 1_000_000, "day");
    const at500K = calculateHitRateSeries(videos, range(7), 500_000, "day");

    expect(at1M.find((p) => p.totalShorts > 0)?.hitRate).toBe(50);
    expect(at500K.find((p) => p.totalShorts > 0)?.hitRate).toBe(100);
  });
});

describe("calculateHitRateTrend", () => {
  it("returns null when either half has no Shorts to compare", () => {
    expect(calculateHitRateTrend([], range(30), 1_000_000)).toBeNull();

    const onlyRecent = [makeShort({ views: 2_000_000, publishedAt: daysBefore(2) })];
    expect(calculateHitRateTrend(onlyRecent, range(30), 1_000_000)).toBeNull();
  });

  it("detects improvement", () => {
    const videos = [
      // First half of a 30-day window (older): 1 of 2 hits.
      makeShort({ views: 2_000_000, publishedAt: daysBefore(25) }),
      makeShort({ views: 100_000, publishedAt: daysBefore(24) }),
      // Second half (recent): 2 of 2 hits.
      makeShort({ views: 3_000_000, publishedAt: daysBefore(5) }),
      makeShort({ views: 4_000_000, publishedAt: daysBefore(4) }),
    ];
    const trend = calculateHitRateTrend(videos, range(30), 1_000_000);
    expect(trend).not.toBeNull();
    expect(trend!.firstHalf).toBe(50);
    expect(trend!.secondHalf).toBe(100);
    expect(trend!.delta).toBe(50);
  });

  it("detects decline with a negative delta", () => {
    const videos = [
      makeShort({ views: 2_000_000, publishedAt: daysBefore(25) }),
      makeShort({ views: 2_000_000, publishedAt: daysBefore(24) }),
      makeShort({ views: 10_000, publishedAt: daysBefore(5) }),
      makeShort({ views: 20_000, publishedAt: daysBefore(4) }),
    ];
    const trend = calculateHitRateTrend(videos, range(30), 1_000_000);
    expect(trend!.delta).toBe(-100);
  });
});
