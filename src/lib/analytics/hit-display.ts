import type { HitRateSummary } from "./hit-rate";

/**
 * =========================================================================
 * WHICH OF THE FIVE THINGS A HIT RATE IS SAYING
 * =========================================================================
 *
 * ONE PLACE, BECAUSE THE DUPLICATION IS WHAT CAUSED THE BUG. `HitRateValue`,
 * the channel-page KPI cards, the Overview summary strip and the Overview
 * banner each derived "is anything scoreable here?" from the same three fields
 * with their own copy of the predicate. They drifted, and the drift was
 * visible: one card group printed "Hit rate: Not configured" beside "Shorts
 * that hit: 0" — the same object, read two ways, contradicting itself in a
 * space of four inches. The count was outside the guard that protected the
 * rate, and nothing in the type system said it should be inside.
 *
 * The five states are exhaustive and ordered from most specific to least, so a
 * caller resolves exactly one and never has to reason about overlap:
 *
 *   "noShorts"        nothing was published in this period. There is no
 *                     question to answer, let alone a failure to report.
 *   "notConfigured"   Shorts exist and no rule reached any of them — the niche
 *                     is missing a threshold, a window, or both. An admin has a
 *                     decision to make; nothing is broken.
 *   "nothingDecided"  a rule exists and no verdict has landed yet. Every Short
 *                     is still inside its window or was published with nobody
 *                     recording. A wait, not a gap.
 *   "evidenceLimited" verdicts exist, none of them is a hit, and Shorts that
 *                     DID pass the bar unwatched make the zero an artefact of
 *                     the evidence rather than of the work. See
 *                     `HitRateSummary.evidenceLimited`.
 *   "measured"        a real rate over a real denominator — INCLUDING a true
 *                     0%, which must keep rendering as 0.0%. A channel that
 *                     published forty Shorts and missed with all forty has
 *                     earned that number and the screen must not soften it.
 *
 * PURE, so the states can be tested without a DOM. Every surface that renders a
 * hit rate or a hit count calls this rather than re-deriving it.
 */
export type HitDisplayState =
  | "noShorts"
  | "notConfigured"
  | "nothingDecided"
  | "evidenceLimited"
  | "measured";

export function resolveHitDisplayState(
  summary: HitRateSummary,
  totalShorts: number,
): HitDisplayState {
  if (totalShorts <= 0) return "noShorts";

  const { judged, tally } = summary;

  if (judged === 0) {
    // Nothing judged AND nothing waiting to be judged means no rule ever
    // reached these Shorts. If something is pending or unrecorded there IS a
    // rule — it simply has not produced an answer yet, which sends the reader
    // somewhere completely different.
    return tally.pending === 0 && tally.unknown === 0
      ? "notConfigured"
      : "nothingDecided";
  }

  if (summary.evidenceLimited) return "evidenceLimited";

  return "measured";
}

/**
 * Whether a surface may print the raw hit COUNT as a value.
 *
 * The rule this enforces: `HitRateSummary.hits` is a plain `number` and is `0`
 * in three of the five states above, where it means "we could not ask" rather
 * than "we asked and the answer was none". A count is only meaningful beside a
 * denominator that exists, and in the evidence-limited state it is not the
 * count of hits — it is the count of hits somebody happened to observe, which
 * is a different and much smaller quantity.
 *
 * "Shorts that hit: 0" is the exact sentence that produced the bug report this
 * module was written for.
 */
export function mayShowHitCount(state: HitDisplayState): boolean {
  return state === "measured";
}

/**
 * The rate, or `null` where the rate is arithmetic rather than measurement.
 *
 * THE COMPANION TO `mayShowHitCount`, FOR EVERY CONSUMER THAT IS NOT A LABEL.
 * `HitRateSummary.rate` deliberately stays `0` in the evidence-limited state so
 * that the arithmetic remains available to whoever genuinely needs it — but
 * almost nobody does. A chart plots it, a comparator ranks it, a mean averages
 * it, a PDF prints it, and every one of those uses is the same fabrication the
 * label surfaces already refuse: a zero standing in for "we could not ask".
 *
 * Each of those consumers had its own `evidenceLimited ? null : rate`, or —
 * worse — did not have one. `sortRows` had it, `calculatePortfolioSummary` did
 * not, so Overview's headline averaged in a zero from the same object whose row
 * in the table below read "0%–20%". This is that expression, once.
 *
 * `null` is already the "no measurement" value in all four places, and all four
 * already render it correctly: a gap in the line, a parked row, a skipped
 * entry, an em dash.
 */
export function measuredRate(summary: HitRateSummary): number | null {
  return summary.evidenceLimited ? null : summary.rate;
}
