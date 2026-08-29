import { describe, expect, it } from "vitest";
import {
  addTallies,
  annotateAgainstThreshold,
  calculateHitRate,
  clearsThreshold,
  evaluateHit,
  formatHitWindow,
  hitContributionOf,
  isFinalOutcome,
  missingHitRuleHalf,
  pickGoverningRule,
  resolveHitRule,
  tallyContributions,
  tallyShorts,
  windowClosesAt,
  windowRatio,
  type HitRule,
  type WindowObservation,
} from "../hit-rate";
import {
  makeHit,
  makeMiss,
  makePending,
  makeShort,
  makeUnknown,
  makeUnscoreable,
  makeVerdict,
} from "./factories";

/**
 * THE DEFINITION OF A HIT, PINNED.
 *
 * If any of these break, the number the whole business runs on is wrong. They
 * are written as the four outcomes plus the two things that decide between them
 * — the clock and the evidence — because that is how the rule is argued about
 * in the room, and a test file that reads like the argument is one somebody
 * will actually check against when they change it.
 */

const HOUR = 3_600_000;
const PUBLISHED = Date.UTC(2026, 0, 1, 12, 0, 0);
/** The canonical rule: a million views within a week. */
const RULE: HitRule = { threshold: 1_000_000, windowHours: 168 };

/** `hours` after publication, as epoch ms. */
const at = (hours: number): number => PUBLISHED + hours * HOUR;

function verdict(options: {
  rule?: HitRule;
  lifetimeViews: number;
  observations?: readonly WindowObservation[];
  nowHours: number;
}) {
  return evaluateHit({
    publishedAtMs: PUBLISHED,
    rule: options.rule ?? RULE,
    lifetimeViews: options.lifetimeViews,
    observations: options.observations ?? [],
    nowMs: at(options.nowHours),
  });
}

// ---------------------------------------------------------------------------
// HALF A RULE IS NOT A RULE
// ---------------------------------------------------------------------------

describe("a niche needs BOTH numbers before it can score anything", () => {
  it("resolves a rule only when the threshold and the window are both set", () => {
    expect(resolveHitRule({ hitThreshold: 1_000_000, hitWindowHours: 168 })).toEqual(RULE);
  });

  it("scores nothing with a threshold and no window", () => {
    // The exact configuration the old product had for every niche, and the one
    // that reads as "a million views, whenever". There is no window to fall
    // back to, because falling back to lifetime views is what this replaced.
    expect(resolveHitRule({ hitThreshold: 1_000_000, hitWindowHours: null })).toBeNull();
    expect(missingHitRuleHalf({ hitThreshold: 1_000_000, hitWindowHours: null })).toBe(
      "window",
    );
  });

  it("scores nothing with a window and no threshold", () => {
    expect(resolveHitRule({ hitThreshold: null, hitWindowHours: 168 })).toBeNull();
    expect(missingHitRuleHalf({ hitThreshold: null, hitWindowHours: 168 })).toBe("threshold");
  });

  it("names both halves when a niche has neither, so an admin knows where to go", () => {
    expect(missingHitRuleHalf({ hitThreshold: null, hitWindowHours: null })).toBe("both");
    expect(missingHitRuleHalf({ hitThreshold: 500_000, hitWindowHours: 48 })).toBeNull();
  });

  it("treats a stored zero as unset rather than as an instantly-cleared bar", () => {
    // "0 views within 0 hours" would make every Short ever published a hit at
    // the moment of upload, which is the loudest possible way for a typo to
    // reach a payslip.
    expect(resolveHitRule({ hitThreshold: 0, hitWindowHours: 168 })).toBeNull();
    expect(resolveHitRule({ hitThreshold: 1_000_000, hitWindowHours: 0 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE FOUR OUTCOMES
// ---------------------------------------------------------------------------

describe("hit", () => {
  it("is a hit when a reading inside the window was already over the bar", () => {
    // THE HEADLINE CASE: over the bar at hour 2 of a 168-hour window. Views only
    // rise, so a Short past the line on day one is past it on day seven, and the
    // verdict does not need a reading at the close to be certain.
    const result = verdict({
      lifetimeViews: 9_000_000,
      observations: [{ views: 1_050_000, atHours: 2 }],
      nowHours: 400,
    });

    expect(result.outcome).toBe("hit");
    expect(result.viewsAtWindow).toBe(1_050_000);
    // The EARLIEST clearing reading, because "it had already cleared by hour 2"
    // is the strongest true statement available about this Short.
    expect(result.observedAtHours).toBe(2);
  });

  it("is a hit when the reading at the close is over the bar", () => {
    const result = verdict({
      lifetimeViews: 1_200_000,
      observations: [{ views: 1_000_000, atHours: 167 }],
      nowHours: 400,
    });

    expect(result.outcome).toBe("hit");
    expect(result.observedAtHours).toBe(167);
  });

  it("is inclusive at the bar: exactly the threshold counts", () => {
    const result = verdict({
      lifetimeViews: 1_000_000,
      observations: [{ views: 1_000_000, atHours: 24 }],
      nowHours: 400,
    });
    expect(result.outcome).toBe("hit");

    const justUnder = verdict({
      lifetimeViews: 999_999,
      observations: [{ views: 999_999, atHours: 24 }],
      nowHours: 400,
    });
    expect(justUnder.outcome).toBe("miss");
  });

  it("trusts an early reading over a later one that dropped below the bar", () => {
    // View counts can fall when YouTube purges inflated views. A Short that was
    // over the line on Tuesday was over it on Tuesday, and the rule says
    // "reached", not "still had at the end".
    const result = verdict({
      lifetimeViews: 900_000,
      observations: [
        { views: 1_100_000, atHours: 24 },
        { views: 980_000, atHours: 160 },
      ],
      nowHours: 400,
    });

    expect(result.outcome).toBe("hit");
    expect(result.observedAtHours).toBe(24);
  });

  it("ignores a reading taken after the window shut", () => {
    // The whole point of the window. This Short reached two million — eventually
    // — and the only reading is from a month later, which says nothing about
    // what it had done by day seven.
    const result = verdict({
      lifetimeViews: 2_000_000,
      observations: [{ views: 2_000_000, atHours: 700 }],
      nowHours: 800,
    });

    expect(result.outcome).not.toBe("hit");
    expect(result.outcome).toBe("unknown");
  });
});

describe("miss", () => {
  it("is a confident miss with NO snapshots when lifetime views are under the bar", () => {
    // The inference that rescues 80% of the existing library — 1,530 of 1,904
    // Shorts — on an account where almost nothing was being sampled. A Short
    // that has not reached a million in a year did not reach it in its first
    // week, and no history is required to know that.
    const result = verdict({ lifetimeViews: 40_000, nowHours: 8_760 });

    expect(result.outcome).toBe("miss");
    // Nothing was seen at the window, and the columns say so rather than
    // dressing today's total up as a measurement taken at day seven.
    expect(result.viewsAtWindow).toBeNull();
    expect(result.observedAtHours).toBeNull();
  });

  it("is an observed miss when the last reading inside the window was short", () => {
    const result = verdict({
      lifetimeViews: 5_000_000,
      observations: [
        { views: 100_000, atHours: 6 },
        { views: 400_000, atHours: 167 },
      ],
      nowHours: 400,
    });

    expect(result.outcome).toBe("miss");
    // The LATEST reading decides a miss: "still short at hour 167" is a much
    // stronger statement than "still short at hour 6", and the column is what
    // lets a screen say which one it has.
    expect(result.viewsAtWindow).toBe(400_000);
    expect(result.observedAtHours).toBe(167);
  });

  it("records the rule it was judged against, not the rule as it stands today", () => {
    const result = verdict({ lifetimeViews: 10, nowHours: 8_760 });
    expect(result.thresholdApplied).toBe(1_000_000);
    expect(result.windowHoursApplied).toBe(168);
    expect(result.windowClosesAtMs).toBe(windowClosesAt(PUBLISHED, 168));
  });
});

describe("pending", () => {
  it("is pending while the window is open", () => {
    const result = verdict({ lifetimeViews: 12_000, nowHours: 24 });

    expect(result.outcome).toBe("pending");
    expect(result.viewsAtWindow).toBeNull();
  });

  it("is STILL pending when it is already over the bar", () => {
    // The branch people argue with. Counting an early winner today would let the
    // in-flight cohort contribute its winners and none of its unfinished
    // siblings, so every recent period would read near 100% — the old age bias,
    // inverted. Nothing is lost: the window shuts in six days and the reading at
    // hour 3 makes it a hit then, permanently.
    const result = verdict({
      lifetimeViews: 4_000_000,
      observations: [{ views: 4_000_000, atHours: 3 }],
      nowHours: 4,
    });

    expect(result.outcome).toBe("pending");
  });

  it("becomes a hit the moment the window shuts, on the same evidence", () => {
    const observations = [{ views: 4_000_000, atHours: 3 }];

    expect(verdict({ lifetimeViews: 4_000_000, observations, nowHours: 167 }).outcome).toBe(
      "pending",
    );
    expect(verdict({ lifetimeViews: 4_000_000, observations, nowHours: 168 }).outcome).toBe(
      "hit",
    );
  });

  it("is not final, so it will be re-decided", () => {
    expect(isFinalOutcome("pending")).toBe(false);
  });
});

describe("unknown", () => {
  it("is unknown with no snapshots when lifetime views are over the bar", () => {
    // NEVER A HIT. 374 Shorts on this account are in exactly this state: past
    // the bar today, with nobody recording during the window, so it might have
    // taken two days or two years. Guessing "hit" would invent the answer the
    // whole exercise exists to stop inventing.
    const result = verdict({ lifetimeViews: 3_000_000, nowHours: 8_760 });

    expect(result.outcome).toBe("unknown");
    expect(result.viewsAtWindow).toBeNull();
    expect(result.observedAtHours).toBeNull();
  });

  it("is unknown when every reading falls outside the window", () => {
    const result = verdict({
      lifetimeViews: 3_000_000,
      observations: [
        { views: 2_000_000, atHours: 200 },
        { views: 3_000_000, atHours: 900 },
      ],
      nowHours: 1_000,
    });

    expect(result.outcome).toBe("unknown");
  });

  it("is not frozen, because evidence can still arrive", () => {
    // A backfilled snapshot series would settle a pile of these at once, so
    // unlike a hit or a miss it is re-decided on every run.
    expect(isFinalOutcome("unknown")).toBe(false);
    expect(isFinalOutcome("hit")).toBe(true);
    expect(isFinalOutcome("miss")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WHICH NICHE JUDGES A SHORT
// ---------------------------------------------------------------------------

describe("pickGoverningRule", () => {
  const gta: HitRule = { threshold: 1_000_000, windowHours: 168 };
  const tlou: HitRule = { threshold: 500_000, windowHours: 48 };

  it("takes the lowest threshold, so a genuine Last of Us hit is not swallowed by GTA", () => {
    const picked = pickGoverningRule([
      { nicheId: "niche_gta", rule: gta },
      { nicheId: "niche_tlou", rule: tlou },
    ]);
    expect(picked?.nicheId).toBe("niche_tlou");
  });

  it("does not depend on the order the candidates arrive in", () => {
    const a = pickGoverningRule([
      { nicheId: "niche_gta", rule: gta },
      { nicheId: "niche_tlou", rule: tlou },
    ]);
    const b = pickGoverningRule([
      { nicheId: "niche_tlou", rule: tlou },
      { nicheId: "niche_gta", rule: gta },
    ]);
    expect(a).toEqual(b);
  });

  it("breaks a tie on niche id so a payroll run is reproducible", () => {
    const picked = pickGoverningRule([
      { nicheId: "niche_b", rule: gta },
      { nicheId: "niche_a", rule: { threshold: 1_000_000, windowHours: 24 } },
    ]);
    expect(picked?.nicheId).toBe("niche_a");
  });

  it("returns null when nothing is configured", () => {
    expect(pickGoverningRule([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE RATE
// ---------------------------------------------------------------------------

describe("calculateHitRate — judged Shorts only", () => {
  it("divides hits by hits plus misses", () => {
    const summary = calculateHitRate({
      hits: 12,
      misses: 28,
      pending: 0,
      unknown: 0,
      unscoreable: 0,
    });
    expect(summary.rate).toBe(30);
    expect(summary.judged).toBe(40);
  });

  it("keeps pending Shorts out of BOTH halves", () => {
    // The mechanism that removes the age bias. Nine Shorts published this week
    // must not drag the denominator down while they are still unfinished — under
    // the old rule they were counted as misses, which is exactly how publishing
    // more made the number fall.
    const summary = calculateHitRate({
      hits: 3,
      misses: 1,
      pending: 9,
      unknown: 0,
      unscoreable: 0,
    });

    expect(summary.rate).toBe(75);
    expect(summary.judged).toBe(4);
    expect(summary.excluded).toBe(9);
  });

  it("keeps unknown and unscoreable Shorts out of both halves too, and counts them", () => {
    const summary = calculateHitRate({
      hits: 10,
      misses: 30,
      pending: 5,
      unknown: 374,
      unscoreable: 60,
    });

    expect(summary.rate).toBe(25);
    expect(summary.judged).toBe(40);
    expect(summary.excluded).toBe(439);
    // Every exclusion survives to the surface. A screen that cannot say what it
    // left out will be believed exactly as much as one that can.
    expect(summary.tally.unknown).toBe(374);
    expect(summary.tally.unscoreable).toBe(60);
  });

  it("returns null — never 0% — when nothing was judged", () => {
    const nothing = calculateHitRate({
      hits: 0,
      misses: 0,
      pending: 12,
      unknown: 3,
      unscoreable: 0,
    });

    // 0% would assert "these were judged and none of them hit". Fifteen Shorts
    // that nobody could judge is a different statement, and the UI renders this
    // null as an em dash for that reason.
    expect(nothing.rate).toBeNull();
    expect(nothing.judged).toBe(0);
  });

  it("reports a real 0% when Shorts were judged and none hit", () => {
    const summary = calculateHitRate({
      hits: 0,
      misses: 20,
      pending: 0,
      unknown: 0,
      unscoreable: 0,
    });
    expect(summary.rate).toBe(0);
  });

  it("rounds to two places", () => {
    expect(
      calculateHitRate({ hits: 12, misses: 26, pending: 0, unknown: 0, unscoreable: 0 }).rate,
    ).toBe(31.58);
    expect(
      calculateHitRate({ hits: 1, misses: 2, pending: 0, unknown: 0, unscoreable: 0 }).rate,
    ).toBe(33.33);
  });
});

describe("the range the true rate lies in", () => {
  it("bounds the rate by treating every unknown first as a miss, then as a hit", () => {
    const summary = calculateHitRate({
      hits: 10,
      misses: 30,
      pending: 0,
      unknown: 10,
      unscoreable: 0,
    });

    expect(summary.rate).toBe(25);
    expect(summary.lowerBound).toBe(20); // 10 / 50
    expect(summary.upperBound).toBe(40); // 20 / 50
  });

  it("collapses the range onto the rate when there is nothing unknown", () => {
    const summary = calculateHitRate({
      hits: 10,
      misses: 30,
      pending: 4,
      unknown: 0,
      unscoreable: 2,
    });

    // No ambiguity to report. Pending and unscoreable Shorts are excluded, but
    // they are not POTENTIAL hits the way an unknown is — nobody knows they
    // ever crossed the bar, and one of them has no bar at all.
    expect(summary.lowerBound).toBe(summary.rate);
    expect(summary.upperBound).toBe(summary.rate);
  });

  it("is wide when the unknowns dominate, which is the point of showing it", () => {
    // This account's real shape: 374 unknowns against a judged library that is
    // mostly confident misses. A single point estimate here would be a confident
    // number with 374 winners quietly deleted from it.
    const summary = calculateHitRate({
      hits: 40,
      misses: 1_530,
      pending: 0,
      unknown: 374,
      unscoreable: 0,
    });

    expect(summary.rate).toBe(2.55);
    expect(summary.lowerBound).toBe(2.06);
    expect(summary.upperBound).toBe(21.3);
  });

  it("has no bounds when there is nothing to bound", () => {
    const summary = calculateHitRate({
      hits: 0,
      misses: 0,
      pending: 3,
      unknown: 0,
      unscoreable: 0,
    });
    expect(summary.lowerBound).toBeNull();
    expect(summary.upperBound).toBeNull();
  });
});

describe("tallies", () => {
  it("counts a stream of contributions", () => {
    const tally = tallyContributions([
      "hit",
      "hit",
      "miss",
      "pending",
      "unknown",
      "unscoreable",
    ]);
    expect(tally).toEqual({ hits: 2, misses: 1, pending: 1, unknown: 1, unscoreable: 1 });
  });

  it("adds up, so a portfolio is the sum of its channels", () => {
    const a = tallyContributions(["hit", "miss"]);
    const b = tallyContributions(["hit", "pending"]);
    expect(addTallies(a, b)).toEqual({
      hits: 2,
      misses: 1,
      pending: 1,
      unknown: 0,
      unscoreable: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// THE BAR ON ITS OWN — a display concern, and named as one
// ---------------------------------------------------------------------------

describe("clearsThreshold", () => {
  it("is inclusive at the boundary", () => {
    expect(clearsThreshold(1_000_000, 1_000_000)).toBe(true);
    expect(clearsThreshold(999_999, 1_000_000)).toBe(false);
  });

  it("clears nothing when the niche has no threshold", () => {
    expect(clearsThreshold(5_000_000, null)).toBe(false);
  });
});

/**
 * =========================================================================
 * READING A VERDICT BACK
 * =========================================================================
 * `evaluateHit` above is how a verdict is MADE. These are how one is READ, off
 * a stored row, by every surface that counts them — and the one distinction
 * that matters is between a Short nobody could judge and a Short nobody was
 * watching. They look identical in the `outcome` column, both say "unknown",
 * and they mean opposite things.
 */
describe("hitContributionOf", () => {
  it("passes the four verdicts through unchanged", () => {
    expect(hitContributionOf(makeVerdict("hit"))).toBe("hit");
    expect(hitContributionOf(makeVerdict("miss"))).toBe("miss");
    expect(hitContributionOf(makeVerdict("pending"))).toBe("pending");
    expect(hitContributionOf(makeVerdict("unknown"))).toBe("unknown");
  });

  it("separates 'no rule' from 'nobody was watching' on the null rule", () => {
    // Both are stored as "unknown" — the outcome column has four values and
    // there is deliberately no fifth. The rule columns are what tell them
    // apart, and they send a reader to two different places: one is a niche an
    // admin has to finish configuring, the other is history that no longer
    // exists.
    const evidential = makeVerdict("unknown");
    const unscoreable = makeVerdict("unknown", {
      thresholdApplied: null,
      windowHoursApplied: null,
    });

    expect(hitContributionOf(evidential)).toBe("unknown");
    expect(hitContributionOf(unscoreable)).toBe("unscoreable");
  });

  it("treats a missing verdict as unscoreable, never as a miss", () => {
    // The evaluator runs on the sync cron, so a Short discovered ten minutes
    // ago genuinely has no answer. Reading that as a failure would let the
    // hit rate fall every time somebody published.
    expect(hitContributionOf(null)).toBe("unscoreable");
    expect(hitContributionOf(undefined)).toBe("unscoreable");
  });

  it("half a stored rule is not a rule here either", () => {
    expect(
      hitContributionOf(makeVerdict("miss", { windowHoursApplied: null })),
    ).toBe("unscoreable");
    expect(hitContributionOf(makeVerdict("hit", { thresholdApplied: null }))).toBe(
      "unscoreable",
    );
  });
});

describe("tallyShorts", () => {
  it("counts a mixed library into the five populations", () => {
    const tally = tallyShorts([
      makeHit({ views: 2_000_000 }),
      makeHit({ views: 3_000_000 }),
      makeMiss({ views: 40_000 }),
      makePending({ views: 10_000 }),
      makeUnknown({ views: 8_000_000 }),
      makeUnscoreable({ views: 500_000 }),
      // No verdict stored at all.
      makeShort({ views: 900_000 }),
    ]);

    expect(tally).toEqual({
      hits: 2,
      misses: 1,
      pending: 1,
      unknown: 1,
      unscoreable: 2,
    });
  });

  it("counts nothing from a view count, however large", () => {
    // The whole point, in one assertion: a 40M-view Short with no verdict
    // contributes to neither half of anything.
    const tally = tallyShorts([makeShort({ views: 40_000_000 })]);
    expect(tally.hits).toBe(0);
    expect(tally.misses).toBe(0);
    expect(tally.unscoreable).toBe(1);
  });
});

describe("windowRatio", () => {
  it("measures how close it came WHERE THE RULE LOOKS", () => {
    const verdictWithReading = makeVerdict("miss", {
      viewsAtWindow: 750_000,
      observedAtHours: 160,
    });
    expect(windowRatio(verdictWithReading)).toBeCloseTo(0.75);
  });

  it("is null when nothing was seen inside the window", () => {
    // The state most Shorts on this account are in: the miss was inferred from
    // "lifetime is still under the bar", which never observed anything. A
    // lifetime ratio substituted here would be a different number wearing this
    // one's name — the exact confusion the old single `thresholdRatio` caused.
    expect(windowRatio(makeVerdict("miss"))).toBeNull();
    expect(windowRatio(makeVerdict("pending"))).toBeNull();
    expect(windowRatio(null)).toBeNull();
  });
});

describe("annotateAgainstThreshold", () => {
  it("annotates the LIFETIME ratio to the display bar for the Shorts table", () => {
    const [a, b] = annotateAgainstThreshold(
      [makeShort({ views: 2_400_000 }), makeShort({ views: 500_000 })],
      1_000_000,
    );
    expect(a.clearsThreshold).toBe(true);
    expect(a.lifetimeRatio).toBeCloseTo(2.4);
    expect(b.clearsThreshold).toBe(false);
    expect(b.lifetimeRatio).toBeCloseTo(0.5);
  });

  it("reports the window ratio separately, and only where there is a reading", () => {
    /*
     * TWO RATIOS BECAUSE THERE ARE TWO QUESTIONS, and the field that used to
     * answer both was called `thresholdRatio`. It measured lifetime views and
     * was read as "how close did this come to being a hit" — which under a
     * window is a question about the window's close, and is frequently
     * unanswerable.
     */
    const seen = makeMiss({
      views: 5_000_000,
      hit: makeVerdict("miss", { viewsAtWindow: 400_000, observedAtHours: 160 }),
    });
    const inferred = makeMiss({ views: 5_000_000 });

    const [withReading, withoutReading] = annotateAgainstThreshold(
      [seen, inferred],
      1_000_000,
    );

    // Same lifetime total, same bar, same lifetime ratio.
    expect(withReading.lifetimeRatio).toBeCloseTo(5);
    expect(withoutReading.lifetimeRatio).toBeCloseTo(5);
    // Where the rule looked, they are 0.4x and unknowable.
    expect(withReading.windowRatio).toBeCloseTo(0.4);
    expect(withoutReading.windowRatio).toBeNull();
  });

  it("does not divide by zero, and reports no ratio without a threshold", () => {
    const [zero] = annotateAgainstThreshold([makeShort({ views: 100 })], 0);
    expect(zero.lifetimeRatio).toBeNull();

    const [none] = annotateAgainstThreshold([makeShort({ views: 5_000_000 })], null);
    expect(none.clearsThreshold).toBe(false);
    expect(none.lifetimeRatio).toBeNull();
  });
});

describe("formatHitWindow", () => {
  it("says days where days are what somebody means", () => {
    expect(formatHitWindow(168)).toBe("7 days");
    expect(formatHitWindow(24)).toBe("1 day");
    expect(formatHitWindow(48)).toBe("2 days");
  });

  it("keeps hours when the rule is not a whole number of days", () => {
    expect(formatHitWindow(36)).toBe("36 hours");
    expect(formatHitWindow(1)).toBe("1 hour");
  });
});
