import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NICHE_EARNINGS_DEFINITION,
  NICHE_EARNINGS_DEFINITION_LONGFORM,
  NICHE_EARNINGS_LABEL,
  NO_TOTAL_EXPLANATION,
  buildNicheEarnings,
  nicheViewTotals,
  type NicheChannelViews,
  type NicheEarningsInput,
} from "../niche-earnings";
import {
  NICHE_NO_VIEWS,
  NO_VIEWS_TO_PRICE_EXPLANATION,
  TRACKED_NICHE_VALUE_DEFINITION,
  TRACKED_NICHE_VALUE_DEFINITION_LONGFORM,
  resolveNicheRpm,
  rpmWindowEndingAt,
  type NicheRpmResolution,
} from "../niche-rpm";
import { videosInDateRange } from "../filters";
import { sum } from "../stats";
import { makeLongform, makeShort, makeUncertain } from "./factories";
import type { DateRange } from "../types";

/**
 * =========================================================================
 * WHAT EACH NICHE IS GENERATING — THE BASIS, AND WHO IS ALLOWED TO SEE IT
 * =========================================================================
 *
 * THE REGRESSION THIS SUITE EXISTS FOR, in the owner's words: "It still says
 * 'Not enough view history yet'." Two bases in a row answered a question about
 * a WINDOW — the lifetime views of the period's uploads, then the views gained
 * inside the period — and a window is exactly what the app cannot always see.
 * Both printed sentences where a money figure was asked for, in the ordinary
 * case rather than an edge one.
 *
 * The basis pinned here is the one that cannot fail that way: EVERY view the
 * tracked channels have, of the niche's format, priced at the niche's rate. It
 * is computed from view counts the dataset payload already carries, so there
 * is no history to be short of and nothing to wait for. The first test below
 * is the regression itself, and it is written so that reinstating a date
 * filter fails it.
 *
 * WHY THIS IS TESTED AS PURE FUNCTIONS AND NOT AS COMPONENTS. The runner here
 * is Node with no DOM — `vitest.config.ts` sets `environment: "node"` and only
 * collects `*.test.ts` — so a rendered assertion is not available. That is not
 * a compromise for these rules, because they are not rendering decisions. The
 * disclosure gate is the DATA: `NicheDTO.rpm` arrives null for a reader
 * without `finance.view`, the panel is built from those nulls, and
 * `disclosed: false` is what the component keys off. And the basis is a
 * SELECTOR both money surfaces call — `nicheViewTotals` — rather than a loop
 * each of them writes, precisely so one test covers both screens.
 */

const WINDOW = rpmWindowEndingAt(Date.UTC(2026, 7, 31, 14, 30));

/** The period a reader has selected. August 2026. */
const PERIOD: DateRange = {
  startMs: Date.UTC(2026, 7, 1),
  endMs: Date.UTC(2026, 8, 1),
};

/** Long before that period, and still earning views today. */
const LONG_AGO = Date.UTC(2024, 2, 3);

/** A niche priced by hand at $0.03–$0.06 per 1,000 engaged views. */
function pricedRpm(): NicheRpmResolution {
  return resolveNicheRpm({
    manual: {
      rpmLowMinorPerMillion: 3_000,
      rpmHighMinorPerMillion: 6_000,
      rpmCurrency: "USD",
    },
    channels: [],
    window: WINDOW,
    baseCurrency: "USD",
    engagedViewShareBasisPoints: 5_000,
  });
}

/** A niche nobody has priced and no own channel can speak for. */
function unpricedRpm(): NicheRpmResolution {
  return resolveNicheRpm({
    manual: {
      rpmLowMinorPerMillion: null,
      rpmHighMinorPerMillion: null,
      rpmCurrency: null,
    },
    channels: [],
    window: WINDOW,
    baseCurrency: "USD",
    engagedViewShareBasisPoints: 5_000,
  });
}

function niche(overrides: Partial<NicheEarningsInput> = {}): NicheEarningsInput {
  return {
    id: "niche_gta",
    name: "GTA",
    colorIndex: 0,
    rpm: pricedRpm(),
    ourViews: 2_000_000,
    competitorViews: 8_000_000,
    ownChannelIds: ["chan_1"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// THE BASIS
// ---------------------------------------------------------------------------

describe("the regression: a niche whose channels published before the period", () => {
  /**
   * =======================================================================
   * THE BUG, STATED AS A TEST
   * =======================================================================
   *
   * One own channel and one competitor, both with a single Short posted in
   * March 2024, both still holding millions of views. The reader is looking at
   * August 2026. Under a date-filtered basis this niche contains nothing at
   * all, so the panel refused to price it and said so in words — which is what
   * the owner kept seeing.
   *
   * Under the total-views basis it prices, and the arithmetic is written out
   * rather than derived so a broken implementation cannot agree with a broken
   * expectation: 2,000,000 of our views at 50% engaged is 1,000,000 priced
   * views, which at $0.03–$0.06 per 1,000 engaged views is $30.00–$60.00.
   */
  const channels: NicheChannelViews[] = [
    {
      ownedByNorthstar: true,
      videos: [makeShort({ publishedAt: LONG_AGO, views: 2_000_000 })],
    },
    {
      ownedByNorthstar: false,
      videos: [makeShort({ publishedAt: LONG_AGO, views: 8_000_000 })],
    },
  ];

  it("produces money, where the upload-date basis produced nothing", () => {
    const totals = nicheViewTotals(channels, "shorts");
    expect(totals).toEqual({ ourViews: 2_000_000, competitorViews: 8_000_000 });

    const panel = buildNicheEarnings([niche({ ...totals })]);
    expect(panel.rows[0]!.state).toBe("priced");
    expect(panel.total).toEqual({ lowMinor: 3_000, highMinor: 6_000, currency: "USD" });
  });

  /**
   * THE COUNTERFACTUAL, SPELLED OUT — this is what the old selector answered
   * for the identical channels, and it is why the panel had nothing to say.
   * Kept in the suite so that swapping `videosOfFormat` back for
   * `videosInDateRange` inside `nicheViewTotals` cannot pass: the test above
   * would then produce these zeroes.
   */
  it("is the exact case a date-filtered selector answers with zero", () => {
    const inRange = sum(
      channels.flatMap((channel) =>
        videosInDateRange(channel.videos, PERIOD, "shorts").map((video) => video.views),
      ),
    );
    expect(inRange).toBe(0);

    const panel = buildNicheEarnings([
      niche({ ourViews: 0, competitorViews: 0 }),
    ]);
    expect(panel.rows[0]!.state).toBe("no_views");
    expect(panel.total).toBeNull();
  });
});

describe("the total-views basis", () => {
  /**
   * EVERY VIDEO, WHATEVER ITS DATE. Three Shorts spread over two and a half
   * years, one of them inside the selected period: all three count, and the
   * total is their sum rather than the one recent one.
   */
  it("counts every video regardless of when it was published", () => {
    const totals = nicheViewTotals(
      [
        {
          ownedByNorthstar: true,
          videos: [
            makeShort({ publishedAt: LONG_AGO, views: 1_000_000 }),
            makeShort({ publishedAt: Date.UTC(2025, 5, 9), views: 300_000 }),
            makeShort({ publishedAt: Date.UTC(2026, 7, 14), views: 40_000 }),
          ],
        },
      ],
      "shorts",
    );

    expect(totals.ourViews).toBe(1_340_000);
  });

  /**
   * THE FORMAT FILTER IS NOT OPTIONAL, and an uncertain video is in NEITHER
   * format — `isVideoOfFormat`'s rule, held here because this is a money
   * denominator: a video nobody could classify must not have its views priced
   * into a format that never claimed it.
   */
  it("respects the format, and leaves an uncertain video out of both", () => {
    const channel: NicheChannelViews = {
      ownedByNorthstar: true,
      videos: [
        makeShort({ views: 1_000_000 }),
        makeLongform({ views: 5_000_000 }),
        makeUncertain({ views: 7_000_000 }),
      ],
    };

    expect(nicheViewTotals([channel], "shorts").ourViews).toBe(1_000_000);
    expect(nicheViewTotals([channel], "longform").ourViews).toBe(5_000_000);
    // The uncertain 7M is in neither, so the two formats do not sum to the
    // library. The gap IS the uncertainty, visible rather than laundered.
    expect(
      nicheViewTotals([channel], "shorts").ourViews +
        nicheViewTotals([channel], "longform").ourViews,
    ).toBe(6_000_000);
  });

  /** Ours and theirs, split on ownership and never pooled. */
  it("splits our channels from everybody else's", () => {
    const totals = nicheViewTotals(
      [
        { ownedByNorthstar: true, videos: [makeShort({ views: 1_500_000 })] },
        { ownedByNorthstar: true, videos: [makeShort({ views: 500_000 })] },
        { ownedByNorthstar: false, videos: [makeShort({ views: 8_000_000 })] },
      ],
      "shorts",
    );

    expect(totals).toEqual({ ourViews: 2_000_000, competitorViews: 8_000_000 });
    // Swapping the two sides is a silent, plausible-looking mutation, so the
    // asymmetry is pinned rather than left to the equality above.
    expect(totals.ourViews).not.toBe(totals.competitorViews);
  });

  it("is zero for a niche with no channels at all", () => {
    expect(nicheViewTotals([], "shorts")).toEqual({ ourViews: 0, competitorViews: 0 });
  });
});

// ---------------------------------------------------------------------------
// WHO SEES IT
// ---------------------------------------------------------------------------

describe("who the earnings panel is built for", () => {
  /**
   * THE GATE. An employee's dataset carries `rpm: null` on every niche, because
   * `resolveNicheRpmByNiche` returns null rather than an empty map and
   * `toNicheDTO` forwards only what it was handed. There is nothing here to
   * reconstruct a figure from, so the panel is ABSENT rather than empty.
   */
  it("is not disclosed at all to a reader who was sent no economics", () => {
    const panel = buildNicheEarnings([
      niche({ rpm: null }),
      niche({ id: "niche_finance", name: "Finance", rpm: null }),
    ]);

    expect(panel.disclosed).toBe(false);
    expect(panel.rows).toEqual([]);
    expect(panel.total).toBeNull();
  });

  it("is not disclosed on an organization with no niches at all", () => {
    const panel = buildNicheEarnings([]);

    expect(panel.disclosed).toBe(false);
    expect(panel.rows).toEqual([]);
  });

  /**
   * A niche-scoped member granted `finance.view` receives economics for their
   * own niches and NO ENTRY for the rest. One null must not blank the panel,
   * and the niches they were not sent must not be named.
   */
  it("shows the niches a scoped reader was sent, and never names the others", () => {
    const panel = buildNicheEarnings([
      niche({ id: "mine", name: "GTA" }),
      niche({ id: "theirs", name: "Finance", rpm: null }),
    ]);

    expect(panel.disclosed).toBe(true);
    expect(panel.rows.map((row) => row.id)).toEqual(["mine"]);
    expect(panel.rows.map((row) => row.name)).not.toContain("Finance");
  });
});

// ---------------------------------------------------------------------------
// WHAT IT SAYS WHEN IT CANNOT SAY A NUMBER
// ---------------------------------------------------------------------------

describe("what the panel says when it cannot say a number", () => {
  it("reports nothing priced rather than a portfolio worth zero", () => {
    const panel = buildNicheEarnings([
      niche({ rpm: unpricedRpm() }),
      niche({ id: "niche_finance", name: "Finance", rpm: unpricedRpm() }),
    ]);

    expect(panel.disclosed).toBe(true);
    expect(panel.pricedCount).toBe(0);
    expect(panel.total).toBeNull();
    expect(panel.noTotalReason).toBe("nothing_priced");
    // The niches are still listed — an admin needs to see WHICH ones are
    // waiting on a decision — and each says it is unpriced rather than $0.
    expect(panel.rows.map((row) => row.state)).toEqual(["unpriced", "unpriced"]);
  });

  /**
   * A priced niche whose tracked channels hold no views prices to zero
   * correctly, and must still not print "$0": that reads as a claim about the
   * niche rather than about an empty tracker. Same rule as the niche card.
   */
  it("separates 'no views to price' from 'nobody has priced it'", () => {
    const panel = buildNicheEarnings([
      niche({ ourViews: 0, competitorViews: 0 }),
    ]);

    expect(panel.rows[0]!.state).toBe("no_views");
    expect(panel.pricedCount).toBe(0);
    // The view figures are real and are zero; it is the MONEY that must not be
    // rendered as a figure.
    expect(panel.rows[0]!.value.trackedNicheViews).toBe(0);
    expect(panel.rows[0]!.value.capturePercent).toBeNull();
  });

  /**
   * =========================================================================
   * THE PANEL MUST NOT TELL AN OWNER WHO HAS PRICED A NICHE THAT HE HAS NOT
   * =========================================================================
   * `pricedCount` is zero in TWO different situations — nobody entered a rate,
   * and every rated niche holds no views — and they are two different
   * instructions to the owner. The headline keys off which of them holds.
   */
  it("does not claim a niche is unpriced when it is priced but has no views", () => {
    const panel = buildNicheEarnings([
      niche({ id: "a", ourViews: 0, competitorViews: 0 }),
      niche({ id: "b", name: "Finance", ourViews: 0, competitorViews: 0 }),
    ]);

    expect(panel.pricedCount).toBe(0);
    expect(panel.noTotalReason).toBe("no_views");
    // Every row has a rate. "Nothing priced" would be a false statement.
    expect(panel.rows.map((row) => row.state)).toEqual(["no_views", "no_views"]);
  });

  /** The genuinely unpriced case still reports itself as such. */
  it("still reports nothing_priced when no niche has a rate at all", () => {
    const panel = buildNicheEarnings([niche({ rpm: unpricedRpm() })]);

    expect(panel.noTotalReason).toBe("nothing_priced");
  });

  /**
   * A mix: one niche has a rate but no views, another has no rate. Neither is
   * priced, and the honest reading is the one that does not accuse the owner
   * of having priced nothing — a rate does exist.
   */
  it("prefers 'no views' when at least one niche does have a rate", () => {
    const panel = buildNicheEarnings([
      niche({ id: "a", ourViews: 0, competitorViews: 0 }),
      niche({ id: "b", name: "Finance", rpm: unpricedRpm() }),
    ]);

    expect(panel.pricedCount).toBe(0);
    expect(panel.noTotalReason).toBe("no_views");
  });

  /** Every withheld total names a reason, and every reason has a sentence. */
  it("has one explanation per reason, and none of them mentions history", () => {
    for (const sentence of Object.values(NO_TOTAL_EXPLANATION)) {
      expect(sentence.length).toBeGreaterThan(0);
      expect(sentence).not.toContain("view history");
      expect(sentence).not.toContain("measured");
    }
  });
});

// ---------------------------------------------------------------------------
// THE ARITHMETIC
// ---------------------------------------------------------------------------

describe("the arithmetic on total views", () => {
  /**
   * The ordinary case. Two niches, no shared channel, both priced in the base
   * currency: the totals add.
   *
   * 2,000,000 of our views at 50% engaged is 1,000,000 priced views, which at
   * $0.03–$0.06 per 1,000 engaged views is $30.00–$60.00. Two such niches
   * total $60.00–$120.00.
   */
  it("adds Northstar's own share across niches that share no channel", () => {
    const panel = buildNicheEarnings([
      niche({ id: "a", ownChannelIds: ["chan_1"] }),
      niche({ id: "b", ownChannelIds: ["chan_2"] }),
    ]);

    expect(panel.noTotalReason).toBeNull();
    expect(panel.total).toEqual({ lowMinor: 6_000, highMinor: 12_000, currency: "USD" });
  });

  /** Capture is ours over the tracked total: 2M of 10M is 20%. */
  it("computes the capture percentage from the two view totals", () => {
    const panel = buildNicheEarnings([niche()]);

    expect(panel.rows[0]!.value.capturePercent).toBe(20);
    expect(panel.rows[0]!.value.trackedNicheViews).toBe(10_000_000);
  });

  /** And it is genuinely ours ÷ (ours + theirs), not a constant that happens
   * to fit one fixture. */
  it("moves with the split", () => {
    const panel = buildNicheEarnings([
      niche({ ourViews: 7_500_000, competitorViews: 2_500_000 }),
    ]);

    expect(panel.rows[0]!.value.capturePercent).toBe(75);
  });

  /**
   * A NEGATIVE TOTAL CLAMPS TO ZERO VIEWS, NEVER TO NEGATIVE MONEY. Nothing on
   * this basis produces one — a view count cannot be negative — but the clamp
   * in `calculateNicheValue` is load-bearing for every caller, so it is held.
   */
  it("clamps a negative sum to zero rather than pricing negative money", () => {
    const panel = buildNicheEarnings([
      niche({ ourViews: -500_000, competitorViews: 1_000_000 }),
    ]);

    const value = panel.rows[0]!.value;
    expect(value.ourViews).toBe(0);
    expect(value.trackedNicheViews).toBe(1_000_000);
    expect(value.ourRevenue).toEqual({ lowMinor: 0, highMinor: 0, currency: "USD" });
    expect(value.trackedRevenue!.lowMinor).toBeGreaterThan(0);
  });

  /**
   * =========================================================================
   * THE DOUBLE-COUNT, WHICH IS THE WHOLE REASON THE TOTAL IS ALLOWED TO BE NULL
   * =========================================================================
   * A channel in two niches is counted in BOTH — correct per niche, and never
   * addable across them, because the same views would be priced at two
   * different rates.
   */
  it("refuses a total when one channel is filed under two priced niches", () => {
    const panel = buildNicheEarnings([
      niche({ id: "gaming", name: "Gaming", ownChannelIds: ["chan_1"] }),
      niche({ id: "gta", name: "GTA", ownChannelIds: ["chan_1"] }),
    ]);

    expect(panel.pricedCount).toBe(2);
    expect(panel.total).toBeNull();
    expect(panel.noTotalReason).toBe("channel_in_two_priced_niches");
    // The rows survive. Each niche's own figure is still true; it is only the
    // sum that does not exist.
    expect(panel.rows).toHaveLength(2);
    expect(panel.rows.every((row) => row.value.ourRevenue !== null)).toBe(true);
  });

  /**
   * A channel in a priced niche AND an unpriced one contributes to exactly one
   * figure, so there is nothing to double.
   */
  it("allows a total when the shared niche has no rate to contribute", () => {
    const panel = buildNicheEarnings([
      niche({ id: "gta", ownChannelIds: ["chan_1"] }),
      niche({ id: "unrated", rpm: unpricedRpm(), ownChannelIds: ["chan_1"] }),
    ]);

    expect(panel.noTotalReason).toBeNull();
    expect(panel.total).toEqual({ lowMinor: 3_000, highMinor: 6_000, currency: "USD" });
  });

  /**
   * The engaged-view share reaches the panel through the resolution, not
   * through a settings payload, and it is what halves the figure. Pinned here
   * because this is the surface an admin reads a portfolio number off: if the
   * share stopped arriving, every figure would silently double.
   */
  it("prices the portfolio through the engaged-view share on the resolution", () => {
    const full = resolveNicheRpm({
      manual: {
        rpmLowMinorPerMillion: 3_000,
        rpmHighMinorPerMillion: 6_000,
        rpmCurrency: "USD",
      },
      channels: [],
      window: WINDOW,
      baseCurrency: "USD",
      // 100%: the identity, and what the arithmetic did before engaged views.
      engagedViewShareBasisPoints: 10_000,
    });

    const halved = buildNicheEarnings([niche()]);
    const whole = buildNicheEarnings([niche({ rpm: full })]);

    expect(halved.total).toEqual({ lowMinor: 3_000, highMinor: 6_000, currency: "USD" });
    expect(whole.total).toEqual({ lowMinor: 6_000, highMinor: 12_000, currency: "USD" });
  });

  /**
   * =========================================================================
   * THE EXACT 2x A WRONG BASIS WOULD INTRODUCE
   * =========================================================================
   * Long-form RPM is quoted per 1,000 RAW views and Shorts RPM per 1,000
   * ENGAGED views, so the identical numeric rate over the identical view count
   * buys exactly twice the money on a Long Form niche at a 50% share. That
   * factor is the whole reason `RpmBasis` exists, and it is pinned as an exact
   * equality in both directions rather than as an inequality.
   */
  it("prices long-form on raw views and shorts on the engaged subset", () => {
    const shorts = buildNicheEarnings([niche({ format: "shorts" })]);
    const longform = buildNicheEarnings([niche({ format: "longform" })]);

    expect(shorts.rows[0]!.value.basis).toBe("engaged");
    expect(longform.rows[0]!.value.basis).toBe("raw");

    // 2,000,000 ours: 1,000,000 engaged on shorts, 2,000,000 raw on long form.
    expect(shorts.rows[0]!.value.pricedViews).toBe(5_000_000);
    expect(longform.rows[0]!.value.pricedViews).toBe(10_000_000);

    expect(shorts.total).toEqual({ lowMinor: 3_000, highMinor: 6_000, currency: "USD" });
    expect(longform.total).toEqual({
      lowMinor: 6_000,
      highMinor: 12_000,
      currency: "USD",
    });
  });
});

/**
 * =========================================================================
 * THE TOTAL MUST NOT CLAIM A COVERAGE IT DOES NOT HAVE
 * =========================================================================
 * The sum can only include niches that HAVE a rate — an unpriced niche is
 * unknown, not zero, so there is nothing to add. The label is derived from the
 * same counts the sum was built from.
 */
describe("what the total says it covers", () => {
  it("does not present a partial sum as the whole portfolio", () => {
    const panel = buildNicheEarnings([
      niche({ id: "a", ownChannelIds: ["chan_1"] }),
      niche({
        id: "b",
        name: "Finance",
        rpm: unpricedRpm(),
        // Larger than the priced niche, which is the point: what is left out
        // is unbounded, so the subtotal can be arbitrarily far from the truth.
        ourViews: 50_000_000,
        ownChannelIds: ["chan_2"],
      }),
    ]);

    expect(panel.pricedCount).toBe(1);
    expect(panel.rows).toHaveLength(2);
    expect(panel.total).not.toBeNull();
    expect(panel.totalIsPartial).toBe(true);
    expect(panel.totalLabel).toBe("Northstar's share, 1 of 2 niches priced");
    expect(panel.totalLabel).not.toContain("all niches");
  });

  it("says so plainly when the total really does cover every niche shown", () => {
    const panel = buildNicheEarnings([
      niche({ id: "a", ownChannelIds: ["chan_1"] }),
      niche({ id: "b", name: "Finance", ownChannelIds: ["chan_2"] }),
    ]);

    expect(panel.totalIsPartial).toBe(false);
    expect(panel.totalLabel).toBe("Northstar's share, 2 priced niches");
  });

  it("counts one niche in the singular", () => {
    const panel = buildNicheEarnings([niche({ id: "a" })]);

    expect(panel.totalLabel).toBe("Northstar's share, 1 priced niche");
  });

  /**
   * A withheld total carries no label at all. A leftover string beside a number
   * that is not there is how a caption ends up describing the wrong figure.
   */
  it("carries no label when there is no total to label", () => {
    const panel = buildNicheEarnings([
      niche({ id: "a", ownChannelIds: ["shared"] }),
      niche({ id: "b", name: "Finance", ownChannelIds: ["shared"] }),
    ]);

    expect(panel.total).toBeNull();
    expect(panel.totalLabel).toBe("");
    expect(panel.totalIsPartial).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE WORDS
// ---------------------------------------------------------------------------

/**
 * =========================================================================
 * THE COPY DESCRIBES THE BASIS THAT IS ACTUALLY IN FORCE
 * =========================================================================
 *
 * Every definition on these two surfaces promised a period at some point, and
 * for two rounds the figure under it refused to appear because of one. Both
 * halves of that are pinned: the new wording says what is multiplied by what
 * and that the selector does not move it, and the sentences the owner was
 * reading instead of a number are gone from every string these surfaces
 * render.
 */
const FORBIDDEN = [
  "Not enough view history",
  "measured over",
  "Measured over",
  "view history",
  "gained during the selected period",
];

describe("the copy tells the total-views truth", () => {
  const definitions = [
    NICHE_EARNINGS_DEFINITION,
    NICHE_EARNINGS_DEFINITION_LONGFORM,
    TRACKED_NICHE_VALUE_DEFINITION,
    TRACKED_NICHE_VALUE_DEFINITION_LONGFORM,
  ];

  it("says the figure is every view the tracked channels have", () => {
    expect(NICHE_EARNINGS_DEFINITION).toContain("every Shorts view the channels");
    expect(NICHE_EARNINGS_DEFINITION_LONGFORM).toContain(
      "every long-form view the channels",
    );
    expect(TRACKED_NICHE_VALUE_DEFINITION).toContain("every Shorts view the channels");
    expect(TRACKED_NICHE_VALUE_DEFINITION_LONGFORM).toContain(
      "every long-form view the channels",
    );
  });

  /**
   * THE BOUND THE COPY MUST NOT DENY.
   *
   * `buildDataset` fetches `videos: { where: { publishedAt: { gte: since } } }`
   * with `since` derived from the org's `lookbackDays`, and `channel-sync`
   * applies the same cutoff at ingest — so the browser never holds the full
   * back catalogue and cannot price it. An earlier draft of these definitions
   * promised "however long ago it was posted", which at a narrowed window is a
   * sentence asserting the opposite of the arithmetic beneath it. Each one now
   * names the window instead, in the words Settings already uses for it.
   */
  it("names the history window instead of promising the whole catalogue", () => {
    for (const definition of definitions) {
      expect(definition).toContain("history window set under Settings");
      expect(definition).not.toContain("however long ago");
      expect(definition).not.toContain("every Short in the tracker");
      expect(definition).not.toContain("every video in the tracker");
    }
  });

  /** The panel heading carries the same qualifier the tooltip does, and no
   * phantom rate: the figure below it is a cumulative total, not a monthly. */
  it("keeps the heading tracked-qualified and in the past tense", () => {
    expect(NICHE_EARNINGS_LABEL).toContain("tracked");
    expect(NICHE_EARNINGS_LABEL).not.toContain("is generating");
  });

  /**
   * The zero state fires on zero VIEWS. Naming one cause as if it were the only
   * one sent an owner off to add channels already sitting on the card in front
   * of him, so neither sentence asserts a cause any more.
   */
  it("does not blame the no-views state on there being no videos", () => {
    for (const text of [NO_VIEWS_TO_PRICE_EXPLANATION, NO_TOTAL_EXPLANATION.no_views]) {
      expect(text).not.toContain("single video of this format");
      expect(text).not.toContain("Add the channels");
      expect(text).not.toContain("add the channels");
      expect(text).toContain("history window set under Settings");
    }
  });

  /** The owner will switch 7d/30d and watch the money stay still. The tooltip
   * has to have told him that first. */
  it("says the period selector does not change the figure", () => {
    for (const definition of definitions) {
      expect(definition.toLowerCase()).toContain("does not change");
      expect(definition.toLowerCase()).toContain("period");
    }
  });

  /** "Tracked" is not optional: the denominator is a set somebody curates. */
  it("keeps saying the total only contains channels in the tracker", () => {
    for (const definition of definitions) {
      expect(definition).toContain("add or remove a competitor");
    }
  });

  it("promises no period and names no history", () => {
    const strings = [
      ...definitions,
      NICHE_NO_VIEWS,
      NO_VIEWS_TO_PRICE_EXPLANATION,
      ...Object.values(NO_TOTAL_EXPLANATION),
    ];
    for (const text of strings) {
      for (const phrase of FORBIDDEN) {
        expect(text).not.toContain(phrase);
      }
    }
  });
});

/**
 * The surfaces are JSX and this runner has no DOM, so the one thing that
 * cannot be asserted through the pure functions is that the components render
 * what they are handed. A source assertion is the available check, and it is
 * the same technique `niche-card-controls.test.ts` uses.
 */
describe("the money surfaces render this basis and no other", () => {
  const read = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), "utf8");

  /** Comments are prose about the past; only what ships is asserted on. */
  const code = (source: string): string =>
    source
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

  const PANEL = "components/dashboard/niche-earnings-panel.tsx";
  const STRIP = "components/niches/niche-value-strip.tsx";
  const CARDS = "app/(app)/niches/page.tsx";

  it("computes both money figures through the one shared selector", () => {
    expect(code(read(PANEL))).toContain("nicheViewTotals");
    expect(code(read(CARDS))).toContain("nicheViewTotals");
  });

  it("never date-filters the views it prices", () => {
    for (const relative of [PANEL, STRIP, CARDS]) {
      expect(code(read(relative))).not.toContain("videosInDateRange");
      expect(code(read(relative))).not.toContain("getShortsInDateRange");
    }
  });

  /** The whole snapshot dependency is gone from what renders: no fetch, no
   * skeleton, no failure sentence, no coverage predicate. */
  it("no longer reads the views-gained pipeline", () => {
    for (const relative of [PANEL, STRIP, CARDS]) {
      const source = code(read(relative));
      expect(source).not.toContain("useNicheViewsGained");
      expect(source).not.toContain("VIEWS_GAINED_UNAVAILABLE");
      expect(source).not.toContain("hasUsableGainsHistory");
      expect(source).not.toContain("measuredSpanNote");
    }
  });

  /**
   * THE PANEL AND THE STRIP ARE ENTIRELY ABOUT MONEY, so every one of these
   * phrases is forbidden outright in what they ship.
   */
  it("renders none of the sentences the owner was reading instead of a number", () => {
    for (const relative of [PANEL, STRIP]) {
      const source = code(read(relative));
      for (const phrase of FORBIDDEN) {
        expect(source).not.toContain(phrase);
      }
    }
  });

  /**
   * THE NICHE CARDS PAGE IS NOT, and the distinction is the point rather than
   * an exemption. It renders the hit rate too, and the page header legitimately
   * says the portfolio hit rate is "measured over" the production niches —
   * that sentence is about a rule, not about money, and blanket-banning the
   * phrase would delete a true statement to satisfy a test. What the page must
   * not carry is the money copy: a promise about the selected period, or the
   * refusal the owner kept reading.
   */
  it("carries none of the money-period copy on the niche cards page", () => {
    const source = code(read(CARDS));
    expect(source).not.toContain("Not enough view history");
    expect(source).not.toContain("gained during the selected period");
    expect(source).not.toContain("view history");
  });

  it("takes the total's caption from the builder", () => {
    expect(code(read(PANEL))).toContain("panel.totalLabel");
  });

  it("no longer claims the sum covers every niche", () => {
    expect(code(read(PANEL))).not.toContain("all niches");
  });

  /**
   * The empty state must key off the REASON, not off `pricedCount === 0` —
   * those differ exactly when a priced niche has no views, which is the state
   * that produced a false sentence.
   */
  it("keys its empty state off the reason rather than the count", () => {
    expect(read(PANEL)).toContain('panel.noTotalReason === "nothing_priced"');
    expect(read(PANEL)).not.toContain("panel.pricedCount === 0");
  });

  it("renders the caveat when the total omits niches", () => {
    expect(read(PANEL)).toContain("panel.totalIsPartial");
    expect(read(PANEL)).toContain("NICHE_EARNINGS_PARTIAL_TOTAL");
  });

  it("no longer claims automatic refresh is switched off, anywhere it did", () => {
    for (const relative of [
      "lib/analytics/niche-earnings.ts",
      "lib/analytics/niche-rpm.ts",
      "server/services/niche-rpm-service.ts",
    ]) {
      expect(read(relative)).not.toContain("currently switched off");
    }
  });
});
