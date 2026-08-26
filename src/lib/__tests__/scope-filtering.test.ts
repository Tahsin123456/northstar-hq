import { describe, expect, it } from "vitest";
import { calculateChannelMetrics, calculatePortfolioSummary } from "@/lib/analytics";
import type { ChannelMetrics } from "@/lib/analytics/types";
import type { ChannelDTO, NicheRefDTO, OwnershipType } from "@/lib/dto";
import { filterRowsByScope } from "@/hooks/use-channel-analytics";
import { DEFAULT_SORT, sortRows } from "@/lib/sorting";
import { DAY_MS, daysAgo, makeShort } from "@/lib/analytics/__tests__/factories";

/**
 * Niche and ownership scoping.
 *
 * These filters sit *upstream* of every metric, so the tests here are really
 * about one guarantee: a scoped view reports the scoped set's numbers, never a
 * filtered presentation of global ones.
 */

const NOW = Date.UTC(2026, 5, 1);
const range = (days: number) => ({ startMs: NOW - days * DAY_MS, endMs: NOW });

const GTA: NicheRefDTO = { id: "n-gta", name: "GTA", colorIndex: 0 };
const RDR: NicheRefDTO = { id: "n-rdr", name: "Red Dead Redemption", colorIndex: 1 };
const FINANCE: NicheRefDTO = { id: "n-fin", name: "Finance", colorIndex: 2 };

interface TestRow {
  channel: ChannelDTO;
  metrics: ChannelMetrics;
}

function makeRow(options: {
  id: string;
  name?: string;
  ownershipType?: OwnershipType;
  niches?: NicheRefDTO[];
  /** Views per Short, all published inside the window. */
  views?: number[];
}): TestRow {
  const views = options.views ?? [];
  const channel = {
    id: options.id,
    youtubeChannelId: `UC${options.id}`,
    handle: `@${options.id}`,
    title: options.name ?? options.id,
    label: null,
    displayName: options.name ?? options.id,
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
    ownershipType: options.ownershipType ?? "competitor",
    niches: options.niches ?? [],
  } satisfies ChannelDTO;

  return {
    channel,
    metrics: calculateChannelMetrics({
      videos: views.map((v, i) => makeShort({ views: v, publishedAt: daysAgo(i + 1, NOW) })),
      range: range(30),
      threshold: 1_000_000,
    }),
  };
}

const ROWS: TestRow[] = [
  makeRow({ id: "a", ownershipType: "own", niches: [GTA], views: [2_000_000, 2_000_000] }),
  makeRow({ id: "b", ownershipType: "competitor", niches: [GTA], views: [2_000_000, 100] }),
  makeRow({ id: "c", ownershipType: "competitor", niches: [RDR], views: [100, 100] }),
  makeRow({ id: "d", ownershipType: "own", niches: [GTA, FINANCE], views: [5_000_000] }),
  makeRow({ id: "e", ownershipType: "competitor", niches: [], views: [3_000_000] }),
];

describe("filterRowsByScope — niche", () => {
  it("returns everything for 'all'", () => {
    expect(filterRowsByScope(ROWS, "all", "all")).toHaveLength(5);
  });

  it("matches channels assigned to the niche", () => {
    const gta = filterRowsByScope(ROWS, GTA.id, "all");
    expect(gta.map((r) => r.channel.id).sort()).toEqual(["a", "b", "d"]);
  });

  it("includes a channel that belongs to several niches", () => {
    // "d" is in both GTA and Finance and must appear under each.
    expect(filterRowsByScope(ROWS, FINANCE.id, "all").map((r) => r.channel.id)).toEqual(["d"]);
    expect(filterRowsByScope(ROWS, GTA.id, "all").map((r) => r.channel.id)).toContain("d");
  });

  it("'unassigned' finds exactly the channels with no niche", () => {
    expect(filterRowsByScope(ROWS, "unassigned", "all").map((r) => r.channel.id)).toEqual(["e"]);
  });

  it("returns nothing for a niche id that no longer exists", () => {
    // A deleted niche can linger in a bookmarked URL; it must degrade to an
    // empty result rather than throwing or silently showing everything.
    expect(filterRowsByScope(ROWS, "n-deleted", "all")).toHaveLength(0);
  });
});

describe("filterRowsByScope — ownership", () => {
  it("selects only the user's own channels", () => {
    expect(filterRowsByScope(ROWS, "all", "own").map((r) => r.channel.id).sort()).toEqual([
      "a",
      "d",
    ]);
  });

  it("selects only competitors", () => {
    expect(
      filterRowsByScope(ROWS, "all", "competitor").map((r) => r.channel.id).sort(),
    ).toEqual(["b", "c", "e"]);
  });
});

describe("filterRowsByScope — combined", () => {
  it("intersects niche and ownership", () => {
    expect(filterRowsByScope(ROWS, GTA.id, "own").map((r) => r.channel.id).sort()).toEqual([
      "a",
      "d",
    ]);
    expect(
      filterRowsByScope(ROWS, GTA.id, "competitor").map((r) => r.channel.id),
    ).toEqual(["b"]);
  });

  it("can produce an empty set without error", () => {
    expect(filterRowsByScope(ROWS, RDR.id, "own")).toHaveLength(0);
  });
});

describe("scoped analytics", () => {
  it("summarises only the scoped channels, not a filtered global average", () => {
    // Across everything, hit rates are: a 100%, b 50%, c 0%, d 100%, e 100%.
    const all = calculatePortfolioSummary(
      ROWS.map((r) => ({ id: r.channel.id, name: r.channel.displayName, metrics: r.metrics })),
    );
    expect(all.averageHitRate).toBe(70);

    // Scoped to GTA + our channels (a and d), both at 100%.
    const scoped = filterRowsByScope(ROWS, GTA.id, "own");
    const summary = calculatePortfolioSummary(
      scoped.map((r) => ({ id: r.channel.id, name: r.channel.displayName, metrics: r.metrics })),
    );
    expect(summary.channelCount).toBe(2);
    expect(summary.averageHitRate).toBe(100);
    expect(summary.totalShorts).toBe(3);
    // The 100-view Shorts from the excluded channels must not appear anywhere.
    expect(summary.totalViews).toBe(9_000_000);
  });
});

describe("sortRows — ownFirst", () => {
  it("leaves ordering untouched by default", () => {
    const sorted = sortRows(ROWS, DEFAULT_SORT);
    // Hit rate descending, volume as tie-break: a (100%, 2) before d/e (100%, 1).
    expect(sorted[0].channel.id).toBe("a");
    expect(sorted[sorted.length - 1].channel.id).toBe("c");
  });

  it("floats own channels above competitors when enabled", () => {
    const sorted = sortRows(ROWS, DEFAULT_SORT, { ownFirst: true });
    const ownership = sorted.map((r) => r.channel.ownershipType);
    expect(ownership).toEqual(["own", "own", "competitor", "competitor", "competitor"]);
  });

  it("still ranks by the chosen metric inside each ownership group", () => {
    const sorted = sortRows(ROWS, DEFAULT_SORT, { ownFirst: true });
    // Own group: a (100%, 2 Shorts) outranks d (100%, 1 Short) on volume.
    expect(sorted.slice(0, 2).map((r) => r.channel.id)).toEqual(["a", "d"]);
    // Competitor group still ordered by hit rate: e (100%) > b (50%) > c (0%).
    expect(sorted.slice(2).map((r) => r.channel.id)).toEqual(["e", "b", "c"]);
  });

  it("does not mutate the input", () => {
    const before = ROWS.map((r) => r.channel.id);
    sortRows(ROWS, DEFAULT_SORT, { ownFirst: true });
    expect(ROWS.map((r) => r.channel.id)).toEqual(before);
  });
});
