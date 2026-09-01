import { describe, expect, it } from "vitest";
import {
  DEFAULT_NICHE_FORMAT,
  NICHE_FORMATS,
  isNicheFormat,
  isVideoOfFormat,
  toNicheFormat,
  type NicheFormat,
} from "../niche-format";

/**
 * The format rule is one line of code with the whole Long Form measurement
 * story riding on it, so the whole truth table is pinned rather than sampled.
 * The case that matters most is the one that never changes a passing test by
 * accident: an UNCERTAIN video belongs to NEITHER format, because
 * `isShort: false` conflates long-form with "the classifier could not tell",
 * and only `classification` separates them.
 */

describe("isVideoOfFormat — the full format × classification matrix", () => {
  /**
   * Every classifier outcome the pipeline can produce, with the `isShort`
   * value the classifier pairs it with — `isShort` is only ever true when
   * classification === "short".
   */
  const VIDEOS = {
    short: { isShort: true, classification: "short" },
    notShort: { isShort: false, classification: "not_short" },
    uncertain: { isShort: false, classification: "uncertain" },
  } as const;

  /** The entire rule, as data. Rows: video kind; columns: format asked about. */
  const EXPECTED: ReadonlyArray<
    [keyof typeof VIDEOS, NicheFormat, boolean]
  > = [
    ["short", "shorts", true],
    ["short", "longform", false],
    ["notShort", "shorts", false],
    ["notShort", "longform", true],
    // The load-bearing row pair: uncertain matches NEITHER format. A longform
    // rule written as `!isShort` would flip the last row to true and quietly
    // pour every unclassifiable video into Long Form analytics.
    ["uncertain", "shorts", false],
    ["uncertain", "longform", false],
  ];

  it.each(EXPECTED)("%s asked about %s → %s", (kind, format, expected) => {
    expect(isVideoOfFormat(VIDEOS[kind], format)).toBe(expected);
  });

  it("keeps an uncertain video out of BOTH formats — the sum may be smaller than the library", () => {
    const uncertain = VIDEOS.uncertain;
    const matchedAnywhere = NICHE_FORMATS.some((format) => isVideoOfFormat(uncertain, format));
    expect(matchedAnywhere).toBe(false);
  });

  it("decides shorts from the boolean, not from classification alone", () => {
    // A row that claims "short" while `isShort` is false is a row the
    // classifier never writes — but if one appears, the conservative column
    // wins: no positive identification, no Shorts membership.
    expect(isVideoOfFormat({ isShort: false, classification: "short" }, "shorts")).toBe(false);
  });
});

describe("toNicheFormat — fail closed", () => {
  it("narrows the two stored values", () => {
    expect(toNicheFormat("shorts")).toBe("shorts");
    expect(toNicheFormat("longform")).toBe("longform");
  });

  it("reads anything unrecognised as shorts — the list the team actually looks at", () => {
    // A typo, a hand-edited row, a value from a future release: none of them
    // may move a niche into a Long Form list nobody opens yet.
    for (const stored of ["", "Shorts", "LONGFORM", "long", "video", null, undefined]) {
      expect(toNicheFormat(stored)).toBe("shorts");
    }
  });
});

describe("the catalogue constants", () => {
  it("offers shorts first and defaults to it, matching the column default", () => {
    expect(NICHE_FORMATS).toEqual(["shorts", "longform"]);
    expect(DEFAULT_NICHE_FORMAT).toBe("shorts");
  });

  it("isNicheFormat recognises exactly the two formats", () => {
    expect(isNicheFormat("shorts")).toBe(true);
    expect(isNicheFormat("longform")).toBe(true);
    expect(isNicheFormat("longs")).toBe(false);
    expect(isNicheFormat("")).toBe(false);
    expect(isNicheFormat(undefined)).toBe(false);
  });
});
