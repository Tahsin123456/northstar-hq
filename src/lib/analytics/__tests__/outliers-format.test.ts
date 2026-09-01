import { describe, expect, it } from "vitest";
import {
  calculateChannelBaseline,
  calculateOutliers,
} from "@/lib/analytics/outliers";
import { calculateChannelMetrics } from "@/lib/analytics/channel-metrics";
import {
  DAY_MS,
  daysAgo,
  makeHit,
  makeLongform,
  makeMiss,
  makePending,
  makeShort,
  makeUncertain,
  makeVerdict,
} from "./factories";

/**
 * =========================================================================
 * THE LONG FORM FEED'S POPULATION, AND ITS BASELINE
 * =========================================================================
 *
 * `calculateOutliers(…, "longform")` must hold two things at once:
 *
 *   • only `classification === "not_short"` videos are candidates — a Short
 *     never appears in the Long Form feed, and an uncertain video appears in
 *     NEITHER feed (the pinned `isVideoOfFormat` rule);
 *   • the channel baseline is built from the SAME population, so a long-form
 *     video is measured against the channel's typical long-form video and
 *     never against its Shorts median. On a mixed channel those two medians
 *     differ by an order of magnitude, which is exactly the fixture below.
 *
 * Plus the mirrored bit-for-bit pin for `calculateChannelMetrics` on the
 * longform side of the same mixed fixture the deploy guard uses for shorts.
 */

const NOW = Date.UTC(2026, 5, 1);
const range = (days: number) => ({ startMs: NOW - days * DAY_MS, endMs: NOW });

/** A settled long-form video: a stored miss, the ordinary settled state. */
const settledLongform = (views: number, days: number) =>
  makeLongform({
    views,
    publishedAt: daysAgo(days, NOW),
    hit: makeVerdict("miss"),
  });

/** A settled Short, for the mixed channel's other population. */
const settledShort = (views: number, days: number) =>
  makeMiss({ views, publishedAt: daysAgo(days, NOW) });

describe("the longform feed's population", () => {
  it("contains only not_short videos — Shorts and uncertain never appear", () => {
    const videos = [
      settledLongform(500_000, 3),
      makeShort({ views: 9_000_000, publishedAt: daysAgo(2, NOW) }),
      makeUncertain({ views: 9_000_000, publishedAt: daysAgo(2, NOW) }),
    ];

    const results = calculateOutliers(
      [{ channelId: "c1", videos }],
      range(7),
      range(90),
      NOW,
      "longform",
    );

    expect(results).toHaveLength(1);
    expect(results[0].video.classification).toBe("not_short");
  });

  it("keeps the uncertain video out of the shorts feed too — in neither", () => {
    const uncertain = makeUncertain({ views: 9_000_000, publishedAt: daysAgo(2, NOW) });
    const channels = [{ channelId: "c1", videos: [uncertain] }];

    expect(calculateOutliers(channels, range(7), range(90), NOW, "shorts")).toHaveLength(0);
    expect(calculateOutliers(channels, range(7), range(90), NOW, "longform")).toHaveLength(0);
  });

  it("measures a long-form video against the LONG-FORM median on a mixed channel", () => {
    // Shorts median 1M; long-form median 100K. A 1M long-form upload is a 10x
    // long-form breakout — and would read as a flat 1.0x if the baseline
    // leaked the Shorts population in.
    const videos = [
      ...Array.from({ length: 6 }, (_, i) => settledShort(1_000_000, i + 10)),
      ...Array.from({ length: 5 }, (_, i) => settledLongform(100_000, i + 10)),
      makeLongform({
        views: 1_000_000,
        publishedAt: daysAgo(2, NOW),
        hit: makeVerdict("miss"),
      }),
    ];

    const baseline = calculateChannelBaseline("c1", videos, range(90), NOW, "longform");
    expect(baseline.medianViews).toBe(100_000);
    // The 6 Shorts are not merely excluded from the median — they are not in
    // the sample at all.
    expect(baseline.sampleSize).toBe(6); // 5 settled + the settled breakout

    const results = calculateOutliers(
      [{ channelId: "c1", videos }],
      range(7),
      range(90),
      NOW,
      "longform",
    );
    expect(results).toHaveLength(1);
    expect(results[0].outlierMultiple).toBe(10);
    expect(results[0].channelMedianViews).toBe(100_000);
  });

  it("defaults to shorts, byte-identically with the old call shape", () => {
    const baselineVideos = Array.from({ length: 6 }, (_, i) => settledShort(100_000, i + 10));
    const breakout = makeHit({ views: 4_200_000, publishedAt: daysAgo(2, NOW) });
    const channels = [{ channelId: "c1", videos: [...baselineVideos, breakout] }];

    const withDefault = calculateOutliers(channels, range(7), range(90), NOW);
    const explicit = calculateOutliers(channels, range(7), range(90), NOW, "shorts");

    expect(withDefault).toEqual(explicit);
    expect(withDefault[0].outlierMultiple).toBe(42);
  });
});

describe("channel metrics on the longform side of the mixed fixture", () => {
  it("counts only the long-form videos, and excludes Shorts plus uncertain", () => {
    const RANGE_30D = { startMs: NOW - 30 * DAY_MS, endMs: NOW };
    const videos = [
      // The mirrored guard fixture: the same populations as the shorts
      // bit-for-bit test, read from the other side.
      makeHit({ views: 2_000_000, publishedAt: daysAgo(5, NOW) }),
      makeMiss({ views: 300_000, publishedAt: daysAgo(6, NOW) }),
      makePending({ views: 50_000, publishedAt: daysAgo(1, NOW) }),
      makeLongform({ views: 10_000_000, publishedAt: daysAgo(4, NOW) }),
      makeUncertain({ views: 4_000_000, publishedAt: daysAgo(3, NOW) }),
      makeShort({ views: 999, publishedAt: daysAgo(45, NOW) }),
    ];

    const metrics = calculateChannelMetrics({
      videos,
      range: RANGE_30D,
      threshold: 1_000_000,
      format: "longform",
    });

    expect(metrics.totalShorts).toBe(1); // the one long-form video
    expect(metrics.totalViews).toBe(10_000_000);
    // The format complement: 3 Shorts + 1 uncertain in range.
    expect(metrics.excludedLongform).toBe(4);
    // An unjudged long-form video decides nothing.
    expect(metrics.hits.judged).toBe(0);
  });
});
