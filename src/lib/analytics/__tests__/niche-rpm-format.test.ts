import { describe, expect, it } from "vitest";
import {
  MAX_RPM_MAJOR_PER_THOUSAND,
  NICHE_NO_VIEWS_GAINED,
  RPM_IMPLAUSIBLE_MAJOR_PER_THOUSAND,
  RPM_IMPLAUSIBLE_MAJOR_PER_THOUSAND_LONGFORM,
  TRACKED_NICHE_VALUE_DEFINITION,
  calculateNicheValue,
  manualRpmBasis,
  rpmBounds,
  rpmImplausibleMajorPerThousand,
  trackedNicheValueDefinition,
  type NicheRpmResolution,
} from "@/lib/analytics/niche-rpm";

/**
 * =========================================================================
 * HOW A HAND-ENTERED RATE IS READ, PER FORMAT
 * =========================================================================
 *
 * A Shorts RPM is quoted per 1,000 ENGAGED views and the engine applies the
 * engaged-view share before pricing. A long-form RPM is quoted per 1,000
 * plain views everywhere anybody would copy one from, and NO share applies.
 * Confusing the two is the exact factor-of-two error `RpmBasis` exists to
 * make unwritable — so this file pins the factor itself: at the owner's 50%
 * share, pricing a longform niche on the Shorts basis would halve every Long
 * Form money figure, and the assertion below is that the raw basis pays
 * exactly 2x what the wrong basis would.
 *
 * The derived branch is pinned unchanged in both formats: a measured rate's
 * numerator is money YouTube actually paid, already net of Google's own
 * engaged accounting, so it is per raw view whatever the format.
 */

/** A hand-entered $3–$6 per 1,000 (3,000–6,000 minor per million views). */
const MANUAL: NicheRpmResolution = {
  source: "manual",
  range: {
    lowMinorPerMillion: 3_000,
    highMinorPerMillion: 6_000,
    currency: "USD",
  },
} as NicheRpmResolution;

/** The owner's stated engaged share: 50%. */
const HALF = 5_000;

describe("rpmBounds' manual basis is the format's own", () => {
  it("keeps shorts on the engaged basis — with and without the argument", () => {
    // No format argument: every pre-deploy call site, byte-identical.
    expect(rpmBounds(MANUAL)).toMatchObject({ basis: "engaged" });
    expect(rpmBounds(MANUAL, "shorts")).toMatchObject({ basis: "engaged" });
  });

  it("reads a longform manual range per plain 1,000 views", () => {
    expect(rpmBounds(MANUAL, "longform")).toMatchObject({
      basis: "raw",
      lowMinorPerMillion: 3_000,
      highMinorPerMillion: 6_000,
      currency: "USD",
    });
  });

  it("keeps a derived rate raw whatever the format", () => {
    const derived = {
      source: "derived",
      rpmMinorPerMillion: 4_000,
      currency: "USD",
    } as unknown as NicheRpmResolution;

    expect(rpmBounds(derived, "shorts")).toMatchObject({ basis: "raw" });
    expect(rpmBounds(derived, "longform")).toMatchObject({ basis: "raw" });
  });

  it("is one rule shared with the dialogs — manualRpmBasis", () => {
    expect(manualRpmBasis("shorts")).toBe("engaged");
    expect(manualRpmBasis("longform")).toBe("raw");
  });
});

describe("the exact 2x a wrong basis would introduce", () => {
  const VIEWS = 1_000_000;

  it("prices a longform niche's views in full — never engaged-scaled", () => {
    const value = calculateNicheValue({
      ourViews: VIEWS,
      competitorViews: 0,
      bounds: rpmBounds(MANUAL, "longform"),
      engagedViewShareBasisPoints: HALF,
    });

    // 1,000,000 raw views at $0.03–$0.06 per 1,000: $30–$60, in cents.
    expect(value.pricedViews).toBe(VIEWS);
    expect(value.ourRevenue).toEqual({
      lowMinor: 3_000,
      highMinor: 6_000,
      currency: "USD",
    });
    expect(value.basis).toBe("raw");
  });

  it("pins the halving the engaged basis applies — the mistake, quantified", () => {
    // The same range read on the Shorts basis prices only the engaged half of
    // the views. This is CORRECT for a Shorts niche and would be the silent
    // 2x understatement for a Long Form one.
    const wrongBasis = calculateNicheValue({
      ourViews: VIEWS,
      competitorViews: 0,
      bounds: rpmBounds(MANUAL, "shorts"),
      engagedViewShareBasisPoints: HALF,
    });

    expect(wrongBasis.pricedViews).toBe(VIEWS / 2);
    expect(wrongBasis.ourRevenue).toEqual({
      lowMinor: 1_500,
      highMinor: 3_000,
      currency: "USD",
    });

    const rightBasis = calculateNicheValue({
      ourViews: VIEWS,
      competitorViews: 0,
      bounds: rpmBounds(MANUAL, "longform"),
      engagedViewShareBasisPoints: HALF,
    });

    // The factor itself, asserted as arithmetic rather than prose.
    expect(rightBasis.ourRevenue!.lowMinor).toBe(wrongBasis.ourRevenue!.lowMinor * 2);
    expect(rightBasis.ourRevenue!.highMinor).toBe(wrongBasis.ourRevenue!.highMinor * 2);
  });
});

describe("per-format implausibility warn bounds", () => {
  it("warns shorts at $10 and longform at $50", () => {
    expect(rpmImplausibleMajorPerThousand("shorts")).toBe(10);
    expect(rpmImplausibleMajorPerThousand("longform")).toBe(50);
    // And the constants the lookup reads stay what the dialogs print.
    expect(RPM_IMPLAUSIBLE_MAJOR_PER_THOUSAND).toBe(10);
    expect(RPM_IMPLAUSIBLE_MAJOR_PER_THOUSAND_LONGFORM).toBe(50);
  });

  it("shares the $100 hard cap between the formats", () => {
    // The cap also feeds the server-side schema ceiling; it is deliberately
    // NOT per-format, and this assertion is the tripwire for anybody who
    // splits it without meaning to change a refusal message.
    expect(MAX_RPM_MAJOR_PER_THOUSAND).toBe(100);
  });
});

describe("the pricing-basis COPY tells each format's own truth", () => {
  /*
   * The human version of the 2x above: the Shorts tooltip ends by saying a
   * hand-entered rate applies to ENGAGED views only. Rendered over a Long
   * Form niche — where the arithmetic applies the rate to raw views — that
   * sentence asserts the opposite of the figure beneath it, and an owner who
   * trusts it doubles his entered rate to "compensate". So the definition is
   * selected on the niche's format, and the two variants are pinned to
   * disagree in exactly the load-bearing sentence.
   */
  it("keeps the Shorts definition's engaged-views sentence, byte-identical", () => {
    expect(trackedNicheValueDefinition("shorts")).toBe(TRACKED_NICHE_VALUE_DEFINITION);
    expect(TRACKED_NICHE_VALUE_DEFINITION).toContain(
      "A hand-entered rate is applied to ENGAGED views only",
    );
  });

  it("says no engaged-view share applies on the longform variant", () => {
    const longform = trackedNicheValueDefinition("longform");
    expect(longform).toContain("no engaged-view share applies");
    expect(longform).not.toContain("ENGAGED views only");
    // And the noun is the format's own.
    expect(longform).toContain("long-form views");
  });

  it("uses one empty-period line for both formats — a gain is the same word on both sides", () => {
    // The upload basis needed a per-format noun ("No Shorts in this period" /
    // "No videos…"); a GAIN is a movement of views, so one line serves both
    // and the two products cannot drift apart on the same state.
    expect(NICHE_NO_VIEWS_GAINED).toBe("No views gained in this period");
  });
});
