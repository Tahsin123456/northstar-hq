import { describe, expect, it } from "vitest";
import { calculateHitRateSeries, calculateHitRateTrend, pickGranularity } from "../series";
import {
  DAY_MS,
  makeHit,
  makeLongform,
  makeMiss,
  makePending,
  makeShort,
  makeUnknown,
} from "./factories";

/**
 * Series buckets are aligned in *local* time so the chart matches the dates a
 * user sees elsewhere in the UI. Fixtures therefore use local-time
 * constructors rather than Date.UTC, which keeps these assertions true in any
 * timezone the suite runs in.
 *
 * =========================================================================
 * THESE TESTS NO LONGER PASS A THRESHOLD, AND THAT IS THE POINT
 * =========================================================================
 * `calculateHitRateSeries` used to take one and count the Shorts above it per
 * bucket. Buckets are keyed on UPLOAD DATE, so the rightmost ones always held
 * the youngest Shorts — the ones with the least time to reach any bar — and the
 * line sagged on the right of every channel, always, whatever the work was
 * like. The series counts stored verdicts now, and a Short still inside its
 * window sits in neither half of its bucket.
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
    const points = calculateHitRateSeries([], range(7), "day");
    expect(points.length).toBeGreaterThanOrEqual(7);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i].bucketStartMs).toBe(points[i - 1].bucketEndMs);
    }
  });

  it("reports null — not 0% — for a bucket with no uploads", () => {
    // This is the difference between "paused" and "published and missed". A
    // chart that plots 0 for an idle week tells the user a falsehood.
    const points = calculateHitRateSeries([], range(7), "day");
    expect(points.every((p) => p.hits.rate === null)).toBe(true);
    expect(points.every((p) => p.totalShorts === 0)).toBe(true);
  });

  it("reports null — not 0% — for a bucket whose Shorts are all still in flight", () => {
    /*
     * THE FIX FOR THE SAGGING RIGHT-HAND END.
     *
     * Under the old rule this bucket read 0%: three Shorts published yesterday,
     * none of them anywhere near a million views yet, all three in the
     * denominator. The chart showed a cliff at the right on every channel that
     * had not stopped publishing. Now they are unfinished, the bucket has
     * nothing decided in it, and the line draws a gap.
     */
    const videos = [
      makePending({ views: 12_000, publishedAt: daysBefore(1) }),
      makePending({ views: 30_000, publishedAt: daysBefore(1) }),
      makePending({ views: 9_000, publishedAt: daysBefore(1) }),
    ];
    const points = calculateHitRateSeries(videos, range(7), "day");
    const populated = points.filter((p) => p.totalShorts > 0);

    expect(populated).toHaveLength(1);
    expect(populated[0].totalShorts).toBe(3);
    expect(populated[0].hits.rate).toBeNull();
    expect(populated[0].hits.tally.pending).toBe(3);
  });

  it("computes per-bucket hit rates from the stored verdicts", () => {
    const videos = [
      makeHit({ views: 2_000_000, publishedAt: daysBefore(1) }),
      makeMiss({ views: 500_000, publishedAt: daysBefore(1) }),
      makeHit({ views: 3_000_000, publishedAt: daysBefore(3) }),
    ];
    const points = calculateHitRateSeries(videos, range(7), "day");

    const populated = points.filter((p) => p.totalShorts > 0);
    expect(populated).toHaveLength(2);
    // Numeric comparator: a bare .sort() would compare these as strings.
    expect(populated.map((p) => p.hits.rate).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      50, 100,
    ]);
  });

  it("keeps a bucket's exclusions where the tooltip can reach them", () => {
    const videos = [
      makeHit({ views: 2_000_000, publishedAt: daysBefore(2) }),
      makeUnknown({ views: 8_000_000, publishedAt: daysBefore(2) }),
      makePending({ views: 5_000, publishedAt: daysBefore(2) }),
      makeShort({ views: 100_000, publishedAt: daysBefore(2) }),
    ];
    const bucket = calculateHitRateSeries(videos, range(7), "day").find(
      (p) => p.totalShorts > 0,
    );

    expect(bucket?.totalShorts).toBe(4);
    expect(bucket?.hits.judged).toBe(1);
    expect(bucket?.hits.rate).toBe(100);
    // A gap or a 100% both need explaining, and these are what explain them.
    expect(bucket?.hits.tally.unknown).toBe(1);
    expect(bucket?.hits.tally.pending).toBe(1);
    expect(bucket?.hits.tally.unscoreable).toBe(1);
  });

  it("excludes long-form from every bucket", () => {
    const videos = [
      makeHit({ views: 2_000_000, publishedAt: daysBefore(2) }),
      makeLongform({ views: 90_000_000, publishedAt: daysBefore(2) }),
    ];
    const points = calculateHitRateSeries(videos, range(7), "day");
    const populated = points.filter((p) => p.totalShorts > 0);
    expect(populated).toHaveLength(1);
    expect(populated[0].totalShorts).toBe(1);
    expect(populated[0].totalViews).toBe(2_000_000);
  });

  it("ignores Shorts outside the window", () => {
    const videos = [makeHit({ views: 5_000_000, publishedAt: daysBefore(60) })];
    const points = calculateHitRateSeries(videos, range(7), "day");
    expect(points.every((p) => p.totalShorts === 0)).toBe(true);
  });
});

describe("calculateHitRateTrend", () => {
  it("returns null when either half has nothing decided to compare", () => {
    expect(calculateHitRateTrend([], range(30))).toBeNull();

    const onlyRecent = [makeHit({ views: 2_000_000, publishedAt: daysBefore(2) })];
    expect(calculateHitRateTrend(onlyRecent, range(30))).toBeNull();
  });

  it("returns null rather than a fabricated fall when the recent half is unfinished", () => {
    /*
     * The old failure mode, pinned.
     *
     * Two decided hits in the first half, four Shorts published in the second
     * half that are still inside their windows. The lifetime rule scored the
     * second half 0% and reported "−100 pp" — a catastrophic decline invented
     * entirely by the calendar. There is no comparison to make here, and that
     * is what the function now says.
     */
    const videos = [
      makeHit({ views: 2_000_000, publishedAt: daysBefore(25) }),
      makeHit({ views: 2_000_000, publishedAt: daysBefore(24) }),
      makePending({ views: 10_000, publishedAt: daysBefore(5) }),
      makePending({ views: 20_000, publishedAt: daysBefore(4) }),
      makePending({ views: 15_000, publishedAt: daysBefore(3) }),
      makePending({ views: 25_000, publishedAt: daysBefore(2) }),
    ];
    expect(calculateHitRateTrend(videos, range(30))).toBeNull();
  });

  it("detects improvement", () => {
    const videos = [
      // First half of a 30-day window (older): 1 of 2 hits.
      makeHit({ views: 2_000_000, publishedAt: daysBefore(25) }),
      makeMiss({ views: 100_000, publishedAt: daysBefore(24) }),
      // Second half (recent): 2 of 2 hits.
      makeHit({ views: 3_000_000, publishedAt: daysBefore(5) }),
      makeHit({ views: 4_000_000, publishedAt: daysBefore(4) }),
    ];
    const trend = calculateHitRateTrend(videos, range(30));
    expect(trend).not.toBeNull();
    expect(trend!.firstHalf).toBe(50);
    expect(trend!.secondHalf).toBe(100);
    expect(trend!.delta).toBe(50);
    // The denominators travel with the halves: "50% then 100%" over two Shorts
    // each is a very different claim from the same numbers over two hundred.
    expect(trend!.firstJudged).toBe(2);
    expect(trend!.secondJudged).toBe(2);
  });

  it("detects a real decline — one made of decided misses, not of young Shorts", () => {
    const videos = [
      makeHit({ views: 2_000_000, publishedAt: daysBefore(25) }),
      makeHit({ views: 2_000_000, publishedAt: daysBefore(24) }),
      makeMiss({ views: 10_000, publishedAt: daysBefore(5) }),
      makeMiss({ views: 20_000, publishedAt: daysBefore(4) }),
    ];
    const trend = calculateHitRateTrend(videos, range(30));
    expect(trend!.delta).toBe(-100);
  });
});
