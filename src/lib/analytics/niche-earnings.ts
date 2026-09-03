import {
  RPM_MIN_SNAPSHOT_COVERAGE,
  calculateNicheValue,
  rpmBounds,
  type NicheRpmResolution,
  type NicheValue,
  type ProjectedMoney,
} from "./niche-rpm";
import { DEFAULT_NICHE_FORMAT, type NicheFormat } from "@/lib/niches/niche-format";

/**
 * =========================================================================
 * WHAT EVERY NICHE IS GENERATING, ON ONE SCREEN
 * =========================================================================
 *
 * The owner's seventh request: "I should be able to see how much the niche
 * generates in $ within a given timeframe under Overview, but again, this
 * should only be visible to Admins."
 *
 * WHAT IS PRICED: views GAINED during the selected period, from the
 * `VideoSnapshot` delta series — every view the tracked channels earned in
 * the window, old uploads included. Not the lifetime views of what happened
 * to be published in it: that is the upload basis, which the hit rate, Upload
 * views and the market-share percentages deliberately keep, because it
 * answers a different question ("how did recent output do?") than money does
 * ("what did the period pay?").
 *
 * ---------------------------------------------------------------------------
 * A PURE FUNCTION, BECAUSE THE HARD PARTS ARE ALL RULES
 * ---------------------------------------------------------------------------
 * The panel that renders this is React; everything below is arithmetic and
 * refusals, and the refusals are the part worth pinning. The test runner here
 * is Node with no DOM, so a rule expressed as JSX is a rule no test can hold —
 * the same argument `posterSourceFor` and `frameFor` make. In particular the
 * DISCLOSURE decision lives here, so "an employee sees nothing" is a property a
 * test states rather than a component nobody can mount.
 *
 * ---------------------------------------------------------------------------
 * FOUR REFUSALS, AND WHY EACH ONE IS A REFUSAL RATHER THAN A ZERO
 * ---------------------------------------------------------------------------
 * 1. WITHHELD. `NicheDTO.rpm` is `null` for a reader without `finance.view` —
 *    the server does not send the economics at all. The panel is then ABSENT,
 *    not empty: an employee looking at Overview should see a page with no money
 *    on it, rather than a money panel with nothing in it inviting them to ask
 *    why. This is a structural gate rather than a role check in the browser; a
 *    reader who is not permitted has nothing to render from.
 *
 * 2. NOTHING PRICED. No channel supplies a measured rate and no range has been
 *    entered by hand. The panel says exactly that, with the per-niche reasons
 *    the resolver already computed. It does NOT render a table of "$0.00",
 *    which would tell an owner his catalogue generates nothing.
 *
 * 3. NOT ENOUGH HISTORY. The app can only measure a gain where the snapshot
 *    series brackets the period, and it refuses a money figure where too
 *    little of a niche's library is bracketed. The floor is
 *    `RPM_MIN_SNAPSHOT_COVERAGE` — 0.9, the DOLLAR floor, not the 0.8 the
 *    history chart uses: missing videos shift a chart's shape, but here they
 *    subtract someone's views from a money figure. Below it: words, never a
 *    number priced from an incomplete count.
 *
 * 4. NO VIEWS GAINED. A priced, measured niche whose channels gained nothing
 *    over the measured days really does price to zero, and the arithmetic is
 *    correct — but "$0" under a niche's name reads as a claim about the niche
 *    rather than about the period on screen. Words, not a figure. Same rule
 *    the niche card already follows.
 *
 * ---------------------------------------------------------------------------
 * THE TOTAL IS THE DANGEROUS PART
 * ---------------------------------------------------------------------------
 * A channel filed under two niches is measured once and counted in BOTH, which
 * is correct for a PER-NICHE figure and wrong for a portfolio total: adding the
 * niche figures together counts that channel's views twice. `niche-rpm-service`
 * states the rule and this is the first surface that could break it, because it
 * is the first one to sum across niches at all.
 *
 * So the total is computed over DISTINCT channels, and where a channel really
 * does appear in two priced niches there is no honest single figure — the same
 * views would have to be priced at two different rates — and the total is
 * withheld with the overlap named. Refusing costs the owner a number; a
 * silently doubled one costs him a decision.
 */

/** The coverage behind one niche's measured gains, or `null` when nothing
 * could be measured at all (no history reaches the period). */
export type MeasuredCoverage = {
  readonly coveredVideos: number;
  readonly totalVideos: number;
} | null;

/**
 * Is this niche's measurement trustworthy enough to price?
 *
 * ONE PREDICATE FOR BOTH SURFACES — the Overview panel and the niche card
 * decide "words or money" through this, so the two can never disagree about
 * the same niche in the same period. `null` coverage means the endpoint had
 * nothing to measure (or omitted the niche), which is the same refusal as
 * thin coverage said harder. A library of zero videos is NOT insufficient —
 * there is nothing the measurement failed to cover — it is simply a niche
 * with nothing to gain, which the no-gains state handles.
 */
export function hasUsableGainsHistory(measured: MeasuredCoverage): boolean {
  if (measured === null) return false;
  if (measured.totalVideos === 0) return true;
  return measured.coveredVideos / measured.totalVideos >= RPM_MIN_SNAPSHOT_COVERAGE;
}

/** One niche, as the panel is handed it. */
export interface NicheEarningsInput {
  readonly id: string;
  readonly name: string;
  readonly colorIndex: number;
  /**
   * The niche's format, already narrowed from the DTO. Decides how a
   * hand-entered rate is priced — engaged for shorts, raw for long form — via
   * `rpmBounds`. Optional so the existing Shorts panel builder and its tests
   * keep meaning what they meant; absent reads as shorts.
   */
  readonly format?: NicheFormat;
  /**
   * The resolved rate, or `null` when the reader may not see economics.
   *
   * ONE NULL FOR ONE MEANING, matching `NicheDTO.rpm`: null is "withheld", and
   * "nobody has priced this" is a VALUE of the object rather than its absence.
   * That is what lets the disclosure test below be a single check.
   */
  readonly rpm: NicheRpmResolution | null;
  /** Views gained over the measured span by channels Northstar owns. */
  readonly ourViewsGained: number;
  /** The same delta for every other tracked channel in this niche. */
  readonly competitorViewsGained: number;
  /**
   * How much of the niche's library the gains above actually measured.
   * `null` when the endpoint could measure nothing — no history reaching the
   * period at all — which is a harder version of the same refusal.
   */
  readonly measured: MeasuredCoverage;
  /**
   * The own channels behind `ourViewsGained`.
   *
   * Carried solely to detect the double-count above. Ids rather than a count,
   * because the question is whether the SAME channel appears twice across
   * niches, which a count cannot answer.
   */
  readonly ownChannelIds: readonly string[];
}

/** Why a niche has no figure on this panel. */
export type NicheEarningsState =
  /** A rate applies and views were gained and measured. There is money to show. */
  | "priced"
  /** A rate applies and nothing tracked here gained views. Words, not "$0". */
  | "no_gains"
  /** A rate applies and the view history covers too little of the library to
   * price honestly. Words, and the coverage counts, never a number. */
  | "insufficient_history"
  /** No rate applies at all. The resolver's own reason travels on the row. */
  | "unpriced";

export interface NicheEarningsRow {
  readonly id: string;
  readonly name: string;
  readonly colorIndex: number;
  /** Carried through from the input so the row's renderer quotes the rate on
   * the same basis the arithmetic priced it with. */
  readonly format: NicheFormat;
  readonly state: NicheEarningsState;
  /** The resolution, so the row can name its rate, its basis and its reasons. */
  readonly rpm: NicheRpmResolution;
  /** Always computed — the view figures are real even where the money is not.
   * On an `insufficient_history` row the money inside MUST NOT render: it was
   * priced from an incomplete count, which is why the state exists. */
  readonly value: NicheValue;
  /** The coverage behind the row, so a thin-history row can say how thin. */
  readonly measured: MeasuredCoverage;
}

/** Why there is no single portfolio figure. `null` when there is one. */
export type NoTotalReason =
  /** Not one niche has a rate. */
  | "nothing_priced"
  /**
   * Every niche that HAS a rate — and could be measured — gained nothing over
   * the measured days.
   *
   * Split out from `nothing_priced` because the two states are opposite
   * instructions to the owner — one is waiting for a decision, the other for
   * a wider period or the next refresh — and collapsing them made the panel
   * tell an owner who had just entered his first RPM that he had entered none.
   */
  | "nothing_gained"
  /**
   * Every rate-bearing niche is below the coverage floor, so no money figure
   * exists to add. The instruction here is a third one again: wait — the
   * history fills in on its own as the app keeps recording — or pick a more
   * recent period the history already covers.
   */
  | "no_usable_history"
  /**
   * A channel is filed under two priced niches, so its views would be counted
   * twice — and at two different rates, which is not a figure that exists.
   */
  | "channel_in_two_priced_niches"
  /**
   * Two niches priced in different currencies. Unreachable while the resolver
   * converts everything into the organization's base, and refused rather than
   * assumed: adding minor units across currencies is the one arithmetic error
   * that looks completely normal on screen.
   */
  | "mixed_currency";

export interface NicheEarningsPanel {
  /**
   * False means the reader was not sent any economics. Render NOTHING — not an
   * empty panel, not a locked one.
   */
  readonly disclosed: boolean;
  readonly rows: readonly NicheEarningsRow[];
  /** How many rows actually carry money. */
  readonly pricedCount: number;
  /**
   * Northstar's own gained views, priced, summed over DISTINCT channels — or
   * `null`, with `noTotalReason` saying why.
   *
   * NEVER A PARTIAL SUM PRESENTED AS A TOTAL, and the second half of that
   * sentence is the half that was missing. The sum genuinely covers only the
   * PRICED rows — an unpriced niche is unknown, not zero, so it cannot be added
   * — which means the figure is a subtotal whenever `pricedCount` is below
   * `rows.length`. That is the ordinary state, not an edge case: nobody prices
   * eight niches at once. So the total is still computed, because a subtotal is
   * useful, and `totalLabel` states its scope rather than the panel asserting a
   * coverage it does not have. `rows` is itself already scoped to the reader's
   * assigned niches, which is why the label counts ROWS rather than saying
   * "all".
   */
  readonly total: ProjectedMoney | null;
  readonly noTotalReason: NoTotalReason | null;
  /**
   * What `total` actually covers, ready to render. Empty when `total` is null.
   *
   * Derived here rather than in the panel so that "the label matches the sum"
   * is a property a test can hold — the panel is JSX and the test runner has no
   * DOM, the same argument the header makes about the disclosure rule.
   */
  readonly totalLabel: string;
  /** True when the total omits niches. Drives the caveat under the rows. */
  readonly totalIsPartial: boolean;
}

export function buildNicheEarnings(
  niches: readonly NicheEarningsInput[],
): NicheEarningsPanel {
  /*
   * THE DISCLOSURE TEST, and it is deliberately `every` rather than `some`.
   *
   * A permitted reader receives an object for every niche they are assigned to
   * and no entry at all for the rest — `resolveNicheRpmByNiche` leaves an
   * out-of-scope niche out of the map rather than answering it with an empty
   * resolution, so a niche-scoped member granted `finance.view` legitimately
   * sees a mix of nulls and objects. Treating one null as "withheld" would
   * blank the panel for exactly that person; treating ALL nulls as withheld is
   * the honest reading, and it is also the only state an unpermitted reader can
   * be in, because they receive nulls for everything.
   */
  if (niches.length === 0 || niches.every((niche) => niche.rpm === null)) {
    return {
      disclosed: false,
      rows: [],
      pricedCount: 0,
      total: null,
      noTotalReason: null,
      totalLabel: "",
      totalIsPartial: false,
    };
  }

  const rows: NicheEarningsRow[] = [];

  for (const niche of niches) {
    // A niche outside this reader's assignment. Left out entirely rather than
    // listed as unpriced: naming it and saying it has no rate is itself a
    // disclosure about a niche they were not sent.
    if (niche.rpm === null) continue;

    const format = niche.format ?? DEFAULT_NICHE_FORMAT;
    const bounds = rpmBounds(niche.rpm, format);
    const value = calculateNicheValue({
      // `calculateNicheValue` clamps a negative input to 0, which is exactly
      // right here: a purge-driven negative sum is a real view movement and
      // an impossible amount of money, so the view figure survives raw in the
      // DTO while the pricing floor stops at nothing.
      ourViews: niche.ourViewsGained,
      competitorViews: niche.competitorViewsGained,
      bounds,
      // Off the resolution, where it travels welded to the rate it scales.
      engagedViewShareBasisPoints: niche.rpm.engagedViewShareBasisPoints,
    });

    rows.push({
      id: niche.id,
      name: niche.name,
      colorIndex: niche.colorIndex,
      format,
      state:
        bounds === null
          ? "unpriced"
          : // History first, gains second: a niche the history cannot cover
            // has an UNKNOWN gain, and "no views gained" would be a claim the
            // measurement never made.
            !hasUsableGainsHistory(niche.measured)
            ? "insufficient_history"
            : // `capturePercent` is null exactly when the measured niche
              // gained nothing, which is the one case where a correct "$0"
              // would be read as a claim about the niche.
              value.capturePercent === null
              ? "no_gains"
              : "priced",
      rpm: niche.rpm,
      value,
      measured: niche.measured,
    });
  }

  const priced = rows.filter((row) => row.state === "priced");

  if (priced.length === 0) {
    /*
     * THREE DIFFERENT NOTHINGS, and telling them apart is the whole point.
     *
     * "No niche has a rate", "the rated niches gained nothing", and "the
     * history cannot cover this period yet" are three different instructions
     * to the owner — enter a rate; widen the period or wait for the next
     * refresh; wait for the history to fill in or pick a recent period. The
     * rows are right either way; what changes is which sentence sits above
     * them and whether they render at all.
     */
    const rated = rows.filter((row) => row.state !== "unpriced");
    return {
      disclosed: true,
      rows,
      pricedCount: 0,
      total: null,
      noTotalReason:
        rated.length === 0
          ? "nothing_priced"
          : rated.every((row) => row.state === "insufficient_history")
            ? "no_usable_history"
            : "nothing_gained",
      totalLabel: "",
      totalIsPartial: false,
    };
  }

  /*
   * THE DOUBLE-COUNT CHECK, over channel ids rather than over niches.
   *
   * Only PRICED niches matter: a channel sitting in one priced niche and one
   * unpriced one contributes to exactly one figure, so there is nothing to
   * double. Checked before the sum rather than corrected after it, because
   * there is no correction — the same views would need pricing at two rates,
   * and picking one of them silently is how a portfolio number becomes fiction.
   */
  const seen = new Set<string>();
  for (const row of priced) {
    const input = niches.find((niche) => niche.id === row.id);
    for (const channelId of input?.ownChannelIds ?? []) {
      if (seen.has(channelId)) {
        return {
          disclosed: true,
          rows,
          pricedCount: priced.length,
          total: null,
          noTotalReason: "channel_in_two_priced_niches",
          totalLabel: "",
          totalIsPartial: false,
        };
      }
      seen.add(channelId);
    }
  }

  const currency = priced[0]!.value.ourRevenue!.currency;
  if (priced.some((row) => row.value.ourRevenue!.currency !== currency)) {
    return {
      disclosed: true,
      rows,
      pricedCount: priced.length,
      total: null,
      noTotalReason: "mixed_currency",
      totalLabel: "",
      totalIsPartial: false,
    };
  }

  /*
   * SUMMING ALREADY-PROJECTED FIGURES IS CORRECT HERE, and it is worth saying
   * why, because the RPM module refuses exactly this pattern elsewhere.
   *
   * `gapRevenue` is priced from a view difference rather than by subtracting
   * two projections, because interval SUBTRACTION widens an answer to
   * [lowTotal − highOurs, highTotal − lowOurs] and can go negative. Interval
   * ADDITION has no such problem: [a,b] + [c,d] is exactly [a+c, b+d], and the
   * bounds stay ordered. The alternative — adding the view counts first and
   * pricing once — is unavailable anyway, since each niche has its own rate.
   */
  let lowMinor = 0;
  let highMinor = 0;
  for (const row of priced) {
    lowMinor += row.value.ourRevenue!.lowMinor;
    highMinor += row.value.ourRevenue!.highMinor;
  }

  return {
    disclosed: true,
    rows,
    pricedCount: priced.length,
    total: { lowMinor, highMinor, currency },
    noTotalReason: null,
    totalLabel: nicheEarningsTotalLabel(priced.length, rows.length),
    totalIsPartial: priced.length < rows.length,
  };
}

/**
 * What the figure beside the heading covers, said in the label itself.
 *
 * THE LABEL IS THE CHECK. The sum can only include niches that have a rate, so
 * a header reading "all niches" over it was a claim the arithmetic never made:
 * with two of eight niches priced it asserted a portfolio figure while six
 * niches — unknown, not zero, and possibly the largest ones — were missing with
 * no caveat anywhere on screen. Counting the rows instead is honest in both
 * directions, and it also happens to fix the scoped reader: a member granted
 * `finance.view` for two of eight niches is shown "2 niches priced", which is
 * true of what they were sent, where "all niches" was not.
 */
export function nicheEarningsTotalLabel(
  pricedCount: number,
  nicheCount: number,
): string {
  const niches = pricedCount === 1 ? "niche" : "niches";
  if (pricedCount >= nicheCount) {
    return `Northstar's share, ${pricedCount} priced ${niches}`;
  }
  return `Northstar's share, ${pricedCount} of ${nicheCount} ${
    nicheCount === 1 ? "niche" : "niches"
  } priced`;
}

// ---------------------------------------------------------------------------
// THE MEASURED SPAN
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * The label for a period the view history only partly covers.
 *
 * The figure is real; what it covers is not the whole period on the selector,
 * and a money number wearing a 30-day label while measuring 9 days is the
 * partial-sum-as-total mistake in time instead of across niches. Never used
 * to fabricate anything — where nothing at all is measurable, the states
 * above refuse instead of shortening the label to zero.
 */
export function measuredSpanNote(measuredDays: number, periodDays: number): string {
  return `Measured over the last ${measuredDays} of ${periodDays} ${
    periodDays === 1 ? "day" : "days"
  } — view history begins there.`;
}

/** The lead sentence when the history did cover the whole period. */
export function fullSpanNote(periodDays: number): string {
  return `Measured over the full ${periodDays} ${periodDays === 1 ? "day" : "days"}.`;
}

/**
 * The smallest lag worth a sentence: one minute, the smallest unit the note
 * can express. Below it "up to 0 minutes" is not a caveat, it is noise under
 * every figure forever.
 */
export const BASELINE_LAG_FLOOR_MS = 60_000;

const HOUR_MS = 3_600_000;

/**
 * A duration for a non-technical reader, ROUNDED UP.
 *
 * Up, always, because the number lands in a sentence that says "up to": round
 * 100 minutes down to an hour and the label states a bound the arithmetic does
 * not support, which is the one way this caveat could become a lie.
 */
export function approxDurationCeil(ms: number): string {
  if (ms < HOUR_MS) {
    const minutes = Math.max(1, Math.ceil(ms / 60_000));
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  if (ms < 48 * HOUR_MS) {
    const hours = Math.ceil(ms / HOUR_MS);
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.ceil(ms / DAY_MS);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * The caveat for a span some videos only join part way through.
 *
 * WHY THIS SENTENCE HAS TO EXIST. The measurement now baselines a video whose
 * own history starts a little inside the window on its own first reading,
 * instead of dropping it — see `BASELINE_GRACE_FRACTION`. That fixes a figure
 * that was refusing to appear at all, and it gives up the claim that every
 * video was measured over the identical span. The label may not keep making
 * that claim silently: it names the gap, and it names the DIRECTION of the
 * error, which is the half an owner planning against the number needs.
 *
 * The gap is stated in TIME, not as a percentage of the money. A video's views
 * do not arrive evenly — a Short can take most of its lifetime views in its
 * first hours — so "understated by at most 0.6%" would be a bound nobody can
 * support. "Their first two hours are missing, so this is a little low" is
 * exactly what is known.
 */
export function baselineLagNote(lagMs: number): string {
  return `The app started recording some of these videos up to ${approxDurationCeil(
    lagMs,
  )} into that span, so their first views are missing and this figure is a little low.`;
}

/**
 * The note for one response, or `null` when the whole period was measured from
 * end to end for every video.
 *
 * Derived from the server's own `requestedStartMs`/`measuredFromMs` echo
 * rather than from the client's copy of the range, so the label describes the
 * span that was actually measured even if the two ever disagree. Day counts
 * are rounded and floored at 1: a partial day of history is still history,
 * and "0 of 30 days" under a real figure would be self-contradictory.
 *
 * THIS NOW SPEAKS WHERE IT USED TO GO SILENT. A response whose clamp never
 * fired — `measuredFromMs === requestedStartMs` — can still carry videos whose
 * own history starts later, and that is exactly the case the ragged-baseline
 * caveat exists for. Returning `null` on the strength of the span alone would
 * hide it precisely when it is the only thing left to say.
 */
export function measuredSpanNoteFrom(response: {
  readonly requestedStartMs: number;
  readonly measuredFromMs: number | null;
  readonly endMs: number;
  readonly maxBaselineLagMs: number | null;
}): string | null {
  const { requestedStartMs, measuredFromMs, endMs, maxBaselineLagMs } = response;
  if (measuredFromMs === null) return null;

  const periodDays = Math.max(1, Math.round((endMs - requestedStartMs) / DAY_MS));
  const clamped = measuredFromMs > requestedStartMs;
  const ragged = maxBaselineLagMs !== null && maxBaselineLagMs >= BASELINE_LAG_FLOOR_MS;

  if (!clamped && !ragged) return null;

  const measuredDays = Math.max(1, Math.round((endMs - measuredFromMs) / DAY_MS));
  const span = clamped ? measuredSpanNote(measuredDays, periodDays) : fullSpanNote(periodDays);
  return ragged ? `${span} ${baselineLagNote(maxBaselineLagMs)}` : span;
}

// ---------------------------------------------------------------------------
// WHAT THE PANEL SAYS
// ---------------------------------------------------------------------------

/** The panel's heading. "Tracked" is not optional; see `market-share.ts`. */
export const NICHE_EARNINGS_LABEL = "What each niche is generating";

/**
 * The definition. The period now means what the selector implies — views
 * gained during it — and the caveat that remains is the honest one: the
 * measurement reaches only as far back as the recorded history does, and the
 * label says so whenever that is short of the period.
 */
export const NICHE_EARNINGS_DEFINITION =
  "For each niche, the Shorts views its tracked channels gained during the selected period are priced at that niche's RPM. This counts every view earned in the period — including views picked up by older uploads — not just the views of what was published recently. The app can only measure from the day it started recording view history: when the period reaches further back than the history does, the figure covers the recorded days and the label says so. Every figure only counts channels in your tracker, so it moves when you add or remove a competitor.";

/** The Long Form panel's copy of the definition — the views are not Shorts there. */
export const NICHE_EARNINGS_DEFINITION_LONGFORM =
  "For each niche, the long-form views its tracked channels gained during the selected period are priced at that niche's RPM. This counts every view earned in the period — including views picked up by older uploads — not just the views of what was published recently. The app can only measure from the day it started recording view history: when the period reaches further back than the history does, the figure covers the recorded days and the label says so. Every figure only counts channels in your tracker, so it moves when you add or remove a competitor.";

/** The definition for the panel a page of the given format mounts. */
export function nicheEarningsDefinition(format: NicheFormat): string {
  return format === "shorts"
    ? NICHE_EARNINGS_DEFINITION
    : NICHE_EARNINGS_DEFINITION_LONGFORM;
}

/** Why no niche has a figure — the missing-decision state. */
export const NICHE_EARNINGS_NOTHING_PRICED =
  "No niche has a rate yet, so there is nothing to price. A niche gets one either from a Northstar channel in it that reports revenue, or from an RPM range entered by hand on the niche's card. Until one of those exists, an empty panel here is a missing decision rather than a portfolio worth nothing.";

/**
 * The caveat under a total that does not cover every niche on the panel.
 *
 * Rendered whenever `totalIsPartial`, alongside the label that already says so.
 * The label states the scope; this states the CONSEQUENCE, which is the part an
 * owner planning against the figure needs: the missing niches are unknown
 * rather than zero, so the true number is higher by an amount nobody can bound.
 */
export const NICHE_EARNINGS_PARTIAL_TOTAL =
  "This total covers only the niches that have a rate. The rest are not zero — they are unpriced, so nothing here estimates them, and the real figure is higher by however much they are worth. Give them an RPM range to bring them in.";

/** One sentence per reason a portfolio total is withheld. */
export const NO_TOTAL_EXPLANATION: Readonly<Record<NoTotalReason, string>> = {
  nothing_priced:
    "No niche has a rate, so there is no total to add up.",
  nothing_gained:
    "Every niche with a rate gained no views over the measured days, so there is nothing to price. Widen the period, or check back after the next refresh.",
  no_usable_history:
    "View history does not yet cover enough of this period to price any niche. It fills in on its own as the app keeps recording — check back, or pick a more recent period.",
  channel_in_two_priced_niches:
    "One of Northstar's channels is filed under two priced niches, so adding the niches together would count its views twice — at two different rates. The per-niche figures below are each correct on their own; no single total is.",
  mixed_currency:
    "Two niches are priced in different currencies, so their figures cannot be added. Set one base currency under Finance and they will total.",
};
