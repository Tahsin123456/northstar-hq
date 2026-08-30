import { describe, expect, it } from "vitest";
import {
  blankBonusNote,
  explainBlankBonus,
  missingRuleSentence,
  splitBlankNiches,
  unrecordedRuleSentence,
  type EarningsNicheGapSource,
} from "@/lib/payroll/earnings-copy";

/**
 * The sentences on somebody's own pay screen, pinned.
 *
 * These are not cosmetic strings. They are the only explanation an employee
 * gets for a zero bonus, and each one ends by telling them which setting to ask
 * an administrator for — so a sentence that names the wrong gap sends a real
 * person to the wrong colleague about the wrong field, on the subject of their
 * own pay. It looks exactly as authoritative as the right sentence would.
 *
 * The bug these were extracted from: a production niche with a COMPLETE hit
 * rule and no `hitPaymentMinor` was told it had no hit window. The rule was
 * fine. Nobody had said what a hit was worth.
 */

/** A niche whose rule is finished — 500,000 views inside 48 hours. */
const SCORING = {
  nicheName: "GTA",
  thresholdApplied: 500_000,
  windowHoursApplied: 48,
  thresholdSource: "unconfigured",
} as const;

function line(over: Partial<EarningsNicheGapSource> = {}): EarningsNicheGapSource {
  return { ...SCORING, ruleMissing: null, ...over };
}

describe("a niche that can score and cannot pay", () => {
  it("names the payment, and never the rule it already has", () => {
    const sentence = missingRuleSentence(
      line({ ruleMissing: { rule: null, payment: true } }),
      { rule: null, payment: true },
    );

    // The gap, named. This is the assertion the old code failed.
    expect(sentence).toMatch(/nobody has said what one hit here is worth/i);
    expect(sentence).toMatch(/An administrator sets the payment\./);

    // And the three claims it must NOT make. The niche has both halves of its
    // rule, so sending somebody to fix either would be sending them nowhere.
    expect(sentence).not.toMatch(/window/i);
    expect(sentence).not.toMatch(/how long/i);
    expect(sentence).not.toMatch(/nothing in this niche can be counted/i);
  });

  it("states the rule it does have, so the row still says what a hit is", () => {
    const sentence = missingRuleSentence(
      line({ ruleMissing: { rule: null, payment: true } }),
      { rule: null, payment: true },
    );

    // "You got 0 hits" means nothing without the bar it was measured against,
    // and this niche HAS one — the whole point of the fix is that the measuring
    // happened.
    expect(sentence).toContain("500,000 views within 2 days");
    expect(sentence).toMatch(/your Shorts are counted against it/i);
  });
});

describe("a niche that cannot score", () => {
  it("names the missing half, and only that half", () => {
    const noThreshold = missingRuleSentence(
      line({ thresholdApplied: null, ruleMissing: { rule: "threshold", payment: false } }),
      { rule: "threshold", payment: false },
    );
    expect(noThreshold).toMatch(/number of views/i);
    expect(noThreshold).toMatch(/nothing in this niche can be counted/i);
    expect(noThreshold).not.toMatch(/worth/i);

    const noWindow = missingRuleSentence(
      line({ windowHoursApplied: null, ruleMissing: { rule: "window", payment: false } }),
      { rule: "window", payment: false },
    );
    expect(noWindow).toContain("500,000 views");
    expect(noWindow).toMatch(/how long a Short has to reach them/i);
    expect(noWindow).toMatch(/An administrator sets the window\.|sets it\./);
    expect(noWindow).not.toMatch(/worth/i);
  });

  it("asks for both halves when neither is set", () => {
    const sentence = missingRuleSentence(
      line({
        thresholdApplied: null,
        windowHoursApplied: null,
        ruleMissing: { rule: "both", payment: false },
      }),
      { rule: "both", payment: false },
    );
    expect(sentence).toMatch(/both a number of views and a window/i);
    expect(sentence).toMatch(/An administrator sets both\./);
  });
});

describe("a niche missing the rule AND the price", () => {
  /**
   * Both, because closing one leaves the other. An employee told only about the
   * threshold would chase it, wait a month, and find the same zero — the hits
   * would be counted by then and still worth nothing.
   */
  it("names both gaps rather than the first one it finds", () => {
    const sentence = missingRuleSentence(
      line({ windowHoursApplied: null, ruleMissing: { rule: "window", payment: true } }),
      { rule: "window", payment: true },
    );

    expect(sentence).toMatch(/how long a Short has to reach them/i);
    expect(sentence).toMatch(/what one hit here would be worth/i);
    expect(sentence).toMatch(/An administrator sets both\./);
  });

  it("asks for all three when nothing at all is set", () => {
    const sentence = missingRuleSentence(
      line({
        thresholdApplied: null,
        windowHoursApplied: null,
        ruleMissing: { rule: "both", payment: true },
      }),
      { rule: "both", payment: true },
    );
    expect(sentence).toMatch(/An administrator sets all three\./);
  });
});

describe("a settled month whose rule was never recorded", () => {
  /**
   * Not a configuration gap and nobody's to fix. A record finalized before
   * windows existed carries a threshold and no window, and routing that through
   * the sentences above would tell somebody to go and ask an administrator to
   * complete a rule for a month that cannot change.
   */
  it("says it was not recorded, and asks nobody for anything", () => {
    const sentence = unrecordedRuleSentence(
      line({ thresholdApplied: 500_000, windowHoursApplied: null, thresholdSource: "as_finalized" }),
    );
    expect(sentence).toContain("500,000 views");
    expect(sentence).toMatch(/not recorded when this month was settled/i);
    expect(sentence).not.toMatch(/administrator/i);
    expect(sentence).not.toMatch(/nobody has set/i);
  });
});

describe("the headline over a bonus that could only be zero", () => {
  const unpriced = line({ ruleMissing: { rule: null, payment: true } });
  const unscoreable = line({
    nicheName: "RDR",
    thresholdApplied: null,
    ruleMissing: { rule: "threshold", payment: false },
  });
  const watchlist = line({
    nicheName: "Last of Us",
    thresholdSource: "watchlist",
    ruleMissing: null,
  });

  it("does not claim nothing was counted when everything was", () => {
    const { title, body, nothingToFix } = explainBlankBonus([unpriced]);

    expect(nothingToFix).toBe(false);
    expect(title).toMatch(/counted/i);
    expect(body).toMatch(/GTA are counted normally/);
    expect(body).toMatch(/nobody has said what a hit there is worth/i);
    // The old sentence, which was the bug one level up from the row: it told
    // this person their hit rule was unfinished when it is finished.
    expect(body).not.toMatch(/hit needs a number of views and a window/i);
    expect(body).toMatch(/does not affect your normal pay/i);
  });

  it("keeps the rule gap's own words when that is the gap", () => {
    const { title, body } = explainBlankBonus([unscoreable]);
    expect(title).toBe("Your hits cannot be counted yet");
    expect(body).toMatch(/Nobody has finished the hit rule for RDR/);
    expect(body).not.toMatch(/counted normally/i);
  });

  it("sends nobody after a setting that should not exist", () => {
    // Every niche is one Northstar watches. Nothing is missing, nothing is
    // coming, and an orange banner telling somebody to chase an administrator
    // would waste both their time.
    const { title, body, nothingToFix } = explainBlankBonus([watchlist]);

    expect(nothingToFix).toBe(true);
    expect(title).toBe("None of your niches pays a hit bonus");
    expect(body).toMatch(/deliberately not paid/i);
    expect(body).toMatch(/how it is meant to work/i);
    expect(body).not.toMatch(/administrator/i);
  });

  it("names every gap when somebody has one of each", () => {
    const { body, nothingToFix } = explainBlankBonus([unscoreable, unpriced, watchlist]);

    expect(nothingToFix).toBe(false);
    expect(body).toMatch(/RDR/);
    expect(body).toMatch(/GTA/);
    expect(body).toMatch(/Last of Us/);
  });

  it("summarises the same way the row beside the total does", () => {
    // The note and the block are read one after the other. "Nothing can be
    // counted" over "counted, but nothing says what they pay" is one zero with
    // two stories.
    expect(blankBonusNote([unpriced])).toMatch(/counted, but nothing says what they pay/);
    expect(blankBonusNote([unscoreable])).toMatch(/nothing can be counted yet/);
    expect(blankBonusNote([watchlist])).toMatch(/none of your niches pays a hit bonus/);
    // A rule gap outranks a payment gap: the stronger claim is the true one.
    expect(blankBonusNote([unpriced, unscoreable])).toMatch(/nothing can be counted yet/);
  });

  it("puts each line in exactly one group", () => {
    const groups = splitBlankNiches([unscoreable, unpriced, watchlist]);
    expect(groups.unscoreable.map((l) => l.nicheName)).toEqual(["RDR"]);
    expect(groups.unpriced.map((l) => l.nicheName)).toEqual(["GTA"]);
    expect(groups.watchlist.map((l) => l.nicheName)).toEqual(["Last of Us"]);
  });
});
