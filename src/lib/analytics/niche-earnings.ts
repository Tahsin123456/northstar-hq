import {
  HISTORY_DATE_PLACEHOLDER,
  calculateNicheValue,
  fillHistoryDate,
  rpmBounds,
  type NicheRpmResolution,
  type NicheValue,
  type ProjectedMoney,
} from "./niche-rpm";
import { measuredChannelsCaption } from "./views-gained-labels";
import { DEFAULT_NICHE_FORMAT, type NicheFormat } from "@/lib/niches/niche-format";

/**
 * =========================================================================
 * WHAT EVERY NICHE IS GENERATING, ON ONE SCREEN
 * =========================================================================
 *
 * The owner's seventh request: "I should be able to see how much the niche
 * generates in $ under Overview, but again, this should only be visible to
 * Admins." And his definition of the figure, verbatim: "Niche earnings = the
 * overall views a channel generated in the given timeframe — the channel
 * might have videos from 2-3 months before that still generate views and they
 * should count — x the set niche RPM range."
 *
 * ---------------------------------------------------------------------------
 * WHAT IS PRICED: THE VIEWS THE TRACKED CHANNELS GAINED IN THE PERIOD
 * ---------------------------------------------------------------------------
 * Each member channel's lifetime view counter, read at the period's start and
 * at its close, the difference scaled by the channel's estimated share of the
 * niche's format, summed over the niche, priced at the niche's rate. Every
 * video the channel has is inside that counter however old it is; nothing
 * depends on when anything was uploaded.
 *
 * TWO OTHER BASES WERE SHIPPED AND BOTH WERE WRONG, in opposite directions.
 * The upload-date basis priced the lifetime views of whatever was PUBLISHED in
 * the period, so a niche whose channels posted before it showed nothing. The
 * lifetime basis priced every view the channels had EVER had, so a 30-day
 * label sat over a figure six figures too high and the period selector did
 * not move it. The channel delta is the one the owner actually described.
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
 * 3. MEASURING. A priced niche none of whose channels holds two readings yet
 *    — the first reading was taken, the second comes with the next refresh.
 *    Its gain is UNKNOWN, not zero, and the sentence says when the figure
 *    arrives. A PARTIALLY measured niche is priced, with a caption saying how
 *    many of its channels the figure covers.
 *
 * 4. NO VIEWS. A priced, measured niche whose channels gained nothing really
 *    does price to zero, and the arithmetic is correct — but "$0" under a
 *    niche's name reads as a claim about the niche rather than about the
 *    period. Words, not a figure. Same rule the niche card follows.
 *
 * ---------------------------------------------------------------------------
 * THE TOTAL IS THE DANGEROUS PART
 * ---------------------------------------------------------------------------
 * A channel filed under two niches is counted in BOTH, which is correct for a
 * PER-NICHE figure and wrong for a portfolio total: adding the niche figures
 * together counts that channel's views twice. `niche-rpm-service` states the
 * rule and this is the first surface that could break it, because it is the
 * first one to sum across niches at all.
 *
 * So the total is computed over DISTINCT channels, and where a channel really
 * does appear in two priced niches there is no honest single figure — the same
 * views would have to be priced at two different rates — and the total is
 * withheld with the overlap named. Refusing costs the owner a number; a
 * silently doubled one costs him a decision.
 */

/** How much of a niche the gains figure covers, or `null` when nothing was measured at all. */
export type MeasuredChannels = {
  readonly measuredChannels: number;
  readonly totalChannels: number;
} | null;

/** Is this niche still waiting for its first delta? */
export function isStillMeasuring(measured: MeasuredChannels): boolean {
  if (measured === null) return true;
  return measured.totalChannels > 0 && measured.measuredChannels === 0;
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
  /** The same figure for every other tracked channel in this niche. */
  readonly competitorViewsGained: number;
  /**
   * How many of the niche's channels the gains above cover. `null` when the
   * endpoint could measure nothing — no history reaching the period at all —
   * which is the same "measuring" state said harder.
   */
  readonly measured: MeasuredChannels;
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
  | "no_views"
  /** A rate applies and no channel holds two readings yet. Words, and a
   * promise of when: the next refresh. */
  | "measuring"
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
   * On a `measuring` row the money inside MUST NOT render: nothing was
   * measured, which is why the state exists. */
  readonly value: NicheValue;
  /** The coverage behind the row, so a partial figure can say how partial. */
  readonly measured: MeasuredChannels;
  /** "3 of 5 channels measured" under a partial figure; null when the figure
   * covers the whole niche or is not a figure at all. */
  readonly measuredCaption: string | null;
}

/** Why there is no single portfolio figure. `null` when there is one. */
export type NoTotalReason =
  /** Not one niche has a rate. */
  | "nothing_priced"
  /**
   * Every niche that HAS a rate — and was measured — gained nothing over the
   * measured days.
   *
   * Split out from `nothing_priced` because the two states are opposite
   * instructions to the owner — one is waiting for a decision, the other for
   * a wider period or the next refresh — and collapsing them made the panel
   * tell an owner who had just entered his first RPM that he had entered none.
   */
  | "no_views"
  /**
   * Every rate-bearing niche is still waiting for its second reading, so no
   * money figure exists to add. The instruction is a third one again: wait
   * for the next refresh.
   */
  | "still_measuring"
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

    const state: NicheEarningsState =
      bounds === null
        ? "unpriced"
        : // Measurement first, gains second: a niche nothing has measured has
          // an UNKNOWN gain, and "no views gained" would be a claim the
          // measurement never made.
          isStillMeasuring(niche.measured)
          ? "measuring"
          : // `capturePercent` is null exactly when the measured niche gained
            // nothing, which is the one case where a correct "$0" would be
            // read as a claim about the niche.
            value.capturePercent === null
            ? "no_views"
            : "priced";

    rows.push({
      id: niche.id,
      name: niche.name,
      colorIndex: niche.colorIndex,
      format,
      state,
      rpm: niche.rpm,
      value,
      measured: niche.measured,
      // Only under a figure. A caption saying "0 of 4 channels measured" under
      // the measuring sentence would say the same thing twice, worse.
      measuredCaption:
        state === "priced" && niche.measured !== null
          ? measuredChannelsCaption(niche.measured)
          : null,
    });
  }

  const priced = rows.filter((row) => row.state === "priced");

  if (priced.length === 0) {
    /*
     * THREE DIFFERENT NOTHINGS, and telling them apart is the whole point.
     *
     * "No niche has a rate", "the rated niches gained nothing", and "the
     * rated niches are still on their first reading" are three different
     * instructions to the owner — enter a rate; widen the period or wait for
     * the next refresh; wait for the next refresh. The rows are right either
     * way; what changes is which sentence sits above them.
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
          : rated.every((row) => row.state === "measuring")
            ? "still_measuring"
            : "no_views",
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
// WHAT THE PANEL SAYS
// ---------------------------------------------------------------------------

/**
 * The panel's heading.
 *
 * "TRACKED" IS NOT OPTIONAL; see `market-share.ts`. The app knows the handful
 * of channels somebody added, not the niche, so a heading that names the niche
 * alone claims a number the app cannot compute.
 *
 * PAST TENSE, NOT PRESENT PROGRESSIVE. "is generating" is a rate, and a rate
 * with no time unit beside it is read as one — per month, most often. The
 * figure beneath is what the period produced, and the span note under the
 * heading says which days that was.
 */
export const NICHE_EARNINGS_LABEL = "What each tracked niche has generated";

/**
 * The definition, as a template.
 *
 * FIVE FACTS, IN THE ORDER A READER NEEDS THEM: what is multiplied by what;
 * that every video counts however old it is; that the Shorts/long-form split
 * is an estimate, because YouTube reports one count per channel; when the
 * history began, so a period reaching further back is understood to be
 * measured over the recorded days; and that the figure only counts channels
 * somebody added, so it moves when the tracker does.
 *
 * `{date}` is filled by `nicheEarningsDefinition` from the response's own
 * `historyBeganMs`; nothing renders the constant raw. Written for the owner,
 * who is not technical: no "snapshot", no "delta", no "coverage".
 */
export const NICHE_EARNINGS_DEFINITION = `For each niche, the views its tracked channels gained during the selected period — across every video they have, however long ago it was posted — priced at the niche's RPM. Each channel's total is split between Shorts and long-form by the mix seen in its uploads, so the Shorts figure is an estimate. View history began on ${HISTORY_DATE_PLACEHOLDER}; when the period reaches further back, the figure covers the recorded days and the label says so. Only channels in your tracker count, so it moves when you add or remove a competitor. A hand-entered rate is applied to engaged views only — the paid subset of the view count, set under Settings.`;

/** The Long Form panel's copy of the definition — the views are not Shorts there, and no engaged-view share applies. */
export const NICHE_EARNINGS_DEFINITION_LONGFORM = `For each niche, the long-form views its tracked channels gained during the selected period — across every video they have, however long ago it was posted — priced at the niche's RPM. Each channel's total is split between Shorts and long-form by the mix seen in its uploads, so the long-form figure is an estimate. View history began on ${HISTORY_DATE_PLACEHOLDER}; when the period reaches further back, the figure covers the recorded days and the label says so. Only channels in your tracker count, so it moves when you add or remove a competitor. Every rate here is applied to the full view count: long-form RPM is quoted per 1,000 views, and no engaged-view share applies.`;

/** The definition for the panel a page of the given format mounts, with the history date in. */
export function nicheEarningsDefinition(
  format: NicheFormat,
  historyBeganMs: number | null = null,
): string {
  return fillHistoryDate(
    format === "shorts" ? NICHE_EARNINGS_DEFINITION : NICHE_EARNINGS_DEFINITION_LONGFORM,
    historyBeganMs,
  );
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
  "This total covers only the niches that have a rate and a figure. The rest are not zero — they are unpriced or still measuring, so nothing here estimates them, and the real figure is higher by however much they are worth.";

/** One sentence per reason a portfolio total is withheld. */
export const NO_TOTAL_EXPLANATION: Readonly<Record<NoTotalReason, string>> = {
  nothing_priced:
    "No niche has a rate, so there is no total to add up.",
  no_views:
    "Every niche with a rate gained no views over the measured days — nothing tracked in them moved, or no channel is filed under them yet — so there is nothing to add up. Try a wider period, or check back after the next refresh.",
  still_measuring:
    "Every niche with a rate is on its first reading. Views gained is the difference between two readings, so the first total appears once the next refresh has taken the second one.",
  channel_in_two_priced_niches:
    "One of Northstar's channels is filed under two priced niches, so adding the niches together would count its views twice — at two different rates. The per-niche figures below are each correct on their own; no single total is.",
  mixed_currency:
    "Two niches are priced in different currencies, so their figures cannot be added. Set one base currency under Finance and they will total.",
};
