import { describe, expect, it } from "vitest";
import {
  calculateChannelBaseline,
  calculateOutliers,
  calculateViewsPerDay,
  MIN_SHORTS_FOR_BASELINE,
  sortOutliers,
} from "../outliers";
import { DAY_MS, daysAgo, makeLongform, makeShort } from "./factories";

const NOW = Date.UTC(2026, 5, 1);
const range = (days: number) => ({ startMs: NOW - days * DAY_MS, endMs: NOW });

describe("calculateChannelBaseline", () => {
  it("uses the median, not the mean", () => {
    // One 40M outlier. The mean is ~8.1M; the median is 100K. Only the median
    // describes what this channel typically does.
    const videos = [100_000, 90_000, 110_000, 100_000, 40_000_000].map((views, i) =>
      makeShort({ views, publishedAt: daysAgo(i + 1, NOW) }),
    );
    const baseline = calculateChannelBaseline("c1", videos, range(90));
    expect(baseline.medianViews).toBe(100_000);
    expect(baseline.isReliable).toBe(true);
  });

  it("marks a small sample unreliable rather than reporting a fragile median", () => {
    const videos = [100_000, 5_000_000].map((views, i) =>
      makeShort({ views, publishedAt: daysAgo(i + 1, NOW) }),
    );
    const baseline = calculateChannelBaseline("c1", videos, range(90));
    expect(baseline.sampleSize).toBe(2);
    expect(baseline.isReliable).toBe(false);
  });

  it("becomes reliable exactly at the documented minimum", () => {
    const videos = Array.from({ length: MIN_SHORTS_FOR_BASELINE }, (_, i) =>
      makeShort({ views: 100_000, publishedAt: daysAgo(i + 1, NOW) }),
    );
    expect(calculateChannelBaseline("c1", videos, range(90)).isReliable).toBe(true);

    const oneFewer = videos.slice(1);
    expect(calculateChannelBaseline("c1", oneFewer, range(90)).isReliable).toBe(false);
  });

  it("ignores long-form when building the baseline", () => {
    const videos = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeShort({ views: 100_000, publishedAt: daysAgo(i + 1, NOW) }),
      ),
      makeLongform({ views: 90_000_000, publishedAt: daysAgo(2, NOW) }),
    ];
    const baseline = calculateChannelBaseline("c1", videos, range(90));
    expect(baseline.sampleSize).toBe(5);
    expect(baseline.medianViews).toBe(100_000);
  });
});

describe("calculateOutliers", () => {
  const baselineVideos = Array.from({ length: 6 }, (_, i) =>
    makeShort({ views: 100_000, publishedAt: daysAgo(i + 10, NOW) }),
  );

  it("scores a breakout against the channel median", () => {
    const breakout = makeShort({ views: 4_200_000, publishedAt: daysAgo(2, NOW) });
    const results = calculateOutliers(
      [{ channelId: "c1", videos: [...baselineVideos, breakout] }],
      range(7),
      range(90),
      NOW,
    );

    expect(results).toHaveLength(1);
    // 4.2M / 100K = 42x — the spec's worked example.
    expect(results[0].outlierMultiple).toBe(42);
    expect(results[0].channelMedianViews).toBe(100_000);
  });

  it("does not flag a big Short from a big channel as an outlier", () => {
    // A 5M Short from a channel that habitually does 4M is only 1.25x.
    const bigChannel = Array.from({ length: 6 }, (_, i) =>
      makeShort({ views: 4_000_000, publishedAt: daysAgo(i + 10, NOW) }),
    );
    const short = makeShort({ views: 5_000_000, publishedAt: daysAgo(2, NOW) });

    const results = calculateOutliers(
      [{ channelId: "big", videos: [...bigChannel, short] }],
      range(7),
      range(90),
      NOW,
    );
    expect(results[0].outlierMultiple).toBe(1.25);
  });

  it("returns null rather than a misleading multiple on a thin sample", () => {
    const thin = [
      makeShort({ views: 50_000, publishedAt: daysAgo(20, NOW) }),
      makeShort({ views: 60_000, publishedAt: daysAgo(21, NOW) }),
    ];
    const breakout = makeShort({ views: 3_000_000, publishedAt: daysAgo(2, NOW) });

    const results = calculateOutliers(
      [{ channelId: "thin", videos: [...thin, breakout] }],
      range(7),
      range(90),
      NOW,
    );

    const scored = results.find((r) => r.video.views === 3_000_000);
    // Without the guard this would read as a ~50x outlier off two data points.
    expect(scored?.outlierMultiple).toBeNull();
    expect(scored?.baselineSampleSize).toBe(3);
  });

  it("returns null when the median is zero, rather than Infinity", () => {
    const zeroChannel = Array.from({ length: 6 }, (_, i) =>
      makeShort({ views: 0, publishedAt: daysAgo(i + 10, NOW) }),
    );
    const short = makeShort({ views: 1_000_000, publishedAt: daysAgo(2, NOW) });

    const results = calculateOutliers(
      [{ channelId: "z", videos: [...zeroChannel, short] }],
      range(7),
      range(90),
      NOW,
    );
    const scored = results.find((r) => r.video.views === 1_000_000);
    expect(scored?.outlierMultiple).toBeNull();
  });

  it("never scores long-form", () => {
    const results = calculateOutliers(
      [
        {
          channelId: "c1",
          videos: [
            ...baselineVideos,
            makeLongform({ views: 90_000_000, publishedAt: daysAgo(2, NOW) }),
          ],
        },
      ],
      range(7),
      range(90),
      NOW,
    );
    expect(results).toHaveLength(0);
  });

  it("keeps each channel's baseline separate", () => {
    const smallChannel = Array.from({ length: 6 }, (_, i) =>
      makeShort({ views: 10_000, publishedAt: daysAgo(i + 10, NOW) }),
    );
    const bigChannel = Array.from({ length: 6 }, (_, i) =>
      makeShort({ views: 5_000_000, publishedAt: daysAgo(i + 10, NOW) }),
    );

    const results = calculateOutliers(
      [
        {
          channelId: "small",
          videos: [...smallChannel, makeShort({ views: 500_000, publishedAt: daysAgo(1, NOW) })],
        },
        {
          channelId: "big",
          videos: [...bigChannel, makeShort({ views: 5_500_000, publishedAt: daysAgo(1, NOW) })],
        },
      ],
      range(7),
      range(90),
      NOW,
    );

    const small = results.find((r) => r.channelId === "small");
    const big = results.find((r) => r.channelId === "big");

    // The 500K Short is the far more remarkable of the two, despite being 11x
    // smaller in absolute terms. That inversion is the whole point.
    expect(small?.outlierMultiple).toBe(50);
    expect(big?.outlierMultiple).toBe(1.1);
    expect(small!.outlierMultiple!).toBeGreaterThan(big!.outlierMultiple!);
  });
});

describe("calculateViewsPerDay", () => {
  it("returns null under a day old rather than extrapolating", () => {
    const fresh = makeShort({ views: 40_000, publishedAt: NOW - 2 * 3_600_000 });
    const { viewsPerDay } = calculateViewsPerDay(fresh, NOW);
    // 40K in two hours is not "480K/day".
    expect(viewsPerDay).toBeNull();
  });

  it("computes a rate once a full day has passed", () => {
    const short = makeShort({ views: 300_000, publishedAt: NOW - 3 * DAY_MS });
    const { viewsPerDay, ageDays } = calculateViewsPerDay(short, NOW);
    expect(ageDays).toBeCloseTo(3);
    expect(viewsPerDay).toBe(100_000);
  });
});

describe("sortOutliers", () => {
  const make = (multiple: number | null, views: number) => ({
    video: makeShort({ views }),
    channelId: "c",
    outlierMultiple: multiple,
    channelMedianViews: 100_000,
    baselineSampleSize: 6,
    viewsPerDay: null,
    ageDays: 3,
  });

  it("ranks by multiple, highest first", () => {
    const sorted = sortOutliers([make(3, 300_000), make(42, 4_200_000), make(9, 900_000)], "outlierMultiple");
    expect(sorted.map((s) => s.outlierMultiple)).toEqual([42, 9, 3]);
  });

  it("keeps unbenchmarkable Shorts last, never interleaved", () => {
    const sorted = sortOutliers(
      [make(null, 9_000_000), make(2, 200_000), make(null, 100)],
      "outlierMultiple",
    );
    expect(sorted[0].outlierMultiple).toBe(2);
    expect(sorted.slice(1).every((s) => s.outlierMultiple === null)).toBe(true);
  });

  it("can rank by raw views instead", () => {
    const sorted = sortOutliers([make(42, 100_000), make(2, 9_000_000)], "views");
    expect(sorted[0].video.views).toBe(9_000_000);
  });

  it("does not mutate its input", () => {
    const input = [make(1, 10), make(5, 50)];
    const before = input.map((s) => s.outlierMultiple);
    sortOutliers(input, "outlierMultiple");
    expect(input.map((s) => s.outlierMultiple)).toEqual(before);
  });
});
