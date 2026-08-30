import { describe, expect, it } from "vitest";
import { compareToMarket } from "../market";
import { nicheSelection, scopeMarketComparison } from "../market-scope";
import type { NicheKind } from "@/lib/niches/niche-kind";
import { DAY_MS, daysAgo, makeHit, makeMiss } from "./factories";

/**
 * =========================================================================
 * WHO IS IN "OUR vs MARKET"
 * =========================================================================
 *
 * The screen whose entire job is the comparison was the last aggregate still
 * pooling watchlist niches into it. These pin the two things that has to mean:
 * the portfolio comparison leaves watchlist-only channels out of BOTH pools,
 * and asking about a watchlist niche on purpose still gets an answer — a
 * labelled one, not the studio's scorecard and not silence.
 */

const NOW = Date.UTC(2026, 5, 1);
const range = (days: number) => ({ startMs: NOW - days * DAY_MS, endMs: NOW });

const GTA = { id: "n-gta", kind: "production" as NicheKind };
const MINECRAFT = { id: "n-mc", kind: "watchlist" as NicheKind };
const CATALOGUE = [GTA, MINECRAFT];

/**
 * A tracked channel, reduced to what the scope reads: its niches and who owns
 * it. The videos ride along so the same rows can be handed to `compareToMarket`
 * and the two decisions can be tested where they actually meet.
 */
function row(options: {
  id: string;
  ownershipType?: "own" | "competitor";
  niches?: readonly { id: string; kind: NicheKind }[];
  /** Views per Short. At or above a million is a stored hit, below it a miss. */
  views?: readonly number[];
}) {
  return {
    channel: {
      id: options.id,
      ownershipType: options.ownershipType ?? "competitor",
      niches: options.niches ?? [],
    },
    videos: (options.views ?? []).map((v, i) =>
      v >= 1_000_000
        ? makeHit({ views: v, publishedAt: daysAgo(i + 1, NOW) })
        : makeMiss({ views: v, publishedAt: daysAgo(i + 1, NOW) }),
    ),
  };
}

const pool = (rows: readonly ReturnType<typeof row>[], own: boolean) =>
  rows.filter((r) => (r.channel.ownershipType === "own") === own).map((r) => ({
    videos: r.videos,
  }));

describe("nicheSelection", () => {
  it("reads 'all' and 'unassigned' as the studio's own question", () => {
    expect(nicheSelection("all", CATALOGUE)).toEqual({ mode: "portfolio" });
    // Filing nothing is not the same act as filing something under a watchlist.
    expect(nicheSelection("unassigned", CATALOGUE)).toEqual({ mode: "portfolio" });
    // The report generator's spelling of the same thing.
    expect(nicheSelection(null, CATALOGUE)).toEqual({ mode: "portfolio" });
  });

  it("carries the selected niche's kind", () => {
    expect(nicheSelection("n-gta", CATALOGUE)).toEqual({ mode: "niche", kind: "production" });
    expect(nicheSelection("n-mc", CATALOGUE)).toEqual({ mode: "niche", kind: "watchlist" });
  });

  it("falls back to the portfolio rule for an id the catalogue does not know", () => {
    // A stale link, a deleted niche, or the dataset not having arrived. The safe
    // direction is to describe less rather than to quietly describe work the
    // studio does not do.
    expect(nicheSelection("n-gone", CATALOGUE)).toEqual({ mode: "portfolio" });
    expect(nicheSelection("n-gta", [])).toEqual({ mode: "portfolio" });
  });
});

describe("the portfolio comparison", () => {
  const rows = [
    row({ id: "ours-gta", ownershipType: "own", niches: [GTA], views: [2_000_000, 100_000] }),
    row({ id: "rival-gta", niches: [GTA], views: [100_000, 100_000] }),
    // Watchlist-only, on both sides of the ownership line.
    row({ id: "ours-mc", ownershipType: "own", niches: [MINECRAFT], views: [2_000_000] }),
    row({ id: "rival-mc", niches: [MINECRAFT], views: [2_000_000, 2_000_000] }),
  ];

  it("excludes watchlist-only channels from both pools", () => {
    const scope = scopeMarketComparison(rows, nicheSelection("all", CATALOGUE));

    expect(scope.rows.map((r) => r.channel.id)).toEqual(["ours-gta", "rival-gta"]);
    expect(scope.kind).toBe("studio");
    expect(scope.isScorecard).toBe(true);
    // The count a caption has to state, rather than leave to be noticed.
    expect(scope.watchlistExcluded).toBe(2);
  });

  it("keeps a channel that sits in a watchlist niche AND a production one", () => {
    // The rule is "watchlist is excluded", not "only production is included".
    // A channel filed under GTA and Minecraft is still a channel in GTA.
    const both = row({ id: "ours-both", ownershipType: "own", niches: [GTA, MINECRAFT] });
    const scope = scopeMarketComparison([...rows, both], nicheSelection("all", CATALOGUE));

    expect(scope.rows.map((r) => r.channel.id)).toContain("ours-both");
    expect(scope.watchlistExcluded).toBe(2);
  });

  it("keeps an unfiled channel, which is not the same as one filed as watchlist", () => {
    const unfiled = row({ id: "ours-unfiled", ownershipType: "own", niches: [] });
    const scope = scopeMarketComparison([unfiled], nicheSelection("all", CATALOGUE));

    expect(scope.rows).toHaveLength(1);
    expect(scope.watchlistExcluded).toBe(0);
  });

  /**
   * THE NUMBER THE SPLIT EXISTS TO FIX, at the one screen whose whole job is
   * the comparison.
   */
  it("changes the reported hit rate, and moves both halves at once", () => {
    const selection = nicheSelection("all", CATALOGUE);
    const scoped = scopeMarketComparison(rows, selection).rows;

    const unsplit = compareToMarket(pool(rows, true), pool(rows, false), range(30), 1_000_000);
    const split = compareToMarket(pool(scoped, true), pool(scoped, false), range(30), 1_000_000);

    const hitRate = (c: typeof split) => c.metrics.find((m) => m.key === "hitRate");

    // Unsplit: our Minecraft channel flatters us to 2 of 3, and their Minecraft
    // channel pushes the "market" to 2 of 4 — a hit rate for Northstar built
    // partly out of a niche Northstar does not publish into.
    expect(hitRate(unsplit)?.ours).toBe(66.67);
    expect(hitRate(unsplit)?.market).toBe(50);

    // Split: what the studio actually did, against the field it actually
    // competes with.
    expect(hitRate(split)?.ours).toBe(50);
    expect(hitRate(split)?.market).toBe(0);

    // And BOTH pools shrank. A split that scoped only "ours" would have left
    // the market at 50% and produced a comparison whose two halves came from
    // differently-shaped populations — worse than not splitting at all.
    expect(split.ours.shorts.length).toBeLessThan(unsplit.ours.shorts.length);
    expect(split.market.shorts.length).toBeLessThan(unsplit.market.shorts.length);
  });
});

describe("a watchlist niche selected on purpose", () => {
  const rows = [
    row({ id: "ours-mc", ownershipType: "own", niches: [MINECRAFT], views: [2_000_000, 2_000_000] }),
    row({ id: "rival-mc", niches: [MINECRAFT], views: [2_000_000, 100_000] }),
  ];

  it("answers rather than going silent, and says it is not the scorecard", () => {
    const scope = scopeMarketComparison(rows, nicheSelection("n-mc", CATALOGUE));

    // Every channel in the niche is in the answer — the viewer asked about this
    // niche, and refusing would exclude a watchlist niche from the product
    // rather than from the average.
    expect(scope.rows).toHaveLength(2);
    expect(scope.watchlistExcluded).toBe(0);

    // Labelled, so no surface can render it as the studio's own number.
    expect(scope.kind).toBe("watchlist");
    expect(scope.isScorecard).toBe(false);

    const comparison = compareToMarket(
      pool(scope.rows, true),
      pool(scope.rows, false),
      range(30),
      1_000_000,
    );
    // A real comparison, not an empty one: this is the thing the viewer came for.
    expect(comparison.metrics.find((m) => m.key === "hitRate")?.ours).toBe(100);
    expect(comparison.metrics.find((m) => m.key === "hitRate")?.market).toBe(50);
    expect(comparison.comparableCount).toBeGreaterThan(0);
  });

  it("a production niche is the same whole population, and IS the scorecard", () => {
    const gtaRows = [
      row({ id: "ours-gta", ownershipType: "own", niches: [GTA, MINECRAFT] }),
      row({ id: "rival-gta", niches: [GTA] }),
    ];
    const scope = scopeMarketComparison(gtaRows, nicheSelection("n-gta", CATALOGUE));

    expect(scope.rows).toHaveLength(2);
    expect(scope.kind).toBe("production");
    expect(scope.isScorecard).toBe(true);
    expect(scope.watchlistExcluded).toBe(0);
  });
});
