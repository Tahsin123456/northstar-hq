import { describe, expect, it } from "vitest";
import type { NicheRpmResolution } from "@/lib/analytics/niche-rpm";
import {
  buildNicheRpmPatch,
  leavesNicheUnpriced,
  rpmWithheld,
} from "../niche-rpm-patch";

/**
 * What the RPM dialog sends, and the one case where it must send nothing.
 *
 * `updateNiche` writes a column when its key arrives and leaves it alone when
 * it does not, so this pure function is the entire "can saving destroy a stored
 * range?" question. The hit payment learned that lesson expensively: a form
 * seeded from a withheld null wrote that emptiness over a rate an admin chose.
 */

const WINDOW = { startMs: 0, endMs: 1, days: 28 } as const;

/** A payload that showed this form the stored range. */
const SHOWN: NicheRpmResolution = {
  source: "manual",
  range: { lowMinorPerMillion: 3_000, highMinorPerMillion: 6_000, currency: "USD" },
  // Already in the base currency, so the range in force and the range as typed
  // are the same object — the ordinary case.
  enteredRange: { lowMinorPerMillion: 3_000, highMinorPerMillion: 6_000, currency: "USD" },
  rejectedChannels: [],
};

/** A payload that showed a measurement, with the range it is overriding. */
const OVERRIDDEN: NicheRpmResolution = {
  source: "derived",
  rpmMinorPerMillion: 5_600,
  currency: "USD",
  evidence: { window: WINDOW, channels: [], viewsUsed: 1_000_000, revenueMinorUsed: 5_600 },
  supersededRange: {
    lowMinorPerMillion: 3_000,
    highMinorPerMillion: 6_000,
    currency: "USD",
  },
  rejectedChannels: [],
};

describe("what the RPM form submits", () => {
  it("sends all three keys when a range was typed", () => {
    expect(
      buildNicheRpmPatch({
        loadedRpm: SHOWN,
        lowMinorPerMillion: 4_000,
        highMinorPerMillion: 9_000,
        currency: "USD",
      }),
    ).toEqual({
      rpmLowMinorPerMillion: 4_000,
      rpmHighMinorPerMillion: 9_000,
      rpmCurrency: "USD",
    });
  });

  it("clears the range and its currency together when both boxes are emptied", () => {
    // A deliberate edit on a form that was actually shown the value. The
    // currency goes with the range because a code with nothing attached
    // describes nothing.
    const draft = {
      loadedRpm: SHOWN,
      lowMinorPerMillion: null,
      highMinorPerMillion: null,
      currency: "USD",
    };
    expect(buildNicheRpmPatch(draft)).toEqual({
      rpmLowMinorPerMillion: null,
      rpmHighMinorPerMillion: null,
      rpmCurrency: null,
    });
    expect(leavesNicheUnpriced(draft)).toBe(true);
  });

  /**
   * THE BUG THIS MODULE EXISTS FOR.
   *
   * A form built from a payload that withheld the range shows two empty boxes.
   * Submitting those emptinesses would write nulls over a stored range on
   * behalf of somebody who was never shown it. Sending nothing is what "leave
   * it alone" has to mean on an API where an absent key is not a write.
   */
  it("sends nothing at all when the range was withheld and nothing was typed", () => {
    const draft = {
      loadedRpm: null,
      lowMinorPerMillion: null,
      highMinorPerMillion: null,
      currency: "USD",
    };
    expect(rpmWithheld(draft.loadedRpm)).toBe(true);
    expect(buildNicheRpmPatch(draft)).toBeNull();
    // And it does not announce a gap it cannot see: whatever is stored is still
    // stored, so claiming the niche is unpriced would be the same false claim
    // in the opposite direction.
    expect(leavesNicheUnpriced(draft)).toBe(false);
  });

  it("still lets a withheld range be REPLACED by one somebody types", () => {
    expect(
      buildNicheRpmPatch({
        loadedRpm: null,
        lowMinorPerMillion: 1_000,
        highMinorPerMillion: 2_000,
        currency: "USD",
      }),
    ).toEqual({
      rpmLowMinorPerMillion: 1_000,
      rpmHighMinorPerMillion: 2_000,
      rpmCurrency: "USD",
    });
  });

  /**
   * A measurement is not a withheld range.
   *
   * `{ source: "derived" }` carries the range it is overriding, precisely so
   * the form can seed from it. Treating a derived resolution as "withheld"
   * would make the range uneditable the moment an own channel started
   * reporting — and unclearable, which is worse.
   */
  it("treats an overridden range as shown, so it can still be edited or cleared", () => {
    expect(rpmWithheld(OVERRIDDEN)).toBe(false);
    expect(
      buildNicheRpmPatch({
        loadedRpm: OVERRIDDEN,
        lowMinorPerMillion: null,
        highMinorPerMillion: null,
        currency: "USD",
      }),
    ).toEqual({
      rpmLowMinorPerMillion: null,
      rpmHighMinorPerMillion: null,
      rpmCurrency: null,
    });
  });
});
