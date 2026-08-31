import {
  calculateNicheValue,
  rpmBounds,
  type NicheRpmResolution,
  type NicheValue,
  type ProjectedMoney,
} from "./niche-rpm";

/**
 * =========================================================================
 * WHAT EVERY NICHE IS GENERATING, ON ONE SCREEN
 * =========================================================================
 *
 * The owner's seventh request: "I should be able to see how much the niche
 * generates in $ within a given timeframe under Overview, but again, this
 * should only be visible to Admins."
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
 * THREE REFUSALS, AND WHY EACH ONE IS A REFUSAL RATHER THAN A ZERO
 * ---------------------------------------------------------------------------
 * 1. WITHHELD. `NicheDTO.rpm` is `null` for a reader without `finance.view` —
 *    the server does not send the economics at all. The panel is then ABSENT,
 *    not empty: an employee looking at Overview should see a page with no money
 *    on it, rather than a money panel with nothing in it inviting them to ask
 *    why. This is a structural gate rather than a role check in the browser; a
 *    reader who is not permitted has nothing to render from.
 *
 * 2. NOTHING PRICED. This is the state of this deployment TODAY, for every
 *    niche, and it is the one the owner will actually see first. No channel can
 *    supply a measured rate — `autoRefreshEnabled` is false, so nothing writes
 *    the `VideoSnapshot` rows a derived rate needs a denominator from — and no
 *    range has been entered. The panel says exactly that, with the per-niche
 *    reasons the resolver already computed. It does NOT render a table of
 *    "$0.00", which would tell an owner his catalogue generates nothing.
 *
 * 3. NO SHORTS IN THE PERIOD. A priced niche that published nothing in the
 *    selected window really does price to zero, and the arithmetic is correct —
 *    but "$0" under a niche's name reads as a claim about the niche rather than
 *    about the period on screen. Words, not a figure. Same rule the niche card
 *    already follows.
 *
 * ---------------------------------------------------------------------------
 * THE TOTAL IS THE DANGEROUS PART
 * ---------------------------------------------------------------------------
 * A channel filed under two niches is judged once and counted in BOTH, which is
 * correct for a RATE and wrong for a portfolio total: adding the niche figures
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

/** One niche, as the panel is handed it. */
export interface NicheEarningsInput {
  readonly id: string;
  readonly name: string;
  readonly colorIndex: number;
  /**
   * The resolved rate, or `null` when the reader may not see economics.
   *
   * ONE NULL FOR ONE MEANING, matching `NicheDTO.rpm`: null is "withheld", and
   * "nobody has priced this" is a VALUE of the object rather than its absence.
   * That is what lets the disclosure test below be a single check.
   */
  readonly rpm: NicheRpmResolution | null;
  /** Raw Shorts views from channels Northstar owns, over the selected period. */
  readonly ourViews: number;
  /** Raw Shorts views from every other tracked channel in this niche. */
  readonly competitorViews: number;
  /**
   * The own channels behind `ourViews`.
   *
   * Carried solely to detect the double-count above. Ids rather than a count,
   * because the question is whether the SAME channel appears twice across
   * niches, which a count cannot answer.
   */
  readonly ownChannelIds: readonly string[];
}

/** Why a niche has no figure on this panel. */
export type NicheEarningsState =
  /** A rate applies and something was published. There is money to show. */
  | "priced"
  /** A rate applies and nothing was published in the period. Words, not "$0". */
  | "no_shorts"
  /** No rate applies at all. The resolver's own reason travels on the row. */
  | "unpriced";

export interface NicheEarningsRow {
  readonly id: string;
  readonly name: string;
  readonly colorIndex: number;
  readonly state: NicheEarningsState;
  /** The resolution, so the row can name its rate, its basis and its reasons. */
  readonly rpm: NicheRpmResolution;
  /** Always computed — the view figures are real even where the money is not. */
  readonly value: NicheValue;
}

/** Why there is no single portfolio figure. `null` when there is one. */
export type NoTotalReason =
  /** Not one niche has a rate. The panel's headline state, today. */
  | "nothing_priced"
  /**
   * Every niche that HAS a rate published nothing in the selected period.
   *
   * Split out from `nothing_priced` because the two states are opposite
   * instructions to the owner — one is waiting for a decision, the other for an
   * upload, or merely for a wider period — and collapsing them made the panel
   * tell an owner who had just entered his first RPM that he had entered none.
   * Reachable the moment one rate exists and the period is narrowed, which is
   * the first thing anybody does after pricing a niche.
   */
  | "nothing_published"
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
   * Northstar's own Shorts, priced, summed over DISTINCT channels — or `null`,
   * with `noTotalReason` saying why.
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

    const bounds = rpmBounds(niche.rpm);
    const value = calculateNicheValue({
      ourViews: niche.ourViews,
      competitorViews: niche.competitorViews,
      bounds,
      // Off the resolution, where it travels welded to the rate it scales.
      engagedViewShareBasisPoints: niche.rpm.engagedViewShareBasisPoints,
    });

    rows.push({
      id: niche.id,
      name: niche.name,
      colorIndex: niche.colorIndex,
      state:
        bounds === null
          ? "unpriced"
          : // `capturePercent` is null exactly when the tracked niche has no
            // views in the period, which is the one case where a correct "$0"
            // would be read as a claim about the niche.
            value.capturePercent === null
            ? "no_shorts"
            : "priced",
      rpm: niche.rpm,
      value,
    });
  }

  const priced = rows.filter((row) => row.state === "priced");

  if (priced.length === 0) {
    /*
     * TWO DIFFERENT NOTHINGS, and telling them apart is the whole point.
     *
     * `priced` excludes `no_shorts` as well as `unpriced`, so an owner who had
     * entered one rate and then narrowed the period landed here and was told
     * "no niche has a rate yet" — false, and the exact opposite of what his
     * rows already said correctly. The rows are right either way; what changes
     * is which sentence sits above them and whether they render at all.
     */
    return {
      disclosed: true,
      rows,
      pricedCount: 0,
      total: null,
      noTotalReason: rows.every((row) => row.state === "unpriced")
        ? "nothing_priced"
        : "nothing_published",
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

/** The panel's heading. "Tracked" is not optional; see `market-share.ts`. */
export const NICHE_EARNINGS_LABEL = "What each niche is generating";

/**
 * The definition, which has to carry the period caveat before anything else.
 *
 * THE LABEL AND THE ARITHMETIC DISAGREE UNLESS THIS IS SAID. The owner asked
 * for what a niche generates "within a given timeframe", and the period
 * selector sitting above this panel makes that reading irresistible. It is not
 * what the figure is: the period chooses which UPLOADS are counted, and what is
 * priced is those uploads' lifetime views to date. Views EARNED in a period
 * would need the `VideoSnapshot` delta series, which nothing is currently
 * writing — the same missing series that makes every derived rate unavailable.
 * So the panel states its own definition rather than letting the control above
 * it imply a different one.
 */
export const NICHE_EARNINGS_DEFINITION =
  "For each niche, the Shorts published in the selected period are priced at that niche's RPM. Read the period carefully: it chooses which uploads are in the figure, not which views or revenue were earned during it, so this is what those uploads are worth in total rather than what the niche made last month. Views earned inside a period would need view history, which is collected by automatic refresh — currently switched off. Every figure only counts channels in your tracker, so it moves when you add or remove a competitor.";

/** Why no niche has a figure — the state of this deployment today. */
export const NICHE_EARNINGS_NOTHING_PRICED =
  "No niche has a rate yet, so there is nothing to price. A niche gets one either from a Northstar channel in it that reports revenue — which needs view history, collected by automatic refresh — or from an RPM range entered by hand on the niche's card. Until one of those exists, an empty panel here is a missing decision rather than a portfolio worth nothing.";

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
  nothing_published:
    "Every niche with a rate published nothing in this period, so there is nothing to price. Widen the period, or check whether these channels were refreshed.",
  channel_in_two_priced_niches:
    "One of Northstar's channels is filed under two priced niches, so adding the niches together would count its views twice — at two different rates. The per-niche figures below are each correct on their own; no single total is.",
  mixed_currency:
    "Two niches are priced in different currencies, so their figures cannot be added. Set one base currency under Finance and they will total.",
};
