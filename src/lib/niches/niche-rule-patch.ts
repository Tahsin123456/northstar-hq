/**
 * =========================================================================
 * WHAT THE HIT-RULE DIALOG SENDS — AND WHAT IT LEAVES OFF
 * =========================================================================
 *
 * Pure, no React, no I/O, so the one decision that has already cost a stored
 * rate can be asserted on rather than reasoned about. `updateNiche` writes a
 * column when its key arrives and leaves it alone when it does not, which makes
 * "which keys are on this request" the whole of the data-loss question — and
 * that question was being answered inline in a submit handler, three states
 * deep in a ternary, where nothing could test it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE: A FIELD THIS FORM WAS NEVER GIVEN A VALUE FOR IS NOT A FIELD IT MAY
 * SUBMIT
 * ─────────────────────────────────────────────────────────────────────────────
 * `toNicheDTO` ships `hitPaymentMinor: null` for a watchlist niche whatever the
 * row holds — nobody is paid for a niche the studio only watches, so a rate on
 * the wire could only be rendered beside a bonus that cannot exist. The stored
 * value stays put so reclassifying a niche is reversible.
 *
 * Reversible on the way OUT. The way back was where it broke: the dialog seeded
 * its payment field from that withheld null, so an admin flipping the niche to
 * production saw an empty box and, on save, wrote that emptiness straight over
 * the rate somebody had chosen. Three separate comments in this codebase promise
 * the flip does not destroy the number; this module is where that promise is
 * kept, because the alternative — widening the DTO to carry a watchlist rate —
 * would put a per-hit price for an unpaid niche in front of every employee
 * holding `analytics.view`, which is everyone.
 *
 * A TYPED AMOUNT IS ALWAYS SENT, watchlist-turned-production included, so an
 * admin who wants to REPLACE the hidden rate still can. What they cannot do from
 * here is clear it by leaving blank a field they were never shown — and once the
 * niche is production the rate arrives on the next payload, where clearing it is
 * one deliberate edit away.
 */

import type { NicheKind } from "./niche-kind";

/** True when the DTO this form was built from withheld the stored rate. */
export function paymentRateWithheld(loadedKind: NicheKind): boolean {
  return loadedKind === "watchlist";
}

/** The dialog's state, at the moment somebody presses Save. */
export interface NicheRuleDraft {
  /**
   * The kind the loaded `NicheDTO` carried — what was SHOWN.
   *
   * Distinct from `kind` below, and the distinction is the entire fix. What
   * this form was handed is a fact about the payload that arrived; flipping the
   * toggle does not retroactively fill in a field the server never sent.
   */
  readonly loadedKind: NicheKind;
  /** The kind selected in the dialog — what will APPLY. */
  readonly kind: NicheKind;
  readonly hitThreshold: number | null;
  readonly hitWindowHours: number | null;
  /** The parsed payment field. `null` means the box is empty. */
  readonly hitPaymentMinor: number | null;
  /** True when this person holds `niches.manage` and may reclassify. */
  readonly mayReclassify: boolean;
}

/**
 * The request body. Both optional keys mean "not a write" by their absence.
 */
export interface NicheRulePatch {
  readonly hitThreshold: number | null;
  readonly hitWindowHours: number | null;
  readonly hitPaymentMinor?: number | null;
  readonly kind?: NicheKind;
}

export function buildNicheRulePatch(draft: NicheRuleDraft): NicheRulePatch {
  const watchlist = draft.kind === "watchlist";

  /*
   * Two ways not to send a price.
   *
   *   THE NICHE IS WATCHLIST NOW — an absent key is not a write, so switching a
   *   niche to watchlist leaves the stored rate exactly where it was.
   *
   *   THE FIELD WAS NEVER LOADED AND NOTHING WAS TYPED — the flip back. The box
   *   is empty because the DTO withheld the value, not because nothing is set,
   *   and submitting that emptiness is what wrote the null over a real rate.
   */
  const sendPayment =
    !watchlist && (!paymentRateWithheld(draft.loadedKind) || draft.hitPaymentMinor !== null);

  return {
    hitThreshold: draft.hitThreshold,
    hitWindowHours: draft.hitWindowHours,
    ...(sendPayment ? { hitPaymentMinor: draft.hitPaymentMinor } : {}),
    // Absent unless this person may actually set it, and unless it changed:
    // `kind` is `niches.manage`, one permission below the three numbers, so
    // somebody holding only `settings.manage` sends no key rather than a 403.
    ...(draft.mayReclassify && draft.kind !== draft.loadedKind ? { kind: draft.kind } : {}),
  };
}

/**
 * True when saving this draft leaves the niche able to score a hit and unable
 * to pay for one — the failure that is invisible until a payroll run.
 *
 * FALSE, NOT TRUE, WHERE THE RATE WAS WITHHELD AND LEFT ALONE. Whatever is
 * stored is still stored and this form has never seen it, so announcing a gap
 * would be the same false claim as the bug above, pointing the other way.
 */
export function leavesNicheUnpriced(draft: NicheRuleDraft): boolean {
  const patch = buildNicheRulePatch(draft);
  return "hitPaymentMinor" in patch && patch.hitPaymentMinor === null;
}
