import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildNicheEarnings,
  type NicheEarningsInput,
} from "../niche-earnings";
import {
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
 * WHY THIS IS TESTED AS A PURE FUNCTION AND NOT AS A COMPONENT. The runner here
 * is Node with no DOM — `vitest.config.ts` sets `environment: "node"` and only
 * collects `*.test.ts` — so a rendered assertion is not available. That is not
 * a compromise for this particular rule, because the rule is not a rendering
 * decision. The gate is the DATA: `NicheDTO.rpm` arrives null for a reader
 * without `finance.view`, the panel is built from those nulls, and
 * `disclosed: false` is what the component keys off. Testing the builder tests
 * the boundary; testing the component would only test that somebody remembered
 * to write an `if`.
 *
 * The server side of the same gate is already pinned in
 * `niche-rpm-disclosure.test.ts` (the DTO withholds the resolution) and
 * `niche-rpm-permission.test.ts` (the write needs both permissions). This file
 * covers the third link: that the new surface built on top of them cannot
 * reconstruct anything from what it was given.
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
    ourViews: 2_000_000,
    competitorViews: 8_000_000,
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

describe("what the panel says when it cannot say a number", () => {
  /**
   * THE STATE OF THIS DEPLOYMENT TODAY, for every niche.
   *
   * Nothing writes `VideoSnapshot` rows while `autoRefreshEnabled` is false, so
   * no rate can be derived, and no range has been entered. The panel must say
   * that rather than render a column of zeros — "$0" under a niche's name is a
   * claim that the niche generates nothing, which is a statement about the
   * catalogue rather than about what the app can currently see.
   */
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
   * A priced niche that published nothing in the selected period prices to zero
   * correctly, and must still not print "$0": that reads as a claim about the
   * niche rather than about the period on screen. Same rule as the niche card.
   */
  it("separates 'nothing published in this period' from 'nobody has priced it'", () => {
    const panel = buildNicheEarnings([
      niche({ ourViews: 0, competitorViews: 0 }),
    ]);

    expect(panel.rows[0]!.state).toBe("no_shorts");
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
   * and everybody's rate had nothing to price — and the panel used to key its
   * headline sentence off the count, so the second state rendered "No niche has
   * a rate yet, so there is nothing to price."
   *
   * That is not a hypothetical ordering of events. It is what the owner sees
   * the moment he enters his first RPM and then narrows the period, which is
   * the obvious next thing to do after pricing a niche. The rows underneath
   * were already saying the opposite and correct thing, and were being thrown
   * away. The reason now distinguishes the two so the panel can keep them.
   */
  it("does not claim a niche is unpriced when it is priced but published nothing", () => {
    const panel = buildNicheEarnings([
      niche({ id: "a", ourViews: 0, competitorViews: 0 }),
      niche({ id: "b", name: "Finance", ourViews: 0, competitorViews: 0 }),
    ]);

    expect(panel.pricedCount).toBe(0);
    expect(panel.noTotalReason).toBe("nothing_published");
    // Every row has a rate. "Nothing priced" would be a false statement.
    expect(panel.rows.map((row) => row.state)).toEqual(["no_shorts", "no_shorts"]);
  });

  /** The genuinely unpriced case still reports itself as such. */
  it("still reports nothing_priced when no niche has a rate at all", () => {
    const panel = buildNicheEarnings([niche({ rpm: unpricedRpm() })]);

    expect(panel.noTotalReason).toBe("nothing_priced");
  });

  /**
   * A mix: one niche has a rate but published nothing, another has no rate.
   * Neither is priced, and the honest reading is the one that does not accuse
   * the owner of having priced nothing — a rate does exist.
   */
  it("prefers 'nothing published' when at least one niche does have a rate", () => {
    const panel = buildNicheEarnings([
      niche({ id: "a", ourViews: 0, competitorViews: 0 }),
      niche({ id: "b", name: "Finance", rpm: unpricedRpm() }),
    ]);

    expect(panel.pricedCount).toBe(0);
    expect(panel.noTotalReason).toBe("nothing_published");
  });
});

describe("the portfolio total", () => {
  /**
   * The ordinary case. Two niches, no shared channel, both priced in the base
   * currency: the totals add.
   *
   * 2,000,000 raw views of ours at 50% engaged is 1,000,000 priced views, which
   * at $0.03–$0.06 per 1,000 engaged views is $30.00–$60.00. Two such niches
   * total $60.00–$120.00. Written out rather than derived, so a broken
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

  /**
   * =========================================================================
   * THE DOUBLE-COUNT, WHICH IS THE WHOLE REASON THE TOTAL IS ALLOWED TO BE NULL
   * =========================================================================
   * `niche-rpm-service` states the rule it is protecting: "A CHANNEL IN TWO
   * NICHES IS JUDGED ONCE AND COUNTED IN BOTH, which is correct for a RATE ...
   * What must never be done with the result is to add the niche totals together
   * into a portfolio figure, because that would count the channel twice."
   *
   * This panel is the first surface in the app that sums across niches at all,
   * so it is the first place that rule could be broken. There is no correction
   * available — the same views would have to be priced at two different rates,
   * and silently picking one is how a portfolio number becomes fiction — so the
   * total is withheld and the per-niche figures, each correct on its own, stay.
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
 * unknown, not zero, so there is nothing to add. That is correct arithmetic
 * under a label that was not: the panel printed "Northstar's share, all
 * niches" over it, so with two of eight niches priced it asserted a portfolio
 * figure while six were silently missing, and `noTotalReason` stayed null so no
 * caveat rendered anywhere.
 *
 * The module's own contract on the field says "Never a partial sum presented as
 * a total". The sum is worth keeping; what had to go was the claim. So the
 * label is derived from the same counts the sum was built from, and the panel
 * renders whatever it is handed rather than a sentence written at design time.
 *
 * The same fix covers the scoped reader: `rows` is already narrowed to the
 * niches a member was assigned, so counting rows describes what THEY were sent,
 * where "all niches" described a catalogue they cannot see.
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

/**
 * The panel is JSX and this runner has no DOM, so the one thing that cannot be
 * asserted through `buildNicheEarnings` is that the component actually RENDERS
 * the label it is handed. That is precisely where the bug lived: the builder was
 * always correct about what it summed, and the header ignored it in favour of a
 * sentence written at design time. A source assertion is the available check,
 * and it is the same technique `niche-card-controls.test.ts` uses.
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
   * those differ exactly when a priced niche published nothing, which is the
   * state that produced a false sentence.
   */
  it("keys its empty state off the reason rather than the count", () => {
    expect(panelSource).toContain('panel.noTotalReason === "nothing_priced"');
    expect(panelSource).not.toContain("panel.pricedCount === 0");
  });

  it("renders the caveat when the total omits niches", () => {
    expect(panelSource).toContain("panel.totalIsPartial");
    expect(panelSource).toContain("NICHE_EARNINGS_PARTIAL_TOTAL");
  });
});
