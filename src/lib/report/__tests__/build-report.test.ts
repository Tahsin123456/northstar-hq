import { describe, expect, it } from "vitest";
import { buildReport } from "../build-report";
import { calculateChannelMetrics } from "@/lib/analytics/channel-metrics";
import { calculateMarketShare } from "@/lib/analytics/market-share";
import type { DatasetDTO, VideoDTO } from "@/lib/dto";
import { DAY_MS, daysAgo, makeLongform, makeShort } from "@/lib/analytics/__tests__/factories";

/**
 * The report must never disagree with the screens.
 *
 * These assert that `buildReport` reports exactly what the analytics engine
 * produces for the same inputs — not an approximation, not a re-derivation.
 * If someone later adds a shortcut calculation inside the report builder,
 * these fail.
 */

const NOW = Date.UTC(2026, 5, 1);

/**
 * The factories build the analytics engine input shape; the dataset carries the
 * slightly wider wire shape. Adding the three classification fields here keeps
 * the fixtures honest rather than casting the difference away.
 */
function asVideoDTO(video: ReturnType<typeof makeShort>): VideoDTO {
  return {
    ...video,
    classification: video.isShort ? "short" : "not_short",
    classificationConfidence: 0.99,
    isAvailable: true,
  };
}
const range = (days: number) => ({ startMs: NOW - days * DAY_MS, endMs: NOW });

function channel(
  id: string,
  ownershipType: "own" | "competitor",
  views: number[],
  extraVideos: ReturnType<typeof makeShort>[] = [],
): DatasetDTO["channels"][number] {
  return {
    channel: {
      id,
      youtubeChannelId: `UC${id}`,
      handle: `@${id}`,
      title: id,
      label: null,
      displayName: id,
      description: "",
      avatarUrl: null,
      bannerUrl: null,
      country: null,
      subscriberCount: 1000,
      hiddenSubscriberCount: false,
      lifetimeViewCount: null,
      lifetimeVideoCount: null,
      channelUrl: "",
      lastFetchedAt: NOW,
      lastFetchStatus: "success",
      lastFetchError: null,
      addedAt: NOW,
      isActive: true,
      ownershipType,
      niches: [{ id: "n1", name: "GTA", colorIndex: 0 }],
    },
    videos: [
      ...views.map((v, i) => asVideoDTO(makeShort({ views: v, publishedAt: daysAgo(i + 1, NOW) }))),
      ...extraVideos.map(asVideoDTO),
    ],
    excludedCount: 0,
    unclassifiedCount: 0,
  };
}

function dataset(channels: DatasetDTO["channels"]): DatasetDTO {
  return {
    channels,
    niches: [
      {
        id: "n1",
        name: "GTA",
        colorIndex: 0,
        slug: "gta",
        hitThreshold: null,
        sortOrder: 0,
        channelCount: channels.length,
        createdAt: NOW,
      },
    ],
    collections: [],
    savedShorts: [],
    noteCounts: { channels: {}, niches: {}, videos: {} },
    viewsDefinition: {
      canComputeViewsInPeriod: false,
      snapshotSpanHours: 0,
      snapshotCount: 0,
      snapshotDays: 0,
    },
    lookbackDays: 400,
    generatedAt: NOW,
    oldestFetchedAt: NOW,
    hasApiKey: true,
  };
}

describe("buildReport — data accuracy", () => {
  const ds = dataset([
    channel("ours", "own", [2_000_000, 500_000, 100_000]),
    channel("rival", "competitor", [3_000_000, 3_000_000, 200_000]),
  ]);

  const report = buildReport({
    dataset: ds,
    range: range(30),
    threshold: 1_000_000,
    nicheId: null,
    periodLabel: "Last 30 days",
    now: NOW,
  });

  it("reports exactly what the analytics engine computes for the same window", () => {
    const allVideos = ds.channels.flatMap((c) => [...c.videos]);
    const expected = calculateChannelMetrics({
      videos: allVideos,
      range: range(30),
      threshold: 1_000_000,
    });

    const views = report.summary.find((m) => m.key === "totalViews");
    const hitRate = report.summary.find((m) => m.key === "hitRate");
    const shorts = report.summary.find((m) => m.key === "shortsUploaded");
    const medianViews = report.summary.find((m) => m.key === "medianViews");

    expect(views?.value).toBe(expected.totalViews);
    expect(hitRate?.value).toBe(expected.hitRate);
    expect(shorts?.value).toBe(expected.totalShorts);
    expect(medianViews?.value).toBe(expected.medianViews);
  });

  it("reports the same market share the page computes", () => {
    const expected = calculateMarketShare(
      ds.channels.filter((c) => c.channel.ownershipType === "own").map((c) => ({ videos: c.videos })),
      ds.channels.filter((c) => c.channel.ownershipType !== "own").map((c) => ({ videos: c.videos })),
      range(30),
    );
    expect(report.marketShare.sharePercent).toBe(expected.sharePercent);
    expect(report.marketShare.ourViews).toBe(expected.ourViews);
  });

  it("compares against the immediately preceding window of the same length", () => {
    expect(report.comparisonRange.endMs).toBe(report.range.startMs);
    expect(report.comparisonRange.endMs - report.comparisonRange.startMs).toBe(
      report.range.endMs - report.range.startMs,
    );
  });

  it("excludes long-form from every reported figure", () => {
    const withLongform = dataset([
      channel("ours", "own", [1_000_000], [
        makeLongform({ views: 900_000_000, publishedAt: daysAgo(2, NOW) }),
      ]),
      channel("rival", "competitor", [1_000_000]),
    ]);

    const r = buildReport({
      dataset: withLongform,
      range: range(30),
      threshold: 1_000_000,
      nicheId: null,
      periodLabel: "Last 30 days",
      now: NOW,
    });

    // 900M of long-form must be absent from the total and from market share.
    expect(r.summary.find((m) => m.key === "totalViews")?.value).toBe(2_000_000);
    expect(r.marketShare.sharePercent).toBe(50);
  });

  it("scopes to a niche when one is selected", () => {
    const mixed = dataset([
      channel("gta", "own", [1_000_000]),
      {
        ...channel("other", "competitor", [5_000_000]),
        channel: {
          ...channel("other", "competitor", []).channel,
          niches: [{ id: "n2", name: "RDR", colorIndex: 1 }],
        },
      },
    ]);

    const scoped = buildReport({
      dataset: mixed,
      range: range(30),
      threshold: 1_000_000,
      nicheId: "n1",
      periodLabel: "Last 30 days",
      now: NOW,
    });

    expect(scoped.trackedChannelCount).toBe(1);
    expect(scoped.summary.find((m) => m.key === "totalViews")?.value).toBe(1_000_000);
  });

  it("marks upload volume as directionally neutral in the summary", () => {
    const shorts = report.summary.find((m) => m.key === "shortsUploaded");
    // Movement is reported; no verdict is attached.
    expect(shorts?.trend.direction).toBe("neutral");
    expect(shorts?.trend.isImprovement).toBeNull();
  });

  it("uses percentage points for rates and relative percent for magnitudes", () => {
    expect(report.summary.find((m) => m.key === "hitRate")?.trend.unit).toBe(
      "percentagePoints",
    );
    expect(report.summary.find((m) => m.key === "marketShare")?.trend.unit).toBe(
      "percentagePoints",
    );
    expect(report.summary.find((m) => m.key === "totalViews")?.trend.unit).toBe(
      "relativePercent",
    );
  });

  it("only emits insights that the data supports", () => {
    // Every generated line must be a plain restatement, never a causal claim.
    for (const line of report.insights) {
      expect(line).not.toMatch(/because|due to|caused|driven by|thanks to/i);
      expect(line.length).toBeGreaterThan(10);
    }
  });

  it("omits insights entirely when there is no baseline to compare", () => {
    const empty = buildReport({
      dataset: dataset([channel("ours", "own", [])]),
      range: range(30),
      threshold: 1_000_000,
      nicheId: null,
      periodLabel: "Last 30 days",
      now: NOW,
    });
    // No Shorts on either side means nothing truthful can be said.
    expect(empty.insights.length).toBe(0);
  });
});
