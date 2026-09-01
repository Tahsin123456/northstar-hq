import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { calculateChannelMetrics } from "../channel-metrics";
import { EVIDENCE_LIMITED_MIN_UPPER_BOUND } from "../constants";
import { mayShowHitCount, resolveHitDisplayState } from "../hit-display";
import { calculateHitRate, tallyContributions, tallyShorts } from "../hit-rate";
import type { DateRange } from "../types";
import {
  DAY_MS,
  daysAgo,
  makeHit,
  makeMiss,
  makePending,
  makeShort,
  makeShortsWithHits,
  makeUnknown,
  makeUnscoreable,
} from "./factories";

/**
 * =========================================================================
 * "0 HITS" WHEN THE TRUTH IS "NOTHING HERE COULD BE JUDGED"
 * =========================================================================
 *
 * The bug this file exists for, in the owner's words: a channel with several
 * Shorts far past its niche's bar showed 0 hits over a 30-day window. Nothing
 * had failed — every niche on the account has a threshold and no hit window,
 * which is half a rule, so no verdict could ever be written and the app had
 * never asked the question. A zero asserts an answer. The absence of an answer
 * is a different fact and has to look different.
 *
 * The second half is the trap: setting the missing windows, which is the
 * obvious fix, makes it WORSE. `evaluateHit` can infer a miss from a lifetime
 * total but can only ever OBSERVE a hit, so a library with no snapshot history
 * produces misses and nothing else — a confident "0.0% over 6 decided" where
 * five of the excluded Shorts were the owner's actual hits. That is worse than
 * a blank, because it looks like a measurement.
 *
 * These tests pin both, and — just as important — pin the case that must NOT be
 * softened: a channel that really was judged and really did miss every time
 * still reads zero.
 */

const NOW = Date.UTC(2026, 5, 1);
const range = (days: number): DateRange => ({
  startMs: NOW - days * DAY_MS,
  endMs: NOW,
});
const BAR = 1_000_000;

// ---------------------------------------------------------------------------
// THE CHANNEL WHOSE SHORTS CANNOT BE JUDGED
// ---------------------------------------------------------------------------

describe("a channel with nothing scoreable does not read as zero", () => {
  it("reports a null rate and the 'not configured' state, not 0%", () => {
    // dimfected, as the account actually holds it: fourteen Shorts in the last
    // thirty days, several of them enormous, in a niche whose rule is half
    // written. Views deliberately far past the bar — under the old lifetime
    // rule every one of these would have counted as a hit.
    const videos = [
      makeUnscoreable({ views: 14_749_002, publishedAt: daysAgo(26, NOW) }),
      makeUnscoreable({ views: 14_309_924, publishedAt: daysAgo(19, NOW) }),
      makeUnscoreable({ views: 2_199_920, publishedAt: daysAgo(32 - 10, NOW) }),
      makeUnscoreable({ views: 1_224_215, publishedAt: daysAgo(23, NOW) }),
      makeUnscoreable({ views: 1_156_246, publishedAt: daysAgo(16, NOW) }),
      makeUnscoreable({ views: 322_065, publishedAt: daysAgo(24, NOW) }),
    ];

    const metrics = calculateChannelMetrics({ videos, range: range(30), threshold: BAR });

    expect(metrics.totalShorts).toBe(6);
    // The engine's contract: null, never 0, when nothing was judged.
    expect(metrics.hits.rate).toBeNull();
    expect(metrics.hits.judged).toBe(0);
    expect(metrics.hits.excluded).toBe(6);
    expect(metrics.hits.evidenceLimited).toBe(false);

    // And the state every surface keys off says WHY, so no screen has to guess.
    expect(resolveHitDisplayState(metrics.hits, metrics.totalShorts)).toBe(
      "notConfigured",
    );
    // The count is 0 and is not a fact about this channel, so no surface may
    // print it. This is the literal "Shorts that hit: 0" from the bug report.
    expect(mayShowHitCount(resolveHitDisplayState(metrics.hits, metrics.totalShorts))).toBe(
      false,
    );
  });

  it("distinguishes 'no rule' from 'a rule with nothing decided yet'", () => {
    // Same absence of a rate, completely different message: one sends an admin
    // to the niche editor, the other says come back on Thursday.
    const noRule = calculateHitRate(tallyShorts([makeUnscoreable(), makeUnscoreable()]));
    const notYet = calculateHitRate(tallyShorts([makePending(), makePending()]));

    expect(noRule.rate).toBeNull();
    expect(notYet.rate).toBeNull();
    expect(resolveHitDisplayState(noRule, 2)).toBe("notConfigured");
    expect(resolveHitDisplayState(notYet, 2)).toBe("nothingDecided");
  });

  it("reads an empty period as 'no Shorts', not as a failure", () => {
    const metrics = calculateChannelMetrics({ videos: [], range: range(30), threshold: BAR });
    expect(metrics.totalShorts).toBe(0);
    expect(resolveHitDisplayState(metrics.hits, metrics.totalShorts)).toBe("noShorts");
    expect(mayShowHitCount("noShorts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE CHANNEL THAT GENUINELY SCORED ZERO
// ---------------------------------------------------------------------------

describe("a genuine zero still reads as zero", () => {
  it("prints a real 0% for Shorts that were judged and all missed", () => {
    // Twelve Shorts, every one judged, every one short of the bar inside its
    // window. This channel HAS a hit rate and it is zero. Nothing in this
    // change may soften that — the whole point of the product is being able to
    // say so.
    const videos = Array.from({ length: 12 }, (_, i) =>
      makeMiss({ views: 40_000 + i, publishedAt: daysAgo(10, NOW) }),
    );
    const metrics = calculateChannelMetrics({ videos, range: range(30), threshold: BAR });

    expect(metrics.hits.rate).toBe(0);
    expect(metrics.hits.judged).toBe(12);
    expect(metrics.hits.evidenceLimited).toBe(false);
    expect(resolveHitDisplayState(metrics.hits, metrics.totalShorts)).toBe("measured");
    // The count IS meaningful here: zero of twelve decided.
    expect(mayShowHitCount("measured")).toBe(true);
  });

  it("keeps a real zero when a single unrecorded Short cannot change the answer", () => {
    // A hundred fair misses and one Short nobody watched. Upper bound is under
    // 1%, so the zero stands: one unrecorded winner out of a hundred and one is
    // not what is holding this rate down.
    const tally = tallyContributions([
      ...Array.from({ length: 100 }, () => "miss" as const),
      "unknown" as const,
    ]);
    const summary = calculateHitRate(tally);

    expect(summary.rate).toBe(0);
    expect(summary.upperBound).toBeLessThan(EVIDENCE_LIMITED_MIN_UPPER_BOUND);
    expect(summary.evidenceLimited).toBe(false);
    expect(resolveHitDisplayState(summary, 101)).toBe("measured");
  });
});

// ---------------------------------------------------------------------------
// THE STATE THAT APPEARS THE DAY SOMEBODY SETS THE MISSING WINDOWS
// ---------------------------------------------------------------------------

describe("a zero pinned by the evidence is not a measurement", () => {
  it("flags the exact shape the real channel produces once a window is set", () => {
    // Replayed from the real rows: under a 500K / 7-day rule dimfected returns
    // 0 hits, 6 misses, 2 pending and 5 unknown — and the 5 unknowns are the
    // Shorts the owner is calling hits. `rate` is arithmetically 0 over 6
    // decided, and printing that would be a lie with a decimal point in it.
    const videos = [
      ...Array.from({ length: 6 }, () => makeMiss({ publishedAt: daysAgo(20, NOW) })),
      ...Array.from({ length: 2 }, () => makePending({ publishedAt: daysAgo(3, NOW) })),
      makeUnknown({ views: 1_156_246, publishedAt: daysAgo(16, NOW) }),
      makeUnknown({ views: 14_309_924, publishedAt: daysAgo(19, NOW) }),
      makeUnknown({ views: 1_224_215, publishedAt: daysAgo(23, NOW) }),
      makeUnknown({ views: 14_749_002, publishedAt: daysAgo(26, NOW) }),
      makeUnknown({ views: 2_199_920, publishedAt: daysAgo(29, NOW) }),
    ];

    const metrics = calculateChannelMetrics({ videos, range: range(30), threshold: BAR });

    expect(metrics.hits.judged).toBe(6);
    expect(metrics.hits.rate).toBe(0);
    expect(metrics.hits.tally.unknown).toBe(5);
    // 0/11 to 5/11: the truth is somewhere in there and nowhere near a point.
    expect(metrics.hits.lowerBound).toBe(0);
    // `ratePercent` rounds to two decimals; 5/11 is 45.45%.
    expect(metrics.hits.upperBound).toBe(45.45);

    expect(metrics.hits.evidenceLimited).toBe(true);
    expect(resolveHitDisplayState(metrics.hits, metrics.totalShorts)).toBe(
      "evidenceLimited",
    );
    // The count of OBSERVED hits is not the count of hits, so it stays unprinted
    // even though it is literally accurate.
    expect(mayShowHitCount("evidenceLimited")).toBe(false);
  });

  it("does not flag a rate that has any observed hit at all", () => {
    // One hit among the unknowns proves somebody was recording when it
    // mattered. The rate is low, not unmeasurable, and the screen should say a
    // number.
    const summary = calculateHitRate(
      tallyContributions([
        "hit",
        ...Array.from({ length: 5 }, () => "miss" as const),
        ...Array.from({ length: 5 }, () => "unknown" as const),
      ]),
    );

    expect(summary.hits).toBe(1);
    expect(summary.evidenceLimited).toBe(false);
    expect(resolveHitDisplayState(summary, 11)).toBe("measured");
  });

  it("does not flag an unmeasured population — that is a different state", () => {
    // No verdicts at all. `judged === 0`, so there is no zero to defend; the
    // reader is sent to the niche editor instead of to a range.
    const summary = calculateHitRate(tallyShorts([makeUnscoreable(), makeUnscoreable()]));
    expect(summary.evidenceLimited).toBe(false);
  });

  it("does not flag a clean measurement with no unknowns", () => {
    const summary = calculateHitRate(
      tallyContributions(Array.from({ length: 8 }, () => "miss" as const)),
    );
    expect(summary.tally.unknown).toBe(0);
    expect(summary.rate).toBe(0);
    expect(summary.evidenceLimited).toBe(false);
  });

  it("leaves a healthy rate alone", () => {
    const videos = makeShortsWithHits(40, 12, BAR, daysAgo(10, NOW));
    const metrics = calculateChannelMetrics({ videos, range: range(30), threshold: BAR });
    expect(metrics.hits.rate).toBe(30);
    expect(metrics.hits.evidenceLimited).toBe(false);
    expect(resolveHitDisplayState(metrics.hits, metrics.totalShorts)).toBe("measured");
  });

  it("puts the boundary exactly where the constant says", () => {
    // Nineteen misses and one unknown: upper bound 5.0%, which is the floor —
    // inclusive, so this is the first shape that counts as evidence-limited.
    const atFloor = calculateHitRate(
      tallyContributions([
        ...Array.from({ length: 19 }, () => "miss" as const),
        "unknown" as const,
      ]),
    );
    expect(atFloor.upperBound).toBe(EVIDENCE_LIMITED_MIN_UPPER_BOUND);
    expect(atFloor.evidenceLimited).toBe(true);

    // Twenty misses and one unknown: 4.76%, under the floor. A real zero.
    const belowFloor = calculateHitRate(
      tallyContributions([
        ...Array.from({ length: 20 }, () => "miss" as const),
        "unknown" as const,
      ]),
    );
    expect(belowFloor.upperBound).toBeLessThan(EVIDENCE_LIMITED_MIN_UPPER_BOUND);
    expect(belowFloor.evidenceLimited).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE STATES ARE EXHAUSTIVE AND MUTUALLY EXCLUSIVE
// ---------------------------------------------------------------------------

describe("resolveHitDisplayState", () => {
  it("returns exactly one state for every shape a summary can take", () => {
    const cases: ReadonlyArray<readonly [string, number, string]> = [
      ["no shorts", 0, "noShorts"],
      ["unscoreable", 3, "notConfigured"],
      ["pending", 3, "nothingDecided"],
      ["measured", 3, "measured"],
    ];

    const summaries: Record<string, ReturnType<typeof calculateHitRate>> = {
      "no shorts": calculateHitRate(tallyShorts([])),
      unscoreable: calculateHitRate(
        tallyShorts([makeUnscoreable(), makeUnscoreable(), makeUnscoreable()]),
      ),
      pending: calculateHitRate(
        tallyShorts([makePending(), makePending(), makePending()]),
      ),
      measured: calculateHitRate(tallyShorts([makeHit(), makeMiss(), makeMiss()])),
    };

    for (const [name, totalShorts, expected] of cases) {
      expect(resolveHitDisplayState(summaries[name], totalShorts)).toBe(expected);
    }
  });

  it("only ever allows the count in the measured state", () => {
    expect(mayShowHitCount("measured")).toBe(true);
    for (const state of [
      "noShorts",
      "notConfigured",
      "nothingDecided",
      "evidenceLimited",
    ] as const) {
      expect(mayShowHitCount(state)).toBe(false);
    }
  });

  it("ignores Shorts outside the period when deciding there is nothing to say", () => {
    // A Short published before the window does not make the window scoreable.
    const videos = [makeShort({ publishedAt: daysAgo(200, NOW), views: 5_000_000 })];
    const metrics = calculateChannelMetrics({ videos, range: range(30), threshold: BAR });
    expect(metrics.totalShorts).toBe(0);
    expect(resolveHitDisplayState(metrics.hits, metrics.totalShorts)).toBe("noShorts");
  });
});

// ---------------------------------------------------------------------------
// THE SURFACES ARE ACTUALLY WIRED TO IT
// ---------------------------------------------------------------------------

/**
 * The engine was already honest — `calculateHitRate` has returned `null` rather
 * than `0` for an empty denominator since the clock arrived, and says so in a
 * comment. The bug was entirely in the screens: three of them read `.hits`, a
 * plain non-nullable number, instead of `.rate`. A pure-logic test cannot see
 * that, and this repository's runner has no DOM, so the guard is on the source.
 */
const readSource = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), "utf8");

describe("the screens read the state rather than re-deriving it", () => {
  it("the channel KPI card no longer prints the hit count unconditionally", () => {
    const source = readSource("components/channel/kpi-cards.tsx");
    // The exact expression that produced "Shorts that hit: 0" beside a headline
    // reading "Hit rate: Not configured".
    expect(source).not.toContain("value={formatNumber(hits.hits)}");
    expect(source).toContain("resolveHitDisplayState");
  });

  it("the shared hit-rate component resolves the state from one place", () => {
    const source = readSource("components/metrics/hit-rate-value.tsx");
    expect(source).toContain("resolveHitDisplayState");
    // The private copy of the predicate is gone, so it cannot drift again.
    expect(source).not.toMatch(/const nothingScoreable =\s*\n?\s*hasShorts/);
  });

  it("the chart tooltip no longer prints a fraction over an empty denominator", () => {
    const source = readSource("components/charts/hit-rate-chart.tsx");
    expect(source).toContain("point.hits.judged === 0");
    expect(source).toContain("point.hits.evidenceLimited");
  });

  it("the Overview banner is gated on nothing being scoreable, not on the threshold", () => {
    // It used to render only when `threshold === null` — the threshold half of
    // the rule — so on an account where every niche has a threshold and no
    // window it never appeared, while the page header above it already said the
    // rule was unconfigured. The screen contradicted itself.
    const source = readSource("app/(app)/page.tsx");
    expect(source).toContain("nothingScoreableInScope");
    expect(source).not.toMatch(/\{threshold === null \? \(\s*\n\s*<HitRuleNotConfiguredNotice/);
    // And the niche it offers to fix counts a missing window as unconfigured.
    expect(source).toContain("n.hitWindowHours === null");
  });
});
