import {
  asksAboutOneNiche,
  isStudioChannel,
  type NicheKind,
  type NicheKindSource,
} from "../niches/niche-kind";

/**
 * =========================================================================
 * WHICH CHANNELS "OURS vs THE MARKET" IS DRAWN FROM
 * =========================================================================
 *
 * `compareToMarket` is handed two pools and compares them. This module decides
 * what goes in the pools, and it is a separate decision on purpose: the maths
 * next door knows about Shorts and verdicts, not about which niches Northstar
 * publishes into.
 *
 * BOTH SIDES ARE SCOPED BY THE SAME RULE, AND THAT IS THE WHOLE POINT.
 * The tempting alternative — scope "ours" to the studio's work and leave the
 * market pool whole, on the grounds that the market is the market — produces
 * exactly the number this round was spent removing. `market.ts` states the
 * contract the comparison rests on: our channels and the competitors we track
 * sit in the SAME niches, judged by the same bar and the same clock, which is
 * what makes a comparison a comparison. Dropping watchlist-only channels from
 * one half and not the other breaks it in the worst available way — our
 * production output measured against a field that includes niches nobody at
 * Northstar competes in, with the two halves the same shape on screen and
 * different shapes underneath. A hit rate "13 pp below market" would then be
 * partly a statement about how hard Minecraft is, in a niche we do not make
 * Minecraft videos for.
 *
 * So: same predicate, both pools, every time. When a channel is excluded it is
 * excluded from ours AND from theirs, and the screen says how many.
 *
 * THE EXCEPTION IS THE SAME EXCEPTION EVERYWHERE ELSE. Pick one niche and the
 * viewer is asking about that niche — see `asksAboutOneNiche`. "How does our
 * stuff compare inside a niche we only watch" is a legitimate question and the
 * honest answer is to answer it, so the rows are left whole and the SCOPE KIND
 * is handed back for the screen to label with. What must not happen is that
 * answer being dressed as the studio's scorecard.
 *
 * The import from `../niches` is the first this directory has: `niche-kind` is
 * itself pure, dependency-free and isomorphic, so the analytics engine's
 * contract survives it. The alternative was a second definition of "counts
 * toward how we are doing" living in here, which is the one thing the split
 * cannot afford.
 */

/** What population the comparison is over, and therefore how to label it. */
export type MarketScopeKind =
  /** No single niche selected: the studio's own scorecard, watchlist excluded. */
  | "studio"
  /** One production niche. Scorecard work, and every channel in it counts. */
  | "production"
  /** One watchlist niche. A real comparison, and deliberately not the scorecard. */
  | "watchlist";

/** The minimum shape a row needs to be scoped. Deliberately not `ChannelRow`. */
export interface MarketScopeRow {
  readonly channel: { readonly niches: readonly NicheKindSource[] };
}

/**
 * Which niche the viewer picked, reduced to the only thing the scope cares
 * about: whether it is one niche, and if so what kind.
 */
export type NicheSelection =
  | { readonly mode: "portfolio" }
  | { readonly mode: "niche"; readonly kind: NicheKind };

export interface MarketScope<T> {
  readonly kind: MarketScopeKind;
  /**
   * The rows BOTH pools are drawn from.
   *
   * One list, split by ownership afterwards, so the two halves cannot be given
   * different populations by a later edit to one of them.
   */
  readonly rows: readonly T[];
  /** Whether this comparison describes work the studio is accountable for. */
  readonly isScorecard: boolean;
  /**
   * Channels inside the niche filter that the comparison left out.
   *
   * Always 0 when one niche is selected — nothing is excluded there. Otherwise
   * the count of channels sitting only in watchlist niches, which is the number
   * a caption has to say out loud rather than leave to be noticed.
   */
  readonly watchlistExcluded: number;
}

/**
 * The filter value plus the niche catalogue, reduced to a selection.
 *
 * An id the catalogue does not know — a stale link, a niche somebody deleted,
 * or simply the dataset not having arrived yet — reads as "portfolio". That is
 * the safe direction for the same reason `includeWatchlist` defaults to false:
 * a forgotten case should describe less rather than quietly describe work the
 * studio does not do.
 */
export function nicheSelection(
  nicheFilter: string | null | undefined,
  niches: readonly { readonly id: string; readonly kind: NicheKind }[],
): NicheSelection {
  if (!asksAboutOneNiche(nicheFilter)) return { mode: "portfolio" };
  const selected = niches.find((niche) => niche.id === nicheFilter);
  return selected ? { mode: "niche", kind: selected.kind } : { mode: "portfolio" };
}

/**
 * Narrow already-niche-filtered rows to the population the comparison is over.
 *
 * `inNiche` is what the niche filter kept; this decides which of those belong
 * in a "how are we doing against the field" number at all.
 */
export function scopeMarketComparison<T extends MarketScopeRow>(
  inNiche: readonly T[],
  selection: NicheSelection,
): MarketScope<T> {
  if (selection.mode === "niche") {
    return {
      kind: selection.kind === "watchlist" ? "watchlist" : "production",
      // Whole. The viewer asked about this niche, so every channel in it is
      // part of the answer — including, in a watchlist niche, the channels the
      // portfolio rule would have dropped.
      rows: inNiche,
      isScorecard: selection.kind === "production",
      watchlistExcluded: 0,
    };
  }

  const rows = inNiche.filter((row) => isStudioChannel(row.channel.niches));
  return {
    kind: "studio",
    rows,
    isScorecard: true,
    watchlistExcluded: inNiche.length - rows.length,
  };
}
