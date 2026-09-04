import { describe, expect, it } from "vitest";
import { buildReport } from "../build-report";
import { calculateChannelMetrics } from "@/lib/analytics/channel-metrics";
import { calculateMarketShare } from "@/lib/analytics/market-share";
import type { DatasetDTO, VideoDTO } from "@/lib/dto";
import {
  DAY_MS,
  daysAgo,
  makeHit,
  makeLongform,
  makeMiss,
  makeShort,
} from "@/lib/analytics/__tests__/factories";

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
 * slightly wider wire shape. Adding the classification and content-type fields
 * here keeps the fixtures honest rather than casting the difference away.
 */
function asVideoDTO(video: ReturnType<typeof makeShort>): VideoDTO {
  return {
    ...video,
    classification: video.isShort ? "short" : "not_short",
    classificationConfidence: 0.99,
    isAvailable: true,
    // No deviations from the channel — which, with the untagged channel below,
    // makes these Shorts genuinely unclassified. The report is built from view
    // counts and stored verdicts and must not start depending on a label an
    // organization may never apply.
    manualContentTypeIds: [],
    excludedContentTypeIds: [],
  };
}

/**
 * Decided Shorts, hit where they cleared a million.
 *
 * The report's job is to agree with the screens, and it now has a verdict to
 * agree about: the hit rate on the cover is counted from these, not derived
 * from the view counts beside them. Long-form and the deliberately-unjudged
 * fixtures keep `hit: null`, which is what an unevaluated Short really looks
 * like on the wire.
 */
function judged(views: number, daysBack: number) {
  return views >= 1_000_000
    ? makeHit({ views, publishedAt: daysAgo(daysBack, NOW) })
    : makeMiss({ views, publishedAt: daysAgo(daysBack, NOW) });
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
      // The report does not read the source, so the fixture states the one a
      // channel with no connection has rather than implying a connection.
      dataSource: "public",
      niches: [{ id: "n1", name: "GTA", colorIndex: 0, kind: "production" }],
      // No editorial rules on the channel — the report does not read them, and
      // an empty list keeps that visible rather than implied.
      contentTypeRules: [],
    },
    videos: [
      ...views.map((v, i) => asVideoDTO(judged(v, i + 1))),
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
        kind: "production",
        slug: "gta",
        // The format every niche in the running product has. Dark on the
        // wire today; the report reads nothing from it.
        format: "shorts",
        hitPaymentMinor: null,
        hitThreshold: null,
        hitWindowHours: null,
        sortOrder: 0,
        channelCount: channels.length,
        createdById: "u1",
        createdByName: "Ada Lovelace",
        createdAt: NOW,
      },
    ],
    // Empty on purpose: the report must produce identical numbers for an
    // organization that has never defined a content type.
    contentTypes: [],
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
    expect(hitRate?.value).toBe(expected.hits.rate);
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
          niches: [{ id: "n2", name: "RDR", colorIndex: 1, kind: "production" }],
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

/**
 * The exclusions have to reach the PDF, not just the screens.
 *
 * A report is the artefact that outlives every dashboard: it gets forwarded,
 * quoted and read six months later by somebody who cannot hover a tooltip. A
 * hit rate printed on a cover without what it left out is the most durable
 * version of the claim this product exists not to make.
 */
describe("buildReport — what the rate left out travels with it", () => {
  it("carries the tally onto the report data", () => {
    const ds = dataset([
      channel("ours", "own", [2_000_000, 100_000]),
      channel("theirs", "competitor", [500_000]),
    ]);

    const report = buildReport({
      dataset: ds,
      range: range(30),
      threshold: 1_000_000,
      nicheId: null,
      periodLabel: "Last 30 days",
      now: NOW,
    });

    const expected = calculateChannelMetrics({
      videos: ds.channels.flatMap((c) => [...c.videos]),
      range: range(30),
      threshold: 1_000_000,
    });

    expect(report.hits.judged).toBe(expected.hits.judged);
    expect(report.hits.tally).toEqual(expected.hits.tally);
    expect(report.hits.rate).toBe(expected.hits.rate);
  });

  it("says so in the insights when the excluded population is material", () => {
    const ds = dataset([
      channel("ours", "own", [2_000_000, 100_000], [
        // Four Shorts with no verdict at all — the state of a library the
        // evaluator has not reached, or one whose niches have no rule.
        makeShort({ views: 800_000, publishedAt: daysAgo(3, NOW) }),
        makeShort({ views: 900_000, publishedAt: daysAgo(4, NOW) }),
        makeShort({ views: 700_000, publishedAt: daysAgo(5, NOW) }),
        makeShort({ views: 600_000, publishedAt: daysAgo(6, NOW) }),
      ]),
    ]);

    const report = buildReport({
      dataset: ds,
      range: range(30),
      threshold: 1_000_000,
      nicheId: null,
      periodLabel: "Last 30 days",
      now: NOW,
    });

    expect(report.hits.tally.unscoreable).toBe(4);
    expect(report.insights.some((line) => line.includes("could not be judged"))).toBe(true);
  });
});
