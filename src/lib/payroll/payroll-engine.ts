/**
 * =========================================================================
 * PAYROLL CALCULATION
 * =========================================================================
 *
 * Pure and isomorphic, like the analytics engine it sits beside: no I/O, no
 * Prisma, no clock. Everything it needs arrives as arguments — `nowMs`
 * included — so the same function that renders a live preview in the browser
 * produces the figure that gets finalized on the server, and the two cannot
 * disagree.
 *
 * ONE DEFINITION OF A HIT
 * This module does not decide what a hit is. `evaluateHit` from the analytics
 * engine does: `hitThreshold` views reached within `hitWindowHours` of
 * publishing, both read from the niche. That is the identical function the
 * dashboard, the charts and the PDF report ask, and payroll additionally picks
 * the niche that judges an ambiguous Short with the engine's own
 * `pickGoverningRule` rather than a ranking of its own. Payroll asks the same
 * question the rest of the product asks, in the same words; it just attaches
 * money to the answer.
 *
 * This import used to be `isHit(views, threshold)` — a comparison of LIFETIME
 * views against a fixed bar, with no notion of age. It changed shape because
 * the definition did, and it changed here rather than being reimplemented,
 * because a payroll that judged hits by its own copy of the rule is how the
 * screen and the payslip start disagreeing about the same Short.
 *
 * A NICHE NEEDS BOTH HALVES OF THE RULE
 * A threshold with no window is the old age-biased comparison wearing the new
 * vocabulary; a window with no threshold has nothing to measure. Either way
 * nothing in that niche can be scored, `resolveHitRule` returns null, and no
 * bonus can arise from a rule nobody finished writing. There is deliberately no
 * organization default to fall back to for either half: payroll learned that
 * lesson expensively when substituting the default threshold paid real money
 * for hits the rest of the product had already said it could not measure.
 *
 * BECAUSE THAT COSTS SOMEBODY MONEY, IT IS NOT SILENT
 * `skippedNiches` names every niche that had Shorts in it and no usable rule,
 * says WHICH HALF is missing, and counts what went unjudged. The payroll screen
 * shows that to an admin BEFORE they finalize. A bonus that quietly disappears
 * and a bonus that disappears with a named reason are different events, and
 * only the second one can be fixed.
 *
 * A HIT IS PAID IN THE PERIOD IT RESOLVES
 * Not the period it was published in. A Short published on 28 January with a
 * seven-day window resolves on 4 February and is paid in February's run.
 * Crediting by publish date under a windowed rule would mean anything published
 * near the end of a month could never earn its bonus — the window would still
 * be open when the month was frozen — which is the unfairness that prompted
 * this change. So the period's hits are the Shorts whose window CLOSED inside
 * it, whenever they were published.
 *
 * BUT A SHORT PAYS ONCE, EVER, AND A DATE CANNOT PROMISE THAT
 * That resolution date MOVES. `reevaluateHitsForNiche` rewrites the recorded
 * rule whenever an admin edits the niche, so a Short that closed on 4 February
 * under GTA's 168-hour rule closes on 6 March once GTA is set to 900 hours.
 * February is finalized and correctly frozen, so its `PayrollHit` rows survive —
 * and March's open run would credit the same videoId to the same person a
 * second time, in real money. `@@unique([recordId, videoId])` cannot see it:
 * that constraint spans ONE record, and these are two.
 *
 * So the guard is not a recomputed date, it is the ledger of what has actually
 * been paid. `alreadyPaidVideoIds` on each employee is every Short already
 * credited to THAT PERSON in a FINALIZED period, and the attribution loop
 * refuses to credit one of them again.
 *
 * ONLY FINALIZED CREDITS ARE PERMANENT. A draft period recalculates on every
 * read by design, so one Short can legitimately move between two DRAFT periods
 * as its rule changes — neither has paid anything, and freezing it against a
 * draft would let whichever month happened to be read first win. Nothing enters
 * this ledger until a period is frozen.
 *
 * AND THE SKIP IS NOT HIDDEN. `unresolved.alreadyPaidCount` names it beside
 * pending and unknown, because "already paid in February" and "it missed"
 * produce the same smaller total and call for opposite reactions — one is an
 * explanation, the other is a reason to go looking.
 *
 * PAYROLL READS THE STORED VERDICT, IT DOES NOT RE-DERIVE ONE
 * The evaluator owns the verdict; that is why it is materialised. "hit" and
 * "miss" are frozen there forever, because a miss inferred from "the lifetime
 * total is still under the bar" stays sound after the Short creeps past the bar
 * and re-deriving it later turns a certain miss into an "unknown". Payroll used
 * to rebuild one observation from the stored row and run the evaluator again,
 * which thawed exactly that. It now reads the stored outcome whenever the row
 * was decided under the very rule being applied — see `storedVerdictFor`, which
 * also says which single case still has to be evaluated and why the row cannot
 * answer it.
 *
 * PENDING AND UNKNOWN EARN NOTHING, AND THEY ARE NOT THE SAME NOTHING
 * A pending Short's window is still open; it will earn when it resolves. An
 * unknown Short's window shut while nobody was recording and it is over the bar
 * today, so there is no honest way to say whether it took two days or two
 * years — it will never earn. One is a wait and the other is a loss, and
 * `unresolved` reports them separately because whoever runs payroll needs to
 * know which they are looking at.
 *
 * WHAT COUNTS, AND WHY
 *   • Only Shorts from channels Northstar OWNS. Paying an editor a bonus
 *     because a competitor went viral would be absurd, and the ownership flag
 *     that decides it is the one already on TrackedChannel.
 *   • Only Shorts whose window closed inside the period, on the same half-open
 *     [start, end) convention every other date range here uses.
 *   • Only niches the person is assigned to.
 *   • Each Short at most once per person, EVER — not merely once per period.
 *     `attributeShort`'s ordering is period-independent so a Short cannot
 *     resolve into two different months on its own, and the frozen ledger
 *     catches the case where an admin's edit moves it anyway.
 *
 * A Short CAN pay two different people. If a Head of Shorts and an editor are
 * both assigned to GTA, one GTA hit earns both of them their own rate. That is
 * the intended reading of the brief, and the reason "no double counting" is
 * scoped to one person's record rather than to the Short globally.
 */

import {
  evaluateHit,
  isFinalOutcome,
  missingHitRuleHalf,
  pickGoverningRule,
  resolveHitRule,
  windowClosesAt,
  type HitOutcome,
  type HitRule,
  type HitVerdict,
  type MissingHitRuleHalf,
  type NicheHitRule,
  type WindowObservation,
} from "@/lib/analytics/hit-rate";

// ---------------------------------------------------------------------------
// INPUTS
// ---------------------------------------------------------------------------

export interface PayrollNiche {
  readonly id: string;
  readonly name: string;
  /**
   * Null means NOBODY HAS SET ONE, and therefore that nothing in this niche can
   * be a hit — not "inherit the organization default". See the note at the top:
   * substituting a number here is what paid bonuses the product had already
   * said it could not measure.
   */
  readonly hitThreshold: number | null;
  /**
   * How long a Short has to reach the threshold, in hours. Null means the same
   * thing the null above means: unset, and therefore unscoreable.
   *
   * Half a rule is not a rule. A niche with a threshold and no window would
   * fall back to comparing lifetime views — the exact age-biased number this
   * whole change exists to remove — so it scores nothing at all instead.
   */
  readonly hitWindowHours: number | null;
}

export interface PayrollEmployee {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly salaryMinor: number;
  readonly hitPaymentMinor: number;
  readonly currency: string;
  /** Niches this person is assigned to. No assignments means no bonuses. */
  readonly nicheIds: readonly string[];
  readonly joinedOnMs: number | null;
  readonly employmentEndedOnMs: number | null;
  /**
   * Shorts already credited to THIS PERSON in a FINALIZED period.
   *
   * The ledger, not a derivation: `PayrollHit` rows joined to frozen
   * `PayrollRecord`s are the record of money that has actually been paid, and
   * they are the only thing that can say a Short has been paid once its
   * resolution date has moved out from under it. See the note at the top.
   *
   * PER PERSON, because the bonus is. A Head of Shorts and an editor both
   * assigned to GTA each earn their own rate for one GTA hit, so paying Alex in
   * February says nothing about whether John may still be credited in March.
   * A global set of paid videoIds would silently cancel the second person's
   * bonus, which is a different bug in the same family.
   *
   * FINALIZED ONLY. A draft is recalculated on every read and has paid nobody,
   * so a Short moving between two drafts as its rule changes is correct
   * behaviour and must not be frozen out by this list.
   *
   * Empty is the ordinary case: a new employee, or an organization with no
   * finalized period behind it.
   */
  readonly alreadyPaidVideoIds: readonly string[];
}

/**
 * The stored `VideoHitEvaluation` row for a Short, if there is one.
 *
 * THE VERDICT, AND THE EVIDENCE THAT PRODUCED IT. It used to carry only the
 * evidence, on the reasoning that feeding `evaluateHit` the same inputs must
 * reproduce the same outcome. It does not, and that was the bug: the row's
 * evidence is not the evaluator's evidence. A miss inferred from "the lifetime
 * total is still under the bar" stores a null `viewsAtWindow` because nothing
 * was ever seen, so payroll re-ran the evaluator with no observations at all,
 * against TODAY's lifetime count — and once the Short crept past the bar a
 * settled miss came back "unknown". The verdict is here now because payroll's
 * job is to READ it. See `storedVerdictFor`.
 *
 * The evidence stays, because there is exactly one question the row cannot
 * answer: payroll narrows to the niches THIS PERSON is assigned to, and when
 * that picks a different niche from the one the row was decided under, no
 * verdict for that rule exists to read. `storedVerdictFor` says why, and that
 * case — and only that case — is evaluated from these fields.
 *
 * Every field but `outcome` is nullable because the column is: on this account
 * `video_snapshots` holds two capture events three days apart and only 59
 * Shorts have any reading inside seven days of publishing, so "nobody was
 * recording" is the ordinary case and not an error state. `outcome` is not
 * nullable — a row exists precisely because something was decided.
 */
export interface PayrollHitEvidence {
  /**
   * What the evaluator decided. Never re-derived here while it is final.
   *
   * "unknown" with a null `thresholdApplied` is the unscoreable row rather than
   * a verdict: the Short's channel sat in no niche with a complete rule.
   */
  readonly outcome: HitOutcome;
  /** The niche whose rule the stored row was decided under. */
  readonly nicheId: string | null;
  /** The rule as it stood at the close, copied rather than referenced. */
  readonly thresholdApplied: number | null;
  readonly windowHoursApplied: number | null;
  /**
   * When the evaluator's window shut — its own close, not one recomputed here.
   *
   * This is the field that decides which period pays a hit, so reading it back
   * rather than recalculating it is the difference between quoting the verdict
   * and re-deciding it. Null only where no rule applied and there was no window
   * to close.
   */
  readonly windowClosesAtMs: number | null;
  /** The snapshot nearest the window's close. */
  readonly viewsAtWindow: number | null;
  readonly observedAtHours: number | null;
}

export interface PayrollShort {
  readonly videoId: string;
  readonly title: string;
  readonly channelId: string;
  readonly channelName: string;
  /** The current lifetime counter. See `PayrollHitEvidence` for how it is used. */
  readonly views: number;
  readonly publishedAtMs: number;
  /** Every niche this Short's channel belongs to. */
  readonly nicheIds: readonly string[];
  /** False for competitor channels, which never earn a bonus. */
  readonly isOwnChannel: boolean;
  /** The materialised evaluation for this Short, or null when none exists yet. */
  readonly evaluation: PayrollHitEvidence | null;
}

export interface PayrollPeriodWindow {
  readonly year: number;
  /** 1-12. */
  readonly month: number;
  readonly startsAtMs: number;
  /** Exclusive. */
  readonly endsAtMs: number;
}

// ---------------------------------------------------------------------------
// OUTPUTS
// ---------------------------------------------------------------------------

export interface QualifyingHit {
  readonly videoId: string;
  readonly title: string;
  readonly channelId: string;
  readonly channelName: string;
  /** The niche the hit was credited to — see `attributeShort`. */
  readonly nicheId: string;
  readonly nicheName: string;
  readonly thresholdApplied: number;
  /**
   * The clock half of the rule this hit was judged under.
   *
   * Travels with the threshold everywhere the threshold goes. "500,000 views"
   * is not a standard and "500,000 views in seven days" is; printing the first
   * without the second on a payslip would describe a rule that does not exist.
   */
  readonly windowHoursApplied: number;
  /**
   * When the window shut — which is when the Short resolved, and therefore
   * which period pays it. The reason a December Short can appear on January's
   * run, and the field a screen needs to explain that rather than look wrong.
   */
  readonly windowClosesAtMs: number;
  /** The lifetime counter at the moment of the run. */
  readonly views: number;
  /** What was actually seen inside the window, when anything was. */
  readonly viewsAtWindow: number | null;
  /** How old the Short was at that reading. The honesty column. */
  readonly observedAtHours: number | null;
  readonly publishedAtMs: number;
}

export interface NicheBreakdown {
  readonly nicheId: string;
  readonly nicheName: string;
  readonly thresholdApplied: number;
  readonly windowHoursApplied: number;
  readonly hitCount: number;
  readonly bonusMinor: number;
}

/**
 * A niche that had Shorts in it and no usable rule to judge them by.
 *
 * The counterpart to `NicheBreakdown`: that one says what was paid, this one
 * says what could not even be asked. Both are needed to read a payroll run,
 * because a niche missing from the breakdown looks exactly like a niche where
 * nothing happened, and one of those is an admin's job to fix.
 *
 * `missing` names WHICH HALF is absent, because "set a threshold" and "set a
 * window" are two different fields and an admin told only that something is
 * unconfigured has to go and find out which. A niche with a threshold and no
 * window is exactly as unscoreable as one with neither — this is the case the
 * earlier round of this notice could not express, since back then a threshold
 * was the whole rule.
 *
 * `shortCount` counts DISTINCT Shorts that were not considered — published in
 * the period, on an owned channel, filed under this niche, and not credited
 * through some other niche that did have a rule. A Short that earned a bonus
 * elsewhere was considered; counting it here would overstate what the missing
 * rule cost.
 *
 * PUBLISHED IN THE PERIOD, not resolved in it, and that is not an oversight.
 * Without a window there is no `windowClosesAt` to compute, so there is no
 * honest answer to "which period would this have resolved into" — the Shorts
 * that can be named are the ones published in the month, which is also the
 * population an admin recognises when they look at it.
 *
 * One Short filed under two unusable niches is counted once in each, so summing
 * `shortCount` across niches can exceed the number of Shorts involved. The
 * per-niche figure is the one that means something — it is what changes when
 * somebody finishes configuring THAT niche.
 */
export interface SkippedNiche {
  readonly nicheId: string;
  readonly nicheName: string;
  readonly missing: MissingHitRuleHalf;
  readonly shortCount: number;
}

/**
 * Shorts that resolved into this period and earned nothing in it.
 *
 * DISTINCT SHORTS, and the counts are deliberately not summed anywhere:
 *
 *   `pendingCount`    — the window is still open. It closes inside this period,
 *                       so this run will pay it once it does; the figure on
 *                       screen is an estimate that can still go up. A WAIT.
 *   `unknownCount`    — the window shut with nobody recording and the Short is
 *                       over the bar today, so it cleared the threshold at some
 *                       point and nothing can say whether that took two days or
 *                       two years. It will never pay. A LOSS.
 *   `alreadyPaidCount`— it was credited to this person in a FINALIZED period
 *                       and its resolution date has since moved into this one,
 *                       because an admin changed the niche's window. A Short
 *                       pays once, ever, so it earns nothing here. NEITHER A
 *                       WAIT NOR A LOSS: the money was paid, in the month that
 *                       paid it.
 *
 * Reported rather than folded into "0 hits" because all three produce the same
 * zero and call for different reactions: "wait for the 1st", "this is what not
 * collecting snapshots costs, and it is permanent", and "this bonus is not
 * missing, it is on an earlier payslip".
 *
 * That last one is why the third count lives here rather than being dropped.
 * A run that credits fewer hits than an admin expected must be explicable at
 * the moment they are looking at it — a silent skip is indistinguishable from
 * the double payment it prevents, and both look like the engine miscounting.
 */
export interface UnresolvedShorts {
  readonly pendingCount: number;
  readonly unknownCount: number;
  readonly alreadyPaidCount: number;
}

export interface PayrollCalculation {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly role: string;
  readonly currency: string;

  readonly employedDuringPeriod: boolean;

  readonly baseSalaryMinor: number;
  readonly hitPaymentMinor: number;
  readonly hitCount: number;
  readonly hitBonusMinor: number;
  readonly totalMinor: number;

  /** Per-niche, so the breakdown reads "GTA 120 × $10" rather than one number. */
  readonly byNiche: readonly NicheBreakdown[];
  /** Every Short that earned a bonus, for the audit trail. */
  readonly hits: readonly QualifyingHit[];
  /**
   * What this figure could NOT take into account, and why.
   *
   * Empty for anybody whose niches all carry a complete rule, which is the
   * ordinary case once the account is configured. Non-empty means this person's
   * bonus is smaller than it looks like it should be, for a reason that is a
   * configuration gap rather than their work.
   */
  readonly skippedNiches: readonly SkippedNiche[];
  /** Their Shorts still waiting on a verdict, and the ones that lost one. */
  readonly unresolved: UnresolvedShorts;
}

// ---------------------------------------------------------------------------
// PERIODS
// ---------------------------------------------------------------------------

/**
 * The calendar month containing `atMs`, in UTC.
 *
 * UTC rather than local time so a period's boundaries do not shift with the
 * viewer's timezone — August has to mean the same thing to everyone looking at
 * the same payroll run.
 */
export function periodForMonth(year: number, month: number): PayrollPeriodWindow {
  const startsAtMs = Date.UTC(year, month - 1, 1);
  const endsAtMs = Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1);
  return { year, month, startsAtMs, endsAtMs };
}

export function periodContaining(atMs: number): PayrollPeriodWindow {
  const date = new Date(atMs);
  return periodForMonth(date.getUTCFullYear(), date.getUTCMonth() + 1);
}

/** The month before this one. */
export function previousPeriod(period: PayrollPeriodWindow): PayrollPeriodWindow {
  return period.month === 1
    ? periodForMonth(period.year - 1, 12)
    : periodForMonth(period.year, period.month - 1);
}

/** Payment lands on the first day of the following month. */
export function payDateFor(period: PayrollPeriodWindow): number {
  return period.endsAtMs;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function periodLabel(period: PayrollPeriodWindow): string {
  return `${MONTHS[period.month - 1]} ${period.year}`;
}

/** Half-open [start, end), the convention every date range in this codebase uses. */
function withinPeriod(atMs: number, period: PayrollPeriodWindow): boolean {
  return atMs >= period.startsAtMs && atMs < period.endsAtMs;
}

// ---------------------------------------------------------------------------
// CALCULATION
// ---------------------------------------------------------------------------

/**
 * Was this person employed at any point during the period?
 *
 * Salary is a flat monthly figure and is deliberately NOT pro-rated — the brief
 * describes it as fixed, and inventing a daily rate would produce numbers
 * nobody agreed to. Somebody employed for part of the month is paid in full;
 * somebody who had left before it started, or joins after it ends, is not on
 * the run at all.
 */
function employedDuring(employee: PayrollEmployee, period: PayrollPeriodWindow): boolean {
  if (employee.joinedOnMs !== null && employee.joinedOnMs >= period.endsAtMs) return false;
  if (employee.employmentEndedOnMs !== null && employee.employmentEndedOnMs < period.startsAtMs) {
    return false;
  }
  return true;
}

/**
 * The rule that judges this Short in this niche, or null when there isn't one.
 *
 * THE RECORDED RULE WINS OVER TODAY'S SETTINGS. When the stored evaluation was
 * decided under this same niche it carries the threshold and window as they
 * stood when the window shut, and those are what this Short was actually judged
 * by. An admin moving GTA from seven days to fourteen in March must not rewrite
 * what February's Shorts achieved, must not move a resolution date from one
 * payroll period into another, and must not make a bonus already paid under the
 * seven-day rule inexplicable. `PayrollHit` keeps `thresholdAtRun` for exactly
 * this reason; this is the same property, extended to the half of the rule the
 * table has no column for.
 *
 * Falls back to the niche's current configuration when there is no stored
 * evaluation, when it was decided under a different niche, or when it predates
 * the rule being recorded. That fallback is the live case — a period still open
 * over Shorts nobody has evaluated yet — not an edge case.
 */
function ruleFor(niche: PayrollNiche, evidence: PayrollHitEvidence | null): HitRule | null {
  if (evidence !== null && evidence.nicheId === niche.id) {
    const recorded = resolveHitRule({
      hitThreshold: evidence.thresholdApplied,
      hitWindowHours: evidence.windowHoursApplied,
    });
    if (recorded !== null) return recorded;
  }
  return resolveHitRule(niche);
}

/**
 * Could this person earn a hit bonus at all, before any Short is looked at?
 *
 * Employment, an assignment and a rate are the three preconditions, and they
 * are checked in one place because the skipped-niche report has to use exactly
 * the same test as the bonus itself. Reporting "14 Shorts were not counted for
 * Alex" about somebody who has no per-hit rate — and would therefore have been
 * paid nothing either way — would raise an alarm about money that was never at
 * stake.
 */
function canEarnBonus(employee: PayrollEmployee, period: PayrollPeriodWindow): boolean {
  return (
    employedDuring(employee, period) &&
    employee.nicheIds.length > 0 &&
    employee.hitPaymentMinor > 0
  );
}

/** What one Short did under the niche that judges it for this person. */
interface ShortJudgement {
  /** The niche whose rule decided it, and the verdict. Null when none could. */
  readonly judged: { readonly niche: PayrollNiche; readonly verdict: HitVerdict } | null;
  /** Assigned niches that could not judge it, because their rule is half-written. */
  readonly unscoreableNicheIds: readonly string[];
}

/**
 * The verdict already reached for this Short under this exact rule, or null.
 *
 * PAYROLL READS A VERDICT, IT DOES NOT MAKE ONE. `evaluateHit` is where a
 * verdict is made — once, on the server, from the whole snapshot series — and
 * `VideoHitEvaluation` is where it is kept so that nothing has to make it
 * twice. This module used to rebuild a single observation from that row and run
 * the evaluator again over it, which is not reproducing a verdict; it is
 * holding a second opinion, formed from strictly worse evidence.
 *
 * AND IT THAWED WHAT THE EVALUATOR FROZE. A miss reached by "the lifetime total
 * is still under the bar" stores a null `viewsAtWindow`, because nothing was
 * ever seen. Payroll therefore passed no observations at all and re-evaluated
 * against TODAY's lifetime count — so the moment the Short crept past the
 * threshold, a settled miss came back as "unknown". That is the exact decay
 * `isFinalOutcome` exists to prevent, arriving through payroll's back door and
 * changing which Shorts a run reports as permanently lost.
 *
 * FINAL VERDICTS ONLY, on the evaluator's own line rather than a second one
 * drawn here. "hit" and "miss" are statements about a window that has already
 * shut and never change. "pending" and "unknown" are re-decided on every
 * evaluator run — the first because time settles it, the second because
 * evidence can arrive — so reading a stale one back would be its own kind of
 * freezing, and worse than the recomputation it replaced: a period would report
 * a Short as still waiting long after its window closed, purely because the
 * cron had not run. Those two are evaluated, as before.
 *
 * WHAT THE ROW CANNOT ANSWER, SAID PLAINLY RATHER THAN COMPUTED AROUND.
 * `VideoHitEvaluation` is unique per (organization, video): ONE verdict per
 * Short, decided under the niche `pickGoverningRule` chose from every niche the
 * channel is filed under. Payroll asks a narrower question — the niches THIS
 * PERSON is assigned to — and when that narrowing picks a different niche, no
 * verdict for that rule exists anywhere to be read. What payroll would need is
 * a stored verdict per (video, niche); the schema keeps one per video. So that
 * case falls through to `evaluateHit` over the one reading the row does carry,
 * and it is the only case that does.
 */
function storedVerdictFor(short: PayrollShort, governing: NicheHitRule): HitVerdict | null {
  const evidence = short.evaluation;
  if (evidence === null) return null;
  if (evidence.nicheId !== governing.nicheId) return null;
  if (!isFinalOutcome(evidence.outcome)) return null;

  // The stored rule must BE the rule being applied, not merely a rule for the
  // same niche. `ruleFor` prefers the recorded pair, so in the ordinary case
  // these agree by construction; where they cannot — a row written before the
  // rule was recorded — the stored outcome answers a question about a different
  // bar, and quoting it would be the fork this whole arrangement prevents.
  if (evidence.thresholdApplied !== governing.rule.threshold) return null;
  if (evidence.windowHoursApplied !== governing.rule.windowHours) return null;

  const applied = {
    thresholdApplied: governing.rule.threshold,
    windowHoursApplied: governing.rule.windowHours,
    // The evaluator's own close, read back rather than recalculated — this is
    // the field that decides which period pays. The fallback is the identical
    // arithmetic over the identical inputs and exists only because the column
    // is nullable: it is null for the unscoreable row, which carries no rule
    // and cannot reach past the two checks above.
    windowClosesAtMs:
      evidence.windowClosesAtMs ?? windowClosesAt(short.publishedAtMs, governing.rule.windowHours),
  };

  if (evidence.outcome === "hit") {
    // A hit is only ever declared from something that was seen, so both fields
    // are present on every hit row the evaluator writes. Narrowed rather than
    // asserted away: a row that contradicts itself falls back to being
    // evaluated, which is what happens to every Short with no stored verdict.
    if (evidence.viewsAtWindow === null || evidence.observedAtHours === null) return null;
    return {
      ...applied,
      outcome: "hit",
      viewsAtWindow: evidence.viewsAtWindow,
      observedAtHours: evidence.observedAtHours,
    };
  }

  return {
    ...applied,
    outcome: "miss",
    // Null here is the ordinary case AND the important one: it means the miss
    // was inferred from the lifetime total rather than observed, which is
    // precisely the verdict that must never be re-derived.
    viewsAtWindow: evidence.viewsAtWindow,
    observedAtHours: evidence.observedAtHours,
  };
}

/**
 * The readings this Short offers, from whatever has been materialised.
 *
 * At most one, and usually none: `VideoHitEvaluation` stores the reading its
 * own verdict rested on, not the whole series. `evaluateHit` discards a reading
 * taken outside the window itself, so handing it a snapshot chosen for a
 * different niche's clock is safe rather than something this module has to
 * check — which matters here, because that mismatch is the case this path
 * exists for.
 *
 * ONLY REACHED WHEN THERE IS NO VERDICT TO READ — see `storedVerdictFor`, which
 * runs first. This is the evidence for a question nobody has stored an answer
 * to: a rule this person's assignments picked that the evaluator did not, or an
 * outcome the evaluator itself re-decides on every run.
 */
function observationsFor(short: PayrollShort): readonly WindowObservation[] {
  const evaluation = short.evaluation;
  if (evaluation === null) return [];
  if (evaluation.viewsAtWindow === null || evaluation.observedAtHours === null) return [];
  return [{ views: evaluation.viewsAtWindow, atHours: evaluation.observedAtHours }];
}

/** The stored verdict where there is one, an evaluation where there is not. */
function verdictFor(
  short: PayrollShort,
  governing: NicheHitRule,
  nowMs: number,
): HitVerdict {
  const stored = storedVerdictFor(short, governing);
  if (stored !== null) return stored;

  return evaluateHit({
    publishedAtMs: short.publishedAtMs,
    rule: governing.rule,
    lifetimeViews: short.views,
    observations: observationsFor(short),
    nowMs,
  });
}

/**
 * Decides which niche judges a Short for this person, and what it decided.
 *
 * THE AMBIGUITY THIS RESOLVES
 * A channel can sit in several niches, and those niches can disagree about what
 * a hit is — a channel filed under both GTA (1M in 7 days) and The Last of Us
 * (500K in 48 hours) can clear one and not the other, and the two rules do not
 * even resolve on the same day. Something has to choose, and the choice has to
 * be the same every time the figure is recalculated or the payroll is not
 * reproducible.
 *
 * THE CHOICE IS NOT PAYROLL'S TO MAKE. `pickGoverningRule` in the analytics
 * engine makes it — lowest threshold, ties on niche id — and it is the same
 * function that decides which niche a stored `VideoHitEvaluation` is recorded
 * against. Payroll narrows the candidate list to the niches this person is
 * assigned to, because money only flows through those, and then defers. Two
 * rankings for one question is how a payslip and a dashboard start describing
 * the same Short differently.
 *
 * THE RANKING IS PERIOD-INDEPENDENT, AND THAT IS LOAD-BEARING. Nothing in it
 * mentions the period being calculated, so every run — January's, February's, a
 * re-run of either — reaches the same niche, the same rule and therefore the
 * same resolution date, and the Short lands in exactly one month for this
 * person. Rank by "whichever niche's window happens to fall inside the month I
 * am computing" and the same Short would be payable twice in two different
 * periods, with the `(record, video)` constraint powerless to notice, because
 * those are two different records.
 *
 * A niche with half a rule is not a candidate at all: it has nothing to clear
 * and nothing to rank. What that costs is reported separately, by
 * `collectSkippedNiches`, rather than smuggled in here as a zero.
 */
function judgeShort(
  short: PayrollShort,
  assignedNicheIds: ReadonlySet<string>,
  nicheById: ReadonlyMap<string, PayrollNiche>,
  nowMs: number,
): ShortJudgement {
  const candidates: NicheHitRule[] = [];
  const unscoreableNicheIds: string[] = [];

  for (const nicheId of short.nicheIds) {
    if (!assignedNicheIds.has(nicheId)) continue;

    const niche = nicheById.get(nicheId);
    if (!niche) continue;

    const rule = ruleFor(niche, short.evaluation);
    if (rule === null) unscoreableNicheIds.push(nicheId);
    else candidates.push({ nicheId, rule });
  }

  const governing = pickGoverningRule(candidates);
  if (governing === null) return { judged: null, unscoreableNicheIds };

  const niche = nicheById.get(governing.nicheId);
  // Unreachable: every candidate came out of the map two loops ago. Narrowed
  // rather than asserted away, because an assertion here would be the one place
  // a future refactor could turn a missing niche into a thrown payroll run.
  if (!niche) return { judged: null, unscoreableNicheIds };

  return {
    judged: { niche, verdict: verdictFor(short, governing, nowMs) },
    unscoreableNicheIds,
  };
}

/**
 * The Shorts a half-written rule left unjudged, grouped by the niche missing it.
 *
 * IN SCOPE means own channel and PUBLISHED in the period. Everywhere else in
 * this file the period is decided by when a Short resolved, but a niche with no
 * window has no resolution date to compute — that is precisely what it is
 * missing. Published-in-the-month is the only population that can be named, and
 * it is the one an admin recognises when they go and look.
 *
 * `judgedVideoIds` is every Short some assigned niche could actually rule on —
 * not merely the ones that paid. Those WERE considered, so they are not
 * evidence of anything missing: a Short filed under both GTA and an
 * unconfigured Science was judged by GTA's rule and would have been whatever
 * Science was set to, whether it went on to hit, miss, or resolve into a
 * different month. Counting it here would bill the missing rule for a Short it
 * never had a say over.
 */
function collectSkippedNiches(
  shorts: readonly PayrollShort[],
  relevantNicheIds: ReadonlySet<string>,
  nicheById: ReadonlyMap<string, PayrollNiche>,
  judgedVideoIds: ReadonlySet<string>,
  period: PayrollPeriodWindow,
): SkippedNiche[] {
  if (relevantNicheIds.size === 0) return [];

  const buckets = new Map<
    string,
    { name: string; missing: MissingHitRuleHalf; videoIds: Set<string> }
  >();

  for (const short of shorts) {
    if (!short.isOwnChannel) continue;
    if (!withinPeriod(short.publishedAtMs, period)) continue;
    if (judgedVideoIds.has(short.videoId)) continue;

    for (const nicheId of short.nicheIds) {
      if (!relevantNicheIds.has(nicheId)) continue;

      const niche = nicheById.get(nicheId);
      if (!niche) continue;

      const missing = missingHitRuleHalf(niche);
      if (missing === null) continue;

      const bucket = buckets.get(nicheId);
      // A Set rather than a counter, for the same reason the bonus loop keeps
      // one: a duplicated row in the input must not inflate the report either.
      if (bucket) bucket.videoIds.add(short.videoId);
      else buckets.set(nicheId, { name: niche.name, missing, videoIds: new Set([short.videoId]) });
    }
  }

  return [...buckets.entries()]
    .map(([nicheId, bucket]) => ({
      nicheId,
      nicheName: bucket.name,
      missing: bucket.missing,
      shortCount: bucket.videoIds.size,
    }))
    // Worst first, then by name so equal rows do not shuffle — the ordering
    // `summariseByNiche` uses, so the two lists read the same way.
    .sort((a, b) => b.shortCount - a.shortCount || a.nicheName.localeCompare(b.nicheName));
}

/**
 * Why a Short that resolved into this period earned nothing in it.
 *
 * Mutually exclusive by construction — one reason per Short — so the counts can
 * be read side by side without anybody wondering whether they overlap.
 */
type UncreditedReason = "pending" | "unknown" | "alreadyPaid";

/** Counts distinct Shorts by why they earned nothing. See `UnresolvedShorts`. */
function tallyUnresolved(reasons: Iterable<UncreditedReason>): UnresolvedShorts {
  let pendingCount = 0;
  let unknownCount = 0;
  let alreadyPaidCount = 0;
  for (const reason of reasons) {
    if (reason === "pending") pendingCount += 1;
    else if (reason === "unknown") unknownCount += 1;
    else alreadyPaidCount += 1;
  }
  return { pendingCount, unknownCount, alreadyPaidCount };
}

/**
 * What one person earned in one period.
 *
 * Deterministic given `nowMs`: the same inputs always produce the same figure,
 * which is what lets a finalized period be re-derived and checked rather than
 * taken on trust. `nowMs` is an argument rather than a `Date.now()` inside,
 * because the boundary between "pending" and everything else is a moment in
 * time and a function that reads the clock itself cannot be tested at it.
 */
export function calculateEmployeePayroll(options: {
  employee: PayrollEmployee;
  shorts: readonly PayrollShort[];
  niches: readonly PayrollNiche[];
  period: PayrollPeriodWindow;
  nowMs: number;
}): PayrollCalculation {
  const { employee, shorts, niches, period, nowMs } = options;

  const employed = employedDuring(employee, period);
  const assignedNicheIds = new Set(employee.nicheIds);
  const nicheById = new Map(niches.map((niche) => [niche.id, niche]));

  const hits: QualifyingHit[] = [];
  // Guards against a duplicated row in the input reaching the total twice. The
  // database's unique constraint is the real backstop; this makes the pure
  // function safe on its own terms too.
  const countedVideoIds = new Set<string>();
  // What this person has ALREADY been paid for, in a period that is frozen.
  // The (record, video) constraint cannot see across periods; this is what
  // does. See `PayrollEmployee.alreadyPaidVideoIds`.
  const alreadyPaidVideoIds = new Set(employee.alreadyPaidVideoIds);
  const unresolvedByVideoId = new Map<string, UncreditedReason>();
  // Every Short some assigned niche could rule on, whatever it ruled. Feeds the
  // skipped-niche report, which is about Shorts nothing could judge — not about
  // Shorts that were judged and lost, or judged into another month.
  const judgedVideoIds = new Set<string>();

  const eligible = canEarnBonus(employee, period);

  if (eligible) {
    for (const short of shorts) {
      if (!short.isOwnChannel) continue;
      if (countedVideoIds.has(short.videoId)) continue;

      const { judged } = judgeShort(short, assignedNicheIds, nicheById, nowMs);
      if (judged === null) continue;

      judgedVideoIds.add(short.videoId);
      const { niche, verdict } = judged;

      // THE PERIOD THE WINDOW CLOSED IN IS THE PERIOD THIS SHORT BELONGS TO,
      // whatever its verdict. A Short published on 28 December with a seven-day
      // window resolved on 4 January: January's run pays it if it hit, and
      // December's run says nothing about it either way. It is not skipped and
      // it is not missing — it is simply somebody else's month.
      if (!withinPeriod(verdict.windowClosesAtMs, period)) continue;

      // PAID ONCE, EVER — AND THE LEDGER SAYS SO, NOT THE DATE ABOVE.
      // `windowClosesAtMs` has just claimed this Short for this period, but
      // that date moves: an admin widening GTA's window rewrites the recorded
      // rule, and a Short February already paid for closes again in March.
      // February is frozen and its `PayrollHit` row survives, so without this
      // the same videoId is credited to the same person twice, in real money.
      // The recomputed date cannot notice — it is the thing that moved — so the
      // question is asked of what was actually paid instead.
      //
      // FINALIZED CREDITS ONLY. Two DRAFT periods may legitimately claim the
      // same Short as its rule changes; a draft recalculates on every read and
      // has paid nobody, so nothing enters this set until a period is frozen.
      //
      // CHECKED BEFORE THE OUTCOME, and reported rather than dropped. Whatever
      // it resolves to now, it can never pay again — so counting it as a wait
      // or as a loss would be false in both directions, and counting it
      // nowhere would leave a smaller total with no explanation on it.
      if (alreadyPaidVideoIds.has(short.videoId)) {
        unresolvedByVideoId.set(short.videoId, "alreadyPaid");
        continue;
      }

      if (verdict.outcome !== "hit") {
        // A miss is a judged, settled answer and needs no reporting. The other
        // two do: "pending" is a wait and "unknown" is a loss, and both look
        // identical to "0 hits" from outside. See `UnresolvedShorts`.
        if (verdict.outcome !== "miss") {
          unresolvedByVideoId.set(short.videoId, verdict.outcome);
        }
        continue;
      }

      countedVideoIds.add(short.videoId);
      hits.push({
        videoId: short.videoId,
        title: short.title,
        channelId: short.channelId,
        channelName: short.channelName,
        nicheId: niche.id,
        nicheName: niche.name,
        thresholdApplied: verdict.thresholdApplied,
        windowHoursApplied: verdict.windowHoursApplied,
        windowClosesAtMs: verdict.windowClosesAtMs,
        views: short.views,
        viewsAtWindow: verdict.viewsAtWindow,
        observedAtHours: verdict.observedAtHours,
        publishedAtMs: short.publishedAtMs,
      });
    }
  }

  // Integer arithmetic throughout — minor units, never a float.
  const baseSalaryMinor = employed ? employee.salaryMinor : 0;
  const hitCount = hits.length;
  const hitBonusMinor = hitCount * employee.hitPaymentMinor;

  const byNiche = summariseByNiche(hits, employee.hitPaymentMinor);

  // Only for somebody who could have been paid. For anybody else the bonus is
  // zero for a reason that has nothing to do with a rule, and saying "Shorts
  // were skipped" would point at the wrong problem.
  const skippedNiches = eligible
    ? collectSkippedNiches(shorts, assignedNicheIds, nicheById, judgedVideoIds, period)
    : [];

  return {
    userId: employee.userId,
    name: employee.name,
    email: employee.email,
    role: employee.role,
    currency: employee.currency,
    employedDuringPeriod: employed,
    baseSalaryMinor,
    hitPaymentMinor: employee.hitPaymentMinor,
    hitCount,
    hitBonusMinor,
    totalMinor: baseSalaryMinor + hitBonusMinor,
    byNiche,
    hits,
    skippedNiches,
    unresolved: tallyUnresolved(unresolvedByVideoId.values()),
  };
}

function summariseByNiche(
  hits: readonly QualifyingHit[],
  hitPaymentMinor: number,
): NicheBreakdown[] {
  const buckets = new Map<
    string,
    { name: string; threshold: number; windowHours: number; count: number }
  >();

  for (const hit of hits) {
    const existing = buckets.get(hit.nicheId);
    if (existing) {
      existing.count += 1;
    } else {
      buckets.set(hit.nicheId, {
        name: hit.nicheName,
        threshold: hit.thresholdApplied,
        windowHours: hit.windowHoursApplied,
        count: 1,
      });
    }
  }

  return [...buckets.entries()]
    .map(([nicheId, bucket]) => ({
      nicheId,
      nicheName: bucket.name,
      thresholdApplied: bucket.threshold,
      windowHoursApplied: bucket.windowHours,
      hitCount: bucket.count,
      bonusMinor: bucket.count * hitPaymentMinor,
    }))
    // Most-earning first, then by name so equal rows do not shuffle.
    .sort((a, b) => b.bonusMinor - a.bonusMinor || a.nicheName.localeCompare(b.nicheName));
}

/** The whole team's payroll for a period. */
export function calculatePayrollRun(options: {
  employees: readonly PayrollEmployee[];
  shorts: readonly PayrollShort[];
  niches: readonly PayrollNiche[];
  period: PayrollPeriodWindow;
  nowMs: number;
}): {
  period: PayrollPeriodWindow;
  calculations: readonly PayrollCalculation[];
  totalMinor: number;
  currency: string;
  /** What the run could not judge. See `SkippedNiche`. */
  skippedNiches: readonly SkippedNiche[];
  /** What the run is still waiting on, and what it has permanently lost. */
  unresolved: UnresolvedShorts;
} {
  const calculations = options.employees
    .map((employee) =>
      calculateEmployeePayroll({
        employee,
        shorts: options.shorts,
        niches: options.niches,
        period: options.period,
        nowMs: options.nowMs,
      }),
    )
    .filter((calculation) => calculation.employedDuringPeriod)
    .sort((a, b) => b.totalMinor - a.totalMinor || a.name.localeCompare(b.name));

  const scope = runScope(options, calculations);

  return {
    period: options.period,
    calculations,
    totalMinor: calculations.reduce((sum, calculation) => sum + calculation.totalMinor, 0),
    // Mixed currencies across a team would need converting before summing; the
    // caller is expected to keep one currency per organization, and the first
    // employee's is reported so the UI can label the total honestly.
    currency: calculations[0]?.currency ?? "USD",
    skippedNiches: scope.skippedNiches,
    unresolved: scope.unresolved,
  };
}

/**
 * The run's own reports, counted over DISTINCT Shorts.
 *
 * Not the sum of the per-employee lists. Two editors assigned to the same
 * unconfigured niche see the same Shorts go uncounted, and adding their figures
 * would tell an admin that twice as many Shorts were affected as exist. What
 * this answers is "how many Shorts could nobody be paid for", which is the
 * number that changes when the configuration is fixed or the window closes.
 *
 * Scoped to niches somebody could actually have earned from. A niche nobody is
 * assigned to costs no money whether or not it has a rule, and these banners
 * are about pay — the niches list is where an unassigned one gets chased.
 */
function runScope(
  options: {
    employees: readonly PayrollEmployee[];
    shorts: readonly PayrollShort[];
    niches: readonly PayrollNiche[];
    period: PayrollPeriodWindow;
    nowMs: number;
  },
  calculations: readonly PayrollCalculation[],
): { skippedNiches: SkippedNiche[]; unresolved: UnresolvedShorts } {
  const bonusEligibleNicheIds = new Set<string>();
  // The union of every frozen credit held by somebody who could have earned a
  // bonus here. Scoped to the same people as the niches above, for the same
  // reason: a Short paid to a leaver who is off this run costs it nothing and
  // is not this banner's business.
  const alreadyPaidVideoIds = new Set<string>();
  for (const employee of options.employees) {
    if (!canEarnBonus(employee, options.period)) continue;
    for (const nicheId of employee.nicheIds) bonusEligibleNicheIds.add(nicheId);
    for (const videoId of employee.alreadyPaidVideoIds) alreadyPaidVideoIds.add(videoId);
  }

  const creditedVideoIds = new Set<string>();
  for (const calculation of calculations) {
    for (const hit of calculation.hits) creditedVideoIds.add(hit.videoId);
  }

  const nicheById = new Map(options.niches.map((niche) => [niche.id, niche]));

  const judgedVideoIds = new Set<string>();
  const unresolvedByVideoId = new Map<string, UncreditedReason>();

  for (const short of options.shorts) {
    if (!short.isOwnChannel) continue;

    // Judged against the UNION of every bonus-eligible niche, which is what
    // makes this a run-level answer rather than the first employee's answer
    // repeated. `pickGoverningRule` is deterministic over that union, so two
    // admins looking at the same run see the same count.
    const { judged } = judgeShort(short, bonusEligibleNicheIds, nicheById, options.nowMs);
    if (judged === null) continue;

    judgedVideoIds.add(short.videoId);

    // Somebody was paid for it on THIS run, so it is not waiting on anything.
    if (creditedVideoIds.has(short.videoId)) continue;
    if (!withinPeriod(judged.verdict.windowClosesAtMs, options.period)) continue;

    // Nobody was paid for it here because somebody was already paid for it in a
    // frozen period. The run-level counterpart of the guard in the attribution
    // loop, and checked ahead of the outcome for the same reason: it is settled
    // money, not an unfinished window and not a lost one.
    if (alreadyPaidVideoIds.has(short.videoId)) {
      unresolvedByVideoId.set(short.videoId, "alreadyPaid");
      continue;
    }

    const outcome = judged.verdict.outcome;
    if (outcome === "pending" || outcome === "unknown") {
      unresolvedByVideoId.set(short.videoId, outcome);
    }
  }

  return {
    skippedNiches: collectSkippedNiches(
      options.shorts,
      bonusEligibleNicheIds,
      nicheById,
      judgedVideoIds,
      options.period,
    ),
    unresolved: tallyUnresolved(unresolvedByVideoId.values()),
  };
}
