import type { NicheRpmResolution } from "@/lib/analytics/niche-rpm";

/**
 * =========================================================================
 * WHAT THE RPM DIALOG SENDS — AND WHEN IT SENDS NOTHING AT ALL
 * =========================================================================
 *
 * Pure, no React, no I/O, and it exists for the same reason
 * `niche-rule-patch.ts` does: `updateNiche` writes a column when its key
 * arrives and leaves it alone when it does not, so "which keys are on this
 * request" IS the data-loss question, and that question does not belong three
 * ternaries deep inside a submit handler where nothing can test it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE, UNCHANGED FROM THE HIT RULE: A FIELD THIS FORM WAS NEVER GIVEN A
 * VALUE FOR IS NOT A FIELD IT MAY SUBMIT
 * ─────────────────────────────────────────────────────────────────────────────
 * `NicheDTO.rpm` is `null` for anybody without `finance.view`, whatever the row
 * holds. A form seeded from that null would show two empty boxes and, on save,
 * write the emptiness over a range somebody chose — the exact bug the payment
 * field had.
 *
 * The write gate closes that door from the other side: `assertMayConfigureRpm`
 * requires `finance.view` as well as `settings.manage`, so a person who cannot
 * READ the range cannot WRITE it either, and the withheld-and-editable state is
 * unreachable rather than merely unlikely. This module is the belt to that
 * braces, and it is worth having because the two guards fail differently: the
 * server one is a 403 the user can see and complain about, this one is silence
 * where silence is correct.
 *
 * CLEARING IS EXPLICIT AND IS NOT THE SAME ACT. Emptying both boxes on a range
 * the form was actually shown sends three nulls, which unprices the niche —
 * a deliberate edit with a confirmation sentence beside it, not an accident of
 * a blank field.
 */

/**
 * True when the payload that built this form withheld the stored range.
 *
 * `rpm === null` is the withheld case and the ONLY one: a permitted reader
 * always receives an object, and "nobody has entered anything" is a value of
 * that object — `{ source: "none" }` — rather than an absence. That is what
 * makes this test possible at all.
 */
export function rpmWithheld(rpm: NicheRpmResolution | null): boolean {
  return rpm === null;
}

/** The dialog's state at the moment somebody presses Save. */
export interface NicheRpmDraft {
  /** The resolution the loaded `NicheDTO` carried — what was SHOWN. */
  readonly loadedRpm: NicheRpmResolution | null;
  /** The parsed low end, or `null` when the box is empty. */
  readonly lowMinorPerMillion: number | null;
  /** The parsed high end, or `null` when the box is empty. */
  readonly highMinorPerMillion: number | null;
  /** The currency the two were typed in. */
  readonly currency: string;
}

/** The request body. All three keys, or no request at all. */
export interface NicheRpmPatch {
  readonly rpmLowMinorPerMillion: number | null;
  readonly rpmHighMinorPerMillion: number | null;
  readonly rpmCurrency: string | null;
}

/**
 * The patch to send, or `null` for "send nothing".
 *
 * `null` happens in exactly one situation: the range was withheld from this
 * form and nothing was typed to replace it. Sending three nulls there would
 * destroy a stored range on behalf of somebody who was never shown it.
 *
 * A half-filled pair is passed through as it stands rather than being repaired
 * here. The server refuses it with a sentence naming the missing half, and the
 * dialog refuses it before that — repairing it silently in the middle would
 * mean the user's two boxes and the stored row disagreed about what they had
 * entered.
 */
export function buildNicheRpmPatch(draft: NicheRpmDraft): NicheRpmPatch | null {
  const typedNothing = draft.lowMinorPerMillion === null && draft.highMinorPerMillion === null;

  if (rpmWithheld(draft.loadedRpm) && typedNothing) return null;

  if (typedNothing) {
    // Cleared on purpose. The currency goes with the range: a code with no
    // range attached describes nothing, and the server refuses one anyway.
    return {
      rpmLowMinorPerMillion: null,
      rpmHighMinorPerMillion: null,
      rpmCurrency: null,
    };
  }

  return {
    rpmLowMinorPerMillion: draft.lowMinorPerMillion,
    rpmHighMinorPerMillion: draft.highMinorPerMillion,
    rpmCurrency: draft.currency,
  };
}

/**
 * True when saving this draft leaves the niche with no price at all.
 *
 * Used to say so before the save rather than after it. FALSE where the range
 * was withheld and left alone — whatever is stored is still stored, and warning
 * about a gap this form cannot see would be the same false claim as the bug
 * above, pointing the other way.
 */
export function leavesNicheUnpriced(draft: NicheRpmDraft): boolean {
  const patch = buildNicheRpmPatch(draft);
  return patch !== null && patch.rpmLowMinorPerMillion === null;
}
