import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BASELINE_LAG_FLOOR_MS,
  NICHE_EARNINGS_DEFINITION,
  NICHE_EARNINGS_DEFINITION_LONGFORM,
  approxDurationCeil,
  buildNicheEarnings,
  hasUsableGainsHistory,
  measuredSpanNote,
  measuredSpanNoteFrom,
  type NicheEarningsInput,
} from "../niche-earnings";
import {
  TRACKED_NICHE_VALUE_DEFINITION,
  TRACKED_NICHE_VALUE_DEFINITION_LONGFORM,
  resolveNicheRpm,
  rpmWindowEndingAt,
  type NicheRpmResolution,
} from "../niche-rpm";

/**
 * =========================================================================
 * THE OVERVIEW EARNINGS PANEL — WHO SEES IT, AND WHAT IT SAYS WHEN IT CANNOT
 * =========================================================================
 *
 * The owner's seventh request has two halves and the second one is the one that
 * needs pinning: "this should only be visible to Admins."
 *
 * WHAT IS PRICED CHANGED — views GAINED during the period, from the snapshot
 * series, instead of the lifetime views of the period's uploads — and with it
 * came a fourth refusal: a period the view history cannot cover well enough is
 * answered in words, never with a figure priced from an incomplete count.
 *
 * WHY THIS IS TESTED AS A PURE FUNCTION AND NOT AS A COMPONENT. The runner here
 * is Node with no DOM — `vitest.config.ts` sets `environment: "node"` and only
 * collects `*.test.ts` — so a rendered assertion is not available. That is not
 * a compromise for this particular rule, because the rule is not a rendering
 * decision. The gate is the DATA: `NicheDTO.rpm` arrives null for a reader
 * without `finance.view`, the panel is built from those nulls, and
 * `disclosed: false` is what the component keys off. Testing the builder tests
 * the boundary; testing the component would only test that somebody remembered
 * to write an `if`.
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
    measured: { coveredVideos: 10, totalVideos: 10 },
    ownChannelIds: ["chan_1"],
    ...overrides,
  };
}

describe("who the earnings panel is built for", () => {
  /**
   * THE GATE. An employee's dataset carries `rpm: null` on every niche, because
   * `resolveNicheRpmByNiche` returns null rather than an empty map and
   * `toNicheDTO` forwards only what it was handed. There is nothing here to
   * reconstruct a figure from, so the panel is ABSENT rather than empty — an
   * Overview with no money on it, rather than a locked box inviting somebody to
   * ask what is behind it.
   */
  it("is not disclosed at all to a reader who was sent no economics", () => {
    const panel = buildNicheEarnings([
      niche({ rpm: null }),
      niche({ id: "niche_finance", name: "Finance", rpm: null }),
    ]);

    expect(panel.disclosed).toBe(false);
    // Not one niche is named. A list of niches with "not estimated" beside each
    // would still be telling an employee which niches exist and that none of
    // them is priced, which is a disclosure of its own.
    expect(panel.rows).toHaveLength(0);
    expect(panel.total).toBeNull();
    expect(panel.pricedCount).toBe(0);
  });

  it("is not disclosed on an organization with no niches at all", () => {
    expect(buildNicheEarnings([]).disclosed).toBe(false);
  });

  /**
   * A NICHE-SCOPED READER GRANTED `finance.view` IS A REAL COMBINATION.
   *
   * `finance.view` is individually grantable — the RPM service's own docstring
   * argues it should be, so a Head of Shorts can be shown niche economics — and
   * `getVisibleNicheIds` then narrows WHICH niches those economics cover. Such
   * a reader receives objects for their own niches and nothing for the rest, so
   * the panel must render what they were sent rather than blanking because one
   * entry is null.
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

describe("the coverage floor under every dollar figure", () => {
  /**
   * 0.9 — `RPM_MIN_SNAPSHOT_COVERAGE`, the DOLLAR floor — and the boundary is
   * pinned from both sides. An uncovered video's views are silently missing
   * from the gains sum, so below the floor the figure would be priced from an
   * incomplete count: words. AT the floor the bounded understatement is
   * accepted, exactly as the derived-RPM judge accepts it: money.
   */
  it("refuses money at coverage 0.899 and grants it at exactly 0.9", () => {
    const below = buildNicheEarnings([
      niche({ measured: { coveredVideos: 899, totalVideos: 1000 } }),
    ]);
    const at = buildNicheEarnings([
      niche({ measured: { coveredVideos: 900, totalVideos: 1000 } }),
    ]);

    expect(below.rows[0]!.state).toBe("insufficient_history");
    expect(below.pricedCount).toBe(0);
    expect(below.total).toBeNull();

    expect(at.rows[0]!.state).toBe("priced");
    expect(at.total).toEqual({ lowMinor: 3_000, highMinor: 6_000, currency: "USD" });
  });

  /** No measurement at all is the same refusal said harder. */
  it("treats a niche the endpoint could not measure as insufficient history", () => {
    const panel = buildNicheEarnings([niche({ measured: null })]);

    expect(panel.rows[0]!.state).toBe("insufficient_history");
    expect(panel.total).toBeNull();
    expect(panel.noTotalReason).toBe("no_usable_history");
  });

  /**
   * A library of zero videos is NOT thin history — there is nothing the
   * measurement failed to cover. It is a niche with nothing to gain, which is
   * the no-gains state's job to say.
   */
  it("does not call an empty library insufficient", () => {
    expect(hasUsableGainsHistory({ coveredVideos: 0, totalVideos: 0 })).toBe(true);
    const panel = buildNicheEarnings([
      niche({
        ourViewsGained: 0,
        competitorViewsGained: 0,
        measured: { coveredVideos: 0, totalVideos: 0 },
      }),
    ]);
    expect(panel.rows[0]!.state).toBe("no_gains");
  });
});

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
   * A priced, fully measured niche that gained nothing prices to zero
   * correctly, and must still not print "$0": that reads as a claim about the
   * niche rather than about the period on screen. Same rule as the niche card.
   */
  it("separates 'nothing gained in this period' from 'nobody has priced it'", () => {
    const panel = buildNicheEarnings([
      niche({ ourViewsGained: 0, competitorViewsGained: 0 }),
    ]);

    expect(panel.rows[0]!.state).toBe("no_gains");
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
   * `pricedCount` is zero in THREE different situations — nobody entered a
   * rate, every rated niche gained nothing, and the history cannot cover the
   * period — and they are three different instructions to the owner. The
   * headline keys off which of them actually holds.
   */
  it("does not claim a niche is unpriced when it is priced but gained nothing", () => {
    const panel = buildNicheEarnings([
      niche({ id: "a", ourViewsGained: 0, competitorViewsGained: 0 }),
      niche({ id: "b", name: "Finance", ourViewsGained: 0, competitorViewsGained: 0 }),
    ]);

    expect(panel.pricedCount).toBe(0);
    expect(panel.noTotalReason).toBe("nothing_gained");
    // Every row has a rate. "Nothing priced" would be a false statement.
    expect(panel.rows.map((row) => row.state)).toEqual(["no_gains", "no_gains"]);
  });

  /** The genuinely unpriced case still reports itself as such. */
  it("still reports nothing_priced when no niche has a rate at all", () => {
    const panel = buildNicheEarnings([niche({ rpm: unpricedRpm() })]);

    expect(panel.noTotalReason).toBe("nothing_priced");
  });

  /**
   * A mix: one niche has a rate but gained nothing, another has no rate.
   * Neither is priced, and the honest reading is the one that does not accuse
   * the owner of having priced nothing — a rate does exist.
   */
  it("prefers 'nothing gained' when at least one niche does have a rate", () => {
    const panel = buildNicheEarnings([
      niche({ id: "a", ourViewsGained: 0, competitorViewsGained: 0 }),
      niche({ id: "b", name: "Finance", rpm: unpricedRpm() }),
    ]);

    expect(panel.pricedCount).toBe(0);
    expect(panel.noTotalReason).toBe("nothing_gained");
  });

  /**
   * When every rate-bearing niche is below the coverage floor, the honest
   * headline is about the HISTORY: "gained nothing" would assert a
   * measurement that never happened, and "nothing priced" would deny a rate
   * the owner entered.
   */
  it("reports no_usable_history when every rated niche is below the floor", () => {
    const panel = buildNicheEarnings([
      niche({ id: "a", measured: { coveredVideos: 1, totalVideos: 10 } }),
      niche({ id: "b", name: "Finance", measured: null }),
      niche({ id: "c", name: "Sport", rpm: unpricedRpm() }),
    ]);

    expect(panel.pricedCount).toBe(0);
    expect(panel.noTotalReason).toBe("no_usable_history");
  });

  /** One measured no-gains niche outranks the thin-history headline: a real
   * measurement exists, so the period genuinely paid nothing measurable. */
  it("prefers 'nothing gained' over 'no usable history' when one niche measured", () => {
    const panel = buildNicheEarnings([
      niche({ id: "a", ourViewsGained: 0, competitorViewsGained: 0 }),
      niche({ id: "b", name: "Finance", measured: null }),
    ]);

    expect(panel.noTotalReason).toBe("nothing_gained");
  });
});

describe("the arithmetic on gains", () => {
  /**
   * The ordinary case. Two niches, no shared channel, both priced in the base
   * currency: the totals add.
   *
   * 2,000,000 gained views of ours at 50% engaged is 1,000,000 priced views,
   * which at $0.03–$0.06 per 1,000 engaged views is $30.00–$60.00. Two such
   * niches total $60.00–$120.00. Written out rather than derived, so a broken
   * implementation cannot agree with a broken expectation.
   */
  it("adds Northstar's own share across niches that share no channel", () => {
    const panel = buildNicheEarnings([
      niche({ id: "a", ownChannelIds: ["chan_1"] }),
      niche({ id: "b", ownChannelIds: ["chan_2"] }),
    ]);

    expect(panel.noTotalReason).toBeNull();
    expect(panel.total).toEqual({ lowMinor: 6_000, highMinor: 12_000, currency: "USD" });
  });

  /** Capture is gained-over-gained: 2M of 10M tracked gains is 20%. */
  it("computes the capture percentage from the gained views", () => {
    const panel = buildNicheEarnings([niche()]);

    expect(panel.rows[0]!.value.capturePercent).toBe(20);
    expect(panel.rows[0]!.value.trackedNicheViews).toBe(10_000_000);
  });

  /**
   * A NEGATIVE SUM CLAMPS TO ZERO VIEWS, NEVER TO NEGATIVE MONEY. Purges can
   * pull a channel's period delta below zero, and the raw figure is a real
   * fact about views — but "-$12" is not an amount of revenue that exists.
   * The clamp lives in `calculateNicheValue` and is pinned HERE because this
   * is the first caller that can actually feed it a negative.
   */
  it("clamps a negative gains sum to zero rather than pricing negative money", () => {
    const panel = buildNicheEarnings([
      niche({ ourViewsGained: -500_000, competitorViewsGained: 1_000_000 }),
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
   * `niche-rpm-service` states the rule it is protecting: a channel in two
   * niches is measured once and counted in BOTH — correct per niche, and
   * never addable across them, because the same views would be priced at two
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
   * figure, so there is nothing to double. Checking against every niche rather
   * than every priced one would withhold a total that is perfectly correct.
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
   * as well as in the maths suite because this is the surface an admin reads a
   * portfolio number off: if the share stopped arriving, every figure on this
   * panel would silently double.
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
});

/**
 * =========================================================================
 * THE TOTAL MUST NOT CLAIM A COVERAGE IT DOES NOT HAVE
 * =========================================================================
 * The sum can only include niches that HAVE a rate — an unpriced niche is
 * unknown, not zero, so there is nothing to add. The label is derived from the
 * same counts the sum was built from, and the panel renders whatever it is
 * handed rather than a sentence written at design time.
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
        ourViewsGained: 50_000_000,
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

describe("the measured-span label", () => {
  it("says exactly how much of the period the history covers", () => {
    expect(measuredSpanNote(9, 30)).toBe(
      "Measured over the last 9 of 30 days — view history begins there.",
    );
  });

  it("is singular-safe", () => {
    expect(measuredSpanNote(1, 1)).toBe(
      "Measured over the last 1 of 1 day — view history begins there.",
    );
  });

  const DAY_MS = 86_400_000;
  const HOUR_MS = 3_600_000;
  const END = Date.UTC(2026, 7, 31);

  it("derives the note from the server's own echo of the request", () => {
    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 30 * DAY_MS,
        measuredFromMs: END - 9 * DAY_MS,
        endMs: END,
        maxBaselineLagMs: 0,
      }),
    ).toBe("Measured over the last 9 of 30 days — view history begins there.");
  });

  it("says nothing when the whole period was measured, for every video", () => {
    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 30 * DAY_MS,
        measuredFromMs: END - 30 * DAY_MS,
        endMs: END,
        maxBaselineLagMs: 0,
      }),
    ).toBeNull();
    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 30 * DAY_MS,
        measuredFromMs: null,
        endMs: END,
        maxBaselineLagMs: null,
      }),
    ).toBeNull();
  });

  /**
   * The half the label used to assert away. Videos are baselined on their own
   * first reading when the sweep reached them late, so the span is no longer
   * uniform across every video — and a note that went silent whenever the
   * clamp had not fired would hide the caveat exactly where it is the only
   * thing left to say.
   */
  it("speaks about ragged baselines even when the clamp never fired", () => {
    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 30 * DAY_MS,
        measuredFromMs: END - 30 * DAY_MS,
        endMs: END,
        maxBaselineLagMs: 2 * 3_600_000,
      }),
    ).toBe(
      "Measured over the full 30 days. The app started recording some of these " +
        "videos up to 2 hours into that span, so their first views are missing " +
        "and this figure is a little low.",
    );
  });

  it("states both caveats when the span is short AND the baselines are ragged", () => {
    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 30 * DAY_MS,
        measuredFromMs: END - 9 * DAY_MS,
        endMs: END,
        maxBaselineLagMs: 49 * 60_000,
      }),
    ).toBe(
      "Measured over the last 9 of 30 days — view history begins there. " +
        "The app started recording some of these videos up to 49 minutes into " +
        "that span, so their first views are missing and this figure is a little low.",
    );
  });

  /** A bound is only a bound if it rounds the safe way. */
  it("rounds the stated gap UP, so 'up to' is never a claim the data cannot support", () => {
    expect(approxDurationCeil(61 * 60_000)).toBe("2 hours");
    expect(approxDurationCeil(90 * 1_000)).toBe("2 minutes");
    expect(approxDurationCeil(3_600_000)).toBe("1 hour");
    expect(approxDurationCeil(49 * HOUR_MS)).toBe("3 days");
  });

  it("stays quiet below the smallest unit it can express", () => {
    // Half a minute of raggedness would render as "up to 0 minutes" or force a
    // false round-up; a caveat under every figure forever is noise, not honesty.
    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 30 * DAY_MS,
        measuredFromMs: END - 30 * DAY_MS,
        endMs: END,
        maxBaselineLagMs: 30_000,
      }),
    ).toBeNull();
    expect(BASELINE_LAG_FLOOR_MS).toBe(60_000);
  });
});

/**
 * =========================================================================
 * THE WORDS — the period means what the selector implies, and nothing claims
 * automatic refresh is off any more (it has been on since September).
 * =========================================================================
 */
describe("the copy tells the gained-views truth", () => {
  const readSource = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), "utf8");

  it("defines the panel figure as views gained during the period", () => {
    expect(NICHE_EARNINGS_DEFINITION).toContain("gained during the selected period");
    expect(NICHE_EARNINGS_DEFINITION_LONGFORM).toContain("gained during the selected period");
    expect(TRACKED_NICHE_VALUE_DEFINITION).toContain("gained during the selected period");
    expect(TRACKED_NICHE_VALUE_DEFINITION_LONGFORM).toContain(
      "gained during the selected period",
    );
  });

  it("no longer claims automatic refresh is switched off, anywhere it did", () => {
    for (const relative of [
      "lib/analytics/niche-earnings.ts",
      "lib/analytics/niche-rpm.ts",
      "server/services/niche-rpm-service.ts",
    ]) {
      expect(readSource(relative)).not.toContain("currently switched off");
    }
  });
});

/**
 * The panel is JSX and this runner has no DOM, so the one thing that cannot be
 * asserted through `buildNicheEarnings` is that the component actually RENDERS
 * what it is handed. A source assertion is the available check, and it is the
 * same technique `niche-card-controls.test.ts` uses.
 */
describe("the panel renders the label rather than asserting its own", () => {
  const panelSource = readFileSync(
    fileURLToPath(
      new URL("../../../components/dashboard/niche-earnings-panel.tsx", import.meta.url),
    ),
    "utf8",
  );

  it("takes the total's caption from the builder", () => {
    expect(panelSource).toContain("panel.totalLabel");
  });

  it("no longer claims the sum covers every niche", () => {
    const code = panelSource
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");

    expect(code).not.toContain("all niches");
  });

  /**
   * The empty state must key off the REASON, not off `pricedCount === 0` —
   * those differ exactly when a priced niche gained nothing or the history is
   * thin, which are the states that produced a false sentence.
   */
  it("keys its empty state off the reason rather than the count", () => {
    expect(panelSource).toContain('panel.noTotalReason === "nothing_priced"');
    expect(panelSource).not.toContain("panel.pricedCount === 0");
  });

  it("renders the caveat when the total omits niches", () => {
    expect(panelSource).toContain("panel.totalIsPartial");
    expect(panelSource).toContain("NICHE_EARNINGS_PARTIAL_TOTAL");
  });

  /** A failed gains read is words, and a pending one is skeletons — never a
   * stale figure under a fresh period label. */
  it("handles the fetch states in words and skeletons", () => {
    expect(panelSource).toContain("VIEWS_GAINED_UNAVAILABLE");
    expect(panelSource).toContain("Skeleton");
    expect(panelSource).toContain("measuredSpanNoteFrom");
  });
});
