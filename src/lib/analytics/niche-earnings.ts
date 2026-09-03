import { videosOfFormat } from "./filters";
import { sum } from "./stats";
import {
  calculateNicheValue,
  rpmBounds,
  type NicheRpmResolution,
  type NicheValue,
  type ProjectedMoney,
} from "./niche-rpm";
import type { AnalyticsVideo } from "./types";
import { DEFAULT_NICHE_FORMAT, type NicheFormat } from "@/lib/niches/niche-format";

/**
 * =========================================================================
 * WHAT EVERY NICHE IS GENERATING, ON ONE SCREEN
 * =========================================================================
 *
 * The owner's seventh request: "I should be able to see how much the niche
 * generates in $ under Overview, but again, this should only be visible to
 * Admins."
 *
 * ---------------------------------------------------------------------------
 * WHAT IS PRICED: ALL THE VIEWS THE TRACKED CHANNELS HAVE
 * ---------------------------------------------------------------------------
 * Every view of every video the tracker holds for the channels in this niche,
 * of this niche's format, multiplied by the niche's rate. Not the views of
 * what happened to be uploaded inside the selected period, and not a snapshot
 * delta over the period either.
 *
 * BOTH OF THOSE WERE TRIED AND BOTH PRINTED WORDS INSTEAD OF MONEY, for the
 * same underlying reason: they asked what a WINDOW produced, and a window is
 * exactly the thing the app cannot always see. The upload basis showed nothing
 * for a niche whose channels published before the period — which is most
 * niches, most of the time. The gains basis showed nothing wherever the
 * recorded view history was shallower than the period — which was everywhere,
 * because the history is days old.
 *
 * This basis needs neither. Every video's current view count is already in the
 * dataset payload the browser is holding, so the figure is computable today,
 * always, with no endpoint, no coverage floor and nothing to wait for.
 *
 * THE PERIOD SELECTOR THEREFORE DOES NOT MOVE THESE FIGURES, and the
 * definition says so out loud — a money number sitting beside a 7d/30d control
 * that ignores it is a number a reader will otherwise assume is broken. The
 * hit rate, Upload views and the market-share percentages keep the upload-date
 * basis: "how did recent output do?" is a real question about a period, and it
 * is not this one.
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
 * 2. NOTHING PRICED. No channel supplies a measured rate and no range has been
 *    entered by hand. The panel says exactly that, with the per-niche reasons
 *    the resolver already computed. It does NOT render a table of "$0.00",
 *    which would tell an owner his catalogue generates nothing.
 *
 * 3. NO VIEWS. A priced niche whose tracked channels hold no views of this
 *    format really does price to zero, and the arithmetic is correct — but "$0"
 *    under a niche's name reads as a claim about the niche's worth rather than
 *    about an empty tracker. Words, not a figure. Same rule the niche card
 *    already follows.
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

/** One tracked channel, as the money basis needs it. */
export interface NicheChannelViews {
  /** True for a channel Northstar operates — `ownershipType === "own"`. */
  readonly ownedByNorthstar: boolean;
  /** Every video the dataset holds for it. Not pre-filtered by date; see below. */
  readonly videos: readonly AnalyticsVideo[];
}

/** The two totals every niche money figure is built from. */
export interface NicheViewTotals {
  readonly ourViews: number;
  readonly competitorViews: number;
}

/**
 * THE MONEY BASIS, IN ONE FUNCTION, FOR BOTH SURFACES.
 *
 * Every view of this format that the tracker holds for these channels, split
 * into Northstar's and everybody else's. `videosOfFormat`, deliberately — no
 * date window anywhere in it:
 *
 *   • A channel's back catalogue keeps earning long after its upload date
 *     leaves any period a selector can name, so filtering by upload date
 *     answers "how did recent output do?" while the label above it says
 *     "what is this niche generating".
 *   • It is also what made these surfaces print sentences instead of money.
 *     A niche whose channels all published before the selected period had a
 *     total of zero, which the honesty rules correctly refuse to render as
 *     "$0" — so the owner saw words where he had asked for a figure, in the
 *     ordinary case rather than an edge one.
 *
 * ONE FUNCTION BECAUSE THERE ARE TWO SURFACES. The Overview panel and the
 * niche card's value strip must never report different money for the same
 * niche; sharing the selector is what makes that structural rather than a
 * thing two files remember to keep in step — the same argument
 * `calculateMarketShare` carries for the share percentages.
 *
 * The format filter is `isVideoOfFormat`, so a video the classifier could not
 * resolve is in NEITHER format and its views are never priced into a format
 * that never claimed it.
 */
export function nicheViewTotals(
  channels: readonly NicheChannelViews[],
  format: NicheFormat,
): NicheViewTotals {
  const viewsOf = (owned: boolean): number =>
    sum(
      channels
        .filter((channel) => channel.ownedByNorthstar === owned)
        .flatMap((channel) =>
          videosOfFormat(channel.videos, format).map((video) => video.views),
        ),
    );

  return { ourViews: viewsOf(true), competitorViews: viewsOf(false) };
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
  /**
   * ALL views held for channels Northstar owns in this niche, of this niche's
   * format. Every video the tracker has for them, regardless of upload date —
   * see the header. The caller sums it with `videosOfFormat`.
   */
  readonly ourViews: number;
  /** The same total for every other tracked channel in this niche. */
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
  /** A rate applies and the tracked channels have views. There is money to show. */
  | "priced"
  /** A rate applies and nothing tracked here has any views of this format.
   * Words, not "$0". */
  | "no_views"
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
  /** Always computed — the view figures are real even where the money is not. */
  readonly value: NicheValue;
}

/** Why there is no single portfolio figure. `null` when there is one. */
export type NoTotalReason =
  /** Not one niche has a rate. */
  | "nothing_priced"
  /**
   * Every niche that HAS a rate holds no views at all.
   *
   * Split out from `nothing_priced` because the two states are opposite
   * instructions to the owner — one is waiting for a decision, the other for
   * channels or a refresh — and collapsing them made the panel tell an owner
   * who had just entered his first RPM that he had entered none.
   */
  | "no_views"
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
   * Northstar's own views, priced, summed over DISTINCT channels — or `null`,
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

    const format = niche.format ?? DEFAULT_NICHE_FORMAT;
    const bounds = rpmBounds(niche.rpm, format);
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
      format,
      state:
        bounds === null
          ? "unpriced"
          : // `capturePercent` is null exactly when the tracked channels hold
            // no views at all, which is the one case where a correct "$0"
            // would be read as a claim about the niche.
            value.capturePercent === null
            ? "no_views"
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
     * "No niche has a rate" and "the rated niches have no views" are two
     * different instructions to the owner — enter a rate; add the channels, or
     * wait for the next refresh to bring their videos in. The rows are right
     * either way; what changes is which sentence sits above them.
     */
    const rated = rows.filter((row) => row.state !== "unpriced");
    return {
      disclosed: true,
      rows,
      pricedCount: 0,
      total: null,
      noTotalReason: rated.length === 0 ? "nothing_priced" : "no_views",
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
 * figure beneath is a cumulative total of every view on record, so a reader
 * doing that gets a number wrong by however many months the window holds.
 */
export const NICHE_EARNINGS_LABEL = "What each tracked niche has generated";

/**
 * The definition.
 *
 * FOUR FACTS, IN THE ORDER A READER NEEDS THEM: what is multiplied by what;
 * how far back "every view" actually reaches; that the period selector does
 * not change it; and that the view total only contains channels somebody
 * added, so it moves when the tracker does.
 *
 * THE WINDOW IS NAMED RATHER THAN DENIED. An earlier draft of this sentence
 * said "however long ago it was posted", which is false: `buildDataset` fetches
 * `videos: { where: { publishedAt: { gte: since } } }` with `since` derived
 * from the org's `lookbackDays`, and `channel-sync` never ingests older uploads
 * in the first place. At the 400-day default the difference is invisible, but a
 * team that narrows the window would see the money shrink under a sentence
 * promising nothing was missing. A stated bound can be argued with; a silent
 * one reads as a bug.
 *
 * There is deliberately nothing here about view history, recorded days or
 * measured spans — none of that is involved in this figure any more, and a
 * caveat about machinery a number does not use is just a reason to distrust
 * the number.
 */
export const NICHE_EARNINGS_DEFINITION =
  "For each niche, every Shorts view the channels tracked in it have — all of them, across every Short the tracker has on record, back as far as the history window set under Settings — priced at that niche's RPM. Changing the period at the top of the page does not change these figures; the period decides which uploads the other stats count, not how many views a channel has. Every figure only counts channels in your tracker, so it moves when you add or remove a competitor.";

/** The Long Form panel's copy of the definition — the views are not Shorts there. */
export const NICHE_EARNINGS_DEFINITION_LONGFORM =
  "For each niche, every long-form view the channels tracked in it have — all of them, across every video the tracker has on record, back as far as the history window set under Settings — priced at that niche's RPM. Changing the period at the top of the page does not change these figures; the period decides which uploads the other stats count, not how many views a channel has. Every figure only counts channels in your tracker, so it moves when you add or remove a competitor.";

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
  /*
   * NO CAUSE ASSERTED, because the state cannot tell them apart. It fires on
   * zero VIEWS, and the ways to reach that include an empty niche, a niche
   * whose channels only post the other format, and — under a narrow history
   * window — channels with a full back catalogue, all of it older than the
   * window. An earlier draft said "no channel tracked in it has a single video
   * of this format yet", which tells an owner looking at three channels on the
   * card to go and add the channels that are already there.
   */
  no_views:
    "Every niche with a rate has no views to price — nothing tracked in them has any views of this format on record. Either no channel is filed under those niches, or nothing those channels posted falls inside the history window set under Settings.",
  channel_in_two_priced_niches:
    "One of Northstar's channels is filed under two priced niches, so adding the niches together would count its views twice — at two different rates. The per-niche figures below are each correct on their own; no single total is.",
  mixed_currency:
    "Two niches are priced in different currencies, so their figures cannot be added. Set one base currency under Finance and they will total.",
};
