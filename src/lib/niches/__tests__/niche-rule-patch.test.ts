import { describe, expect, it } from "vitest";
import {
  buildNicheRulePatch,
  leavesNicheUnpriced,
  paymentRateWithheld,
  type NicheRuleDraft,
} from "@/lib/niches/niche-rule-patch";

/**
 * The hit-rule dialog can destroy a stored rate, and this is where it cannot.
 *
 * `updateNiche` writes a column when its key arrives and leaves it alone when it
 * does not, so the presence of `hitPaymentMinor` on this object IS the data-loss
 * question. Everything below is one shape of it.
 *
 * The bug: `toNicheDTO` withholds a watchlist niche's rate, the form seeded its
 * payment field from that withheld null, and saving after a flip back to
 * production wrote the empty field over a real rate. Three separate comments in
 * that code promised the flip was reversible.
 */

const BASE: NicheRuleDraft = {
  loadedKind: "production",
  kind: "production",
  hitThreshold: 500_000,
  hitWindowHours: 48,
  hitPaymentMinor: 500,
  mayReclassify: true,
};

function draft(over: Partial<NicheRuleDraft> = {}): NicheRuleDraft {
  return { ...BASE, ...over };
}

describe("flipping a watchlist niche back to production", () => {
  it("does not write an empty field over the rate it was never shown", () => {
    // The DTO shipped `hitPaymentMinor: null` because the niche was watchlist,
    // so the box is blank for that reason and not because nothing is set.
    const patch = buildNicheRulePatch(
      draft({ loadedKind: "watchlist", kind: "production", hitPaymentMinor: null }),
    );

    expect("hitPaymentMinor" in patch).toBe(false);
    // The reclassification itself still goes, so the niche does become
    // production — it simply arrives carrying the rate it always had.
    expect(patch.kind).toBe("production");
  });

  it("still sends a rate the admin actually typed", () => {
    // Replacing the hidden number stays possible. What is refused is clearing
    // it by leaving blank a field nobody was shown.
    const patch = buildNicheRulePatch(
      draft({ loadedKind: "watchlist", kind: "production", hitPaymentMinor: 750 }),
    );

    expect(patch.hitPaymentMinor).toBe(750);
    expect(patch.kind).toBe("production");
  });
});

describe("switching a production niche to watchlist", () => {
  it("leaves the stored rate where it is", () => {
    // The other half of "reversible", and the half that already worked: an
    // absent key is not a write.
    const patch = buildNicheRulePatch(draft({ kind: "watchlist", hitPaymentMinor: 500 }));

    expect("hitPaymentMinor" in patch).toBe(false);
    expect(patch.kind).toBe("watchlist");
  });
});

describe("an ordinary production edit", () => {
  it("sends the rate, including an explicit clear", () => {
    expect(buildNicheRulePatch(draft()).hitPaymentMinor).toBe(500);

    // Emptying the box on a niche whose rate WAS loaded is a real instruction:
    // the admin looked at the number and deleted it.
    const cleared = buildNicheRulePatch(draft({ hitPaymentMinor: null }));
    expect("hitPaymentMinor" in cleared).toBe(true);
    expect(cleared.hitPaymentMinor).toBeNull();
  });

  it("always carries both halves of the rule, nulls included", () => {
    const patch = buildNicheRulePatch(draft({ hitThreshold: null, hitWindowHours: null }));
    expect(patch.hitThreshold).toBeNull();
    expect(patch.hitWindowHours).toBeNull();
  });

  it("omits kind when it did not change, or when the caller may not set it", () => {
    expect("kind" in buildNicheRulePatch(draft())).toBe(false);
    // `kind` is `niches.manage`, one permission below the three numbers, so
    // somebody holding only `settings.manage` sends no key rather than a 403.
    expect(
      "kind" in buildNicheRulePatch(draft({ kind: "watchlist", mayReclassify: false })),
    ).toBe(false);
  });
});

describe("what the save toast is allowed to claim", () => {
  it("does not announce a missing payment it was never shown", () => {
    // Whatever is stored is still stored, and this form has never seen it.
    // "Hits here score but earn nothing" would be the original bug pointing the
    // other way — a false alarm instead of a silent overwrite.
    expect(
      leavesNicheUnpriced(
        draft({ loadedKind: "watchlist", kind: "production", hitPaymentMinor: null }),
      ),
    ).toBe(false);
  });

  it("does announce one when the admin genuinely cleared the field", () => {
    expect(leavesNicheUnpriced(draft({ hitPaymentMinor: null }))).toBe(true);
    expect(leavesNicheUnpriced(draft({ hitPaymentMinor: 500 }))).toBe(false);
    // Nothing to be unpriced about: nobody is paid for a watchlist niche.
    expect(leavesNicheUnpriced(draft({ kind: "watchlist", hitPaymentMinor: null }))).toBe(false);
  });
});

describe("which loaded kind withholds a rate", () => {
  it("is watchlist, and only watchlist", () => {
    expect(paymentRateWithheld("watchlist")).toBe(true);
    expect(paymentRateWithheld("production")).toBe(false);
  });
});
