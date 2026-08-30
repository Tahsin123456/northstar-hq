/**
 * =========================================================================
 * WHAT KIND OF NICHE THIS IS
 * =========================================================================
 *
 * Two genuinely different jobs were wearing one word.
 *
 *   PRODUCTION — the studio publishes into it. Its numbers are a scorecard, its
 *                hits are paid for, and the team is accountable for them.
 *   WATCHLIST  — the studio watches it. For formats worth stealing, for an
 *                opening nobody is filling, for a competitor's system worth
 *                reading. Nobody is judged on it and nobody is paid for it.
 *
 * THIS IS NOT DECORATION, IT FIXES A MEASUREMENT PROBLEM. A watchlist niche is
 * full of channels nobody at Northstar is trying to be, so pooling them into
 * "our hit rate" produces a number describing work the studio does not do —
 * arithmetic that is correct over a population nobody chose. Splitting the two
 * is what lets "our hit rate" mean ours.
 *
 * IT IS NOT AN EXCLUSION FROM THE PRODUCT. Watchlist niches keep their own
 * analytics — that is the entire point of watching them — and stay fully
 * browsable and filterable. What they are excluded from is the pooled "how are
 * WE doing" figure, and nothing else.
 *
 * A STRING UNION AND A NARROWER, not an enum: the schema's portability contract
 * forbids `enum` blocks, so `Niche.kind` is a `String` column narrowed here and
 * validated with Zod at every boundary — the same treatment `OwnershipType`
 * gets. This module is deliberately free of Prisma, React and DTO imports so
 * that the pure payroll engine, the browser and the server can all read one
 * definition of the word.
 */

export type NicheKind = "production" | "watchlist";

/** Every kind, in the order a chooser should offer them. Production first. */
export const NICHE_KINDS: readonly NicheKind[] = ["production", "watchlist"];

/**
 * The default for a niche nobody has classified.
 *
 * Production, matching the column default, and deliberately the INCLUSIVE
 * answer: a niche defaulting to watchlist would silently drop channels out of
 * the portfolio the moment somebody created one, which is a number moving for
 * a reason nobody chose. Somebody has to opt a niche OUT of the scorecard.
 */
export const DEFAULT_NICHE_KIND: NicheKind = "production";

/**
 * The stored column, narrowed.
 *
 * Anything unrecognised reads as "production", for the same reason the default
 * is: an unreadable value must not quietly remove a niche from the studio's own
 * numbers. Over-counting is visible and arguable; silently under-counting is
 * neither.
 */
export function toNicheKind(stored: string | null | undefined): NicheKind {
  return stored === "watchlist" ? "watchlist" : "production";
}

export function isNicheKind(value: unknown): value is NicheKind {
  return value === "production" || value === "watchlist";
}

/** The owner named these. Use their words on every surface. */
export const NICHE_KIND_LABEL: Record<NicheKind, string> = {
  production: "Production",
  watchlist: "Watchlist",
};

/** The plural, for a group heading over a list of them. */
export const NICHE_KIND_PLURAL: Record<NicheKind, string> = {
  production: "Production niches",
  watchlist: "Watchlist niches",
};

/** One sentence saying what the kind means, for the heading and the dialog. */
export const NICHE_KIND_DESCRIPTION: Record<NicheKind, string> = {
  production:
    "Niches Northstar publishes into. These are the ones the portfolio hit rate is measured over, and the ones a hit bonus is paid from.",
  watchlist:
    "Niches Northstar watches rather than competes in — for formats worth stealing and openings worth taking. They keep their own analytics and are left out of the portfolio hit rate, and no hit in them is paid.",
};

/** The minimum shape anything needs to answer "is this production?". */
export interface NicheKindSource {
  readonly kind: NicheKind;
}

export function isProductionNiche(niche: NicheKindSource): boolean {
  return niche.kind === "production";
}

/**
 * Does this channel belong to the work the studio is accountable for?
 *
 * TRUE UNLESS WATCHLIST IS THE ONLY THING IT IS. A channel filed under GTA and
 * a watchlist niche is still a channel in GTA, so it counts; a channel filed
 * under nothing but watchlist niches is one nobody is trying to be, and that is
 * exactly the population averaging it in was describing wrongly.
 *
 * AN UNFILED CHANNEL COUNTS, and that is a decision rather than an oversight.
 * Filing nothing is not the same act as filing something under a watchlist:
 * dropping uncategorised channels here would quietly shrink the headline every
 * time somebody added a channel before they got round to labelling it, and the
 * Niches page surfaces that backlog on its own terms. The rule is "watchlist is
 * excluded", not "only production is included".
 */
export function isStudioChannel(niches: readonly NicheKindSource[]): boolean {
  if (niches.length === 0) return true;
  return niches.some(isProductionNiche);
}

/**
 * Did the viewer ask about ONE niche, rather than about the studio?
 *
 * THE EXCEPTION TO `isStudioChannel`, and it lives here beside the rule it
 * excepts because it is the same sentence on three surfaces — the Overview's
 * headline, the generated report, and the Our vs Market comparison. Retyped at
 * each of them is how the three quietly stop agreeing, and a PDF that disagrees
 * with the screen it was generated from is the failure the split exists to
 * prevent.
 *
 * "All niches" and "unassigned" are both the studio's own question. The first
 * obviously; the second because filing nothing is not the same act as filing
 * something under a watchlist, so an unfiled channel stays on the scorecard
 * rule. Pick a single niche and the question changes: the viewer is asking
 * about THAT niche, watchlist or not, and answering with silence would be
 * excluding a watchlist niche from the product rather than from the average.
 *
 * The sentinels are spelled out rather than imported from the filter store,
 * because this module is read by the server, the browser and the payroll engine
 * and has to stay free of their dependencies. `null` is the report generator's
 * spelling of "all niches".
 */
export function asksAboutOneNiche(nicheFilter: string | null | undefined): boolean {
  return Boolean(nicheFilter) && nicheFilter !== "all" && nicheFilter !== "unassigned";
}
