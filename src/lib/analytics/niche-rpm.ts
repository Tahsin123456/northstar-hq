import { roundTo } from "./stats";
import { convertMinorBetween, minorUnitsFor, symbolFor } from "@/lib/finance/money";

/**
 * =========================================================================
 * WHAT A NICHE IS WORTH
 * =========================================================================
 *
 * RPM is revenue per 1,000 views. A niche with an RPM has a SIZE in money:
 * the views the tracker can see, priced. A niche without one has a size in
 * views only, and this file is careful about never letting the second quietly
 * become the first.
 *
 * THIS FILE IS THE DEFINITION, in the same sense `hit-rate.ts` is. One module
 * decides which rate applies to a niche, what evidence a derived rate needs
 * before it is allowed to be one, and how a rate turns into money. The server
 * gathers the evidence and the browser renders the answer; neither re-derives
 * it, because a rule with two homes has two versions the first time somebody
 * edits one of them.
 *
 * PURE AND ISOMORPHIC: no clock, no I/O, no Prisma. Every window boundary and
 * every view count is an argument, which is what lets the trust gate below be
 * tested without a database and without moving anybody's system time.
 *
 * ---------------------------------------------------------------------------
 * THE PRECEDENCE THE OWNER ASKED FOR, IN THE ORDER IT IS APPLIED
 * ---------------------------------------------------------------------------
 *   1. DERIVED — the studio operates a monetized channel in this niche, and
 *      that channel's own reported revenue over its own views IS the rate. A
 *      point, not a range, because it is measured. It overrides everything,
 *      including a range somebody typed.
 *   2. MANUAL — no own channel here clears the bar in (1), so the hand-entered
 *      low–high range applies. This is the fallback in the owner's ordering and
 *      the ONLY path that produces a number on this deployment today: with
 *      `OrganizationSettings.autoRefreshEnabled` false nothing is writing
 *      `VideoSnapshot` rows, so views-gained-in-a-window — the denominator every
 *      derived rate needs — is not computable for any channel.
 *   3. NOTHING. Not zero. Zero is the claim that a niche pays nothing, which is
 *      a statement about the world; "none" is the absence of a statement. They
 *      render as opposite sentences and are never allowed to collapse into each
 *      other — the same rule `youtube-revenue-service.ts` states for revenue,
 *      where "$0.00" must never stand in for "we could not ask".
 *
 * A DISCRIMINATED UNION ON THE OUTCOME, not a nullable number. A nullable rate
 * forces every caller to invent the missing states badly, and `?? 0` is how "we
 * have no idea what this niche pays" becomes "this niche pays nothing" in a
 * figure a studio plans against.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STORED SCALE IS PER 1,000,000 VIEWS
 * ---------------------------------------------------------------------------
 * A Shorts RPM sits well under $0.10. Whole cents per 1,000 views cannot
 * express one at all — $0.045 would have to round to 4 or 5, an 11% error in
 * the rate, and that error is then multiplied by the niche's entire view count.
 * Carrying a further factor of 1,000 makes the granularity $0.00001 per 1,000
 * views and keeps every step integral: `revenueMinor = views * rpm / 1000000`
 * is an exact division by a power of ten with no float anywhere.
 */

/** Views the STORED integer is quoted per. The scale of the two columns. */
export const RPM_VIEW_BASIS = 1_000_000;

/** Views an RPM is SPOKEN per. What "revenue per mille" means to a person. */
export const RPM_QUOTE_BASIS = 1_000;

/**
 * Extra fraction digits an RPM carries beyond its currency's own.
 *
 * `RPM_VIEW_BASIS / RPM_QUOTE_BASIS`, expressed as a digit count, and the two
 * are the same fact said twice: a stored value is minor units per 1,000,000
 * views, a typed value is major units per 1,000 views, and three decimal places
 * is exactly the gap between them. $1.00 per 1,000 views stores as 100000;
 * $0.045 stores as 4500.
 */
export const RPM_EXTRA_DIGITS = 3;

/** Total fraction digits an RPM accepts and displays, for one currency. */
export function rpmDigitsFor(currency: string): number {
  return minorUnitsFor(currency) + RPM_EXTRA_DIGITS;
}

/**
 * The ceiling, as a person would say it: $100 per 1,000 views.
 *
 * Deliberately far below `MAX_MONEY_MINOR`, which is the technical bound and is
 * absurd here. A fat-fingered $2,000 RPM would multiply a niche's projected
 * revenue by four orders of magnitude and still look like a real number on the
 * card, which is precisely the typo this bound exists to keep out of a figure
 * somebody plans against. The highest RPM anybody has ever reported for any
 * format is an order of magnitude under this.
 */
export const MAX_RPM_MAJOR_PER_THOUSAND = 100;

/**
 * Where the form starts warning rather than refusing.
 *
 * $10 per 1,000 views is achievable in finance or B2B long-form and is
 * two orders of magnitude above any Shorts rate, so a number above it is much
 * more likely to be a decimal-place slip than a considered estimate. It is a
 * hint, not a rule: somebody who means it can still save it.
 */
export const RPM_IMPLAUSIBLE_MAJOR_PER_THOUSAND = 10;

/** The largest storable rate for a currency, in minor units per 1,000,000 views. */
export function maxRpmMinorPerMillion(currency: string): number {
  return MAX_RPM_MAJOR_PER_THOUSAND * 10 ** rpmDigitsFor(currency);
}

/**
 * The three nullable columns on `Niche`, as any caller holds them.
 *
 * Structural rather than an import of the Prisma type, for the same reason
 * `HitRuleSource` is: one shape the server row and the browser DTO both
 * satisfy, and no Prisma type in the isomorphic layer.
 */
export interface NicheRpmRangeSource {
  readonly rpmLowMinorPerMillion: number | null;
  readonly rpmHighMinorPerMillion: number | null;
  readonly rpmCurrency: string | null;
}

/**
 * A complete hand-entered range: a floor, a ceiling AND the currency they were
 * typed in.
 *
 * All three, always. `resolveManualRpmRange` is the only way to build one and
 * it refuses to build a half, exactly as `resolveHitRule` refuses to build half
 * a hit rule. A low with no high is not a narrower range, it is an unfinished
 * thought; and a range with no currency is a pair of digits that mean a
 * different amount of money depending on who reads them.
 */
export interface NicheRpmRange {
  readonly lowMinorPerMillion: number;
  readonly highMinorPerMillion: number;
  readonly currency: string;
}

/** Which part of the range a niche is missing, or null when it has all of it. */
export type MissingRpmRangeHalf = "low" | "high" | "currency" | "both";

/**
 * The range in force for a niche, or null when there isn't one.
 *
 * The null is the answer. A non-positive stored value is treated as unset for
 * the same reason a non-positive threshold is: "this niche pays 0" is not an
 * estimate anybody meant to type, and letting a zero through would price a
 * whole niche at nothing while looking configured.
 *
 * An inverted pair (low above high) is also treated as unset rather than
 * silently swapped. Swapping would invent an ordering the user did not state,
 * and a range whose ends are the wrong way round is far more likely to be a
 * mis-keyed number than a mis-ordered one.
 */
export function resolveManualRpmRange(source: NicheRpmRangeSource): NicheRpmRange | null {
  const { rpmLowMinorPerMillion: low, rpmHighMinorPerMillion: high, rpmCurrency } = source;
  if (low === null || !Number.isInteger(low) || low <= 0) return null;
  if (high === null || !Number.isInteger(high) || high <= 0) return null;
  if (high < low) return null;
  const currency = typeof rpmCurrency === "string" ? rpmCurrency.trim().toUpperCase() : "";
  if (!currency) return null;
  return { lowMinorPerMillion: low, highMinorPerMillion: high, currency };
}

/**
 * Which part is missing, for a screen that has to say so.
 *
 * "No low end" and "no currency" send an admin to two different boxes, and the
 * whole point of naming a configuration gap is that somebody can close it
 * without asking anybody what it means.
 */
export function missingRpmRangeHalf(
  source: NicheRpmRangeSource,
): MissingRpmRangeHalf | null {
  const noLow = source.rpmLowMinorPerMillion === null || source.rpmLowMinorPerMillion <= 0;
  const noHigh =
    source.rpmHighMinorPerMillion === null || source.rpmHighMinorPerMillion <= 0;
  if (noLow && noHigh) return "both";
  if (noLow) return "low";
  if (noHigh) return "high";
  if (!source.rpmCurrency?.trim()) return "currency";
  return null;
}

// ---------------------------------------------------------------------------
// THE DERIVED RATE, AND WHAT IT TAKES TO EARN THE NAME
// ---------------------------------------------------------------------------

/**
 * =========================================================================
 * THE TRUST GATE
 * =========================================================================
 *
 * Every constant below is a floor under a number that will be multiplied by a
 * whole niche's view count. They are exported so a test can state them and so
 * raising one is a single edit rather than a hunt.
 */

/**
 * Whole days of measurement a derived rate is computed over.
 *
 * 28 rather than 30, and the reason is arithmetic rather than taste. RPM swings
 * hard by weekday — advertiser budgets are weekly — and a 30-day window
 * contains five of two weekdays and four of the other five, so its mean is
 * biased toward whichever two those happened to be. 28 covers every weekday
 * exactly four times and still spans a full monthly budget cycle.
 */
export const RPM_WINDOW_DAYS = 28;

/**
 * Days at the end that are not measurement yet.
 *
 * YouTube's revenue figures for roughly the last three days are incomplete and
 * the whole current month stays subject to adjustment at its close — the same
 * fact `youtube-revenue-service.ts` keeps a 10-day trailing re-import for.
 * Including them would import Google's least-settled numbers into the numerator
 * of a planning figure.
 */
export const RPM_SETTLE_DAYS = 3;

/**
 * Days inside the window that must actually have earned something.
 *
 * 21 of 28. This catches erratic reporting that the "newly monetized" trim
 * below does not: a channel earning on nine days out of twenty-eight is not
 * producing a stable rate, whatever the total comes to.
 */
export const RPM_MIN_EARNING_DAYS = 21;

/**
 * How much of a channel's library must have a view reading at the window's
 * start before its view delta is trusted.
 *
 * 0.90, and the 0.10 is not slack — it is a bounded overstatement. A video with
 * no reading at the start of the window has an unknown starting count, so it is
 * DROPPED from the denominator rather than zero-based, which shrinks the
 * denominator and INFLATES the rate. 0.90 caps that inflation at about 11%.
 * `history-service` uses 0.80 for a distribution chart, where missing videos
 * shift a shape; here they inflate a dollar figure, so the bar is higher.
 */
export const RPM_MIN_SNAPSHOT_COVERAGE = 0.9;

/**
 * The smallest view count a rate may be divided out of.
 *
 * The least principled of these constants, and it is a floor rather than a
 * comfort level: at 250,000 views one viral Short adding 100,000 moves the rate
 * by 40%. It is exported and easy to raise, and every surface that shows a
 * derived rate also shows the view count behind it so the reader can judge.
 */
export const RPM_MIN_VIEWS = 250_000;

/**
 * The smallest revenue total a rate may be built from, in minor units. $10.00.
 *
 * Derived, not conventional. The revenue importer rounds each DAY to whole
 * minor units, so 28 days carry up to ±14 units of rounding; for that to stay
 * under 1.5% of the total, the total has to clear roughly $9.33.
 */
export const RPM_MIN_REVENUE_MINOR = 1_000;

/** Milliseconds in a day. Windows here are whole UTC days. */
const DAY_MS = 86_400_000;

/**
 * The window a derived rate is measured over.
 *
 * Carried on the result rather than recomputed by whoever renders it, because
 * "$0.04 per 1,000 views" means nothing without "measured over 28 days ending
 * the 14th" beside it — and because the window is NOT the period the user is
 * looking at. RPM is a property of a niche's monetization, not of the reporting
 * range on screen, so a 7-day view still shows a 28-day rate and has to say so.
 */
export interface RpmWindow {
  readonly startMs: number;
  /** Exclusive. The first instant after the last measured day. */
  readonly endMs: number;
  readonly days: number;
}

/**
 * The trailing window of settled days, ending `RPM_SETTLE_DAYS` before now.
 *
 * `nowMs` is an argument for the same reason it is one in `hit-rate.ts`: the
 * server and the browser have to agree, and a test has to be able to move time
 * without mocking a clock.
 */
export function rpmWindowEndingAt(nowMs: number, days = RPM_WINDOW_DAYS): RpmWindow {
  const todayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const endMs = todayStart - RPM_SETTLE_DAYS * DAY_MS;
  return { startMs: endMs - days * DAY_MS, endMs, days };
}

/** One settled day of this channel's revenue, already converted to base. */
export interface RpmRevenueDay {
  /** UTC midnight of the reported day. */
  readonly dayMs: number;
  readonly revenueMinor: number;
}

/**
 * Why a channel the studio owns could not become the baseline for its niche.
 *
 * NONE OF THESE IS AN ERROR. Each is a true sentence about what the data can
 * support, and each one falls through to the hand-entered range rather than
 * producing a number. They are named individually because "no derived rate"
 * with no reason attached is the kind of blank a person fills in with the worst
 * available assumption.
 */
export type RpmChannelRejection =
  /** The connection says this channel is not in the partner programme. */
  | "not_monetized"
  /**
   * We could not ASK. No revenue scope, a failed read, or a report YouTube
   * refused — the four states `youtube-revenue-service` refuses to conflate
   * with zero, kept distinct here for the same reason.
   */
  | "revenue_not_reported"
  /**
   * Earnings begin inside the window, so the window holds more days of views
   * than of money. The owner named this case himself. A channel accepted into
   * the programme on day 21 of a 28-day window would report a rate a third of
   * its real one, and no correction afterwards is as trustworthy as declining.
   *
   * OBSERVED, NOT INFERRED: this fires only where the first earning day is
   * strictly inside the window while earlier days were genuinely held and were
   * quiet. The case where we simply hold nothing earlier is a different reason,
   * below, because it is a fact about our import rather than about the channel.
   */
  | "newly_monetized"
  /**
   * Earnings run from the window's first day, and we hold no revenue at all
   * from before it — so "monetized for years" and "started the day the window
   * opened" are the same picture.
   *
   * SPLIT FROM `newly_monetized` BECAUSE THE SENTENCE IS DIFFERENT. The two
   * used to share a reason, and the shared sentence asserted the channel had
   * started earning mid-window — a specific factual claim about a channel that
   * may have been monetized for a decade. This is the branch that fires on this
   * deployment, where revenue has only just begun importing, so it is also the
   * sentence most people will actually read. The decision is identical
   * (refuse); only the explanation, and what a person can do about it, differ.
   */
  | "revenue_history_too_shallow"
  /** Money arrived on too few of the days to be a rate rather than an event. */
  | "too_few_earning_days"
  /**
   * No view history spanning the window. Today this is every channel: nothing
   * is writing snapshots, so there is no denominator to divide by.
   */
  | "no_view_history"
  /** Snapshots exist but cover too little of the library to trust the delta. */
  | "thin_view_coverage"
  /** Real, settled, covered — and too small to divide safely. */
  | "below_evidence_floor"
  /**
   * The days are stored in a currency with no configured rate into the base.
   * Refused rather than dropped: dropping a channel's revenue would shrink the
   * numerator and understate the niche, which is a wrong number rather than a
   * missing one.
   */
  | "currency_unconvertible";

/**
 * Everything known about one own channel over the window, as the server found
 * it.
 *
 * Assembled by `niche-rpm-service` and judged here, so that the judgement is
 * testable without a database and cannot drift between the two.
 */
export interface RpmChannelEvidence {
  readonly channelId: string;
  readonly channelName: string;
  /** `YouTubeConnection.monetizationStatus` for the connection covering it. */
  readonly monetizationStatus: string;
  /** `YouTubeConnection.revenueSyncStatus`. Only "ok" may feed a baseline. */
  readonly revenueSyncStatus: string;
  /**
   * Settled days held inside the window, already converted to base currency.
   *
   * Days with no row are simply absent; a held row of zero is a day YouTube
   * answered "nothing", which is a different fact and is present with a zero.
   */
  readonly revenueDays: readonly RpmRevenueDay[];
  /**
   * False when any day inside the window is stored in a currency with no
   * configured rate into the organization's base.
   *
   * A channel-level flag rather than a per-day one because the refusal is
   * whole-channel: dropping the days that could not be converted would shrink
   * the numerator and understate the rate, which is a wrong number rather than
   * a missing one. `youtube-revenue-service` refuses a mixed-currency month for
   * the same reason.
   */
  readonly currencyConvertible: boolean;
  /**
   * True when at least one revenue day is held STRICTLY BEFORE the window.
   *
   * The proven-quiet day that tells "newly monetized" apart from "newly
   * imported". Without one, a run of earnings starting at the window's edge is
   * indistinguishable from a backfill that simply has not reached further back,
   * and the two call for opposite decisions.
   */
  readonly hasRevenueDayBeforeWindow: boolean;
  /**
   * Channel-wide views gained across the window, or null when the snapshot
   * series cannot bracket it.
   *
   * CHANNEL-WIDE, not Shorts-only, and the two halves of the fraction have to
   * describe the same body of work. `ChannelRevenueDay` is what the whole
   * channel earned — long-form and YouTube Premium included, because the
   * Analytics request carries no content-type filter — so pairing it with a
   * Shorts-only denominator would inflate the rate by every long-form dollar.
   * A channel that also posts long-form would read several times too high.
   */
  readonly viewsGained: number | null;
  /** Share of the channel's videos with a reading at or before the window start. */
  readonly snapshotCoverage: number;
}

/**
 * One channel's contribution, or the reason it has none.
 *
 * A discriminated union rather than a nullable number, so a rejected channel
 * cannot be added to a total by forgetting a check — and so the reason travels
 * to the screen instead of being thrown away at the point it was learned.
 */
export type RpmChannelOutcome =
  | {
      readonly channelId: string;
      readonly channelName: string;
      readonly accepted: true;
      readonly revenueMinor: number;
      readonly viewsGained: number;
      readonly earningDays: number;
    }
  | {
      readonly channelId: string;
      readonly channelName: string;
      readonly accepted: false;
      readonly reason: RpmChannelRejection;
    };

/**
 * Whether this channel's own numbers may become its niche's rate.
 *
 * The order of the tests is the argument, so it is worth reading as one. Each
 * one that fails stops the rest: a channel that is not monetized has no revenue
 * to have earning days in, and asking about its snapshot coverage would produce
 * a second, less relevant reason for the same fact.
 *
 * THE TRIM FOR "NEWLY MONETIZED" IS A REFUSAL, NOT A CORRECTION. The tempting
 * alternative is to shrink the window to the earning run and divide over that.
 * It is wrong here for a specific reason: the view denominator comes from
 * snapshots on a five-minute grid, and a window narrowed to an arbitrary
 * earning start would bracket views over a shorter span than the money by
 * however much of the first day fell outside it. Refusing costs the studio a
 * number it does not have yet; correcting costs it a number it believes.
 */
export function judgeRpmChannel(
  evidence: RpmChannelEvidence,
  window: RpmWindow,
): RpmChannelOutcome {
  const { channelId, channelName } = evidence;
  const reject = (reason: RpmChannelRejection): RpmChannelOutcome => ({
    channelId,
    channelName,
    accepted: false,
    reason,
  });

  if (evidence.monetizationStatus === "not_monetized") return reject("not_monetized");
  if (evidence.revenueSyncStatus !== "ok") return reject("revenue_not_reported");
  if (!evidence.currencyConvertible) return reject("currency_unconvertible");

  const inWindow = evidence.revenueDays
    .filter((day) => day.dayMs >= window.startMs && day.dayMs < window.endMs)
    .slice()
    .sort((a, b) => a.dayMs - b.dayMs);

  if (inWindow.length === 0) return reject("revenue_not_reported");

  const earning = inWindow.filter((day) => day.revenueMinor > 0);
  if (earning.length === 0) return reject("revenue_not_reported");

  /*
   * The newly-monetized test, stated as the owner stated it — and the import
   * boundary that looks exactly like it, named separately.
   *
   * Earnings that begin after the window opened mean the window holds more days
   * of views than of money, and the rate would be understated by exactly that
   * ratio. That is `newly_monetized`, and it is an OBSERVATION: we hold the
   * earlier days and they are quiet.
   *
   * The second test is the ambiguity. If earnings run from the window's very
   * first day and we hold nothing before it, a channel monetized for years and
   * one monetized that morning produce identical rows. Refusing is the only
   * honest read — but it is refused under its OWN reason, because the sentence
   * a person reads must not assert the monetization history we just admitted we
   * cannot see, and because the thing they can act on is different: one is
   * waiting for the channel, the other is waiting for the import to reach
   * further back.
   */
  const firstEarningDayMs = earning[0]!.dayMs;
  if (firstEarningDayMs > window.startMs) return reject("newly_monetized");
  if (!evidence.hasRevenueDayBeforeWindow) return reject("revenue_history_too_shallow");

  if (earning.length < RPM_MIN_EARNING_DAYS) return reject("too_few_earning_days");

  if (evidence.viewsGained === null) return reject("no_view_history");
  if (evidence.snapshotCoverage < RPM_MIN_SNAPSHOT_COVERAGE) {
    return reject("thin_view_coverage");
  }

  const revenueMinor = inWindow.reduce((total, day) => total + day.revenueMinor, 0);
  if (evidence.viewsGained < RPM_MIN_VIEWS) return reject("below_evidence_floor");
  if (revenueMinor < RPM_MIN_REVENUE_MINOR) return reject("below_evidence_floor");

  return {
    channelId,
    channelName,
    accepted: true,
    revenueMinor,
    viewsGained: evidence.viewsGained,
    earningDays: earning.length,
  };
}

/** What a derived rate was measured from, carried to the screen with it. */
export interface DerivedRpmEvidence {
  readonly window: RpmWindow;
  /** The own channels that passed the gate, in the order given. */
  readonly channels: readonly { readonly id: string; readonly name: string }[];
  readonly viewsUsed: number;
  readonly revenueMinorUsed: number;
}

/** Why a niche has no rate at all — neither derived nor entered. */
export type NoRpmReason =
  /** No channel the studio owns is filed under this niche. */
  | "no_own_channel"
  /** Own channels are here, and none of them could produce a rate. */
  | "own_channels_unusable"
  /**
   * A range WAS entered, in a currency the organization has no rate out of.
   *
   * The same refusal the derived path makes for `currency_unconvertible`, and
   * for the same reason: showing the digits under the base currency's symbol
   * would reinterpret somebody's estimate at a scale they never chose, and
   * converting through a rate nobody configured would be a number nobody
   * entered. It happens after an admin switches the organization's base
   * currency, which is the one moment every stored range is suddenly foreign.
   */
  | "manual_range_unconvertible";

/**
 * THE ANSWER for one niche: which rate applies, and on what basis.
 *
 * Narrowing on `source` makes the shape of the evidence follow the answer. A
 * "none" resolution has no rate to carry and cannot pretend to; a "derived" one
 * always carries the window and the counts behind it, so no surface can print
 * the figure without being handed the means to qualify it.
 */
export type NicheRpmResolution =
  | {
      readonly source: "derived";
      readonly rpmMinorPerMillion: number;
      readonly currency: string;
      readonly evidence: DerivedRpmEvidence;
      /**
       * A hand-entered range that this measurement is overriding.
       *
       * Carried rather than dropped because the owner asked for the derived
       * figure to "override everything", and a screen that silently shows only
       * the measurement teaches whoever typed the range that editing it does
       * nothing. The strip says the range is stored and not in use.
       */
      readonly supersededRange: NicheRpmRange | null;
      /** Own channels that did not qualify, so the reader can see the sample. */
      readonly rejectedChannels: readonly RpmChannelOutcome[];
    }
  | {
      readonly source: "manual";
      /**
       * The range IN FORCE, in the organization's base currency.
       *
       * Every money figure on a screen is projected from this, so it is the one
       * that has to be in the currency the rest of the page is in. Where the
       * stored range was already in the base — the normal case, since the
       * dialog only ever writes the base — this is `enteredRange` unchanged.
       */
      readonly range: NicheRpmRange;
      /**
       * The range EXACTLY AS STORED, in the currency it was typed in.
       *
       * Carried separately so the dialog can seed the boxes with the digits
       * somebody actually typed rather than a converted figure nobody did, and
       * so a screen can say "entered as €0.03–€0.06" beside a converted one.
       * The two are the same object whenever no conversion happened.
       */
      readonly enteredRange: NicheRpmRange;
      /** Why no measurement took precedence. Empty when there is no own channel. */
      readonly rejectedChannels: readonly RpmChannelOutcome[];
    }
  | {
      readonly source: "none";
      readonly reason: NoRpmReason;
      readonly rejectedChannels: readonly RpmChannelOutcome[];
      /**
       * The stored range that could not be brought into the base currency, for
       * the `manual_range_unconvertible` reason. Null for every other reason.
       *
       * Present so the card can name the estimate that exists but cannot be
       * used, rather than telling an admin who priced this niche last month
       * that nobody has priced it.
       */
      readonly unconvertibleRange: NicheRpmRange | null;
    };

export interface NicheRpmInput {
  readonly manual: NicheRpmRangeSource;
  /** Every own channel in this niche, already judged. */
  readonly channels: readonly RpmChannelOutcome[];
  readonly window: RpmWindow;
  /**
   * The currency every accepted channel's revenue was converted into.
   *
   * The organization's base. Conversion happens once, per revenue row, at the
   * lowest level — never on the projected niche total, which may have been
   * built out of several channels in several currencies. A derived rate and an
   * entered range can therefore sit beside each other on one card without
   * either being silently reinterpreted.
   */
  readonly baseCurrency: string;
  /**
   * The organization's configured rates INTO the base, keyed by source
   * currency. Absent or empty means none is configured.
   *
   * Only consulted when a stored range is in some other currency, which is only
   * possible after an admin switches the base — the dialog always writes the
   * base of the day. It carries the same one-directional rule the ledger's
   * `resolveConversion` states: a rate that was entered base→foreign is not
   * inverted to answer foreign→base, because a derived rate is a number nobody
   * chose.
   */
  readonly ratesToBase?: ReadonlyMap<string, number>;
}

/**
 * A stored range brought into the base currency, or `null` when it cannot be.
 *
 * ONE MULTIPLICATION PER END, ON THE RATE, NOT ON THE PROJECTED MONEY. The
 * alternative — projecting in the stored currency and converting the total —
 * would convert a figure that had already been floored and ceiled, so the
 * rounding would be applied twice at two different scales.
 *
 * `convertMinorBetween` is reused verbatim even though these are rates rather
 * than amounts: an RPM is minor units multiplied by a fixed power of ten, and
 * that factor is identical on both sides of the conversion, so it cancels. What
 * does NOT cancel is the currencies' own minor-unit difference — 100 JPY is not
 * 100 cents — and that is exactly what the function corrects for.
 */
function convertRpmRangeToBase(
  range: NicheRpmRange,
  baseCurrency: string,
  rates: ReadonlyMap<string, number> | undefined,
): NicheRpmRange | null {
  const base = baseCurrency.trim().toUpperCase();
  if (!base) return null;
  if (range.currency === base) return range;

  const rate = rates?.get(range.currency);
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return null;

  const lowMinorPerMillion = convertMinorBetween(
    range.lowMinorPerMillion,
    rate,
    range.currency,
    base,
  );
  const highMinorPerMillion = convertMinorBetween(
    range.highMinorPerMillion,
    rate,
    range.currency,
    base,
  );

  // A conversion that rounds an end to nothing, or inverts the pair, has left
  // the range unrepresentable at the base currency's scale. Refused rather than
  // clamped: "this niche pays 0" is the one figure this module never invents.
  if (lowMinorPerMillion <= 0 || highMinorPerMillion < lowMinorPerMillion) return null;
  return { lowMinorPerMillion, highMinorPerMillion, currency: base };
}

/**
 * Which rate applies to a niche.
 *
 * MULTIPLE OWN CHANNELS RESOLVE AS ONE RATIO OF SUMS, and that phrasing is
 * load-bearing:
 *
 *     rpm = RPM_VIEW_BASIS * Σ revenue / Σ views
 *
 * Sum both sides, divide ONCE. That expression already IS the views-weighted
 * mean, and writing it this way removes the chance for somebody to implement
 * "weighted average" with weights taken from `Channel.viewCount` — a lifetime
 * total that has nothing to do with the window. The unweighted alternative is
 * not a near miss but a multiple: a 50,000-view channel at $0.30 and a
 * 5,000,000-view channel at $0.04 average to $0.17 unweighted and $0.043 by
 * ratio of sums, and applied to a 200,000,000-view niche that is the difference
 * between $34,000 and $8,600.
 *
 * A REJECTED CHANNEL CONTRIBUTES NEITHER HALF. Putting a non-monetized
 * channel's views into the denominator against no revenue would drag the
 * niche's rate toward zero and assert the niche pays less than it does — the
 * exact fabrication the four-state revenue convention exists to prevent. Those
 * views are still ours and still count toward what the studio is capturing;
 * they are simply not evidence about a price.
 */
export function resolveNicheRpm(input: NicheRpmInput): NicheRpmResolution {
  const accepted = input.channels.filter(
    (outcome): outcome is Extract<RpmChannelOutcome, { accepted: true }> => outcome.accepted,
  );
  const rejected = input.channels.filter((outcome) => !outcome.accepted);
  const enteredRange = resolveManualRpmRange(input.manual);
  const range =
    enteredRange === null
      ? null
      : convertRpmRangeToBase(enteredRange, input.baseCurrency, input.ratesToBase);

  if (accepted.length > 0) {
    const revenueMinorUsed = accepted.reduce((total, c) => total + c.revenueMinor, 0);
    const viewsUsed = accepted.reduce((total, c) => total + c.viewsGained, 0);
    const rpmMinorPerMillion = Math.round((revenueMinorUsed * RPM_VIEW_BASIS) / viewsUsed);

    /*
     * A rate that rounds to nothing is not a rate.
     *
     * Unreachable with the floors above in place — $10 over 250,000 views is
     * 4,000 — and kept anyway, because the one thing this whole module exists
     * to prevent is a fabricated zero reaching a screen with the authority of a
     * measurement behind it. If a future edit lowers a floor, this falls
     * through to the entered range instead of printing $0.00.
     */
    if (rpmMinorPerMillion >= 1) {
      return {
        source: "derived",
        rpmMinorPerMillion,
        currency: input.baseCurrency,
        evidence: {
          window: input.window,
          channels: accepted.map((c) => ({ id: c.channelId, name: c.channelName })),
          viewsUsed,
          revenueMinorUsed,
        },
        // The range AS ENTERED, not the converted one: this sentence tells an
        // admin what they typed is stored and unused, so it has to show the
        // digits and the symbol they typed.
        supersededRange: enteredRange,
        rejectedChannels: rejected,
      };
    }
  }

  if (enteredRange !== null) {
    if (range !== null) {
      return { source: "manual", range, enteredRange, rejectedChannels: rejected };
    }
    /*
     * A range that exists and cannot be used says so, rather than reading as
     * one that was never entered.
     *
     * This outranks "no own channel here", because it is the only one of the
     * two that somebody can close today — the fix is one exchange rate.
     */
    return {
      source: "none",
      reason: "manual_range_unconvertible",
      rejectedChannels: rejected,
      unconvertibleRange: enteredRange,
    };
  }

  return {
    source: "none",
    reason: input.channels.length === 0 ? "no_own_channel" : "own_channels_unusable",
    rejectedChannels: rejected,
    unconvertibleRange: null,
  };
}

// ---------------------------------------------------------------------------
// TURNING A RATE INTO MONEY
// ---------------------------------------------------------------------------

/**
 * The rate as an interval, whatever produced it.
 *
 * A derived point becomes the degenerate range `low === high` so that every
 * projection below has exactly ONE arithmetic path. The UI decides how to draw
 * it — a point renders as a single figure and never as "$0.045 – $0.045" — but
 * the arithmetic does not branch, which is what stops a derived figure and an
 * entered one being projected by two subtly different routines.
 */
export interface RpmBounds {
  readonly lowMinorPerMillion: number;
  readonly highMinorPerMillion: number;
  readonly currency: string;
}

export function rpmBounds(resolution: NicheRpmResolution): RpmBounds | null {
  if (resolution.source === "derived") {
    return {
      lowMinorPerMillion: resolution.rpmMinorPerMillion,
      highMinorPerMillion: resolution.rpmMinorPerMillion,
      currency: resolution.currency,
    };
  }
  if (resolution.source === "manual") {
    return {
      lowMinorPerMillion: resolution.range.lowMinorPerMillion,
      highMinorPerMillion: resolution.range.highMinorPerMillion,
      currency: resolution.range.currency,
    };
  }
  return null;
}

/** True when both ends agree — a measurement, or somebody who meant one number. */
export function isRpmPoint(bounds: RpmBounds): boolean {
  return bounds.lowMinorPerMillion === bounds.highMinorPerMillion;
}

/** Money projected from a rate. Integer minor units, both ends. */
export interface ProjectedMoney {
  readonly lowMinor: number;
  readonly highMinor: number;
  readonly currency: string;
}

/**
 * Views, priced.
 *
 * A RANGE IS ROUNDED OUTWARD — floor the low end, ceil the high end — rather
 * than to nearest at both. Rounding both to nearest lets a genuine range
 * collapse to a single figure on a small view count, which would claim a
 * precision the input never had; a range that a person typed as a range has to
 * still look like one after the arithmetic.
 *
 * A POINT IS ROUNDED ONCE, TO NEAREST, AND STAYS A POINT — and this branch is
 * not a micro-optimisation, it is the same rule pointing the other way. Floor
 * and ceil applied to a single rate differ by one minor unit whenever
 * `views × rpm` is not an exact multiple of 1,000,000, which is almost always:
 * a measured $0.045 over 12,345,678 views would print "$555.55–$555.56". The
 * whole at-a-glance signal on the card is that a measurement is one figure and
 * a guess is two, and manufacturing a one-cent spread out of rounding would
 * dress every measurement up as an estimate.
 *
 * Integer in and integer out. The division is by a power of ten and both
 * operands are integers, so the only float in the expression is the intermediate
 * product, which stays exact well past any view count this app will ever hold
 * (a hundred million views at a $1 rate is 10^11, and the exact-integer limit is
 * above 9 × 10^15).
 */
export function projectRevenue(views: number, bounds: RpmBounds): ProjectedMoney {
  const safeViews = Number.isFinite(views) && views > 0 ? Math.floor(views) : 0;

  if (isRpmPoint(bounds)) {
    const exact = Math.round((safeViews * bounds.lowMinorPerMillion) / RPM_VIEW_BASIS);
    return { lowMinor: exact, highMinor: exact, currency: bounds.currency };
  }

  return {
    lowMinor: Math.floor((safeViews * bounds.lowMinorPerMillion) / RPM_VIEW_BASIS),
    highMinor: Math.ceil((safeViews * bounds.highMinorPerMillion) / RPM_VIEW_BASIS),
    currency: bounds.currency,
  };
}

/**
 * ==========================================================================
 * WHAT THE NICHE IS WORTH, AND HOW MUCH OF IT IS OURS
 * ==========================================================================
 *
 * NAMING IS LOAD-BEARING, and this is the same warning `market-share.ts`
 * carries. The app knows about the channels somebody added to the tracker — a
 * handful out of a niche that may hold thousands — so this is what the TRACKED
 * niche is worth, never what the niche is worth. The denominator moves when a
 * competitor is added or removed, which is the whole reason the qualifier has
 * to survive into every label, tooltip and export.
 */
export const TRACKED_NICHE_VALUE_DEFINITION =
  "Tracked niche revenue prices the Shorts views of the channels currently tracked for this niche at its RPM. It is not what the niche as a whole generates — the view total only contains channels you have added to the tracker, so it moves when you add or remove competitors — and where the RPM is a hand-entered estimate the money is an estimate too. Note which views are priced: the lifetime views to date of the Shorts PUBLISHED in the selected period, exactly as the hit rate counts them. The period chooses which uploads are in the figure, not which views or revenue were earned during it, so this is what those uploads are worth in total rather than what the niche made last month.";

export interface NicheValue {
  readonly ourViews: number;
  readonly competitorViews: number;
  readonly trackedNicheViews: number;
  /**
   * Our share of tracked views, 0..100, or `null` when nothing was published.
   *
   * A SHARE OF VIEWS, and it stays one even where the RPM is a range. Applying
   * one rate to both halves cancels it exactly — (ourViews × R) ÷ (totalViews ×
   * R) is ourViews ÷ totalViews — so a money-denominated share would carry no
   * information this one does not, and rendering it as "12% – 12%" would
   * suggest an uncertainty that is not there. What the RPM adds is the SIZE of
   * the niche in money, not a new share.
   */
  readonly capturePercent: number | null;
  /** The tracked niche priced, or null when no rate applies. */
  readonly trackedRevenue: ProjectedMoney | null;
  /** Our own views priced at the same rate. Null for the same reason. */
  readonly ourRevenue: ProjectedMoney | null;
  /**
   * What the rest of the tracked niche is worth — the gap, priced.
   *
   * Computed from the VIEW difference and priced once, never as one projected
   * total minus another. Interval subtraction would widen the answer to
   * [lowTotal − highOurs, highTotal − lowOurs] and can go negative even though
   * both halves used the identical rate. The rate cancels, so it is applied
   * after the subtraction rather than before it.
   */
  readonly gapRevenue: ProjectedMoney | null;
}

export function calculateNicheValue(params: {
  readonly ourViews: number;
  readonly competitorViews: number;
  readonly bounds: RpmBounds | null;
}): NicheValue {
  const ourViews = Math.max(0, Math.floor(params.ourViews));
  const competitorViews = Math.max(0, Math.floor(params.competitorViews));
  const trackedNicheViews = ourViews + competitorViews;
  const { bounds } = params;

  return {
    ourViews,
    competitorViews,
    trackedNicheViews,
    // `null` rather than 0 when nothing was published, matching
    // `calculateMarketShare`: a share of nothing is undefined, not zero.
    capturePercent:
      trackedNicheViews === 0 ? null : roundTo((ourViews / trackedNicheViews) * 100, 1),
    trackedRevenue: bounds === null ? null : projectRevenue(trackedNicheViews, bounds),
    ourRevenue: bounds === null ? null : projectRevenue(ourViews, bounds),
    gapRevenue: bounds === null ? null : projectRevenue(competitorViews, bounds),
  };
}

// ---------------------------------------------------------------------------
// READING AND WRITING A RATE AS TEXT
// ---------------------------------------------------------------------------

/** Longer than any legitimate rate; a guard against pathological input. */
const MAX_RPM_INPUT_LENGTH = 24;

/**
 * Text a person typed -> minor units per 1,000,000 views, or `null` when it
 * cannot be read.
 *
 * WHY NOT `parseMoneyToMinor`. That function is correct and is deliberately not
 * reused: it rounds at the currency's own precision, so it reads "0.045" as 5
 * cents. Five cents is an 11% error in a Shorts RPM, and that error is then
 * multiplied by a niche's entire view count. This parser keeps three further
 * digits — exactly the factor between "per 1,000 views" as typed and "per
 * 1,000,000 views" as stored — and does its arithmetic on digit strings, so no
 * float ever sees the value.
 *
 * Deliberately stricter than the money parser as well. A rate is typed once,
 * into a labelled box, by an admin; it is never pasted out of one of our own
 * tables, so there is no grouped-thousands or accounting-negative case to
 * support, and a negative rate is not a thing that exists.
 */
export function parseRpmToMinorPerMillion(
  input: string,
  currency: string,
): number | null {
  if (typeof input !== "string") return null;

  let text = input.replace(/\s/g, "");
  if (!text || text.length > MAX_RPM_INPUT_LENGTH) return null;

  // A symbol or code pasted along with the number, at either end.
  const code = currency.trim().toUpperCase();
  const symbol = symbolFor(code);
  for (const marker of [symbol, code]) {
    if (!marker) continue;
    const upper = text.toUpperCase();
    if (upper.startsWith(marker.toUpperCase())) text = text.slice(marker.length);
    else if (upper.endsWith(marker.toUpperCase())) text = text.slice(0, -marker.length);
  }

  if (!/^\d*[.,]?\d*$/.test(text)) return null;

  const separator = text.includes(",") ? "," : ".";
  const [whole = "", fraction = ""] = text.split(separator);
  if (whole === "" && fraction === "") return null;

  const digits = rpmDigitsFor(code);
  const kept = fraction.slice(0, digits).padEnd(digits, "0");
  const dropped = fraction.slice(digits);

  let value = Number(`${whole === "" ? "0" : whole}${kept}`);
  if (!Number.isFinite(value)) return null;
  // Round half up on the digits that do not fit, so somebody typing a fourth
  // decimal is not silently truncated downward.
  if (dropped.length > 0 && Number(dropped[0]) >= 5) value += 1;
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

/**
 * Minor units per 1,000,000 views -> the text a form field shows.
 *
 * Trailing zeros beyond the currency's own precision are trimmed, so a stored
 * $1.00 comes back as "1.00" rather than "1.00000" — the extra digits exist to
 * hold a value, not to be typed past.
 */
export function rpmToInputText(minorPerMillion: number, currency: string): string {
  const digits = rpmDigitsFor(currency);
  const magnitude = String(Math.abs(Math.trunc(minorPerMillion))).padStart(digits + 1, "0");
  const whole = magnitude.slice(0, -digits);
  let fraction = magnitude.slice(-digits);
  const floor = minorUnitsFor(currency);
  while (fraction.length > floor && fraction.endsWith("0")) {
    fraction = fraction.slice(0, -1);
  }
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * A rate as a person reads it: "$0.045", "₺1.20".
 *
 * Per 1,000 views, because that is what RPM means and what the label beside it
 * says. Up to the currency's own decimals plus the three the scale carries, and
 * no fewer than its own — "$0.05" and "$0.045" are both legible, "$0.0" is not.
 */
export function formatRpm(minorPerMillion: number, currency: string): string {
  if (!Number.isFinite(minorPerMillion)) return "";
  const digits = rpmDigitsFor(currency);
  // Display-only float: divided once at the last moment, formatted, never
  // stored and never summed — the same rule the money formatter follows.
  const value = minorPerMillion / 10 ** digits;
  return `${symbolFor(currency)}${value.toLocaleString(undefined, {
    minimumFractionDigits: minorUnitsFor(currency),
    maximumFractionDigits: digits,
  })}`;
}

// ---------------------------------------------------------------------------
// WHAT THE SCREENS SAY
// ---------------------------------------------------------------------------

/**
 * The user-facing wording, in one place.
 *
 * Beside the definitions rather than in `analytics/constants.ts`, where the
 * hit-rule strings live, and the reason is that this module OWNS the states
 * these sentences describe. `RpmChannelRejection` is declared here; a sentence
 * for one of its members declared somewhere else is a sentence that can fall
 * out of step with the union the day a member is added. Everything that renders
 * an RPM reads from here, so no surface can invent its own wording for a state.
 */
export const UNPRICED_NICHE_SHORT = "Not estimated";

/** Why a niche has no money figure, in words a studio owner can act on. */
export const UNPRICED_NICHE_EXPLANATION =
  "Nobody has said what 1,000 views in this niche are worth, and Northstar has no monetized channel here whose own revenue could stand in. Until one of those exists there is no honest way to put a number on the niche — an empty figure here is a missing decision, not a niche worth nothing.";

/** A priced niche that published nothing in the period. */
export const UNPRICED_NICHE_SHORT_NO_SHORTS = "No Shorts in this period";

/**
 * What a priced niche with no Shorts in the period says instead of a figure.
 *
 * WORDS, NOT "$0", and this is the same rule as everywhere else in this module
 * rather than a special case. Zero views really do price to zero money, so the
 * arithmetic is not wrong — but "$0" sitting under "Tracked niche revenue" is
 * read as "this niche generates nothing", which is a claim about the niche
 * rather than about the period somebody selected. The `MiniStat` beside it uses
 * words for exactly this reason.
 */
export const NO_SHORTS_TO_PRICE_EXPLANATION =
  "Nothing tracked here was published in the selected period, so there are no views to price. The rate below still applies — widen the period to see what this niche is worth.";

/** A niche whose stored estimate exists but cannot be shown in the base currency. */
export const UNCONVERTIBLE_NICHE_SHORT = "Estimate unusable";

/** The label for the money figure. "Tracked" is not optional; see above. */
export const TRACKED_NICHE_VALUE_LABEL = "Tracked niche revenue";

/** How a derived rate is introduced, so nobody reads it as a guess. */
export const DERIVED_RPM_EXPLANATION =
  "Measured from what Northstar's own channels in this niche actually earned, over the last 28 settled days, divided by the views they gained in the same window. It overrides any range entered by hand.";

/** How an entered range is introduced, so nobody reads it as a measurement. */
export const MANUAL_RPM_EXPLANATION =
  "An estimate somebody entered by hand, because no channel Northstar operates in this niche can supply a measured rate yet. Every money figure below is that estimate multiplied out, not a measurement.";

/**
 * The lead-in to the per-channel reasons, wherever they are shown.
 *
 * Shown under a HAND-ENTERED rate as well as under an unpriced niche, which is
 * the case it was added for. The owner's request names exactly this state — "if
 * our channels aren't monetized, newly monetized... I should be able to enter an
 * RPM range" — and it used to be the one state where the reason his own channel
 * was not overriding the guess was computed, sent to the browser, and dropped.
 */
export const RPM_NOT_MEASURED_BECAUSE = "Not measured from our own channel yet because:";

/** A niche priced in a currency the organization cannot convert out of. */
export const MANUAL_RPM_UNCONVERTIBLE_EXPLANATION =
  "This niche has a hand-entered RPM range, but it was typed in a currency with no exchange rate configured into the organization's base currency — so there is no honest way to show it here. Nothing has been lost: add the rate under Finance → Exchange rates and the estimate comes back. Converting it without a rate somebody chose, or printing the digits under the wrong symbol, would both be numbers nobody entered.";

/**
 * The positive marker for a measured rate.
 *
 * The card marks BOTH states rather than treating one as the unmarked default.
 * An estimate whose two ends happen to be equal — which the form deliberately
 * allows, for somebody who genuinely means one number — is otherwise a figure
 * indistinguishable from a measurement, and "no chip" is not a claim anybody
 * reads as "guessed".
 */
export const MEASURED_RPM_CHIP = "Measured";

/** The marker for a rate somebody typed, whether or not its ends differ. */
export const ESTIMATED_RPM_CHIP = "Est";

/** One sentence per rejection, for the surface that has to say why. */
export const RPM_REJECTION_EXPLANATION: Readonly<Record<RpmChannelRejection, string>> = {
  not_monetized:
    "is not in the YouTube Partner Programme, so it reports no revenue to derive a rate from.",
  revenue_not_reported:
    "has no revenue we could read for this window — the account is not connected for revenue, the last read failed, or YouTube declined the report. That is not the same as earning nothing.",
  newly_monetized:
    "started earning part-way through the window — we hold the earlier days and they are quiet — so it has more days of views than of revenue. A rate divided out of that would understate what the niche pays.",
  revenue_history_too_shallow:
    "has earnings from the first day of the window and none imported from before it, so we cannot tell a long-monetized channel from one that started earning that morning. Revenue import reaches further back with every daily run; until it clears the window there is no way to know which of the two this is.",
  too_few_earning_days:
    "earned on too few days of the window for a steady rate. A handful of earning days describes an event rather than a price.",
  no_view_history:
    "has no recorded view history spanning the window, so there is nothing to divide its revenue by. View history is collected by automatic refresh, which is currently switched off.",
  thin_view_coverage:
    "has view history for too little of its library, so the views it gained cannot be measured without overstating the rate.",
  below_evidence_floor:
    "earned too little over too few views for a rate divided out of it to be stable.",
  currency_unconvertible:
    "reports revenue in a currency with no exchange rate configured, so it cannot be brought into the organization's base currency. An admin can add one under Finance → Exchange rates.",
};

/** En dash, matching the hit-rate bounds. Not a hyphen: this is a range. */
const RANGE_DASH = "–";

/**
 * The rate, drawn as what it is.
 *
 * A point where both ends agree — a measurement, or an admin who genuinely
 * meant one number — and a two-ended range otherwise. Never a midpoint: the
 * middle of a range is a figure nobody entered, and printing one turns a stated
 * uncertainty into a false precision.
 */
export function formatRpmBounds(bounds: RpmBounds): string {
  const low = formatRpm(bounds.lowMinorPerMillion, bounds.currency);
  if (isRpmPoint(bounds)) return low;
  return `${low}${RANGE_DASH}${formatRpm(bounds.highMinorPerMillion, bounds.currency)}`;
}
