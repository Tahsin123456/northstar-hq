import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { calculateChannelMetrics, calculatePortfolioSummary } from "@/lib/analytics";
import type { ChannelMetrics } from "@/lib/analytics/types";
import type { ChannelDTO, NicheRefDTO, OwnershipType } from "@/lib/dto";
import { filterRowsByScope, untaggedChannelCount } from "@/hooks/use-channel-analytics";
import { DEFAULT_SORT, sortRows } from "@/lib/sorting";
import {
  DAY_MS,
  daysAgo,
  makeHit,
  makeMiss,
} from "@/lib/analytics/__tests__/factories";

/**
 * Niche and ownership scoping.
 *
 * These filters sit *upstream* of every metric, so the tests here are really
 * about one guarantee: a scoped view reports the scoped set's numbers, never a
 * filtered presentation of global ones.
 */

const NOW = Date.UTC(2026, 5, 1);
const range = (days: number) => ({ startMs: NOW - days * DAY_MS, endMs: NOW });

const GTA: NicheRefDTO = { id: "n-gta", name: "GTA", colorIndex: 0, kind: "production" };
const RDR: NicheRefDTO = {
  id: "n-rdr",
  name: "Red Dead Redemption",
  colorIndex: 1,
  kind: "production",
};
const FINANCE: NicheRefDTO = { id: "n-fin", name: "Finance", colorIndex: 2, kind: "production" };

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
  /** Tags the channel has ever been characterised by — one open-ended rule each. */
  contentTypeIds?: readonly string[];
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
    // Every fixture here reads through the public API. This file is about which
    // rows a niche or ownership filter keeps, and no filter reads the source —
    // so the honest fixture value is the one a channel with no connection has.
    dataSource: "public",
    niches: options.niches ?? [],
    /*
     * Untagged unless a case says otherwise, so the niche and ownership
     * assertions below cannot start passing for the wrong reason.
     *
     * Each tag becomes one epoch-dated, open-ended rule — what the migration
     * wrote and what "Apply to this channel" writes. The channel-level filter
     * reads a rule's TAG and deliberately ignores its dates, because a row here
     * is a channel whose metrics describe everything it ever published; the
     * per-Short filters are where a window decides anything.
     */
    contentTypeRules: (options.contentTypeIds ?? []).map((contentTypeId) => ({
      id: `rule_${options.id}_${contentTypeId}`,
      contentTypeId,
      effectiveFrom: 0,
      effectiveUntil: null,
      consecutiveOverrides: 0,
      overrideStreakFrom: null,
      autoClosedAt: null,
    })),
  } satisfies ChannelDTO;

  return {
    channel,
    metrics: calculateChannelMetrics({
      /*
       * Decided Shorts, hit where they cleared a million.
       *
       * This file is about SCOPE — which rows a niche or ownership filter
       * admits — and the hit rate is only here so the scoped summary has
       * something to be right about. Giving the fixtures verdicts keeps that
       * intact: without them every Short would be unscoreable and the summary
       * would be null everywhere, which would make these assertions pass for a
       * reason that has nothing to do with scoping.
       */
      videos: views.map((v, i) =>
        v >= 1_000_000
          ? makeHit({ views: v, publishedAt: daysAgo(i + 1, NOW) })
          : makeMiss({ views: v, publishedAt: daysAgo(i + 1, NOW) }),
      ),
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
      ROWS.map((r) => ({
        id: r.channel.id,
        name: r.channel.displayName,
        metrics: r.metrics,
        // Every fixture niche here is production, so the scorecard is the whole
        // set — this test is about the SCOPE predicate, not the kind split.
        countsTowardHitRate: true,
      })),
    );
    expect(all.averageHitRate).toBe(70);

    // Scoped to GTA + our channels (a and d), both at 100%.
    const scoped = filterRowsByScope(ROWS, GTA.id, "own");
    const summary = calculatePortfolioSummary(
      scoped.map((r) => ({
        id: r.channel.id,
        name: r.channel.displayName,
        metrics: r.metrics,
        countsTowardHitRate: true,
      })),
    );
    expect(summary.channelCount).toBe(2);
    expect(summary.averageHitRate).toBe(100);
    expect(summary.totalShorts).toBe(3);
    // The 100-view Shorts from the excluded channels must not appear anywhere.
    expect(summary.totalViews).toBe(9_000_000);
  });
});

/**
 * The content-type scope, read off the CHANNEL's own tags.
 *
 * `ChannelContentType` is back, so "channels that make Rankings" is answered by
 * the tag on the channel rather than by scanning its Shorts for one. These pin
 * the halves that are easy to get backwards: a channel may carry several tags,
 * "Untagged" means it carries none, and — the one this round changed — a tag
 * is org-wide, so it composes with the niche filter instead of living inside it.
 */
describe("filterRowsByScope — content type", () => {
  const RANKING = "ct-ranking";
  const CUTSCENE = "ct-cutscene";

  const TYPED_ROWS: TestRow[] = [
    makeRow({ id: "a", views: [100, 100], contentTypeIds: [RANKING] }),
    makeRow({ id: "b", views: [100], contentTypeIds: [CUTSCENE] }),
    // A channel the team describes as doing both.
    makeRow({ id: "c", views: [100], contentTypeIds: [RANKING, CUTSCENE] }),
    makeRow({ id: "d", views: [100, 100] }),
  ];

  it("keeps a channel tagged with the type", () => {
    const rows = filterRowsByScope(TYPED_ROWS, "all", "all", RANKING);
    expect(rows.map((r) => r.channel.id)).toEqual(["a", "c"]);
  });

  it("counts a channel carrying several tags under each of them", () => {
    const rows = filterRowsByScope(TYPED_ROWS, "all", "all", CUTSCENE);
    expect(rows.map((r) => r.channel.id)).toEqual(["b", "c"]);
  });

  it("'unassigned' is a channel carrying no tag at all", () => {
    expect(
      filterRowsByScope(TYPED_ROWS, "all", "all", "unassigned").map((r) => r.channel.id),
    ).toEqual(["d"]);
  });

  it("agrees with the count the filter menu labels itself with", () => {
    expect(untaggedChannelCount(TYPED_ROWS)).toBe(
      filterRowsByScope(TYPED_ROWS, "all", "all", "unassigned").length,
    );
  });

  it("returns nothing for a tag that no longer exists", () => {
    // A deleted tag can linger in a bookmarked `?contentType=` URL; it must
    // degrade to an empty result rather than silently showing everything.
    expect(filterRowsByScope(TYPED_ROWS, "all", "all", "ct-deleted")).toHaveLength(0);
  });

  it("composes with niche and ownership rather than living inside the niche", () => {
    const rows: TestRow[] = [
      makeRow({
        id: "gta-own",
        ownershipType: "own",
        niches: [GTA],
        views: [100],
        contentTypeIds: [RANKING],
      }),
      makeRow({
        id: "gta-competitor",
        ownershipType: "competitor",
        niches: [GTA],
        views: [100],
        contentTypeIds: [RANKING],
      }),
      makeRow({
        id: "rdr-own",
        ownershipType: "own",
        niches: [RDR],
        views: [100],
        contentTypeIds: [RANKING],
      }),
    ];

    expect(
      filterRowsByScope(rows, GTA.id, "own", RANKING).map((r) => r.channel.id),
    ).toEqual(["gta-own"]);

    // THE CHANGE THIS ROUND MAKES, pinned: the same tag is a perfectly good
    // question with no niche selected, because it belongs to no niche. Under the
    // previous design a type only existed inside its own niche, so this pairing
    // could not be expressed at all.
    expect(
      filterRowsByScope(rows, "all", "all", RANKING).map((r) => r.channel.id).sort(),
    ).toEqual(["gta-competitor", "gta-own", "rdr-own"]);
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

/**
 * =========================================================================
 * THE TWO SCOPES ON THE OVERVIEW ARE NOT THE SAME SCOPE
 * =========================================================================
 *
 * The dashboard derives two sets from the same rows: `scopedRows`, which is
 * niche + ownership + CONTENT TYPE and feeds the channel table and the empty
 * state, and `nicheScopedRows`, which stops at ownership and feeds
 * "Performance by content type". The second deliberately ignores the type
 * filter, because a table whose job is to rank the types against each other
 * would collapse to a single row if it applied the selection made among its
 * own rows.
 *
 * That makes `scopedRows.length === 0` a statement about a DIFFERENT question
 * than "is there a breakdown to show", and a draft of the reorder used it as
 * though the two were equivalent. They diverge on one reachable input and the
 * tests below are that input: a type nobody claims empties the channel list
 * while leaving a full, correct breakdown behind it.
 */
describe("the empty channel list does not mean the breakdown is empty", () => {
  const RANKING = "ct-ranking";
  const TAGGED_ROWS: TestRow[] = [
    makeRow({ id: "a", niches: [GTA], views: [100, 100], contentTypeIds: [RANKING] }),
    makeRow({ id: "b", niches: [GTA], views: [100], contentTypeIds: [RANKING] }),
  ];

  it("empties the channel scope while the breakdown scope stays full", () => {
    // Every channel is tagged, so "Unassigned" matches none of them.
    const scopedRows = filterRowsByScope(TAGGED_ROWS, "all", "all", "unassigned");
    const nicheScopedRows = filterRowsByScope(TAGGED_ROWS, "all", "all");

    expect(scopedRows).toHaveLength(0);
    // The set the content-type table is built from. Gating that table on the
    // emptiness of the set above would have deleted these two channels'
    // figures from the screen at the one moment they were all that was left.
    expect(nicheScopedRows).toHaveLength(2);
  });

  it("collapses both only when the narrowing is one the breakdown shares", () => {
    // Niche and ownership ARE applied to both, so an empty channel scope from
    // either of them really does mean an empty breakdown — which is why the
    // empty card and the table's own empty state read as one statement there.
    expect(filterRowsByScope(TAGGED_ROWS, RDR.id, "all", "all")).toHaveLength(0);
    expect(filterRowsByScope(TAGGED_ROWS, RDR.id, "all")).toHaveLength(0);
    expect(filterRowsByScope(TAGGED_ROWS, "all", "own", "all")).toHaveLength(0);
    expect(filterRowsByScope(TAGGED_ROWS, "all", "own")).toHaveLength(0);
  });
});

/**
 * And the gate itself, read off the page.
 *
 * The property above is about two pure functions; this is about the one line of
 * JSX that has to respect it. There is no DOM in this runner, so the render
 * cannot be exercised — but the mistake was not a subtle rendering bug, it was
 * a condition naming the wrong variable, and that is visible in the source.
 */
describe("the Overview's content-type table", () => {
  const page = readFileSync(
    fileURLToPath(new URL("../../app/(app)/page.tsx", import.meta.url)),
    "utf8",
  );

  // The condition between the brace that opens the JSX expression and the
  // component itself. `[^{}]*` is what confines it to the gate: the prose block
  // above ends in `*/}`, so the match cannot start any earlier than that.
  const gate =
    page.match(/\{([^{}]*)\?\s*\(\s*<ContentTypePerformanceTable/)?.[1] ?? "";

  it("is rendered under a gate that exists", () => {
    expect(gate).not.toBe("");
  });

  /**
   * `scopeIsEmpty` is measured over the content-type-filtered rows; this table
   * is not. Gating on it hides a populated breakdown whenever somebody picks a
   * type no channel claims.
   */
  it("is not gated on a scope it does not share", () => {
    expect(gate).not.toContain("scopeIsEmpty");
  });

  /** Last on the page, at the owner's request — below the channel table. */
  it("renders below the channel table", () => {
    expect(page.indexOf("<ChannelTable")).toBeLessThan(
      page.indexOf("<ContentTypePerformanceTable"),
    );
  });
});
