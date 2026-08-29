import { describe, expect, it } from "vitest";
import {
  calculateChannelBaseline,
  calculateOutliers,
  calculateViewsPerDay,
  MIN_AGE_DAYS_WITHOUT_RULE,
  MIN_SHORTS_FOR_BASELINE,
  sortOutliers,
} from "../outliers";
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
 * =========================================================================
 * WHY THE FIXTURES HERE CARRY VERDICTS NOW
 * =========================================================================
 * The multiple compares a Short's lifetime views to its channel's median. That
 * only means something between Shorts that have had comparable time to
 * accumulate — and this module is the one place in the engine that ever
 * reasoned about age at all. A Short whose window is still open is therefore
 * kept out of the baseline and given no multiple, and the verdict is what says
 * "still open": `pending` is the niche's own clock rather than a constant this
 * file invented.
 *
 * `makeMiss` is used for most baseline fixtures because a decided miss is the
 * ordinary state of a settled Short, and it makes the intent explicit: these
 * Shorts are finished, so they are comparable. A Short with no rule at all
 * falls back to `MIN_AGE_DAYS_WITHOUT_RULE`, which the last group pins.
 */
const settled = (views: number, days: number) =>
  makeMiss({ views, publishedAt: daysAgo(days, NOW) });

describe("calculateChannelBaseline", () => {
  it("uses the median, not the mean", () => {
    // One 40M outlier. The mean is ~8.1M; the median is 100K. Only the median
    // describes what this channel typically does.
    const videos = [100_000, 90_000, 110_000, 100_000, 40_000_000].map((views, i) =>
      settled(views, i + 1),
    );
    const baseline = calculateChannelBaseline("c1", videos, range(90), NOW);
    expect(baseline.medianViews).toBe(100_000);
    expect(baseline.isReliable).toBe(true);
  });

  it("marks a small sample unreliable rather than reporting a fragile median", () => {
    const videos = [100_000, 5_000_000].map((views, i) => settled(views, i + 1));
    const baseline = calculateChannelBaseline("c1", videos, range(90), NOW);
    expect(baseline.sampleSize).toBe(2);
    expect(baseline.isReliable).toBe(false);
  });

  it("becomes reliable exactly at the documented minimum", () => {
    const videos = Array.from({ length: MIN_SHORTS_FOR_BASELINE }, (_, i) =>
      settled(100_000, i + 1),
    );
    expect(calculateChannelBaseline("c1", videos, range(90), NOW).isReliable).toBe(true);

    const oneFewer = videos.slice(1);
    expect(calculateChannelBaseline("c1", oneFewer, range(90), NOW).isReliable).toBe(false);
  });

  it("ignores long-form when building the baseline", () => {
    const videos = [
      ...Array.from({ length: 5 }, (_, i) => settled(100_000, i + 1)),
      makeLongform({ views: 90_000_000, publishedAt: daysAgo(2, NOW) }),
    ];
    const baseline = calculateChannelBaseline("c1", videos, range(90), NOW);
    expect(baseline.sampleSize).toBe(5);
    expect(baseline.medianViews).toBe(100_000);
  });

  it("keeps Shorts still inside their window out of the median, and says how many", () => {
    /*
     * A channel that published five settled Shorts at 1M and then four more
     * yesterday. The four new ones have 20K views each because they are two
     * days old, not because they are bad.
     *
     * Averaging them into the baseline would drop the median from 1,000,000 to
     * roughly 500,000 and make every mature Short on the channel look like a 2x
     * breakout — an outlier list manufactured out of the publishing schedule.
     */
    const videos = [
      ...Array.from({ length: 5 }, (_, i) => settled(1_000_000, i + 20)),
      ...Array.from({ length: 4 }, (_, i) =>
        makePending({ views: 20_000, publishedAt: daysAgo(i + 1, NOW) }),
      ),
    ];
    const baseline = calculateChannelBaseline("c1", videos, range(90), NOW);

    expect(baseline.medianViews).toBe(1_000_000);
    expect(baseline.sampleSize).toBe(5);
    expect(baseline.inFlightExcluded).toBe(4);
  });
});

describe("calculateOutliers", () => {
  const baselineVideos = Array.from({ length: 6 }, (_, i) => settled(100_000, i + 10));

  it("scores a breakout against the channel median", () => {
    const breakout = makeHit({ views: 4_200_000, publishedAt: daysAgo(2, NOW) });
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
    expect(results[0].unbenchmarkable).toBeNull();
  });

  it("gives no multiple to a Short still inside its window, and says why", () => {
    /*
     * THE AGE BIAS THIS MODULE USED TO HAVE, POINTING THE OTHER WAY.
     *
     * A Short published two days ago with 90,000 views against a channel median
     * of 100,000 scored 0.9x and read as a slight under-performer. It has had
     * two days; the median is built from Shorts that have had months. The
     * comparison is wrong by an amount nobody can quantify, so the honest
     * answer is that there isn't one — while `viewsPerDay`, which IS age-
     * neutral, is still reported so a fresh breakout remains visible.
     */
    const fresh = makePending({ views: 90_000, publishedAt: daysAgo(2, NOW) });
    const results = calculateOutliers(
      [{ channelId: "c1", videos: [...baselineVideos, fresh] }],
      range(7),
      range(90),
      NOW,
    );

    expect(results).toHaveLength(1);
    expect(results[0].outlierMultiple).toBeNull();
    expect(results[0].unbenchmarkable).toBe("in-flight");
    // Not dropped from the list, and still rankable by the age-neutral rate.
    expect(results[0].viewsPerDay).toBe(45_000);
  });

  it("scores the same Short the moment its window shuts", () => {
    // Identical evidence, one field different. The multiple was always
    // computable; what was missing was any basis for trusting it.
    const settledNow = makeMiss({ views: 90_000, publishedAt: daysAgo(2, NOW) });
    const results = calculateOutliers(
      [{ channelId: "c1", videos: [...baselineVideos, settledNow] }],
      range(7),
      range(90),
      NOW,
    );
    expect(results[0].outlierMultiple).toBe(0.9);
    expect(results[0].unbenchmarkable).toBeNull();
  });

  it("does not flag a big Short from a big channel as an outlier", () => {
    // A 5M Short from a channel that habitually does 4M is only 1.25x.
    const bigChannel = Array.from({ length: 6 }, (_, i) => settled(4_000_000, i + 10));
    const short = makeHit({ views: 5_000_000, publishedAt: daysAgo(2, NOW) });

    const results = calculateOutliers(
      [{ channelId: "big", videos: [...bigChannel, short] }],
      range(7),
      range(90),
      NOW,
    );
    expect(results[0].outlierMultiple).toBe(1.25);
  });

  it("returns null rather than a misleading multiple on a thin sample", () => {
    const thin = [settled(50_000, 20), settled(60_000, 21)];
    const breakout = makeHit({ views: 3_000_000, publishedAt: daysAgo(2, NOW) });

    const results = calculateOutliers(
      [{ channelId: "thin", videos: [...thin, breakout] }],
      range(7),
      range(90),
      NOW,
    );

    const scored = results.find((r) => r.video.views === 3_000_000);
    // Without the guard this would read as a ~50x outlier off two data points.
    expect(scored?.outlierMultiple).toBeNull();
    expect(scored?.unbenchmarkable).toBe("insufficient-baseline");
    expect(scored?.baselineSampleSize).toBe(3);
  });

  it("returns null when the median is zero, rather than Infinity", () => {
    const zeroChannel = Array.from({ length: 6 }, (_, i) => settled(0, i + 10));
    const short = makeHit({ views: 1_000_000, publishedAt: daysAgo(2, NOW) });

    const results = calculateOutliers(
      [{ channelId: "z", videos: [...zeroChannel, short] }],
      range(7),
      range(90),
      NOW,
    );
    const scored = results.find((r) => r.video.views === 1_000_000);
    expect(scored?.outlierMultiple).toBeNull();
    expect(scored?.unbenchmarkable).toBe("insufficient-baseline");
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
    const smallChannel = Array.from({ length: 6 }, (_, i) => settled(10_000, i + 10));
    const bigChannel = Array.from({ length: 6 }, (_, i) => settled(5_000_000, i + 10));

    const results = calculateOutliers(
      [
        {
          channelId: "small",
          videos: [...smallChannel, makeHit({ views: 500_000, publishedAt: daysAgo(1, NOW) })],
        },
        {
          channelId: "big",
          videos: [...bigChannel, makeHit({ views: 5_500_000, publishedAt: daysAgo(1, NOW) })],
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

describe("maturity when there is no rule to ask", () => {
  const noRuleBaseline = Array.from({ length: 6 }, (_, i) =>
    makeShort({ views: 100_000, publishedAt: daysAgo(i + 30, NOW) }),
  );

  it("falls back to the age floor for a Short in an unconfigured niche", () => {
    const tooYoung = makeShort({
      views: 90_000,
      publishedAt: daysAgo(MIN_AGE_DAYS_WITHOUT_RULE - 1, NOW),
    });
    const results = calculateOutliers(
      [{ channelId: "c1", videos: [...noRuleBaseline, tooYoung] }],
      range(30),
      range(90),
      NOW,
    );
    const scored = results.find((r) => r.video.views === 90_000);
    expect(scored?.unbenchmarkable).toBe("in-flight");
  });

  it("scores one that has cleared the floor", () => {
    const oldEnough = makeShort({
      views: 90_000,
      publishedAt: daysAgo(MIN_AGE_DAYS_WITHOUT_RULE, NOW),
    });
    const results = calculateOutliers(
      [{ channelId: "c1", videos: [...noRuleBaseline, oldEnough] }],
      range(30),
      range(90),
      NOW,
    );
    const scored = results.find((r) => r.video.views === 90_000);
    expect(scored?.outlierMultiple).toBe(0.9);
    expect(scored?.unbenchmarkable).toBeNull();
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
    unbenchmarkable: multiple === null ? ("insufficient-baseline" as const) : null,
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
