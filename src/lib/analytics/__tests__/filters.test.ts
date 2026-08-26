import { describe, expect, it } from "vitest";
import {
  getLongformInDateRange,
  getShorts,
  getShortsInDateRange,
  isWithinRange,
  sortByPublishedDesc,
  sortByViewsDesc,
} from "../filters";
import { DAY_MS, daysAgo, makeLongform, makeShort, makeVideo } from "./factories";

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
