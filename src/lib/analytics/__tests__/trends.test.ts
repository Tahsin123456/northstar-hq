import { describe, expect, it } from "vitest";
import {
  calculateTrend,
  formatTrendDelta,
  previousRange,
  trendGlyph,
} from "../trends";
import { calculateMarketShare, calculateMarketShareSeries } from "../market-share";
import { DAY_MS, daysAgo, makeLongform, makeShort } from "./factories";

const NOW = Date.UTC(2026, 5, 1);
const range = (days: number) => ({ startMs: NOW - days * DAY_MS, endMs: NOW });

describe("previousRange", () => {
  it("is the same duration, immediately before, with no gap or overlap", () => {
    const current = range(30);
    const prior = previousRange(current);
    expect(prior.endMs).toBe(current.startMs);
    expect(prior.endMs - prior.startMs).toBe(current.endMs - current.startMs);
  });
});

describe("calculateTrend — percentage points vs percentages", () => {
  it("reports a rate change in percentage points, not percent", () => {
    // The canonical trap: 20% -> 25% is +5 pp, not +5% and not +25%.
    const trend = calculateTrend(25, 20, {
      direction: "higherIsBetter",
      unit: "percentagePoints",
    });
    expect(trend.delta).toBe(5);
    expect(formatTrendDelta(trend)).toBe("+5.0 pp");
    expect(formatTrendDelta(trend)).not.toContain("%");
  });

  it("reports a magnitude change as a relative percentage", () => {
    const trend = calculateTrend(640_000, 698_000, {
      direction: "higherIsBetter",
      unit: "relativePercent",
    });
    expect(formatTrendDelta(trend)).toBe("−8.3%");
    expect(formatTrendDelta(trend)).not.toContain("pp");
  });

  it("keeps both readings available on the same trend", () => {
    const trend = calculateTrend(25, 20, {
      direction: "higherIsBetter",
      unit: "percentagePoints",
    });
    expect(trend.delta).toBe(5);
    expect(trend.deltaPercent).toBe(25);
  });
});

describe("calculateTrend — direction is a property of the metric", () => {
  it("treats a rise in a higher-is-better metric as an improvement", () => {
    const trend = calculateTrend(28.4, 24.2, {
      direction: "higherIsBetter",
      unit: "percentagePoints",
    });
    expect(trend.movement).toBe("up");
    expect(trend.isImprovement).toBe(true);
  });

  it("treats a rise in a lower-is-better metric as a regression", () => {
    const trend = calculateTrend(12, 8, {
      direction: "lowerIsBetter",
      unit: "relativePercent",
    });
    expect(trend.movement).toBe("up");
    expect(trend.isImprovement).toBe(false);
  });

  it("never declares a winner on a neutral metric", () => {
    // Upload frequency: posting more is a strategy, not an achievement.
    const up = calculateTrend(42, 30, { direction: "neutral", unit: "relativePercent" });
    const down = calculateTrend(30, 42, { direction: "neutral", unit: "relativePercent" });

    expect(up.movement).toBe("up");
    expect(down.movement).toBe("down");
    // Movement is reported; judgement is withheld.
    expect(up.isImprovement).toBeNull();
    expect(down.isImprovement).toBeNull();
  });
});

describe("calculateTrend — stagnation and missing data", () => {
  it("reports a tiny move as flat rather than a coloured arrow", () => {
    const trend = calculateTrend(28.42, 28.4, {
      direction: "higherIsBetter",
      unit: "percentagePoints",
    });
    expect(trend.movement).toBe("flat");
    expect(trend.isImprovement).toBeNull();
    expect(formatTrendDelta(trend)).toBe("0 pp");
    expect(trendGlyph(trend.movement)).toBe("→");
  });

  it("shows an em dash when there is no baseline, rather than inventing one", () => {
    const noPrevious = calculateTrend(28.4, null, {
      direction: "higherIsBetter",
      unit: "percentagePoints",
    });
    expect(noPrevious.hasComparison).toBe(false);
    expect(noPrevious.isImprovement).toBeNull();
    expect(formatTrendDelta(noPrevious)).toBe("—");
  });

  it("does not divide by zero when the previous value was zero", () => {
    const trend = calculateTrend(500, 0, {
      direction: "higherIsBetter",
      unit: "relativePercent",
    });
    expect(trend.deltaPercent).toBeNull();
    expect(Number.isFinite(trend.delta ?? 0)).toBe(true);
    expect(formatTrendDelta(trend)).toBe("—");
  });

  it("uses the correct glyph for each movement", () => {
    expect(trendGlyph("up")).toBe("↑");
    expect(trendGlyph("down")).toBe("↓");
    expect(trendGlyph("flat")).toBe("→");
  });
});

describe("calculateMarketShare", () => {
  const ours = [{ videos: [makeShort({ views: 125_000_000, publishedAt: daysAgo(3, NOW) })] }];
  const theirs = [
    { videos: [makeShort({ views: 375_000_000, publishedAt: daysAgo(4, NOW) })] },
  ];

  it("computes our share of tracked views", () => {
    // The spec's worked example: 125M of 500M is 25%.
    const share = calculateMarketShare(ours, theirs, range(30));
    expect(share.ourViews).toBe(125_000_000);
    expect(share.competitorViews).toBe(375_000_000);
    expect(share.totalViews).toBe(500_000_000);
    expect(share.sharePercent).toBe(25);
  });

  it("excludes long-form from both sides of the ratio", () => {
    const share = calculateMarketShare(
      [
        {
          videos: [
            makeShort({ views: 100, publishedAt: daysAgo(2, NOW) }),
            makeLongform({ views: 900_000_000, publishedAt: daysAgo(2, NOW) }),
          ],
        },
      ],
      [{ videos: [makeShort({ views: 100, publishedAt: daysAgo(2, NOW) })] }],
      range(30),
    );
    expect(share.totalViews).toBe(200);
    expect(share.sharePercent).toBe(50);
  });

  it("returns null, not zero, when nothing was published", () => {
    const share = calculateMarketShare([{ videos: [] }], [{ videos: [] }], range(30));
    expect(share.totalViews).toBe(0);
    // A share of nothing is undefined, not 0%.
    expect(share.sharePercent).toBeNull();
  });

  it("reports 100% when only our channels published", () => {
    const share = calculateMarketShare(ours, [{ videos: [] }], range(30));
    expect(share.sharePercent).toBe(100);
  });

  it("ignores Shorts outside the window", () => {
    const share = calculateMarketShare(
      [{ videos: [makeShort({ views: 999_000_000, publishedAt: daysAgo(200, NOW) })] }],
      theirs,
      range(30),
    );
    expect(share.ourViews).toBe(0);
    expect(share.sharePercent).toBe(0);
  });
});

describe("calculateMarketShareSeries", () => {
  it("emits a gap, not a zero, for a period when nobody published", () => {
    const points = calculateMarketShareSeries([{ videos: [] }], [{ videos: [] }], range(60), "week");
    expect(points.length).toBeGreaterThan(0);
    expect(points.every((p) => p.sharePercent === null)).toBe(true);
  });

  it("tracks share moving across buckets", () => {
    const ours = [
      {
        videos: [
          makeShort({ views: 100, publishedAt: daysAgo(40, NOW) }),
          makeShort({ views: 900, publishedAt: daysAgo(5, NOW) }),
        ],
      },
    ];
    const theirs = [
      {
        videos: [
          makeShort({ views: 900, publishedAt: daysAgo(40, NOW) }),
          makeShort({ views: 100, publishedAt: daysAgo(5, NOW) }),
        ],
      },
    ];

    const points = calculateMarketShareSeries(ours, theirs, range(60), "week");
    const populated = points.filter((p) => p.sharePercent !== null);
    expect(populated).toHaveLength(2);
    // Share moved from 10% early to 90% late.
    expect(populated[0].sharePercent).toBe(10);
    expect(populated[populated.length - 1].sharePercent).toBe(90);
  });
});
