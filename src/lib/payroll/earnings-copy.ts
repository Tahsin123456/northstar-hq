/**
 * =========================================================================
 * WHY YOUR HIT BONUS IS WHAT IT IS, IN SENTENCES
 * =========================================================================
 *
 * Pure, isomorphic, no I/O — the discipline `payroll-engine.ts` and
 * `payroll-message.ts` already follow, for the reason that applies here twice
 * over. This is the wording on an employee's own pay screen explaining why they
 * earned nothing, which is the most consequential paragraph the product writes
 * and the one nobody notices is wrong: a sentence that names the wrong missing
 * setting looks exactly as authoritative as one that names the right one.
 *
 * It lives here rather than inside `earnings/page.tsx` so it can be TESTED. A
 * page component in this codebase is not reachable from the runner — the suite
 * is `node`, `*.test.ts`, no DOM — so a sentence written inline in JSX is a
 * sentence nothing can pin. The bug that produced this module (a niche with a
 * complete rule and no price being told it had no hit window) was exactly the
 * kind an assertion catches in a second and a reader never does.
 *
 * NOTHING IS DECIDED HERE. Every gap is read off `ruleMissing`, which the
 * server computed once — see `NichePayrollGap`. This module chooses words for
 * it and nothing else, so a wording change can never move a number and a
 * classification change can never be made by editing prose.
 *
 * THE SAME GAP THE ADMIN SCREENS NAME. The payroll notice and the finalize
 * dialog compose their labels from the identical value through
 * `describeNicheGap`. A niche described as missing a price to the admin and as
 * missing a window to the employee is worse than either being wrong alone: the
 * two people who would sort it out between them cannot agree on what is broken.
 */

import { formatHitWindow } from "@/lib/analytics/hit-rate";
import { formatNumber } from "@/lib/format";
import { describeNicheGap, type NichePayrollGap } from "./payroll-engine";

/**
 * Whether the figure these sentences explain can still move.
 *
 * Structural rather than an import of `MyEarningsDTO["basis"]`, for the reason
 * `EarningsNicheGapSource` below is structural: a pure `lib` module does not
 * reach into `server/services` for a type.
 */
export type EarningsBasis = "estimate" | "finalized";

/**
 * The fields these sentences read off `MyEarningsNicheLineDTO`.
 *
 * Structural rather than an import of the DTO, for the reason `HitRuleSource`
 * in `hit-rate.ts` is structural: it keeps a pure `lib` module from reaching
 * into `server/services` for a type, and it lets a test hand over four fields
 * instead of assembling a whole earnings line to assert on one sentence.
 */
export interface EarningsNicheGapSource {
  readonly nicheName: string;
  readonly thresholdApplied: number | null;
  readonly windowHoursApplied: number | null;
  /** `EarningsThresholdSource`; "watchlist" is the only value branched on. */
  readonly thresholdSource: string;
  readonly ruleMissing: NichePayrollGap | null;
}

/**
 * What is missing from this niche, said the way somebody would ask for it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE GAPS, NOT TWO, AND THE ROW HAS TO NAME THE ONE IT HAS
 * ─────────────────────────────────────────────────────────────────────────────
 * This used to read the two rule columns and infer the gap from them, which was
 * right while a hit was only a bar and a clock. It is not any more. A production
 * niche with a COMPLETE rule and no `hitPaymentMinor` arrives with
 * `ruleMissing: { rule: null, payment: true }` and `thresholdSource:
 * "unconfigured"` — and the old code, seeing two non-null halves, fell through
 * to the window sentence and told somebody their niche had no hit window when it
 * has one. They were then sent to an administrator to ask about the wrong field
 * entirely, on the screen that exists to explain why they earned nothing.
 *
 * THE THREE STATES, AND WHAT SEPARATES THEM
 *   NO RULE     — nothing in the niche is judged. There are no hits to pay for
 *                 because none was ever decided.
 *   NO PAYMENT  — the niche judges perfectly. Shorts in it ARE counted, some of
 *                 them won, and there is no number to multiply by. Saying
 *                 "nothing can be counted" here would understate what happened
 *                 to somebody: their hits are real and unpaid.
 *   NEITHER     — both, and both are named, because closing one leaves the
 *                 other and a second trip to the same administrator.
 *
 * Only ever called with a real gap, which is why `gap` is a parameter rather
 * than re-read off the line: a finalized line carries `ruleMissing: null` — what
 * today's configuration lacks says nothing about a settled month — and a
 * watchlist niche has its own sentence, since nothing is missing there at all.
 */
export function missingRuleSentence(
  line: EarningsNicheGapSource,
  gap: NichePayrollGap,
): string {
  // The rule half, as its own clause, so the payment clause can be appended to
  // any of the three rather than each combination being written out longhand.
  const ruleClause =
    gap.rule === "both"
      ? "nobody has set what counts as a hit here — it needs both a number of views and a window to reach it in"
      : gap.rule === "threshold"
        ? "nobody has set the number of views that counts as a hit here"
        : gap.rule === "window"
          ? `a hit here needs ${formatNumber(line.thresholdApplied ?? 0)} views, but nobody has set how long a Short has to reach them`
          : null;

  // A COMPLETE RULE AND NO PRICE. The niche works: their Shorts were measured
  // against a real bar inside a real window. What is absent is the one number
  // that turns a hit into money, so the sentence says that and nothing about
  // counting — which did happen.
  if (ruleClause === null) {
    const rule =
      line.thresholdApplied === null || line.windowHoursApplied === null
        ? "Your Shorts here are counted against this niche's hit rule"
        : `A hit here is ${formatNumber(line.thresholdApplied)} views within ${formatHitWindow(line.windowHoursApplied)} of going live, and your Shorts are counted against it`;
    return `${rule} — but nobody has said what one hit here is worth, so a hit in it earns nothing. An administrator sets the payment.`;
  }

  const sentence = ruleClause.charAt(0).toUpperCase() + ruleClause.slice(1);

  if (!gap.payment) {
    return `${sentence}, so nothing in this niche can be counted. An administrator sets ${gap.rule === "both" ? "both" : "it"}.`;
  }

  // BOTH GAPS, BOTH NAMED. Completing the rule alone would start counting hits
  // that still could not be paid for, so an employee told only about the rule
  // would be back a month later with the same zero.
  return `${sentence}, and nobody has said what one hit here would be worth either — so nothing in this niche can be counted, and nothing in it could be paid for. An administrator sets ${gap.rule === "both" ? "all three" : "both"}.`;
}

/**
 * =========================================================================
 * THE SETTLED MONTH — the sentence that was missing entirely
 * =========================================================================
 *
 * WHAT WENT WRONG. `missingRuleSentence` and everything around it are reached
 * only from the ESTIMATE path. On a FINALIZED month the earnings DTO is rebuilt
 * from stored `PayrollHit` rows, and the engine deliberately never writes one
 * for a hit it could not price — a zero-value row would enter the paid ledger
 * and make that Short unpayable forever. So the niche vanished from the payslip
 * entirely, the page fell through to its empty state, and somebody who had won
 * a hit was told "You are not on any niche yet". Not silence: the opposite of
 * the reason they were owed an explanation, plus a pointer to the wrong field.
 *
 * WHAT THIS SENTENCE MAY CLAIM, AND WHAT IT MAY NOT.
 *
 *   MAY — that the niche is missing a named setting, which is a fact about the
 *         niche today and is read off the same `NichePayrollGap` the admin
 *         screens read; that a hit in a niche with no price earns nothing,
 *         which is the engine's rule and is not month-specific; that the month
 *         is settled and does not move.
 *
 *   MAY NOT — a COUNT of the person's own Shorts, and this is the sharp one.
 *         The engine knows that number at calculation time and nothing durable
 *         stores it, so on a settled month it is not recoverable without
 *         re-running the engine over today's configuration — which is the
 *         retroactive recalculation the payroll service refuses everywhere. A
 *         made-up "1 of your Shorts" on a payslip is a worse failure than the
 *         silence it replaces. The conditional form carries the meaning without
 *         the claim: any Short of yours that reached the bar earned nothing.
 *
 *   MAY NOT — an AMOUNT, in either direction. There is no rate; "you would have
 *         earned X" is not derivable and inventing one would be the app
 *         deciding a payment it has no basis for.
 *
 *   MAY NOT — the word "yet", or anything else that promises the figure will
 *         change. It will not. What a setting completed today changes is a
 *         later period, and the sentence says exactly that instead.
 */
export function settledGapSentence(
  line: EarningsNicheGapSource,
  gap: NichePayrollGap,
  periodLabel: string,
): string {
  // The same phrase `estimateNotices` builds, through the same function the
  // payroll screen and the finalize dialog use. An employee told "no hit
  // payment" and an admin told "no hit window" about one niche cannot sort it
  // out between them.
  const lacks = `has no ${describeNicheGap(gap)} set`;

  // The one clause every version ends on: this is a setting, not a verdict on
  // the work, and the salary is untouched. Said on a settled month because that
  // is the month somebody has already been paid for and counted.
  const reassurance =
    "It is not about your work, and your normal pay is unaffected.";

  if (gap.rule === null) {
    // A PAYMENT GAP. The niche measures perfectly — saying "nothing could be
    // counted" here would understate what happened, because the counting is
    // exactly what did happen and the win was real.
    const bar =
      line.thresholdApplied === null || line.windowHoursApplied === null
        ? `reached what ${line.nicheName} counts as a hit`
        : `reached ${formatNumber(line.thresholdApplied)} views within ${formatHitWindow(line.windowHoursApplied)} of going live`;

    return `${line.nicheName} ${lacks}, so a hit in it earns nothing — any Short of yours in ${line.nicheName} that ${bar} while ${periodLabel} was open earned no bonus for it. ${periodLabel} is settled and its figures do not change. ${reassurance} An administrator sets what a hit in this niche is worth; setting it now counts towards later periods, not this one.`;
  }

  // A RULE GAP. Nothing was measured, so there is no win to acknowledge and the
  // sentence must not imply one.
  return `${line.nicheName} ${lacks}, so nothing in it can count as a hit — no Short of yours in ${line.nicheName} was measured against a hit rule while ${periodLabel} was open. ${periodLabel} is settled and its figures do not change. ${reassurance} An administrator completes the rule; once it is set, Shorts in this niche count towards later periods, not this one.`;
}

/**
 * What the hit breakdown says when there is not one line to draw.
 *
 * THE FALSE SENTENCE THIS REPLACES. The card used to render one string for an
 * empty breakdown — "You are not on any niche yet, so there is nothing to count
 * hits in. An administrator adds you to one on your employee page." — which is
 * true for somebody with no assignments and flatly false for everybody else who
 * simply has no PAID hit in the period. That is a large group: anybody who
 * missed, and — the case this whole change is about — anybody whose only hit
 * was in a niche with no price on it, since the engine writes no hit row for
 * one of those. Both were sent to an employee page to fix an assignment that
 * was never wrong.
 *
 * The count is the caller's OWN assignment count and nothing else. No names, no
 * rates, nobody else's anything.
 */
export function noNicheLinesSentence(
  assignedNicheCount: number,
  basis: EarningsBasis,
): string {
  if (assignedNicheCount === 0) {
    return "You are not on any niche yet, so there is nothing to count hits in. An administrator adds you to one on your employee page.";
  }

  // TWO DIFFERENCES BETWEEN THE BRANCHES, AND BOTH MATTER.
  //
  // "yet" only while the number can still change — the rule the rest of this
  // page already follows. On a settled month it would promise a hit that is
  // never coming.
  //
  // COUNTED vs PAID. On a settled month the only thing the record proves is
  // that no hit was PAID: an empty breakdown is rebuilt from stored `PayrollHit`
  // rows and the engine writes none for a hit it could not price. Whether one
  // was COUNTED is precisely what nothing durable stores — `settledGapSentence`
  // refuses to claim it in either direction, and this sentence used to claim it
  // in the negative, forty lines below a notice telling the same reader that a
  // Short of theirs may well have reached the bar. Two sentences on one screen
  // that cannot both be true is the guessing this whole change exists to end.
  //
  // On a live month "counted" is right and is not a claim about the past: the
  // estimate recalculates on every read, so a hit that has not been counted yet
  // is exactly what the reader is looking at.
  return basis === "estimate"
    ? "No hit has been counted for you in this period yet, so there is nothing to break down here. Anything above explains why."
    : "No hit was paid to you in this period, so there is nothing to break down here. Anything above explains why.";
}

/**
 * A rule that was never written down, on a month that is already settled.
 *
 * Not a configuration gap and not somebody's to fix. `PayrollNicheLineDTO`
 * carries a null window for a record finalized before windows existed, and for
 * one whose stored evaluations have since been removed — and such a line reaches
 * the row with `ruleMissing: null`, because what today's niche is missing says
 * nothing about a figure settled months ago. Routing it through
 * `missingRuleSentence` would tell somebody to go and ask an administrator to
 * complete a rule for a month nothing can change.
 */
export function unrecordedRuleSentence(line: EarningsNicheGapSource): string {
  if (line.thresholdApplied === null) {
    return "The rule these were judged against was not recorded when this month was settled.";
  }
  return `A hit here was ${formatNumber(line.thresholdApplied)} views. How long a Short had to reach them was not recorded when this month was settled.`;
}

/**
 * The three ways a niche on this page can be incapable of paying a bonus.
 *
 * ONE SPLIT, TWO READERS — the headline notice and the note beside the bonus row
 * both have to name the same thing, and a page that says "nothing can be
 * counted" at the top and "waiting on a price" three rows down has told somebody
 * two different stories about one zero.
 *
 * The groups can overlap in a person's assignment but never in a line: a niche
 * is watchlist, or it is missing part of its rule, or it has a rule and no
 * price. `rule: null` on a gap means the rule is complete and the price is what
 * is absent — see `NichePayrollGap`.
 */
export function splitBlankNiches<T extends EarningsNicheGapSource>(
  lines: readonly T[],
): { unscoreable: T[]; unpriced: T[]; watchlist: T[] } {
  return {
    unscoreable: lines.filter((line) => line.ruleMissing?.rule != null),
    unpriced: lines.filter((line) => line.ruleMissing?.rule === null),
    watchlist: lines.filter((line) => line.thresholdSource === "watchlist"),
  };
}

/** "GTA", "GTA and RDR", "GTA, RDR and Last of Us". */
function nicheNames(lines: readonly EarningsNicheGapSource[]): string {
  const names = lines.map((line) => line.nicheName);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The headline block's words, and whether it is a warning at all. */
export interface BlankBonusExplanation {
  readonly title: string;
  readonly body: string;
  /**
   * True when nothing here is anybody's mistake — every niche is a watchlist
   * one. A permanent orange banner about an arrangement that is working exactly
   * as designed teaches people to ignore orange banners.
   */
  readonly nothingToFix: boolean;
}

/**
 * The headline for a bonus that could not have been anything but zero.
 *
 * WHICH ZERO, NAMED. This block used to say one thing — "A hit needs two
 * settings: how many views, and how long a Short has to reach them. Neither is
 * fully set" — and `noMeasurableNiche` is true in three quite different
 * situations, only one of which that sentence describes. Somebody whose niche
 * has a complete rule and no price was told their hit rule was unfinished when
 * it is finished; somebody on a watchlist niche was told to go and ask an
 * administrator to fix something that is working as intended.
 *
 * It stays one block rather than three: the question a reader arrives with is
 * "why is this zero", which has one answer per person even when their niches are
 * blank for different reasons.
 */
export function explainBlankBonus(
  lines: readonly EarningsNicheGapSource[],
): BlankBonusExplanation {
  const { unscoreable, unpriced, watchlist } = splitBlankNiches(lines);
  const nothingToFix = unscoreable.length === 0 && unpriced.length === 0;

  const title = nothingToFix
    ? "None of your niches pays a hit bonus"
    : unscoreable.length === 0
      ? "Your hits are counted, but nothing says what they pay"
      : unpriced.length === 0 && watchlist.length === 0
        ? "Your hits cannot be counted yet"
        : "Nothing in your niches can earn a hit bonus yet";

  // One sentence per group, in the order of how much is wrong, then the one
  // line every version of this ends on: it is not about their work, and their
  // salary is untouched.
  const parts: string[] = [];

  if (unscoreable.length > 0) {
    parts.push(
      `Nobody has finished the hit rule for ${nicheNames(unscoreable)} — a hit needs a number of views and a window to reach them in — so nothing you put out ${unscoreable.length === 1 ? "there" : "in those"} can be counted as one.`,
    );
  }

  if (unpriced.length > 0) {
    parts.push(
      `Your Shorts in ${nicheNames(unpriced)} are counted normally, but nobody has said what a hit ${unpriced.length === 1 ? "there is" : "in those is"} worth, so ${unpriced.length === 1 ? "a hit in it" : "a hit in them"} earns nothing.`,
    );
  }

  if (watchlist.length > 0) {
    parts.push(
      `${nicheNames(watchlist)} ${watchlist.length === 1 ? "is a niche" : "are niches"} Northstar follows rather than publishes into, so hits ${watchlist.length === 1 ? "in it" : "in them"} are deliberately not paid — nothing is missing there.`,
    );
  }

  parts.push(
    nothingToFix
      ? "That is how it is meant to work, and it does not affect your normal pay."
      : `${unscoreable.length + unpriced.length === 1 ? "That is a setting" : "These are settings"} an administrator fills in — it is not about your work, and it does not affect your normal pay.`,
  );

  return { title, body: parts.join(" "), nothingToFix };
}

/**
 * The same answer as `explainBlankBonus`, in the few words a summary row has.
 *
 * Deliberately the same `splitBlankNiches` call: this note sits directly above
 * the card that explains it at length, and the shortest way to make somebody
 * distrust both is to have them disagree.
 */
export function blankBonusNote(lines: readonly EarningsNicheGapSource[]): string {
  const { unscoreable, unpriced } = splitBlankNiches(lines);
  if (unscoreable.length === 0 && unpriced.length === 0) {
    return "none of your niches pays a hit bonus — see below";
  }
  if (unscoreable.length === 0) return "counted, but nothing says what they pay — see below";
  return "nothing can be counted yet — see below";
}
