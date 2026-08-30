import { ruleCoversPublishDate, type ChannelContentTypeRuleWindow } from "./resolve";

/**
 * ==========================================================================
 * HOW A CHANNEL RULE NOTICES THE CHANNEL CHANGED
 * ==========================================================================
 *
 * The problem, in the owner's words: a channel uploads one content type for a
 * year, then switches up, and future uploads must not get falsely tagged.
 *
 * THERE IS NO RELIABLE AUTOMATIC SIGNAL FOR A STYLE CHANGE, and this codebase
 * does not guess. Inferring it from titles, durations or view shape would be
 * exactly that — a model of what a channel is, invented here, wrong sometimes,
 * and wrong invisibly. What IS reliable is a person looking at an upload and
 * taking the tag off. That is a human judgement about this exact channel, made
 * by somebody who watched the video, and it is already recorded.
 *
 * So the rule listens to removals:
 *
 *   • removing an inherited tag from a Short the rule covers grows the streak
 *     and remembers where the streak started;
 *   • three in a row closes the rule, dated to the START of the streak rather
 *     than to today — that is when the channel actually changed, and dating it
 *     to when somebody noticed would leave every upload in between falsely
 *     tagged forever;
 *   • putting the tag back on a newer Short confirms the rule and clears the
 *     streak, because somebody has just said the channel is still doing this.
 *
 * WHY THIS IS A PURE MODULE AND NOT A FEW LINES INSIDE THE SERVICE. Every
 * property above is a claim about a state machine, and the useful way to pin a
 * state machine is to run it — not to reconstruct it from Prisma stubs. The
 * service does the reading, the writing and the telling; what happens to the
 * three columns lives here, where a test can drive it directly.
 *
 * THE AUTOMATIC PATH IS A SAFETY NET, NOT THE ONLY DOOR. A rule can be closed
 * and re-opened by hand at any time, and re-opening is one action wherever the
 * close is shown. That matters because everything below is a heuristic over
 * three data points: it will occasionally retire a rule somebody wanted, and the
 * answer to that is that the close is announced, dated, and undone in one click
 * — never that it is prevented by making the rule harder to trip.
 */

/**
 * How many consecutive removals retire a rule.
 *
 * THREE, and the number is a judgement about evidence rather than a
 * configuration knob.
 *
 * ONE is noise. A single Short that broke format — a one-off collab, an
 * experiment, a repost — is the ordinary reason somebody takes a tag off, and
 * retiring a year-old rule because of it would make the feature actively
 * dangerous to use. TWO is still comfortably inside coincidence: two
 * experiments in a row is a normal fortnight on a channel that is trying things.
 *
 * THREE consecutive uploads that a person looked at and said "not this any more"
 * is a pattern rather than an accident, and it is reachable in a single sitting
 * — which matters, because the whole point is that the rule retires while
 * somebody is working rather than at some later audit. Higher would be safer per
 * decision and worse overall: a rule that needs five corrections has already
 * mislabelled five uploads, and the person correcting them has already learned
 * not to trust it.
 *
 * The streak is CONSECUTIVE, which is what stops the number needing to be
 * bigger: putting the tag back on a newer Short clears it outright, so three is
 * three in a row against no contrary evidence.
 */
export const RULE_AUTO_CLOSE_STREAK = 3;

/**
 * The columns this state machine reads and writes, in epoch milliseconds.
 *
 * Milliseconds rather than `Date` so the machine is trivially runnable in a
 * test and identical on both sides of the wire. The service converts at the
 * Prisma boundary, which is the only place a `Date` belongs.
 */
export interface RuleStreakState extends ChannelContentTypeRuleWindow {
  /** Consecutive removals on Shorts newer than the streak's start. */
  readonly consecutiveOverrides: number;
  /** Publish date of the EARLIEST Short in the current streak. */
  readonly overrideStreakFrom: number | null;
}

/** What to write back. `null` from either function below means: write nothing. */
export interface RuleStreakChange {
  readonly consecutiveOverrides: number;
  readonly overrideStreakFrom: number | null;
  /**
   * Non-null exactly when this change RETIRES the rule — and it is the date the
   * rule stops at, not the date it was noticed.
   *
   * The caller stamps `autoClosedAt = now` alongside it, so the two questions
   * "when did the channel change?" and "when did we work that out?" keep
   * separate answers. Collapsing them would produce a tidy history and a wrong
   * one.
   */
  readonly closesAt: number | null;
}

/**
 * A person removed this rule's tag from a Short the rule covers.
 *
 * THE THREE REFUSALS, each of which is a decision rather than an oversight:
 *
 * 1. A CLOSED RULE IGNORES REMOVALS. It is not claiming anything, so there is
 *    nothing to retire, and letting a streak accumulate on it would arm a
 *    retirement for a rule somebody might later re-open — which would then close
 *    itself again on the next removal, for reasons dated before the re-opening.
 *
 * 2. A SHORT OUTSIDE THE WINDOW COUNTS FOR NOTHING. This is the case the owner
 *    called out as a bug in the flat design: correcting the label on an old
 *    Short is tidying the back catalogue, and it says nothing whatever about
 *    what the channel is publishing now. Under the flat model there was no way
 *    to tell those two acts apart; under rules it is the coverage check, and it
 *    is the first thing this function does.
 *
 * 3. A SHORT OLDER THAN THE STREAK'S START neither grows the streak nor resets
 *    it. The streak reads FORWARD from where it began — it is evidence that the
 *    channel changed at a point in time and has stayed changed — so three
 *    removals walking backwards through 2023 are three separate corrections to
 *    old work, not a run. It does not reset either: an old correction is no more
 *    evidence AGAINST the switch than for it, and treating it as a confirmation
 *    would let routine back-catalogue tidying keep a dead rule alive forever.
 */
export function recordOverride(
  rule: RuleStreakState,
  publishedAt: number,
): RuleStreakChange | null {
  if (rule.effectiveUntil !== null) return null;
  if (!ruleCoversPublishDate(rule, publishedAt)) return null;

  const streakFrom = rule.overrideStreakFrom;
  if (streakFrom !== null && publishedAt <= streakFrom) return null;

  const from = streakFrom ?? publishedAt;
  const consecutiveOverrides = rule.consecutiveOverrides + 1;

  return {
    consecutiveOverrides,
    overrideStreakFrom: from,
    // Kept at the streak's start, and note it is NOT reset by the close: the
    // count and the date are the evidence for the retirement, and a rule that
    // forgot why it retired could not explain itself on the channel page. They
    // are cleared by re-opening, which is the act that says the evidence was
    // wrong.
    closesAt: consecutiveOverrides >= RULE_AUTO_CLOSE_STREAK ? from : null,
  };
}

/**
 * A person put this rule's tag back on a Short the rule covers.
 *
 * The counter-evidence, and the only thing that clears a streak short of
 * re-opening the rule by hand. Somebody has looked at an upload NEWER than the
 * point the rule was supposedly wrong from and said the rule is right about it,
 * which is exactly the claim the streak was accumulating against.
 *
 * NEWER, strictly. Restoring the tag on a Short older than the streak's start is
 * back-catalogue work again and is symmetrical with the third refusal above: it
 * is not evidence about the recent direction in either direction, so it leaves
 * the streak exactly where it is.
 *
 * A CLOSED RULE IS NOT RE-OPENED BY THIS. Tagging one Short after the rule
 * retired writes a manual row on that Short and means what it says — this Short
 * is a Ranking — whereas re-opening means "and so is everything the channel
 * publishes from here". Inferring the second from the first would undo a
 * retirement the team was told about, without telling them. Re-opening is its
 * own action, offered on the toast that announced the close and on the channel.
 */
export function recordConfirmation(
  rule: RuleStreakState,
  publishedAt: number,
): RuleStreakChange | null {
  if (rule.effectiveUntil !== null) return null;
  // Nothing accumulated: confirming a rule nobody has argued with writes nothing
  // and, since the service audits off these changes, logs nothing either.
  if (rule.consecutiveOverrides === 0 && rule.overrideStreakFrom === null) return null;
  if (!ruleCoversPublishDate(rule, publishedAt)) return null;

  const streakFrom = rule.overrideStreakFrom;
  if (streakFrom !== null && publishedAt <= streakFrom) return null;

  return { consecutiveOverrides: 0, overrideStreakFrom: null, closesAt: null };
}
