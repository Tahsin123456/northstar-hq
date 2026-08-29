import type { JudgedVideo, ThresholdAnnotation } from "./types";
import { ratePercent } from "./stats";

/**
 * =========================================================================
 * WHAT A HIT IS
 * =========================================================================
 *
 * A hit is `threshold` views reached within `windowHours` of publishing.
 *
 * THIS FILE IS THE DEFINITION. Not a helper near it, not one of several ways of
 * asking — the one function every consumer calls, so the dashboard, the charts,
 * the report and payroll cannot drift apart. There is deliberately no second
 * module that also answers this question; a rule with two homes has two
 * versions the first time somebody edits one of them.
 *
 * WHY THE CLOCK EXISTS AT ALL
 * The old rule compared LIFETIME views to a fixed bar, with no notion of age.
 * Measured on this account's real corpus the same channels scored 5.9% for
 * Shorts under seven days old and 18.8% at 30–90 days — a 3x spread bought
 * entirely with the calendar, with nothing about the work changing. Under that
 * rule publishing more made the number fall, which is the opposite of what a
 * performance metric is for. Judging every Short over the same stretch of its
 * own life removes the age bias by construction rather than correcting for it
 * afterwards.
 *
 * PURE AND ISOMORPHIC, like everything else in this directory: no clock of its
 * own, no I/O, no Prisma. `nowMs` is an argument, which is what lets the server
 * and the browser agree and what lets a test move time without mocking it.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR OUTCOMES
 * ---------------------------------------------------------------------------
 *   "hit"     reached the bar inside the window. Either observed at the close,
 *             OR observed earlier and already past it — views only rise, so a
 *             Short over the bar on day two is a hit on day seven.
 *   "miss"    the window shut and it was short. ALSO reachable with no history
 *             at all: if the LIFETIME total today is still under the bar, it
 *             cannot have cleared it inside a window that closed in the past.
 *             That single inference judges 80% of the existing library — 1,530
 *             of 1,904 Shorts — without a snapshot anywhere near the close.
 *   "pending" the window is still open. In NEITHER half of the rate. This is
 *             the mechanism that removes the age bias: a three-day-old Short is
 *             not a miss, it is unfinished.
 *   "unknown" the window shut, nobody was recording, and it DID eventually pass
 *             the bar — so it may have taken two days or two years. 374 Shorts.
 *             Excluded and COUNTED: these are disproportionately the winners,
 *             so dropping them silently biases every rate downward while
 *             looking clean.
 *
 * "unknown" and "pending" are answers, not nulls to coerce. Nothing in this
 * file ever guesses one into a hit or a miss to make a denominator tidier.
 *
 * ---------------------------------------------------------------------------
 * THE LIFETIME HELPERS AT THE BOTTOM OF THIS FILE
 * ---------------------------------------------------------------------------
 * `clearsThreshold` and `annotateAgainstThreshold`, the one function built on
 * it, answer "are these views at or above this number" — the bar half of the
 * rule and nothing else. They are named for what they do rather than for what
 * they used to be called, because the function that used to live here was
 * called `isHit(views, threshold)` and that name is precisely how the calendar
 * got reported as if it were quality. Anything that wants a VERDICT calls
 * `evaluateHit`, which cannot be called without a window.
 *
 * THERE WAS A THIRD, AND IT IS GONE ON PURPOSE. `countAboveThreshold(shorts,
 * threshold)` counted lifetime views against a bar across a whole set — the
 * old rule's shape exactly, one call away from being read as a hit count. Its
 * last caller (the content-type table) moved to counting verdicts, after which
 * nothing but its own test referenced it, and a well-tested exported function
 * looks load-bearing to whoever comes next. It was the most likely surface for
 * the lifetime rule to grow back through, so it was deleted rather than left
 * lying around waiting to be convenient. Anything that needs a count of hits
 * counts verdicts: `tallyShorts`.
 */

/** Milliseconds in an hour. The window is expressed in hours; time is not. */
export const HOUR_MS = 3_600_000;

export type HitOutcome = "hit" | "miss" | "pending" | "unknown";

/**
 * What a Short contributes to a rate.
 *
 * The four verdicts, plus the population that had no rule to be judged by at
 * all — a Short whose channel sits in no configured niche. That is not a fifth
 * verdict and is never stored as one; it is a fifth THING TO COUNT, and it is
 * counted separately because an unjudgeable Short is not evidence of anything
 * except a niche somebody has to finish configuring.
 */
export type HitContribution = HitOutcome | "unscoreable";

/**
 * A complete rule: a bar AND a clock.
 *
 * Both, always. A niche with a threshold and no window has half a rule, and
 * half a rule is not a rule — it is the old lifetime comparison wearing the new
 * vocabulary, which is the exact thing being replaced. `resolveHitRule` is the
 * only way to build one of these, and it refuses to build a half.
 */
export interface HitRule {
  readonly threshold: number;
  readonly windowHours: number;
}

/** Which half of the rule a niche is missing, or null when it has both. */
export type MissingHitRuleHalf = "threshold" | "window" | "both";

/**
 * The two nullable columns on `Niche`, as any caller holds them.
 *
 * Structural rather than an import of the Prisma type, so the browser can call
 * this with a DTO and the server can call it with a row.
 */
export interface HitRuleSource {
  readonly hitThreshold: number | null;
  readonly hitWindowHours: number | null;
}

/**
 * The rule in force for a niche, or null when there isn't one.
 *
 * The null is the answer, not a gap to paper over. There is deliberately no
 * organization-default parameter to fall back to — payroll learned that lesson
 * expensively, paying real bonuses against a bar nobody had chosen — and a
 * default window would be the same mistake with a clock attached.
 *
 * A non-positive stored value is treated as unset. "0 views within 0 hours" is
 * not a rule anybody meant to write, and letting a zero through would make
 * every Short ever published an instantaneous hit.
 */
export function resolveHitRule(source: HitRuleSource): HitRule | null {
  const { hitThreshold, hitWindowHours } = source;
  if (hitThreshold === null || hitThreshold <= 0) return null;
  if (hitWindowHours === null || hitWindowHours <= 0) return null;
  return { threshold: hitThreshold, windowHours: hitWindowHours };
}

/**
 * Which half is missing, for a screen that has to say so.
 *
 * "This niche has no hit threshold" and "this niche has no hit window" send an
 * admin to two different fields. A single "not configured" would make them
 * guess, and the whole point of naming a configuration gap is that somebody can
 * close it without asking.
 */
export function missingHitRuleHalf(source: HitRuleSource): MissingHitRuleHalf | null {
  const noThreshold = source.hitThreshold === null || source.hitThreshold <= 0;
  const noWindow = source.hitWindowHours === null || source.hitWindowHours <= 0;

  if (noThreshold && noWindow) return "both";
  if (noThreshold) return "threshold";
  if (noWindow) return "window";
  return null;
}

/**
 * A niche's rule, carrying the niche it came from.
 *
 * The id travels with the rule because whoever stores a verdict has to record
 * WHICH niche produced it — a bonus paid months ago has to be explainable
 * against the bar that actually applied at the time.
 */
export interface NicheHitRule {
  readonly nicheId: string;
  readonly rule: HitRule;
}

/**
 * Which niche's rule judges a Short whose channel sits in several.
 *
 * THE LOWEST THRESHOLD WINS, ties broken on niche id so the answer is stable
 * whatever order the caller assembled the list in.
 *
 * THIS AGREES WITH `attributeShort` IN THE PAYROLL ENGINE ON PURPOSE. That
 * function credits a hit to the lowest-threshold niche the Short clears, on the
 * reasoning that a Short which genuinely is a Last of Us hit should not earn
 * nothing because the channel is also filed under a niche with a higher bar.
 * Picking the lowest bar *before* knowing the outcome reaches the identical
 * niche for every Short that is a hit at all — the minimum over a set does not
 * change when you first discard the members the Short failed to clear — and it
 * additionally gives a MISS a niche to be recorded against, which
 * `attributeShort` never needed and a stored evaluation does.
 *
 * Niches with only half a rule are not candidates. They have no bar to clear
 * and no bar to rank, and substituting one is how an unconfigured niche starts
 * producing numbers again.
 */
export function pickGoverningRule(
  candidates: readonly NicheHitRule[],
): NicheHitRule | null {
  let best: NicheHitRule | null = null;
  for (const candidate of candidates) {
    if (
      best === null ||
      candidate.rule.threshold < best.rule.threshold ||
      (candidate.rule.threshold === best.rule.threshold && candidate.nicheId < best.nicheId)
    ) {
      best = candidate;
    }
  }
  return best;
}

/** The instant a Short's window shuts. After this, its outcome cannot change. */
export function windowClosesAt(publishedAtMs: number, windowHours: number): number {
  return publishedAtMs + windowHours * HOUR_MS;
}

/** How old a Short was at an instant, in whole hours. Never negative. */
export function ageInHours(publishedAtMs: number, atMs: number): number {
  return Math.max(0, Math.floor((atMs - publishedAtMs) / HOUR_MS));
}

/**
 * The window as a person would say it: "7 days", "48 hours", "36 hours".
 *
 * Days where days are what somebody means — a 168-hour rule is a week and
 * calling it 168 hours on a payslip is technically true and humanly useless.
 * The column is hours because Shorts move fast enough that a 48-hour rule is a
 * reasonable thing for a team to want and a day-based column could not say it.
 */
export function formatHitWindow(windowHours: number): string {
  if (windowHours % 24 === 0) {
    const days = windowHours / 24;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  return `${windowHours} ${windowHours === 1 ? "hour" : "hours"}`;
}

/**
 * What was actually seen, and when.
 *
 * `atHours` is the honesty field. A reading taken at 6 hours on a 168-hour
 * window is a different quality of evidence from one taken at 167, and an
 * outcome shown without it overstates what the database knows.
 */
export interface WindowObservation {
  readonly views: number;
  /** Age of the Short at capture, in hours. */
  readonly atHours: number;
}

export interface HitEvidence {
  readonly publishedAtMs: number;
  readonly rule: HitRule;
  /**
   * Today's total, whatever it is now.
   *
   * Used in exactly one direction: to rule a hit OUT. Under the bar today means
   * never over it inside a window that has already closed, because views only
   * rise. It is never used to call a closed window a hit — that would be the
   * old lifetime rule, reintroduced through the back door.
   */
  readonly lifetimeViews: number;
  /**
   * Every reading available for this Short, in any order.
   *
   * The whole series rather than one pre-chosen snapshot, because *which*
   * reading decides is part of the rule and belongs in here with the rest of
   * it. A caller that had to pick the right one first would be holding half the
   * definition.
   *
   * Usually empty. On this account `video_snapshots` holds two capture events
   * three days apart, and only 59 Shorts (2.5%) have any reading inside seven
   * days of publishing.
   */
  readonly observations: readonly WindowObservation[];
  readonly nowMs: number;
}

/** The rule as it stood, copied onto every verdict rather than referenced. */
interface VerdictRule {
  readonly thresholdApplied: number;
  readonly windowHoursApplied: number;
  readonly windowClosesAtMs: number;
}

/**
 * The verdict, with the evidence that produced it.
 *
 * A DISCRIMINATED UNION RATHER THAN A BOOLEAN AND A FLAG. `pending` and
 * `unknown` are answers; a boolean forces every caller to invent a third state
 * badly, and a nullable boolean invites `?? false`, which is how "we do not
 * know" silently becomes "it missed". Narrowing on `outcome` also makes the
 * shape of the evidence follow the answer: a `pending` verdict has nothing
 * observed to report and cannot pretend otherwise.
 *
 * The rule is copied onto the result rather than referenced, because an admin
 * who moves a niche from seven days to fourteen in March must not silently
 * rewrite what February's Shorts achieved. Whoever stores this stores the rule
 * with it.
 */
export type HitVerdict =
  | (VerdictRule & {
      readonly outcome: "hit";
      /** Always present: a hit is only ever declared from something seen. */
      readonly viewsAtWindow: number;
      readonly observedAtHours: number;
    })
  | (VerdictRule & {
      readonly outcome: "miss";
      /** Null when the verdict was inferred from today's lifetime total. */
      readonly viewsAtWindow: number | null;
      readonly observedAtHours: number | null;
    })
  | (VerdictRule & {
      readonly outcome: "pending";
      readonly viewsAtWindow: null;
      readonly observedAtHours: null;
    })
  | (VerdictRule & {
      readonly outcome: "unknown";
      readonly viewsAtWindow: null;
      readonly observedAtHours: null;
    });

/**
 * THE definition of a hit. Everything in this product that decides whether
 * something hit asks this function, and it cannot be asked without a window.
 *
 * The order of the branches is the argument, so it is worth reading as one:
 *
 *  1. THE WINDOW IS STILL OPEN — "pending", unconditionally, even for a Short
 *     that is already over the bar today.
 *
 *     This is the branch people want to argue with, so: a Short that cleared
 *     the bar at hour 3 of a 168-hour window has demonstrably won, and calling
 *     it pending looks like throwing that away. It is not thrown away — the
 *     window shuts in six days and the snapshot taken at hour 3 makes it a hit
 *     then, permanently. What counting it TODAY would do is let the in-flight
 *     cohort contribute its winners and none of its unfinished siblings, so
 *     every recent period would read near 100%. That is the old age bias
 *     inverted, and the fix for an age bias cannot be another one.
 *
 *  2. WINDOW SHUT, AND SOMETHING WAS SEEN INSIDE IT AT OR OVER THE BAR. A hit,
 *     whether that reading came at hour 6 or hour 167 — this is the "over the
 *     bar on day two is a hit on day seven" case. Checked before the lifetime
 *     inference because it is direct evidence rather than a deduction, and
 *     checked across EVERY in-window reading rather than only the latest,
 *     because a view count can fall when YouTube purges inflated views and a
 *     Short that was over the bar on Tuesday was over it on Tuesday.
 *
 *  3. WINDOW SHUT, AND THE LIFETIME TOTAL IS STILL UNDER THE BAR. A miss, with
 *     certainty and with no history required: a Short that has not reached
 *     500,000 in eight months did not reach it in its first seven days. This
 *     one inference is what makes the metric computable on a library that was
 *     never being sampled.
 *
 *  4. WINDOW SHUT, SEEN INSIDE IT, AND SHORT AT THE LAST READING. A miss,
 *     observed rather than inferred. The LAST reading decides — a Short still
 *     behind at hour 167 is a much stronger statement than one behind at hour 6
 *     — and `observedAtHours` carries which it was so a screen can say so.
 *
 *  5. ANYTHING ELSE IS "unknown". The window shut, nobody was watching inside
 *     it, and the Short is over the bar TODAY — so it cleared at some point and
 *     there is no honest way to say whether that took two days or two years.
 */
export function evaluateHit(evidence: HitEvidence): HitVerdict {
  const { publishedAtMs, rule, lifetimeViews, observations, nowMs } = evidence;
  const { threshold, windowHours } = rule;

  const windowClosesAtMs = windowClosesAt(publishedAtMs, windowHours);
  const applied: VerdictRule = {
    thresholdApplied: threshold,
    windowHoursApplied: windowHours,
    windowClosesAtMs,
  };

  // 1. Unfinished. Not a miss, not yet a hit, and in neither half of the rate.
  if (nowMs < windowClosesAtMs) {
    return { ...applied, outcome: "pending", viewsAtWindow: null, observedAtHours: null };
  }

  // Readings taken inside the window are the only ones that can decide
  // anything. A snapshot at hour 400 of a 168-hour window says what the Short
  // did afterwards, which is exactly the question this rule refuses to answer.
  const inWindow = observations.filter(
    (observation) => observation.atHours >= 0 && observation.atHours <= windowHours,
  );

  // 2. Direct evidence, earliest first — the strongest form of the claim is
  // "it had already cleared by hour N", and the smallest N that is true is the
  // one worth recording.
  let earliestClearing: WindowObservation | null = null;
  for (const observation of inWindow) {
    if (!clearsThreshold(observation.views, threshold)) continue;
    if (earliestClearing === null || observation.atHours < earliestClearing.atHours) {
      earliestClearing = observation;
    }
  }
  if (earliestClearing !== null) {
    return {
      ...applied,
      outcome: "hit",
      viewsAtWindow: earliestClearing.views,
      observedAtHours: earliestClearing.atHours,
    };
  }

  // 3. The inference that rescues a library nobody was sampling.
  //
  // Note this is checked before the observed miss below, and the two agree
  // whenever both apply. It comes first because it is the branch that needs no
  // history at all, and putting it first is what makes it obvious that the
  // metric does not depend on the snapshot table being any good.
  if (!clearsThreshold(lifetimeViews, threshold)) {
    const latest = latestObservation(inWindow);
    return {
      ...applied,
      outcome: "miss",
      // Null unless something really was seen inside the window. Today's total
      // is not "what we saw at the window", and writing it into that column
      // would dress an inference up as a measurement.
      viewsAtWindow: latest?.views ?? null,
      observedAtHours: latest?.atHours ?? null,
    };
  }

  // 4. Seen inside the window and behind at the last look. Over the bar since,
  // but too late — which is the entire point of having a window.
  const latest = latestObservation(inWindow);
  if (latest !== null) {
    return {
      ...applied,
      outcome: "miss",
      viewsAtWindow: latest.views,
      observedAtHours: latest.atHours,
    };
  }

  // 5. It got there. Nobody can say when.
  return { ...applied, outcome: "unknown", viewsAtWindow: null, observedAtHours: null };
}

/** The reading closest to the window's close, or null when there are none. */
function latestObservation(
  observations: readonly WindowObservation[],
): WindowObservation | null {
  let latest: WindowObservation | null = null;
  for (const observation of observations) {
    if (latest === null || observation.atHours > latest.atHours) latest = observation;
  }
  return latest;
}

/**
 * True when the verdict can never change and must not be recomputed.
 *
 * "hit" and "miss" only. Both are statements about a window that has already
 * shut, and both stay true forever:
 *
 *   • a hit was seen over the bar inside the window, and that reading does not
 *     become false later;
 *   • a miss inferred from "lifetime is still under the bar" was sound when it
 *     was made and REMAINS sound after the Short later crosses the bar —
 *     views at the close were at most the total we saw, and that total was
 *     under it. Re-deriving that verdict a year later, when lifetime has since
 *     passed the threshold, would turn a certain miss into an "unknown". That
 *     is the concrete reason freezing is not merely an optimisation.
 *
 * "pending" becomes something else the moment the window shuts. "unknown" is
 * not frozen either: it is the absence of evidence, and evidence can arrive —
 * a backfilled snapshot series would settle a pile of them at once.
 */
export function isFinalOutcome(outcome: HitOutcome): boolean {
  return outcome === "hit" || outcome === "miss";
}

// ---------------------------------------------------------------------------
// THE VERDICT AS IT COMES BACK OUT OF THE DATABASE
// ---------------------------------------------------------------------------

/**
 * A verdict somebody already reached, as any reader holds it.
 *
 * `evaluateHit` above is how a verdict is MADE: once, on the server, from the
 * snapshot series. This is how one is READ — off a `VideoHitEvaluation` row, or
 * off the `VideoHitDTO` that ships it to the browser. Structural rather than an
 * import of either, for the same reason `HitRuleSource` is: one shape both
 * sides can satisfy, and no Prisma type in the isomorphic layer.
 *
 * NOTHING DOWNSTREAM RE-DERIVES A VERDICT FROM THIS. The client has neither the
 * snapshot series nor a clock it should be trusted with, and a second place
 * that turns evidence into an outcome is the fork this file exists to prevent.
 * Readers narrow on `outcome` and render; the evaluator owns the decision.
 */
export interface StoredHitVerdict {
  readonly outcome: HitOutcome;
  /**
   * The rule as it stood when the verdict was reached — NOT the niche's setting
   * today, which may have moved since.
   *
   * `null` on both halves is the unscoreable case: the Short's channel sat in
   * no niche with a complete rule, so the evaluator stored "unknown" with no
   * rule beside it. That pair of nulls is how every reader tells "nobody was
   * watching" apart from "nobody has configured this niche" — see
   * `hitContributionOf`, which is the one place that test is written.
   */
  readonly thresholdApplied: number | null;
  readonly windowHoursApplied: number | null;
  /** What was seen inside the window, on the occasions anything was. */
  readonly viewsAtWindow: number | null;
  readonly observedAtHours: number | null;
}

/**
 * What a Short contributes to a rate, given the verdict stored for it.
 *
 * THE MISSING ROW AND THE MISSING RULE BOTH LAND ON "unscoreable", and the
 * reasons differ enough to be worth stating. A `null` verdict means no
 * evaluation has been written for this Short yet — the evaluator runs on the
 * cron, so a Short synced ten minutes ago genuinely has no answer. A verdict
 * carrying `thresholdApplied === null` means it WAS looked at and there was no
 * rule to look at it with. Neither is a potential hit, and neither may widen
 * the bounds on the rate — which is precisely what `unscoreable` is for. The
 * DTO keeps the two distinguishable so a screen can name the right cause.
 */
export function hitContributionOf(
  verdict: StoredHitVerdict | null | undefined,
): HitContribution {
  if (!verdict) return "unscoreable";
  if (verdict.thresholdApplied === null || verdict.windowHoursApplied === null) {
    return "unscoreable";
  }
  return verdict.outcome;
}

/** Counts a set of Shorts by what their stored verdicts contribute. */
export function tallyShorts(shorts: readonly JudgedVideo[]): HitTally {
  return tallyContributions(shorts.map((short) => hitContributionOf(short.hit)));
}

/**
 * How close it got, measured where the rule actually looks.
 *
 * `viewsAtWindow / thresholdApplied`. `null` whenever there is no reading from
 * inside the window to be a ratio OF — which on this account is most Shorts,
 * because a miss inferred from "lifetime is still under the bar" never saw
 * anything. That null means "we cannot say how close it came", which is a
 * different and far more honest statement than a lifetime ratio wearing this
 * name would be.
 */
export function windowRatio(verdict: StoredHitVerdict | null | undefined): number | null {
  if (!verdict) return null;
  const { viewsAtWindow, thresholdApplied } = verdict;
  if (viewsAtWindow === null || thresholdApplied === null || thresholdApplied <= 0) {
    return null;
  }
  return viewsAtWindow / thresholdApplied;
}

// ---------------------------------------------------------------------------
// THE RATE
// ---------------------------------------------------------------------------

/**
 * A population of Shorts, split by what could be said about each one.
 *
 * Every field is carried through to the surface rather than collapsed, because
 * the exclusions are the story: a 22% hit rate over 40 judged Shorts with 374
 * unknowns thrown out is a different claim from 22% over 400, and a screen that
 * cannot tell them apart will be believed equally in both cases.
 */
export interface HitTally {
  readonly hits: number;
  readonly misses: number;
  readonly pending: number;
  readonly unknown: number;
  /** Shorts whose niche never had both halves of a rule. Not a verdict. */
  readonly unscoreable: number;
}

export const EMPTY_HIT_TALLY: HitTally = {
  hits: 0,
  misses: 0,
  pending: 0,
  unknown: 0,
  unscoreable: 0,
};

/** Counts a stream of contributions into a tally. */
export function tallyContributions(items: Iterable<HitContribution>): HitTally {
  let hits = 0;
  let misses = 0;
  let pending = 0;
  let unknown = 0;
  let unscoreable = 0;

  for (const item of items) {
    if (item === "hit") hits += 1;
    else if (item === "miss") misses += 1;
    else if (item === "pending") pending += 1;
    else if (item === "unknown") unknown += 1;
    else unscoreable += 1;
  }

  return { hits, misses, pending, unknown, unscoreable };
}

/** Adds two tallies. For rolling a per-channel breakdown up to a portfolio. */
export function addTallies(a: HitTally, b: HitTally): HitTally {
  return {
    hits: a.hits + b.hits,
    misses: a.misses + b.misses,
    pending: a.pending + b.pending,
    unknown: a.unknown + b.unknown,
    unscoreable: a.unscoreable + b.unscoreable,
  };
}

export interface HitRateSummary {
  /**
   * hits ÷ (hits + misses), as a percentage.
   *
   * `null` — never `0` — when nothing was judged. Returning `0` for an empty
   * denominator would assert "these Shorts were judged and none of them hit",
   * which is a completely different and false claim. The UI renders `null` as
   * an em dash for exactly this reason.
   */
  readonly rate: number | null;
  readonly hits: number;
  /** hits + misses. The only Shorts the rate is computed over. */
  readonly judged: number;
  /** pending + unknown + unscoreable. Shown, never hidden. */
  readonly excluded: number;
  readonly tally: HitTally;
  /**
   * THE RANGE THE TRUE RATE LIES IN, given what the unknowns might have been.
   *
   * Every unknown eventually passed the bar — that is what makes it an unknown
   * rather than a miss — so each one is a POTENTIAL hit whose timing nobody
   * recorded. `lowerBound` puts all of them in the denominator as though every
   * one took too long; `upperBound` counts every one as a hit. The truth is
   * between, and on this account the gap is wide: 374 unknowns against 1,530
   * confident misses is not a rounding error.
   *
   * A single point estimate that quietly drops 374 winners is the kind of
   * confident wrongness this product exists to avoid, so the bounds ship with
   * the rate and the surface decides how loudly to say it.
   *
   * Both are `null` when there is nothing to bound — the same empty-denominator
   * rule as `rate`. They are equal to `rate` when there are no unknowns, which
   * is the honest way of saying "no ambiguity here".
   */
  readonly lowerBound: number | null;
  readonly upperBound: number | null;
}

/**
 * THE core calculation of this product.
 *
 * Over JUDGED Shorts only. `pending` and `unknown` are in neither half — the
 * first because it is unfinished and the second because nobody was watching —
 * and both are returned in the tally so every surface can say what it left out.
 */
export function calculateHitRate(tally: HitTally): HitRateSummary {
  const judged = tally.hits + tally.misses;
  const withUnknowns = judged + tally.unknown;

  return {
    rate: ratePercent(tally.hits, judged),
    hits: tally.hits,
    judged,
    excluded: tally.pending + tally.unknown + tally.unscoreable,
    tally,
    lowerBound: ratePercent(tally.hits, withUnknowns),
    upperBound: ratePercent(tally.hits + tally.unknown, withUnknowns),
  };
}

// ---------------------------------------------------------------------------
// THE BAR, ON ITS OWN
// ---------------------------------------------------------------------------

/**
 * Are these views at or above this number?
 *
 * Inclusive on purpose: exactly 1,000,000 views counts as a 1M bar; 999,999
 * does not.
 *
 * THIS IS NOT A HIT. It is the bar half of the rule with no clock attached, and
 * it is named for what it actually compares so that no caller can reach for it
 * believing it answers the product's central question. `evaluateHit` is that
 * answer, and it cannot be called without a window.
 *
 * A `null` threshold is not a threshold of zero. It means the niche has never
 * had one configured, so nothing clears it.
 */
export function clearsThreshold(views: number, threshold: number | null): boolean {
  if (threshold === null) return false;
  return views >= threshold;
}

/**
 * Annotates each Short with where it sits relative to a bar, and relative to
 * the one its rule actually applied.
 *
 * A DISPLAY CONCERN, NOT A VERDICT, and the two ratios are what keeps that
 * honest. `lifetimeRatio` compares today's total to whatever bar the screen is
 * exploring with — the threshold control is now a lens over the distribution
 * rather than a definition of a hit, and this is what it moves. `windowRatio`
 * is the one that answers "how close did it get" the way the RULE asks it: at
 * the window's close, against the threshold that judged it. The two are
 * different numbers and the older single `thresholdRatio` silently reported the
 * first while being read as the second.
 *
 * Generic over the row so a caller that passes richer records — a `VideoDTO`
 * with its content-type deviations — gets those back rather than the engine's
 * minimum shape. A `JudgedVideo` at minimum, because `windowRatio` has to come
 * from the stored verdict and there is nowhere else to get it.
 */
export function annotateAgainstThreshold<T extends JudgedVideo>(
  shorts: readonly T[],
  threshold: number | null,
): (T & ThresholdAnnotation)[] {
  // No threshold, no ratio. `0` would sort every Short as an equal, maximal
  // miss; `null` says there is nothing to be a ratio of.
  const safeThreshold = threshold !== null && threshold > 0 ? threshold : null;
  return shorts.map((short) => ({
    ...short,
    clearsThreshold: clearsThreshold(short.views, threshold),
    lifetimeRatio: safeThreshold === null ? null : short.views / safeThreshold,
    windowRatio: windowRatio(short.hit),
  }));
}
