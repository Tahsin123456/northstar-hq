import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NICHE_EARNINGS_DEFINITION,
  NICHE_EARNINGS_DEFINITION_LONGFORM,
  NICHE_EARNINGS_LABEL,
  NICHE_EARNINGS_NOTHING_PRICED,
  NICHE_EARNINGS_PARTIAL_TOTAL,
  NO_TOTAL_EXPLANATION,
  buildNicheEarnings,
  isStillMeasuring,
  nicheEarningsDefinition,
  type NicheEarningsInput,
} from "../niche-earnings";
import {
  HISTORY_DATE_PLACEHOLDER,
  NICHE_MEASURING,
  NICHE_MEASURING_EXPLANATION,
  NICHE_NO_VIEWS,
  NO_VIEWS_TO_PRICE_EXPLANATION,
  TRACKED_NICHE_VALUE_DEFINITION,
  TRACKED_NICHE_VALUE_DEFINITION_LONGFORM,
  resolveNicheRpm,
  rpmWindowEndingAt,
  trackedNicheValueDefinition,
  type NicheRpmResolution,
} from "../niche-rpm";
import { VIEWS_GAINED_UNAVAILABLE } from "../views-gained-labels";

/**
 * =========================================================================
 * WHAT EACH NICHE IS GENERATING — THE BASIS, AND WHO IS ALLOWED TO SEE IT
 * =========================================================================
 *
 * THE REGRESSIONS THIS SUITE EXISTS FOR, in the owner's words. "It still says
 * 'Not enough view history yet'" — the per-video delta blacked out every
 * niche. Then "$177.5K–$310.6K is WAY TOO HIGH" — the lifetime basis priced
 * every view the channels had ever had under a 30-day label. The basis pinned
 * here is the one he described: the views the tracked channels GAINED in the
 * period, every video included however old, at the niche's rate.
 *
 * The delta itself is `channel-views-gained.ts` and is pinned there. This
 * file holds the money layer: what the builder does with a gain, a partial
 * measurement, or no measurement yet; who is disclosed to; what the copy
 * promises; and — by reading source, because the runner has no DOM — that
 * the two surfaces render this basis and no other.
 */

const WINDOW = rpmWindowEndingAt(Date.UTC(2026, 7, 31, 14, 30));

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
    ourViewsGained: 2_000_000,
    competitorViewsGained: 8_000_000,
    measured: { measuredChannels: 2, totalChannels: 2 },
    ownChannelIds: ["chan_1"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// THE STATES
// ---------------------------------------------------------------------------

describe("the states a niche can be in", () => {
  /**
   * The ordinary case, with the arithmetic written out rather than derived
   * so a broken implementation cannot agree with a broken expectation:
   * 2,000,000 of our gained views at 50% engaged is 1,000,000 priced views,
   * which at $0.03–$0.06 per 1,000 engaged views is $30.00–$60.00.
   */
  it("prices a measured niche's gains", () => {
    const panel = buildNicheEarnings([niche()]);

    expect(panel.rows[0]!.state).toBe("priced");
    expect(panel.rows[0]!.measuredCaption).toBeNull();
    expect(panel.total).toEqual({ lowMinor: 3_000, highMinor: 6_000, currency: "USD" });
  });

  /**
   * =======================================================================
   * MEASURING: THE FIRST READING IS IN, THE SECOND IS NOT
   * =======================================================================
   * A gain is UNKNOWN until two readings exist. "No views gained" would be a
   * claim the measurement never made, and "$0" worse.
   */
  it("says measuring, not zero, for a niche none of whose channels has two readings", () => {
    const panel = buildNicheEarnings([
      niche({
        ourViewsGained: 0,
        competitorViewsGained: 0,
        measured: { measuredChannels: 0, totalChannels: 3 },
        ownChannelIds: [],
      }),
    ]);

    expect(panel.rows[0]!.state).toBe("measuring");
    expect(panel.pricedCount).toBe(0);
    expect(panel.total).toBeNull();
    expect(panel.noTotalReason).toBe("still_measuring");
  });

  it("treats a niche the response did not answer for as measuring", () => {
    expect(isStillMeasuring(null)).toBe(true);
    const panel = buildNicheEarnings([niche({ measured: null })]);
    expect(panel.rows[0]!.state).toBe("measuring");
  });

  /** An empty niche is not "measuring" — nothing will ever arrive. */
  it("does not promise a next-refresh figure for a niche with no channels", () => {
    expect(isStillMeasuring({ measuredChannels: 0, totalChannels: 0 })).toBe(false);
    const panel = buildNicheEarnings([
      niche({
        ourViewsGained: 0,
        competitorViewsGained: 0,
        measured: { measuredChannels: 0, totalChannels: 0 },
        ownChannelIds: [],
      }),
    ]);
    expect(panel.rows[0]!.state).toBe("no_views");
  });

  /**
   * A PARTIALLY measured niche is priced — the measured channels' gains are
   * real — and captioned, because the missing channels are unknown rather
   * than zero and a bare figure would read as the whole niche.
   */
  it("prices a partially measured niche and captions which part", () => {
    const panel = buildNicheEarnings([
      niche({ measured: { measuredChannels: 3, totalChannels: 5 } }),
    ]);

    expect(panel.rows[0]!.state).toBe("priced");
    expect(panel.rows[0]!.measuredCaption).toBe("3 of 5 channels measured");
    expect(panel.total).toEqual({ lowMinor: 3_000, highMinor: 6_000, currency: "USD" });
  });

  it("separates 'no views gained' from 'nobody has priced it' and from 'measuring'", () => {
    const panel = buildNicheEarnings([
      niche({ id: "a", ourViewsGained: 0, competitorViewsGained: 0 }),
      niche({ id: "b", name: "Finance", rpm: unpricedRpm() }),
      niche({
        id: "c",
        name: "Fitness",
        ourViewsGained: 0,
        competitorViewsGained: 0,
        measured: { measuredChannels: 0, totalChannels: 2 },
      }),
    ]);

    expect(panel.rows.map((row) => row.state)).toEqual(["no_views", "unpriced", "measuring"]);
    expect(panel.pricedCount).toBe(0);
    // A rate exists, and one niche WAS measured: "no views" is the honest
    // headline — neither "nothing priced" nor "still measuring".
    expect(panel.noTotalReason).toBe("no_views");
  });

  it("reports nothing priced rather than a portfolio worth zero", () => {
    const panel = buildNicheEarnings([
      niche({ rpm: unpricedRpm() }),
      niche({ id: "niche_finance", name: "Finance", rpm: unpricedRpm() }),
    ]);

    expect(panel.disclosed).toBe(true);
    expect(panel.pricedCount).toBe(0);
    expect(panel.noTotalReason).toBe("nothing_priced");
    expect(panel.rows.map((row) => row.state)).toEqual(["unpriced", "unpriced"]);
  });

  /**
   * A purge-driven negative sum is a real view movement and an impossible
   * amount of money: the view figure survives raw in the DTO, the pricing
   * clamps at nothing, and the row reads as no views rather than as "-$30".
   */
  it("clamps a negative gain to no views rather than pricing negative money", () => {
    const panel = buildNicheEarnings([
      niche({ ourViewsGained: -50_000, competitorViewsGained: -10_000 }),
    ]);

    expect(panel.rows[0]!.state).toBe("no_views");
    expect(panel.rows[0]!.value.ourRevenue).toEqual({ lowMinor: 0, highMinor: 0, currency: "USD" });
  });
});

// ---------------------------------------------------------------------------
// WHO SEES IT
// ---------------------------------------------------------------------------

describe("who the earnings panel is built for", () => {
  it("is not disclosed at all to a reader who was sent no economics", () => {
    const panel = buildNicheEarnings([niche({ rpm: null }), niche({ id: "b", rpm: null })]);

    expect(panel.disclosed).toBe(false);
    expect(panel.rows).toEqual([]);
  });

  it("is not disclosed on an organization with no niches at all", () => {
    expect(buildNicheEarnings([]).disclosed).toBe(false);
  });

  it("shows the niches a scoped reader was sent, and never names the others", () => {
    const panel = buildNicheEarnings([niche(), niche({ id: "hidden", name: "Hidden", rpm: null })]);

    expect(panel.disclosed).toBe(true);
    expect(panel.rows.map((row) => row.id)).toEqual(["niche_gta"]);
  });
});

// ---------------------------------------------------------------------------
// THE TOTAL
// ---------------------------------------------------------------------------

describe("the total", () => {
  it("adds Northstar's own share across niches that share no channel", () => {
    const panel = buildNicheEarnings([
      niche({ id: "a", ownChannelIds: ["chan_1"] }),
      niche({ id: "b", ownChannelIds: ["chan_2"] }),
    ]);

    expect(panel.total).toEqual({ lowMinor: 6_000, highMinor: 12_000, currency: "USD" });
    expect(panel.totalLabel).toBe("Northstar's share, 2 priced niches");
    expect(panel.totalIsPartial).toBe(false);
  });

  it("refuses a total when one channel is filed under two priced niches", () => {
    const panel = buildNicheEarnings([
      niche({ id: "a", ownChannelIds: ["chan_1"] }),
      niche({ id: "b", ownChannelIds: ["chan_1"] }),
    ]);

    expect(panel.total).toBeNull();
    expect(panel.noTotalReason).toBe("channel_in_two_priced_niches");
    expect(panel.pricedCount).toBe(2);
  });

  it("allows a total when the shared channel's other niche is still measuring", () => {
    // The measuring niche contributes no figure, so nothing is doubled.
    const panel = buildNicheEarnings([
      niche({ id: "a", ownChannelIds: ["chan_1"] }),
      niche({
        id: "b",
        ownChannelIds: ["chan_1"],
        measured: { measuredChannels: 0, totalChannels: 1 },
      }),
    ]);

    expect(panel.total).toEqual({ lowMinor: 3_000, highMinor: 6_000, currency: "USD" });
    expect(panel.totalIsPartial).toBe(true);
    expect(panel.totalLabel).toBe("Northstar's share, 1 of 2 niches priced");
  });

  it("does not present a partial sum as the whole portfolio", () => {
    const panel = buildNicheEarnings([
      niche({ id: "a" }),
      niche({ id: "b", rpm: unpricedRpm() }),
    ]);

    expect(panel.totalIsPartial).toBe(true);
    expect(panel.totalLabel).toBe("Northstar's share, 1 of 2 niches priced");
    expect(NICHE_EARNINGS_PARTIAL_TOTAL).toContain("still measuring");
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
 * One basis promised a period and refused to render; the next denied the
 * period and priced a lifetime. Both halves are pinned: the sentences the
 * owner read instead of a figure are gone, and the sentences that described
 * the lifetime basis are gone with it.
 */
const FORBIDDEN = [
  "Not enough view history",
  "lifetime",
  "does not change",
  "history window set under Settings",
  "all of them",
];

const DEFINITIONS = [
  NICHE_EARNINGS_DEFINITION,
  NICHE_EARNINGS_DEFINITION_LONGFORM,
  TRACKED_NICHE_VALUE_DEFINITION,
  TRACKED_NICHE_VALUE_DEFINITION_LONGFORM,
];

const MONEY_COPY = [
  ...DEFINITIONS,
  NICHE_EARNINGS_LABEL,
  NICHE_EARNINGS_NOTHING_PRICED,
  NICHE_EARNINGS_PARTIAL_TOTAL,
  NICHE_NO_VIEWS,
  NO_VIEWS_TO_PRICE_EXPLANATION,
  NICHE_MEASURING,
  NICHE_MEASURING_EXPLANATION,
  VIEWS_GAINED_UNAVAILABLE,
  ...Object.values(NO_TOTAL_EXPLANATION),
];

describe("the copy tells the views-gained truth", () => {
  it("says the figure is what the tracked channels gained in the period, every video included", () => {
    for (const definition of DEFINITIONS) {
      expect(definition).toContain("gained during the selected period");
      expect(definition).toContain("however long ago it was posted");
      expect(definition).toContain("add or remove a competitor");
    }
  });

  it("says the format split is an estimate, in the format's own noun", () => {
    expect(NICHE_EARNINGS_DEFINITION).toContain("so the Shorts figure is an estimate");
    expect(TRACKED_NICHE_VALUE_DEFINITION).toContain("so the Shorts figure is an estimate");
    expect(NICHE_EARNINGS_DEFINITION_LONGFORM).toContain("so the long-form figure is an estimate");
    expect(TRACKED_NICHE_VALUE_DEFINITION_LONGFORM).toContain(
      "so the long-form figure is an estimate",
    );
  });

  /** The template carries the placeholder; what renders carries the day. */
  it("names the day the view history began, and never prints the placeholder", () => {
    for (const definition of DEFINITIONS) {
      expect(definition).toContain(`View history began on ${HISTORY_DATE_PLACEHOLDER};`);
    }
    const began = Date.UTC(2026, 8, 1, 12);
    for (const filled of [
      nicheEarningsDefinition("shorts", began),
      nicheEarningsDefinition("longform", began),
      trackedNicheValueDefinition("shorts", began),
      trackedNicheValueDefinition("longform", began),
    ]) {
      expect(filled).not.toContain(HISTORY_DATE_PLACEHOLDER);
      expect(filled).toContain("View history began on ");
      expect(filled).toContain("2026");
    }
    // No date known yet: the claim survives, the day does not get invented.
    const unknown = nicheEarningsDefinition("shorts", null);
    expect(unknown).not.toContain(HISTORY_DATE_PLACEHOLDER);
    expect(unknown).toContain("View history has a beginning;");
  });

  it("keeps the engaged-basis sentence on shorts and its inverse on long form", () => {
    expect(NICHE_EARNINGS_DEFINITION).toContain("engaged views only");
    expect(NICHE_EARNINGS_DEFINITION_LONGFORM).toContain("no engaged-view share applies");
    expect(TRACKED_NICHE_VALUE_DEFINITION).toContain("ENGAGED views only");
    expect(TRACKED_NICHE_VALUE_DEFINITION_LONGFORM).toContain("no engaged-view share applies");
  });

  it("keeps the heading tracked-qualified and in the past tense", () => {
    expect(NICHE_EARNINGS_LABEL).toContain("tracked");
    expect(NICHE_EARNINGS_LABEL).not.toContain("is generating");
  });

  it("says when the first figure arrives, in plain words", () => {
    expect(NICHE_MEASURING).toBe("Measuring — first figure after the next refresh");
    expect(NICHE_MEASURING_EXPLANATION).toContain("next refresh");
    expect(NO_TOTAL_EXPLANATION.still_measuring).toContain("next refresh");
    for (const text of [NICHE_MEASURING_EXPLANATION, NO_TOTAL_EXPLANATION.still_measuring]) {
      expect(text).not.toMatch(/snapshot|delta|coverage/i);
    }
  });

  it("carries none of the sentences from either abandoned basis", () => {
    for (const text of MONEY_COPY) {
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
  const OVERVIEW = "app/(app)/page.tsx";
  const LONGFORM = "app/(app)/longform/page.tsx";

  it("fetches the period's gains through the one shared hook", () => {
    expect(code(read(PANEL))).toContain("useNicheViewsGained(pageFormat, range");
    expect(code(read(CARDS))).toContain("useNicheViewsGained(pageFormat, range");
  });

  it("is handed the page's period by both overviews", () => {
    expect(code(read(OVERVIEW))).toContain("<NicheEarningsPanel niches={niches} range={range} />");
    expect(code(read(LONGFORM))).toContain("<NicheEarningsPanel niches={niches} range={range} />");
  });

  /** The lifetime basis and the upload basis are both gone from what ships. */
  it("never sums the dataset's view counts, by date or otherwise", () => {
    for (const relative of [PANEL, STRIP, CARDS]) {
      const source = code(read(relative));
      expect(source).not.toContain("nicheViewTotals");
      expect(source).not.toContain("videosOfFormat");
      expect(source).not.toContain("videosInDateRange");
      expect(source).not.toContain("getShortsInDateRange");
    }
  });

  it("waits with a skeleton, fails in words, and labels the measured span", () => {
    for (const relative of [PANEL, STRIP]) {
      const source = code(read(relative));
      expect(source).toContain("Skeleton");
      expect(source).toContain("VIEWS_GAINED_UNAVAILABLE");
      expect(source).toContain("NICHE_MEASURING");
      expect(source).toContain("NICHE_NO_VIEWS");
    }
    expect(code(read(PANEL))).toContain("measuredSpanNoteFrom(gains.data)");
    expect(code(read(CARDS))).toContain("measuredSpanNoteFrom(data)");
  });

  it("captions a partial figure with the channels it covers", () => {
    expect(code(read(PANEL))).toContain("row.measuredCaption");
    expect(code(read(STRIP))).toContain("measuredChannelsCaption(measured)");
  });

  it("renders none of the sentences from either abandoned basis", () => {
    for (const relative of [PANEL, STRIP, CARDS]) {
      const source = code(read(relative));
      for (const phrase of ["Not enough view history", "lifetime", "does not change"]) {
        expect(source).not.toContain(phrase);
      }
    }
  });

  it("tells the reader which tracked channels no figure includes", () => {
    expect(code(read(CARDS))).toContain("towards no figure");
    expect(code(read(CARDS))).toContain("not in any");
  });

  it("keys its empty state off the reason rather than the count", () => {
    expect(read(PANEL)).toContain('panel.noTotalReason === "nothing_priced"');
    expect(read(PANEL)).not.toContain("panel.pricedCount === 0");
  });

  it("renders the caveat when the total omits niches", () => {
    expect(read(PANEL)).toContain("panel.totalIsPartial");
    expect(read(PANEL)).toContain("NICHE_EARNINGS_PARTIAL_TOTAL");
  });

  /** The copy modules ship no sentence from either abandoned basis either. */
  it("keeps the abandoned bases' sentences out of the copy modules' code", () => {
    for (const relative of [
      "lib/analytics/niche-earnings.ts",
      "lib/analytics/niche-rpm.ts",
      "lib/analytics/views-gained-labels.ts",
    ]) {
      const source = code(read(relative));
      expect(source).not.toContain("Not enough view history");
      expect(source).not.toContain("does not change this figure");
      expect(source).not.toContain("does not change these figures");
    }
  });
});
