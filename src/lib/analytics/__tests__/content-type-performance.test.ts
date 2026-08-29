import { describe, expect, it } from "vitest";
import {
  UNTAGGED_ROW_LABEL,
  calculateContentTypePerformance,
  type ContentTypeRef,
  type TaggedVideo,
} from "../content-type-performance";
import type { DateRange } from "../types";
import {
  DAY_MS,
  daysAgo,
  makeLongform,
  makeMiss,
  makeShort,
  makeVerdict,
} from "./factories";

const NOW = Date.UTC(2026, 5, 1);
const range = (days: number): DateRange => ({
  startMs: NOW - days * DAY_MS,
  endMs: NOW,
});

const FUNNY: ContentTypeRef = { id: "ct-funny", name: "Funny Memes", colorIndex: 0 };
const RANKINGS: ContentTypeRef = { id: "ct-rank", name: "Rankings", colorIndex: 1 };
const CUTSCENE: ContentTypeRef = { id: "ct-cut", name: "Cutscenes", colorIndex: 2 };
const CATALOGUE = [FUNNY, RANKINGS, CUTSCENE];

/**
 * A Short with tags, published inside every window used below.
 *
 * DECIDED BY DEFAULT, and by its view count: over a million is a hit, under is
 * a miss. That mapping is a fixture convenience, NOT the rule — several tests
 * below override it precisely to prove that the two are independent — but it
 * keeps every existing expectation in this file meaning what it always meant,
 * which is that a tag's rate describes its Shorts rather than their ages.
 */
function tagged(
  views: number,
  contentTypeIds: readonly string[],
  overrides: Partial<TaggedVideo> = {},
): TaggedVideo {
  const base = makeShort({ views, publishedAt: daysAgo(5, NOW), ...overrides });
  return {
    ...base,
    hit:
      base.hit ??
      (views >= 1_000_000
        ? makeVerdict("hit", { viewsAtWindow: views, observedAtHours: 24 })
        : makeVerdict("miss")),
    effectiveContentTypeIds: contentTypeIds,
  };
}

/** The same shape, with no rule behind it — a niche nobody has configured. */
function untaggedByRule(
  views: number,
  contentTypeIds: readonly string[],
): TaggedVideo {
  return {
    ...makeShort({ views, publishedAt: daysAgo(5, NOW) }),
    hit: makeVerdict("unknown", { thresholdApplied: null, windowHoursApplied: null }),
    effectiveContentTypeIds: contentTypeIds,
  };
}

function rowFor(
  result: ReturnType<typeof calculateContentTypePerformance>,
  id: string | null,
) {
  const row = result.rows.find((r) => r.contentTypeId === id);
  if (!row) throw new Error(`no row for ${id ?? "untagged"}`);
  return row;
}

describe("overlapping tags", () => {
  it("counts a Short in every row it is tagged with, so rows do not partition", () => {
    const videos: TaggedVideo[] = [
      tagged(1_000_000, [FUNNY.id, RANKINGS.id]),
      tagged(2_000_000, [FUNNY.id]),
      tagged(3_000_000, [RANKINGS.id]),
    ];

    const result = calculateContentTypePerformance({
      videos,
      range: range(30),
      threshold: 1_000_000,
      contentTypes: CATALOGUE,
    });

    // Two Shorts each, from three distinct Shorts. The overlap is the point.
    expect(rowFor(result, FUNNY.id).shortsCount).toBe(2);
    expect(rowFor(result, RANKINGS.id).shortsCount).toBe(2);

    expect(result.totalShorts).toBe(3);
    expect(result.taggedShorts).toBe(3);
    expect(result.taggedAssignments).toBe(4);
    expect(result.hasOverlap).toBe(true);

    // The identity the shape actually guarantees — and the one it does not.
    expect(result.taggedShorts + result.untaggedShorts).toBe(result.totalShorts);
    const summed = result.rows
      .filter((r) => !r.isUntagged)
      .reduce((acc, r) => acc + r.shortsCount, 0);
    expect(summed).toBeGreaterThan(result.taggedShorts);
  });

  it("does not double-count a duplicated id on one Short", () => {
    const result = calculateContentTypePerformance({
      videos: [tagged(500_000, [FUNNY.id, FUNNY.id])],
      range: range(30),
      threshold: 1_000_000,
      contentTypes: CATALOGUE,
    });

    expect(rowFor(result, FUNNY.id).shortsCount).toBe(1);
    expect(result.taggedAssignments).toBe(1);
    expect(result.hasOverlap).toBe(false);
  });

  it("reports no overlap when every Short carries at most one tag", () => {
    const result = calculateContentTypePerformance({
      videos: [tagged(100, [FUNNY.id]), tagged(200, [RANKINGS.id]), tagged(300, [])],
      range: range(30),
      threshold: 1_000_000,
      contentTypes: CATALOGUE,
    });

    expect(result.taggedAssignments).toBe(2);
    expect(result.taggedShorts).toBe(2);
    expect(result.hasOverlap).toBe(false);
  });
});

describe("median views", () => {
  it("takes the middle value on an odd count", () => {
    const result = calculateContentTypePerformance({
      videos: [
        tagged(100_000, [FUNNY.id]),
        tagged(900_000, [FUNNY.id]),
        tagged(300_000, [FUNNY.id]),
      ],
      range: range(30),
      threshold: 1_000_000,
      contentTypes: CATALOGUE,
    });

    expect(rowFor(result, FUNNY.id).medianViews).toBe(300_000);
  });

  it("averages the two middle values on an even count", () => {
    const result = calculateContentTypePerformance({
      videos: [
        tagged(100_000, [FUNNY.id]),
        tagged(200_000, [FUNNY.id]),
        tagged(400_000, [FUNNY.id]),
        tagged(900_000, [FUNNY.id]),
      ],
      range: range(30),
      threshold: 1_000_000,
      contentTypes: CATALOGUE,
    });

    // (200_000 + 400_000) / 2 — not the lower middle, not the upper.
    expect(rowFor(result, FUNNY.id).medianViews).toBe(300_000);
    expect(rowFor(result, FUNNY.id).meanViews).toBe(400_000);
  });

  it("is unaffected by an outlier that drags the mean", () => {
    const result = calculateContentTypePerformance({
      videos: [
        tagged(100_000, [RANKINGS.id]),
        tagged(120_000, [RANKINGS.id]),
        tagged(140_000, [RANKINGS.id]),
        tagged(40_000_000, [RANKINGS.id]),
      ],
      range: range(30),
      threshold: 1_000_000,
      contentTypes: CATALOGUE,
    });

    const row = rowFor(result, RANKINGS.id);
    expect(row.medianViews).toBe(130_000);
    expect(row.meanViews).toBe(10_090_000);
  });
});

describe("a tag no niche rule reaches", () => {
  it("yields a null hit rate, not 0", () => {
    const result = calculateContentTypePerformance({
      videos: [
        untaggedByRule(5_000_000, [FUNNY.id]),
        untaggedByRule(4_000_000, [FUNNY.id]),
        untaggedByRule(10, [RANKINGS.id]),
      ],
      range: range(30),
      threshold: null,
      contentTypes: CATALOGUE,
    });

    for (const row of result.rows) {
      expect(row.hits.rate).toBeNull();
      expect(row.hits.hits).toBe(0);
      // Never counted as failures. An unconfigured niche must not drag a
      // portfolio rate down while looking like a measurement.
      expect(row.hits.tally.misses).toBe(0);
    }

    // Everything that never depended on a rule is still computed in full.
    expect(rowFor(result, FUNNY.id).shortsCount).toBe(2);
    expect(rowFor(result, FUNNY.id).medianViews).toBe(4_500_000);
    expect(rowFor(result, FUNNY.id).totalViews).toBe(9_000_000);
    expect(result.threshold).toBeNull();
  });

  it("is a different state from a real 0% — same Shorts, one lot judged", () => {
    const unconfigured = calculateContentTypePerformance({
      videos: [untaggedByRule(10, [FUNNY.id]), untaggedByRule(20, [FUNNY.id])],
      range: range(30),
      threshold: null,
      contentTypes: CATALOGUE,
    });
    const measured = calculateContentTypePerformance({
      videos: [tagged(10, [FUNNY.id]), tagged(20, [FUNNY.id])],
      range: range(30),
      threshold: 1_000_000,
      contentTypes: CATALOGUE,
    });

    expect(rowFor(unconfigured, FUNNY.id).hits.rate).toBeNull();
    expect(rowFor(measured, FUNNY.id).hits.rate).toBe(0);
  });

  it("still reports a rate of 0 for a tag that genuinely missed", () => {
    const result = calculateContentTypePerformance({
      videos: [
        tagged(2_000_000, [FUNNY.id]),
        tagged(10_000, [RANKINGS.id]),
        tagged(20_000, [RANKINGS.id]),
      ],
      range: range(30),
      threshold: 1_000_000,
      contentTypes: CATALOGUE,
    });

    expect(rowFor(result, FUNNY.id).hits.rate).toBe(100);
    expect(rowFor(result, RANKINGS.id).hits.rate).toBe(0);
    expect(rowFor(result, RANKINGS.id).hits.hits).toBe(0);
  });

  it("a tag's rate is its verdicts, not its view counts", () => {
    /*
     * THE TABLE'S OWN VERSION OF THE CENTRAL BUG.
     *
     * "Rankings" here has two Shorts at four million views each, both of which
     * took months to get there. The old table counted lifetime views against
     * the bar and reported 100% — and an editor reading it would go and make
     * more Rankings.
     * The verdicts say neither one hit.
     */
    const slowGiants = [
      { ...makeMiss({ views: 4_000_000, publishedAt: daysAgo(5, NOW) }), effectiveContentTypeIds: [RANKINGS.id] },
      { ...makeMiss({ views: 4_200_000, publishedAt: daysAgo(6, NOW) }), effectiveContentTypeIds: [RANKINGS.id] },
    ];

    const result = calculateContentTypePerformance({
      videos: slowGiants,
      range: range(30),
      threshold: 1_000_000,
      contentTypes: CATALOGUE,
    });

    const row = rowFor(result, RANKINGS.id);
    expect(row.totalViews).toBe(8_200_000);
    expect(row.hits.rate).toBe(0);
    expect(row.hits.judged).toBe(2);
  });
});

describe("the untagged row", () => {
  it("counts Shorts nobody has classified, and is flagged rather than given an id", () => {
    const videos = [
      tagged(1_500_000, [FUNNY.id]),
      tagged(100_000, []),
      tagged(300_000, []),
      tagged(2_000_000, []),
    ];

    const result = calculateContentTypePerformance({
      videos,
      range: range(30),
      threshold: 1_000_000,
      contentTypes: CATALOGUE,
    });

    const untagged = rowFor(result, null);
    expect(untagged.isUntagged).toBe(true);
    expect(untagged.name).toBe(UNTAGGED_ROW_LABEL);
    expect(untagged.colorIndex).toBeNull();
    expect(untagged.shortsCount).toBe(3);
    expect(untagged.medianViews).toBe(300_000);
    // It is a real row about real Shorts: its hit rate is measured like any other.
    expect(untagged.hits.rate).toBe(roundedThird());
    expect(result.untaggedShorts).toBe(3);
    expect(result.taggedShorts).toBe(1);
  });

  it("is always last, after every tag however small", () => {
    const result = calculateContentTypePerformance({
      videos: [
        tagged(1, []),
        tagged(2, []),
        tagged(3, []),
        tagged(4, []),
        tagged(5, [RANKINGS.id]),
      ],
      range: range(30),
      threshold: 1_000_000,
      contentTypes: CATALOGUE,
    });

    expect(result.rows.map((r) => r.name)).toEqual(["Rankings", UNTAGGED_ROW_LABEL]);
  });

  it("is omitted entirely when the whole library is classified", () => {
    const result = calculateContentTypePerformance({
      videos: [tagged(10, [FUNNY.id]), tagged(20, [RANKINGS.id])],
      range: range(30),
      threshold: 1_000_000,
      contentTypes: CATALOGUE,
    });

    expect(result.rows.some((r) => r.isUntagged)).toBe(false);
    expect(result.untaggedShorts).toBe(0);
  });

  it("absorbs a Short whose only tag is not in the catalogue", () => {
    const result = calculateContentTypePerformance({
      videos: [tagged(10, ["ct-deleted"])],
      range: range(30),
      threshold: 1_000_000,
      contentTypes: CATALOGUE,
    });

    // Never a row named after a raw id, and never a Short missing from the table.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].isUntagged).toBe(true);
    expect(result.totalShorts).toBe(1);
  });
});

describe("scope", () => {
  it("counts only Shorts, and only inside the window", () => {
    const result = calculateContentTypePerformance({
      videos: [
        tagged(1_000_000, [FUNNY.id], { publishedAt: daysAgo(5, NOW) }),
        tagged(9_000_000, [FUNNY.id], { publishedAt: daysAgo(200, NOW) }),
        { ...makeLongform({ views: 8_000_000, publishedAt: daysAgo(5, NOW) }), effectiveContentTypeIds: [FUNNY.id] },
      ],
      range: range(30),
      threshold: 1_000_000,
      contentTypes: CATALOGUE,
    });

    expect(result.totalShorts).toBe(1);
    expect(rowFor(result, FUNNY.id).shortsCount).toBe(1);
    expect(rowFor(result, FUNNY.id).totalViews).toBe(1_000_000);
  });

  it("ranks by volume and reports each row's share of the whole window", () => {
    const videos = [
      ...Array.from({ length: 4 }, () => tagged(100, [FUNNY.id])),
      ...Array.from({ length: 2 }, () => tagged(100, [RANKINGS.id])),
    ];

    const result = calculateContentTypePerformance({
      videos,
      range: range(30),
      threshold: 1_000_000,
      contentTypes: CATALOGUE,
    });

    expect(result.rows.map((r) => r.name)).toEqual(["Funny Memes", "Rankings"]);
    expect(rowFor(result, FUNNY.id).shareOfShorts).toBeCloseTo(4 / 6);
    // Cutscenes has no Shorts in the window, so it gets no row — but is counted.
    expect(result.unusedContentTypeCount).toBe(1);
  });

  it("returns an empty, honest result for a window with no Shorts", () => {
    const result = calculateContentTypePerformance({
      videos: [tagged(100, [FUNNY.id], { publishedAt: daysAgo(300, NOW) })],
      range: range(30),
      threshold: 1_000_000,
      contentTypes: CATALOGUE,
    });

    expect(result.rows).toEqual([]);
    expect(result.totalShorts).toBe(0);
    expect(result.hasOverlap).toBe(false);
  });
});

/** 1 of 3 Shorts hit, rounded the way `calculateHitRate` rounds it. */
function roundedThird(): number {
  return 33.33;
}
