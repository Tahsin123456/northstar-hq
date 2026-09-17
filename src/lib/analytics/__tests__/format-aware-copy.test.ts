import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_LIMITED_EXPLANATION,
  EVIDENCE_LIMITED_LABEL,
  HIT_RATE_BOUNDS_EXPLANATION,
  HIT_RATE_DEFINITION,
  HIT_RATE_FORMULA,
  HIT_RATE_PENDING_EXPLANATION,
  HIT_RATE_UNKNOWN_EXPLANATION,
  HIT_RATE_UNSCOREABLE_EXPLANATION,
  NOTHING_DECIDED_EXPLANATION,
  NO_VERDICT_YET,
  hitRateCopy,
  staleDataExplanation,
  thresholdLensExplanation,
  uploadViewsTip,
  uploadViewsTipLongform,
} from "@/lib/analytics/constants";
import { trendCaveatFor } from "@/lib/analytics/trends";

/**
 * =========================================================================
 * NO SHARED SURFACE MAY CALL A LONG-FORM VIDEO A SHORT
 * =========================================================================
 *
 * This app is two products over one set of components. A copy constant with
 * "Short" written into it therefore renders, unchanged, on a Long Form screen,
 * where it is simply false — and the owner has reported it twice:
 *
 *   1. A Long Form channel card read "10 Shorts in period" over ten long-form
 *      videos.
 *   2. Hovering a verdict badge under a heading reading "Videos in this
 *      period" produced "the Short has since passed the bar".
 *
 * The second one is why this file exists rather than another one-off pin. The
 * first fix threaded a NOUN through as a prop, which corrected the sentence
 * that was reported and left six neighbouring sentences in the same tooltip
 * untouched — a fix shaped like the bug report instead of like the bug.
 *
 * So there are two guards here, and the second is the one that matters:
 *
 *   • every string in the Long Form set is free of Shorts vocabulary, and
 *   • the components that render them do not import the Shorts-only constants
 *     directly, which is the mechanism by which a new format-blind sentence
 *     gets added without anyone noticing.
 *
 * The Shorts side is pinned byte-for-byte against the shipped constants, so
 * nothing here can quietly reword the product every current user reads.
 */

/** Words that name the Shorts product's unit, in every casing that ships. */
const SHORTS_WORDS = [/\bShorts\b/, /\bShort\b/, /\bshorts\b/, /\ba short\b/];

function namesShorts(text: string): boolean {
  return SHORTS_WORDS.some((pattern) => pattern.test(text));
}

describe("the Long Form hit-rate copy", () => {
  const longform = hitRateCopy("longform");

  it("never calls a long-form video a Short", () => {
    for (const [key, value] of Object.entries(longform)) {
      // `key` is in the message so a failure names the sentence, not just the
      // file — there are ten of them and they read alike.
      expect(namesShorts(value), `${key}: ${value}`).toBe(false);
    }
  });

  it("says video or videos in every sentence that names a unit", () => {
    // The pending sentence is the deliberate exception: it names no unit at
    // all ("Still inside its hit window…"), so it is shared rather than
    // twinned, and a twin would be a second copy waiting to drift.
    expect(longform.pending).toBe(HIT_RATE_PENDING_EXPLANATION);
    expect(namesShorts(longform.pending)).toBe(false);

    for (const key of [
      "definition",
      "formula",
      "nothingDecided",
      "unknown",
      "unscoreable",
      "bounds",
      "evidenceLimitedLabel",
      "evidenceLimited",
      "noVerdictYet",
    ] as const) {
      expect(longform[key], key).toMatch(/\bvideos?\b/);
    }
  });

  /**
   * THE EXACT SENTENCE THE OWNER HOVERED, in the product they hovered it in.
   * Quoted rather than pattern-matched: this is the one whose falseness was
   * visible on screen, and it should fail by name if it ever comes back.
   */
  it("fixes the verdict tooltip the owner reported", () => {
    expect(longform.unknown).toBe(
      "The window closed with no view count recorded inside it, and the video has since passed the bar. It cleared at some point and there is no honest way to say whether that took two days or two years, so it is excluded — and counted, because these are disproportionately the winners and dropping them silently biases every rate downward.",
    );
  });
});

describe("the Shorts hit-rate copy", () => {
  /**
   * Byte-for-byte against the shipped constants. The Long Form product was
   * added to this app, not swapped in: a refactor that corrects the Long Form
   * wording by rewording BOTH is a regression for every current user, and it
   * would otherwise pass every test above.
   */
  it("is exactly the constants that shipped", () => {
    expect(hitRateCopy("shorts")).toEqual({
      definition: HIT_RATE_DEFINITION,
      formula: HIT_RATE_FORMULA,
      nothingDecided: NOTHING_DECIDED_EXPLANATION,
      pending: HIT_RATE_PENDING_EXPLANATION,
      unknown: HIT_RATE_UNKNOWN_EXPLANATION,
      unscoreable: HIT_RATE_UNSCOREABLE_EXPLANATION,
      bounds: HIT_RATE_BOUNDS_EXPLANATION,
      evidenceLimitedLabel: EVIDENCE_LIMITED_LABEL,
      evidenceLimited: EVIDENCE_LIMITED_EXPLANATION,
      noVerdictYet: NO_VERDICT_YET,
    });
  });

  it("still says Shorts, because on the Shorts side that is true", () => {
    expect(hitRateCopy("shorts").unknown).toContain("the Short has since passed the bar");
  });
});

describe("the other shared sentences that name a unit", () => {
  it("adapts the stale-data warning, and defaults to the Shorts wording", () => {
    expect(staleDataExplanation("2 days ago")).toContain("Shorts published since then");
    expect(staleDataExplanation("2 days ago", "shorts")).toContain(
      "Shorts published since then",
    );
    const longform = staleDataExplanation("2 days ago", "longform");
    expect(longform).toContain("Videos published since then");
    expect(namesShorts(longform)).toBe(false);
  });

  it("adapts the threshold lens disclosure", () => {
    expect(thresholdLensExplanation("shorts")).toContain("highlights Shorts");
    const longform = thresholdLensExplanation("longform");
    expect(longform).toContain("highlights videos");
    expect(namesShorts(longform)).toBe(false);
  });

  it("adapts both trend caveats, and defaults to the Shorts wording", () => {
    // `percentagePoints` is the windowed note, anything else the maturation
    // caveat — both of which named Shorts beside Long Form figures.
    for (const unit of ["percentagePoints", "relativePercent"] as const) {
      expect(namesShorts(trendCaveatFor(unit, "longform")), unit).toBe(false);
      expect(namesShorts(trendCaveatFor(unit, "shorts")), unit).toBe(true);
      expect(trendCaveatFor(unit), `${unit} default`).toBe(trendCaveatFor(unit, "shorts"));
    }
  });

  it("adapts the absent views-earned disclosure inside the upload-views tip", () => {
    // Reached only through the tip builders, which is why it survived a sweep
    // of the constants' own call sites.
    expect(uploadViewsTip(30)).toContain("every Short at both ends");
    const longform = uploadViewsTipLongform(30);
    expect(longform).toContain("every video at both ends");
    expect(namesShorts(longform)).toBe(false);
  });
});

/**
 * =========================================================================
 * THE MECHANISM GUARD
 * =========================================================================
 *
 * Every test above checks a string. This one checks the only thing that stops
 * the ELEVENTH string from being added format-blind next month: a shared
 * component must reach its wording through the format, never by importing a
 * Shorts-only constant by name.
 *
 * Source-read because there is no DOM in this runner, the same technique
 * `niche-card-controls.test.ts` uses. A failure here is not "the words are
 * wrong" — it is "this component can now say the wrong words", which is the
 * state the app was in twice.
 */
describe("the components that explain a hit rate", () => {
  /** Shared, mounted under both /channels and /longform/channels. */
  const SHARED = [
    "src/components/metrics/hit-rate-value.tsx",
    "src/components/metrics/hit-outcome-badge.tsx",
    "src/components/channel/kpi-cards.tsx",
    "src/components/dashboard/summary-cards.tsx",
    "src/components/dashboard/data-freshness.tsx",
    "src/components/dashboard/threshold-selector.tsx",
    "src/components/metrics/trend-indicator.tsx",
  ];

  /** The constants that are the Shorts half of a pair. Importing one is the bug. */
  const SHORTS_ONLY = [
    "HIT_RATE_DEFINITION",
    "HIT_RATE_FORMULA",
    "HIT_RATE_UNKNOWN_EXPLANATION",
    "HIT_RATE_UNSCOREABLE_EXPLANATION",
    "HIT_RATE_BOUNDS_EXPLANATION",
    "NOTHING_DECIDED_EXPLANATION",
    "EVIDENCE_LIMITED_LABEL",
    "EVIDENCE_LIMITED_EXPLANATION",
    "THRESHOLD_LENS_EXPLANATION",
    "TREND_MATURATION_CAVEAT",
    "TREND_WINDOWED_NOTE",
  ];

  function source(relativePath: string): string {
    return readFileSync(join(process.cwd(), relativePath), "utf8");
  }

  it("reach their wording through the format, never a Shorts-only constant", () => {
    for (const file of SHARED) {
      const code = source(file);
      for (const constant of SHORTS_ONLY) {
        // `_LONGFORM` twins share the prefix, so the match is anchored on a
        // word boundary to avoid flagging a legitimate twin import.
        const named = new RegExp(`\\b${constant}\\b(?!_LONGFORM)`);
        expect(named.test(code), `${file} imports ${constant}`).toBe(false);
      }
    }
  });

  it("each ask which product they are rendering in", () => {
    // Either from the subtree, or from a `format` the parent already holds.
    for (const file of SHARED) {
      const code = source(file);
      expect(
        code.includes("useDatasetFormat") || code.includes("hitRateCopy(format)"),
        file,
      ).toBe(true);
    }
  });

  /**
   * The noun and the prose now come from ONE lookup. They used to be two
   * mechanisms — a `unitPlural` prop for the noun, module constants for the
   * sentences — which is exactly how the first fix corrected the card and left
   * the tooltip beneath it wrong.
   */
  it("take the unit noun from the same place as the sentences", () => {
    const code = source("src/components/metrics/hit-rate-value.tsx");
    expect(code).toContain('const unitPlural = format === "shorts" ? "Shorts" : "videos"');
    expect(code).not.toContain("unitPlural?:");
  });
});
