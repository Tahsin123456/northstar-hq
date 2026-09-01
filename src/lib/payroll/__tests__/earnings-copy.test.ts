import { describe, expect, it } from "vitest";
import {
  blankBonusNote,
  explainBlankBonus,
  missingRuleSentence,
  noNicheLinesSentence,
  settledGapSentence,
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

/**
 * =========================================================================
 * THE SETTLED MONTH
 * =========================================================================
 *
 * The estimate path has explained a blank bonus, per niche and per gap, for as
 * long as these sentences have existed. The FINALIZED path explained nothing —
 * and it is the path the money is actually on. An employee whose only hit was
 * in a niche with no price got a stored record with no hit rows in it, an empty
 * breakdown, and a card reading "You are not on any niche yet".
 *
 * These assertions are as much about what the sentence MUST NOT say as what it
 * says. On a month that cannot move, "yet" and "waiting" are promises, and a
 * count of somebody's Shorts is a claim nothing durable can back.
 */
describe("a settled month with a niche that could not pay", () => {
  const AUGUST = "August 2026";

  it("names the missing payment, and says the month does not move", () => {
    const sentence = settledGapSentence(
      line({ ruleMissing: { rule: null, payment: true } }),
      { rule: null, payment: true },
      AUGUST,
    );

    expect(sentence).toContain("GTA has no hit payment set");
    expect(sentence).toContain("a hit in it earns nothing");
    expect(sentence).toContain("August 2026 is settled and its figures do not change");
    // The bar it DOES have, so the reader can tell the measuring happened.
    expect(sentence).toContain("500,000 views within 2 days");
    // Where to go, and what it will and will not do.
    expect(sentence).toContain("An administrator sets what a hit in this niche is worth");
    expect(sentence).toContain("counts towards later periods, not this one");
  });

  it("promises nothing about a figure that cannot change", () => {
    const sentence = settledGapSentence(
      line({ ruleMissing: { rule: null, payment: true } }),
      { rule: null, payment: true },
      AUGUST,
    );

    // "yet" and "waiting" both say the number is still coming. It is not.
    expect(sentence).not.toMatch(/\byet\b/i);
    expect(sentence).not.toMatch(/waiting/i);
    // And no amount, in either direction. There is no rate — that is the gap —
    // so "you would have earned" is not derivable and must not be invented.
    expect(sentence).not.toMatch(/\$/);
    expect(sentence).not.toMatch(/would have earned/i);
    expect(sentence).not.toMatch(/owed/i);
  });

  /**
   * THE CLAIM THAT CANNOT BE MADE. Nothing durable stores how many of this
   * person's Shorts the gap cost on a settled month, so the sentence uses the
   * conditional — "any Short of yours that reached the bar" — rather than a
   * number nothing can back. A made-up "1 of your Shorts" on a payslip is a
   * worse failure than the silence it replaces.
   */
  it("counts nothing, because on a settled month nothing stored the count", () => {
    const sentence = settledGapSentence(
      line({ ruleMissing: { rule: null, payment: true } }),
      { rule: null, payment: true },
      AUGUST,
    );

    expect(sentence).toContain("any Short of yours in GTA");
    expect(sentence).not.toMatch(/\d+ of your Shorts/);
  });

  /**
   * The two gaps stopped at different points. A payment gap's Shorts were
   * judged and won; a rule gap's were never measured at all, and a sentence
   * that told somebody their hits "could not be counted" when they were counted
   * and simply not priced would understate what happened to them.
   */
  it("says something different, and correct, about a rule gap", () => {
    const rule = settledGapSentence(
      line({ thresholdApplied: null, ruleMissing: { rule: "threshold", payment: false } }),
      { rule: "threshold", payment: false },
      AUGUST,
    );

    expect(rule).toContain("GTA has no hit threshold set");
    expect(rule).toContain("nothing in it can count as a hit");
    expect(rule).toContain("was measured against a hit rule");
    expect(rule).toContain("An administrator completes the rule");

    // Never the payment sentence, and never an implication that a hit happened.
    expect(rule).not.toMatch(/what a hit in this niche is worth/);
    expect(rule).not.toMatch(/\byet\b/i);

    const payment = settledGapSentence(
      line({ ruleMissing: { rule: null, payment: true } }),
      { rule: null, payment: true },
      AUGUST,
    );
    expect(rule).not.toBe(payment);
  });

  it("names both halves when both are absent, as the admin screens do", () => {
    const sentence = settledGapSentence(
      line({
        thresholdApplied: null,
        windowHoursApplied: null,
        ruleMissing: { rule: "both", payment: true },
      }),
      { rule: "both", payment: true },
      AUGUST,
    );

    // `describeNicheGap`'s composition, unforked: the payroll screen, the
    // finalize dialog and this sentence must name one niche the same way.
    expect(sentence).toContain("no hit threshold or window, and no hit payment set");
  });

  it("says it is not about their work, and leaves the salary alone", () => {
    for (const gap of [
      { rule: null, payment: true },
      { rule: "threshold" as const, payment: false },
    ]) {
      const sentence = settledGapSentence(line({ ruleMissing: gap }), gap, AUGUST);
      expect(sentence).toContain("It is not about your work, and your normal pay is unaffected.");
    }
  });
});

/**
 * The empty hit breakdown, which used to tell most of the people who saw it
 * something false.
 */
describe("what to say when there is no hit line to draw", () => {
  it("keeps the old sentence for somebody genuinely on no niche", () => {
    expect(noNicheLinesSentence(0, "estimate")).toContain("You are not on any niche yet");
    expect(noNicheLinesSentence(0, "finalized")).toContain("You are not on any niche yet");
  });

  /**
   * THE FALSE SENTENCE. A finalized record holds only the hits that PAID, and
   * the engine writes no hit row for one it could not price — so the person
   * this whole change is about arrived here with an empty breakdown and was
   * told he was on no niche and should ask for one. He was on a niche. He had
   * won a hit.
   */
  it("never claims somebody is on no niche when they are on one", () => {
    for (const basis of ["estimate", "finalized"] as const) {
      const sentence = noNicheLinesSentence(1, basis);
      expect(sentence).not.toMatch(/not on any niche/i);
      expect(sentence).not.toMatch(/employee page/i);
      expect(sentence).toMatch(/no hit/i);
    }
  });

  it("says 'yet' only while the number can still change", () => {
    expect(noNicheLinesSentence(1, "estimate")).toMatch(/\byet\b/);
    expect(noNicheLinesSentence(1, "finalized")).not.toMatch(/\byet\b/);
  });

  /**
   * ON A SETTLED MONTH IT CLAIMS PAYMENT, NEVER COUNTING.
   *
   * What the record proves is that no hit was PAID — no `PayrollHit` row was
   * written. Whether one was COUNTED is exactly what nothing durable stores,
   * and `settledGapSentence` refuses to claim it in either direction: on a
   * payment gap it says the opposite, that a Short of theirs may well have
   * reached the bar. Both sentences land on the same screen, so this one saying
   * "no hit was counted for you" left the reader with two answers and no way to
   * choose — the guessing this whole change exists to end.
   */
  it("claims payment, not counting, once the month is settled", () => {
    const settled = noNicheLinesSentence(1, "finalized");
    expect(settled).toContain("No hit was paid to you in this period");
    expect(settled).not.toMatch(/counted/i);

    // A live month may say "counted": the estimate recalculates on every read,
    // so a hit that has not been counted yet is what the reader is looking at.
    expect(noNicheLinesSentence(1, "estimate")).toMatch(/counted/i);
  });
});
