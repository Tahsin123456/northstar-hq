import { describe, expect, it } from "vitest";
import {
  getLongformInDateRange,
  getShorts,
  getShortsInDateRange,
  isWithinRange,
  sortByPublishedDesc,
  sortByViewsDesc,
  videosInDateRange,
} from "../filters";
import {
  DAY_MS,
  daysAgo,
  makeLongform,
  makeShort,
  makeUncertain,
  makeVideo,
} from "./factories";

const NOW = Date.UTC(2026, 5, 1);
const RANGE_30D = { startMs: NOW - 30 * DAY_MS, endMs: NOW };

describe("isWithinRange", () => {
  it("includes the start boundary and excludes the end boundary", () => {
    expect(isWithinRange(RANGE_30D.startMs, RANGE_30D)).toBe(true);
    expect(isWithinRange(RANGE_30D.endMs, RANGE_30D)).toBe(false);
    expect(isWithinRange(RANGE_30D.startMs - 1, RANGE_30D)).toBe(false);
    expect(isWithinRange(RANGE_30D.endMs - 1, RANGE_30D)).toBe(true);
  });
});

describe("getShortsInDateRange", () => {
  it("applies both filters — Shorts only, and inside the window", () => {
    const videos = [
      makeShort({ publishedAt: daysAgo(5, NOW) }),
      makeShort({ publishedAt: daysAgo(40, NOW) }),
      makeLongform({ publishedAt: daysAgo(5, NOW) }),
      makeLongform({ publishedAt: daysAgo(40, NOW) }),
    ];
    expect(getShortsInDateRange(videos, RANGE_30D)).toHaveLength(1);
  });

  it("excludes videos the classifier could not resolve", () => {
    // An unresolved video arrives with isShort false, so it is excluded by the
    // same filter that excludes long-form. That is the conservative behaviour:
    // uncertainty must shrink the sample, never inflate a rate.
    const uncertain = makeVideo({
      isShort: false,
      durationSeconds: 42,
      publishedAt: daysAgo(2, NOW),
    });
    expect(getShortsInDateRange([uncertain], RANGE_30D)).toHaveLength(0);
  });

  it("returns an empty array rather than throwing on empty input", () => {
    expect(getShortsInDateRange([], RANGE_30D)).toEqual([]);
  });
});

describe("getLongformInDateRange", () => {
  it("reports long-form inside the window for transparency", () => {
    const videos = [
      makeShort({ publishedAt: daysAgo(3, NOW) }),
      makeLongform({ publishedAt: daysAgo(3, NOW) }),
      makeLongform({ publishedAt: daysAgo(90, NOW) }),
    ];
    expect(getLongformInDateRange(videos, RANGE_30D)).toHaveLength(1);
  });

  it("excludes videos the classifier could not resolve — the strict selector", () => {
    // `isShort: false` is TWO populations, and only one of them is long-form.
    // The selector reads `classification === "not_short"`, never `!isShort`,
    // so an uncertain video lands in NEITHER format's list.
    const uncertain = makeUncertain({ publishedAt: daysAgo(2, NOW) });
    expect(getLongformInDateRange([uncertain], RANGE_30D)).toHaveLength(0);
    expect(getShortsInDateRange([uncertain], RANGE_30D)).toHaveLength(0);
  });
});

describe("videosInDateRange", () => {
  /** Shorts, long-form and an uncertain video, all inside the window. */
  const mixed = [
    makeShort({ views: 100, publishedAt: daysAgo(2, NOW) }),
    makeShort({ views: 200, publishedAt: daysAgo(40, NOW) }),
    makeLongform({ views: 300, publishedAt: daysAgo(3, NOW) }),
    makeLongform({ views: 400, publishedAt: daysAgo(50, NOW) }),
    makeUncertain({ views: 500, publishedAt: daysAgo(4, NOW) }),
  ];

  it("shorts path returns byte-identical results to getShortsInDateRange", () => {
    // The alias is the ten call sites the whole Shorts product runs on, so
    // "same" here means SAME: equal length, equal order, and the very same
    // row objects — not lookalikes.
    const viaFormat = videosInDateRange(mixed, RANGE_30D, "shorts");
    const viaAlias = getShortsInDateRange(mixed, RANGE_30D);
    expect(viaFormat).toEqual(viaAlias);
    expect(viaFormat.length).toBe(viaAlias.length);
    viaFormat.forEach((video, i) => {
      expect(Object.is(video, viaAlias[i])).toBe(true);
    });
  });

  it("longform path selects not_short only — never the complement of isShort", () => {
    const longform = videosInDateRange(mixed, RANGE_30D, "longform");
    expect(longform.map((v) => v.views)).toEqual([300]);
    // The uncertain video (views: 500) appears in NEITHER format.
    expect(videosInDateRange(mixed, RANGE_30D, "shorts").map((v) => v.views)).toEqual([100]);
  });

  it("applies the half-open window identically for both formats", () => {
    const atStartShort = makeShort({ publishedAt: RANGE_30D.startMs });
    const atEndShort = makeShort({ publishedAt: RANGE_30D.endMs });
    const atStartLong = makeLongform({ publishedAt: RANGE_30D.startMs });
    const atEndLong = makeLongform({ publishedAt: RANGE_30D.endMs });
    const videos = [atStartShort, atEndShort, atStartLong, atEndLong];

    expect(videosInDateRange(videos, RANGE_30D, "shorts")).toEqual([atStartShort]);
    expect(videosInDateRange(videos, RANGE_30D, "longform")).toEqual([atStartLong]);
  });
});

describe("getShorts", () => {
  it("filters by classification with no date constraint", () => {
    const videos = [makeShort({}), makeShort({}), makeLongform({})];
    expect(getShorts(videos)).toHaveLength(2);
  });
});

describe("sorting helpers", () => {
  it("sortByPublishedDesc puts the newest first and does not mutate", () => {
    const input = [
      makeShort({ publishedAt: daysAgo(10, NOW) }),
      makeShort({ publishedAt: daysAgo(1, NOW) }),
      makeShort({ publishedAt: daysAgo(5, NOW) }),
    ];
    const snapshot = [...input];
    const sorted = sortByPublishedDesc(input);
    expect(sorted.map((v) => v.publishedAt)).toEqual([
      daysAgo(1, NOW),
      daysAgo(5, NOW),
      daysAgo(10, NOW),
    ]);
    expect(input).toEqual(snapshot);
  });

  it("sortByViewsDesc puts the highest first and does not mutate", () => {
    const input = [makeShort({ views: 10 }), makeShort({ views: 900 }), makeShort({ views: 50 })];
    const snapshot = [...input];
    expect(sortByViewsDesc(input).map((v) => v.views)).toEqual([900, 50, 10]);
    expect(input).toEqual(snapshot);
  });
});
