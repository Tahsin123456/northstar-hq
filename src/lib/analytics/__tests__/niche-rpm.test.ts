import { describe, expect, it } from "vitest";
import {
  MAX_RPM_MAJOR_PER_THOUSAND,
  RPM_REJECTION_EXPLANATION,
  RPM_MIN_EARNING_DAYS,
  RPM_MIN_SNAPSHOT_COVERAGE,
  RPM_MIN_VIEWS,
  RPM_VIEW_BASIS,
  RPM_WINDOW_DAYS,
  calculateNicheValue,
  formatRpmBounds,
  isRpmPoint,
  judgeRpmChannel,
  maxRpmMinorPerMillion,
  missingRpmRangeHalf,
  parseRpmToMinorPerMillion,
  projectRevenue,
  resolveManualRpmRange,
  resolveNicheRpm,
  rpmBounds,
  rpmToInputText,
  rpmWindowEndingAt,
  type NicheRpmRangeSource,
  type RpmChannelEvidence,
  type RpmChannelOutcome,
  type RpmRevenueDay,
  type RpmWindow,
} from "../niche-rpm";

/**
 * What a niche is worth, and what it takes to say so.
 *
 * The cases below are the ones the owner's request actually turns on: a
 * measurement beating a guess, a guess surviving where the measurement is not
 * trustworthy — his own "newly monetized" case — several own channels resolving
 * as one rate, and an unpriced niche staying unpriced instead of quietly
 * becoming a niche worth nothing.
 */

const DAY_MS = 86_400_000;

/** A fixed instant, so the window under test never moves. */
const NOW = Date.UTC(2026, 7, 31, 14, 30);

const WINDOW = rpmWindowEndingAt(NOW);

/** `n` consecutive earning days from the window's first day. */
function earningDays(
  window: RpmWindow,
  options: { count: number; minorPerDay: number; fromDayOffset?: number },
): RpmRevenueDay[] {
  const from = options.fromDayOffset ?? 0;
  return Array.from({ length: options.count }, (_, index) => ({
    dayMs: window.startMs + (from + index) * DAY_MS,
    revenueMinor: options.minorPerDay,
  }));
}

/** A channel that clears every bar in the gate. */
function healthyChannel(overrides: Partial<RpmChannelEvidence> = {}): RpmChannelEvidence {
  return {
    channelId: "chan_1",
    channelName: "Northstar GTA",
    monetizationStatus: "monetized",
    revenueSyncStatus: "ok",
    // $2.00 a day for the whole window: $56.00 over 28 days.
    revenueDays: earningDays(WINDOW, { count: RPM_WINDOW_DAYS, minorPerDay: 200 }),
    currencyConvertible: true,
    hasRevenueDayBeforeWindow: true,
    viewsGained: 1_000_000,
    snapshotCoverage: 1,
    ...overrides,
  };
}

function accepted(evidence: RpmChannelEvidence): RpmChannelOutcome {
  const outcome = judgeRpmChannel(evidence, WINDOW);
  if (!outcome.accepted) {
    throw new Error(`expected an accepted channel, got ${outcome.reason}`);
  }
  return outcome;
}

/** A stored range of $0.03–$0.06 per 1,000 views, in USD. */
const STORED_RANGE: NicheRpmRangeSource = {
  rpmLowMinorPerMillion: 3_000,
  rpmHighMinorPerMillion: 6_000,
  rpmCurrency: "USD",
};

const NO_RANGE: NicheRpmRangeSource = {
  rpmLowMinorPerMillion: null,
  rpmHighMinorPerMillion: null,
  rpmCurrency: null,
};

function resolve(
  manual: NicheRpmRangeSource,
  channels: readonly RpmChannelOutcome[],
) {
  return resolveNicheRpm({ manual, channels, window: WINDOW, baseCurrency: "USD" });
}

describe("the window a rate is measured over", () => {
  it("is 28 whole days ending three days before today", () => {
    expect(WINDOW.days).toBe(RPM_WINDOW_DAYS);
    expect(WINDOW.endMs % DAY_MS).toBe(0);
    expect(WINDOW.startMs % DAY_MS).toBe(0);
    // The last three days are YouTube's least settled figures and are left out.
    expect(Math.floor(NOW / DAY_MS) * DAY_MS - WINDOW.endMs).toBe(3 * DAY_MS);
  });
});

describe("a hand-entered range", () => {
  it("is unconstructible with only one end, like half a hit rule", () => {
    expect(
      resolveManualRpmRange({ ...STORED_RANGE, rpmHighMinorPerMillion: null }),
    ).toBeNull();
    expect(
      resolveManualRpmRange({ ...STORED_RANGE, rpmLowMinorPerMillion: null }),
    ).toBeNull();
    expect(missingRpmRangeHalf({ ...STORED_RANGE, rpmHighMinorPerMillion: null })).toBe(
      "high",
    );
    expect(missingRpmRangeHalf(NO_RANGE)).toBe("both");
  });

  it("is unconstructible with no currency, because digits alone are not money", () => {
    expect(resolveManualRpmRange({ ...STORED_RANGE, rpmCurrency: null })).toBeNull();
    expect(missingRpmRangeHalf({ ...STORED_RANGE, rpmCurrency: "  " })).toBe("currency");
  });

  it("treats zero as unset rather than as a niche that pays nothing", () => {
    expect(
      resolveManualRpmRange({ ...STORED_RANGE, rpmLowMinorPerMillion: 0 }),
    ).toBeNull();
  });

  it("refuses an inverted pair rather than silently swapping the ends", () => {
    expect(
      resolveManualRpmRange({
        rpmLowMinorPerMillion: 6_000,
        rpmHighMinorPerMillion: 3_000,
        rpmCurrency: "USD",
      }),
    ).toBeNull();
  });

  it("allows both ends equal, for somebody who genuinely means one number", () => {
    const range = resolveManualRpmRange({
      rpmLowMinorPerMillion: 4_500,
      rpmHighMinorPerMillion: 4_500,
      rpmCurrency: "USD",
    });
    expect(range).not.toBeNull();
    expect(isRpmPoint(rpmBounds(resolve({ ...STORED_RANGE }, []))!)).toBe(false);
  });
});

describe("precedence", () => {
  it("lets a trustworthy own channel override a hand-entered range", () => {
    const resolution = resolve(STORED_RANGE, [accepted(healthyChannel())]);

    expect(resolution.source).toBe("derived");
    if (resolution.source !== "derived") return;

    // $56.00 over 1,000,000 views = 5,600 minor units per 1,000,000 views,
    // i.e. $0.056 per 1,000 views. Squarely inside the stored $0.03–$0.06 band
    // and NOT equal to either end of it, so a passing assertion cannot be the
    // manual range wearing the derived label.
    expect(resolution.rpmMinorPerMillion).toBe(5_600);
    expect(resolution.evidence.revenueMinorUsed).toBe(5_600);
    expect(resolution.evidence.viewsUsed).toBe(1_000_000);
    expect(resolution.evidence.channels).toEqual([
      { id: "chan_1", name: "Northstar GTA" },
    ]);
  });

  it("carries the overridden range so a screen can say it is stored and unused", () => {
    const resolution = resolve(STORED_RANGE, [accepted(healthyChannel())]);
    if (resolution.source !== "derived") throw new Error("expected a derived rate");

    // Not dropped. Somebody who edits the range and sees nothing move has to be
    // told why, or they conclude the save is broken.
    expect(resolution.supersededRange).toEqual({
      lowMinorPerMillion: 3_000,
      highMinorPerMillion: 6_000,
      currency: "USD",
    });
  });

  it("renders a measurement as a point and a guess as a range", () => {
    const derived = rpmBounds(resolve(NO_RANGE, [accepted(healthyChannel())]))!;
    const manual = rpmBounds(resolve(STORED_RANGE, []))!;

    expect(isRpmPoint(derived)).toBe(true);
    expect(formatRpmBounds(derived)).toBe("$0.056");
    expect(isRpmPoint(manual)).toBe(false);
    expect(formatRpmBounds(manual)).toBe("$0.03–$0.06");
  });
});

describe("the trust gate, one channel at a time", () => {
  /**
   * The owner's own stated case, and the one this whole gate exists for.
   *
   * A channel accepted into the partner programme part-way through the window
   * has 28 days of views against 10 days of money. Dividing anyway understates
   * the rate by roughly two thirds, and an understated rate applied to a whole
   * niche understates the niche.
   */
  it("refuses a newly monetized channel and falls back to the entered range", () => {
    const newlyMonetized = healthyChannel({
      revenueDays: earningDays(WINDOW, {
        count: 10,
        minorPerDay: 200,
        fromDayOffset: 18,
      }),
    });

    const outcome = judgeRpmChannel(newlyMonetized, WINDOW);
    expect(outcome.accepted).toBe(false);
    if (outcome.accepted) return;
    expect(outcome.reason).toBe("newly_monetized");

    const resolution = resolve(STORED_RANGE, [outcome]);
    expect(resolution.source).toBe("manual");
    if (resolution.source !== "manual") return;
    expect(resolution.range.lowMinorPerMillion).toBe(3_000);
    // The reason travels, so the card can say why the measurement is missing.
    expect(resolution.rejectedChannels).toHaveLength(1);
  });

  /**
   * THE SAME REFUSAL, A DIFFERENT SENTENCE — and the difference is the point.
   *
   * Earnings from day one of the window is what a long-monetized channel looks
   * like, and also what a backfill that has not reached further back looks
   * like. Refusing is right either way. But the two get separate reasons
   * because the words shown to a person differ: `newly_monetized` asserts the
   * channel started earning mid-window, which is a factual claim about a
   * channel that may have been monetized for a decade, and this branch is
   * precisely the one where we have just admitted we cannot see that far back.
   *
   * It is also the branch that fires on this deployment today, where revenue
   * has only just begun importing — so it is the sentence most people will
   * actually read.
   */
  it("names an import boundary as one, rather than calling the channel newly monetized", () => {
    const outcome = judgeRpmChannel(
      healthyChannel({ hasRevenueDayBeforeWindow: false }),
      WINDOW,
    );
    expect(outcome.accepted).toBe(false);
    if (outcome.accepted) return;
    expect(outcome.reason).toBe("revenue_history_too_shallow");

    // The sentence must not assert a monetization history we cannot see, and
    // must name the thing that is actually shallow.
    const sentence = RPM_REJECTION_EXPLANATION[outcome.reason];
    expect(sentence).not.toContain("started earning part-way");
    expect(sentence).toContain("import");

    // And the other reason keeps its own, stronger claim — which is only
    // allowed to be that strong because the earlier days really were held.
    expect(RPM_REJECTION_EXPLANATION.newly_monetized).toContain(
      "we hold the earlier days and they are quiet",
    );
  });

  it("still calls a genuinely newly monetized channel newly monetized", () => {
    // Quiet days ARE held before the window, and earnings begin inside it. That
    // is an observation rather than an inference, which is what earns the
    // stronger sentence.
    const outcome = judgeRpmChannel(
      healthyChannel({
        hasRevenueDayBeforeWindow: true,
        revenueDays: earningDays(WINDOW, {
          count: 20,
          minorPerDay: 200,
          fromDayOffset: 8,
        }),
      }),
      WINDOW,
    );
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("newly_monetized");
  });

  it("refuses a channel earning on too few days to be a rate", () => {
    const outcome = judgeRpmChannel(
      healthyChannel({
        revenueDays: [
          ...earningDays(WINDOW, {
            count: RPM_MIN_EARNING_DAYS - 1,
            minorPerDay: 200,
          }),
          // Held, answered, and zero — a day YouTube said "nothing" about,
          // which is a different fact from a day with no row at all.
          { dayMs: WINDOW.startMs + 27 * DAY_MS, revenueMinor: 0 },
        ],
      }),
      WINDOW,
    );
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("too_few_earning_days");
  });

  /**
   * Today's state, on this deployment, for every channel.
   *
   * `autoRefreshEnabled` is false, so nothing writes snapshots and there is no
   * denominator. The reason is named rather than collapsed into a generic
   * failure because the fix is a settings decision somebody can make.
   */
  it("refuses a channel with no view history spanning the window", () => {
    const outcome = judgeRpmChannel(healthyChannel({ viewsGained: null }), WINDOW);
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("no_view_history");
  });

  it("refuses a channel whose snapshots cover too little of its library", () => {
    const outcome = judgeRpmChannel(
      healthyChannel({ snapshotCoverage: RPM_MIN_SNAPSHOT_COVERAGE - 0.01 }),
      WINDOW,
    );
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("thin_view_coverage");
  });

  it("refuses a channel below the evidence floor", () => {
    const outcome = judgeRpmChannel(
      healthyChannel({ viewsGained: RPM_MIN_VIEWS - 1 }),
      WINDOW,
    );
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("below_evidence_floor");
  });

  /**
   * The single worst bug this feature could ship.
   *
   * A channel YouTube reported zero for, or could not be asked about, has a
   * real view count and a zero numerator. The arithmetic is valid and produces
   * $0.00 — presented, with no estimate chip, as the privileged measured
   * figure. "We could not ask" must never render as "it earns nothing".
   */
  it("never turns a channel we could not ask about into a rate of zero", () => {
    for (const status of ["never", "no_scope", "reported_zero", "error"]) {
      const outcome = judgeRpmChannel(
        healthyChannel({ revenueSyncStatus: status }),
        WINDOW,
      );
      expect(outcome.accepted).toBe(false);
      if (!outcome.accepted) expect(outcome.reason).toBe("revenue_not_reported");
    }

    const notMonetized = judgeRpmChannel(
      healthyChannel({ monetizationStatus: "not_monetized" }),
      WINDOW,
    );
    expect(notMonetized.accepted).toBe(false);
    if (!notMonetized.accepted) expect(notMonetized.reason).toBe("not_monetized");
  });

  it("refuses rather than dropping revenue it cannot convert into the base", () => {
    const outcome = judgeRpmChannel(
      healthyChannel({ currencyConvertible: false }),
      WINDOW,
    );
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe("currency_unconvertible");
  });
});

describe("several own channels in one niche", () => {
  /**
   * The ratio of sums, and why the alternative is not a near miss.
   *
   * A small channel at a high rate and a large one at a low rate average to
   * something four times too high if each channel's ratio is averaged
   * unweighted. Sum both sides and divide once, and the answer is the rate the
   * studio actually earns across the niche.
   */
  it("sums both halves and divides once, rather than averaging per-channel rates", () => {
    const small = accepted(
      healthyChannel({
        channelId: "chan_small",
        channelName: "Small",
        // $15.00 over 28 days, on 50,000... below the view floor, so give it a
        // qualifying denominator with a genuinely higher rate.
        revenueDays: earningDays(WINDOW, { count: RPM_WINDOW_DAYS, minorPerDay: 300 }),
        viewsGained: 280_000,
      }),
    );
    const large = accepted(
      healthyChannel({
        channelId: "chan_large",
        channelName: "Large",
        revenueDays: earningDays(WINDOW, { count: RPM_WINDOW_DAYS, minorPerDay: 200 }),
        viewsGained: 5_000_000,
      }),
    );

    const resolution = resolve(NO_RANGE, [small, large]);
    if (resolution.source !== "derived") throw new Error("expected a derived rate");

    const revenue = 300 * 28 + 200 * 28; // 8,400 + 5,600 = 14,000 minor units
    const views = 280_000 + 5_000_000;
    expect(resolution.evidence.revenueMinorUsed).toBe(revenue);
    expect(resolution.evidence.viewsUsed).toBe(views);
    expect(resolution.rpmMinorPerMillion).toBe(
      Math.round((revenue * RPM_VIEW_BASIS) / views),
    );

    // The unweighted mean of the two per-channel rates is a different, larger
    // number. Asserting that it is NOT that is what makes this test about the
    // choice of mean rather than about arithmetic in general.
    const perChannelMean = Math.round(
      ((8_400 * RPM_VIEW_BASIS) / 280_000 + (5_600 * RPM_VIEW_BASIS) / 5_000_000) / 2,
    );
    expect(resolution.rpmMinorPerMillion).not.toBe(perChannelMean);
    expect(resolution.rpmMinorPerMillion).toBeLessThan(perChannelMean);
  });

  it("derives from the channels that qualify and reports the ones that do not", () => {
    const good = accepted(healthyChannel());
    const bad = judgeRpmChannel(
      healthyChannel({
        channelId: "chan_2",
        channelName: "Fresh",
        monetizationStatus: "not_monetized",
      }),
      WINDOW,
    );

    const resolution = resolve(NO_RANGE, [good, bad]);
    if (resolution.source !== "derived") throw new Error("expected a derived rate");

    // The rejected channel contributes NEITHER half. Putting its views into the
    // denominator against no revenue would drag the niche's rate toward zero
    // and assert the niche pays less than it does.
    expect(resolution.evidence.viewsUsed).toBe(1_000_000);
    expect(resolution.evidence.channels).toHaveLength(1);
    expect(resolution.rejectedChannels).toHaveLength(1);
  });
});

describe("a niche nobody has priced", () => {
  it("stays unset and never becomes zero", () => {
    const resolution = resolve(NO_RANGE, []);

    expect(resolution.source).toBe("none");
    if (resolution.source !== "none") return;
    expect(resolution.reason).toBe("no_own_channel");

    // No bounds to project from, so no money figure exists at all — as opposed
    // to a money figure of nothing, which would be a claim about the niche.
    expect(rpmBounds(resolution)).toBeNull();

    const value = calculateNicheValue({
      ourViews: 1_000_000,
      competitorViews: 9_000_000,
      bounds: null,
    });
    expect(value.trackedRevenue).toBeNull();
    expect(value.ourRevenue).toBeNull();
    expect(value.gapRevenue).toBeNull();
    // The view share is still real and still shown; it needs no rate.
    expect(value.capturePercent).toBe(10);
  });

  it("distinguishes 'no channel here' from 'the channels here cannot say'", () => {
    const unusable = judgeRpmChannel(healthyChannel({ viewsGained: null }), WINDOW);
    const resolution = resolve(NO_RANGE, [unusable]);

    expect(resolution.source).toBe("none");
    if (resolution.source !== "none") return;
    expect(resolution.reason).toBe("own_channels_unusable");
  });
});

/**
 * WHAT HAPPENS TO A STORED RANGE THE DAY AN ADMIN SWITCHES THE BASE CURRENCY.
 *
 * `Niche.rpmCurrency` exists so a range typed as $0.03–$0.06 does not silently
 * become €0.03–€0.06 — but that only helps if something on the read side then
 * does the conversion. Left unconverted, the card would price one niche in
 * euros beside another in dollars under the identical "$"-style symbol, which
 * is the same class of fabricated figure the whole module is written against.
 */
describe("a range entered in a currency that is not the base", () => {
  /** The same $0.03–$0.06, typed before the organization moved to EUR. */
  const USD_RANGE: NicheRpmRangeSource = STORED_RANGE;

  it("is converted into the base, and says what was actually typed", () => {
    const resolution = resolveNicheRpm({
      manual: USD_RANGE,
      channels: [],
      window: WINDOW,
      baseCurrency: "EUR",
      ratesToBase: new Map([["USD", 0.9]]),
    });

    expect(resolution.source).toBe("manual");
    if (resolution.source !== "manual") return;

    // The rate is applied to the RATE, once per end. Both currencies carry two
    // minor units, so the scale factor is 1 and the arithmetic is exact.
    expect(resolution.range).toEqual({
      lowMinorPerMillion: 2_700,
      highMinorPerMillion: 5_400,
      currency: "EUR",
    });
    // And the digits somebody typed survive, so the dialog can seed the boxes
    // with their number rather than a converted one nobody entered.
    expect(resolution.enteredRange).toEqual({
      lowMinorPerMillion: 3_000,
      highMinorPerMillion: 6_000,
      currency: "USD",
    });
  });

  /**
   * NO RATE MEANS NO FIGURE — the same refusal the derived path makes for
   * `currency_unconvertible`, and for the same reason. Inventing a conversion
   * would be a number nobody chose; printing the stored digits under the base
   * currency's symbol would be a different amount of money wearing the same
   * face. The stored range travels anyway, so the card can name it.
   */
  it("refuses rather than reinterpreting the digits under a new symbol", () => {
    const resolution = resolveNicheRpm({
      manual: USD_RANGE,
      channels: [],
      window: WINDOW,
      baseCurrency: "EUR",
      ratesToBase: new Map(),
    });

    expect(resolution.source).toBe("none");
    if (resolution.source !== "none") return;
    // Not "no_own_channel". Somebody DID price this niche, and the fix is one
    // exchange rate rather than a decision nobody has made.
    expect(resolution.reason).toBe("manual_range_unconvertible");
    expect(resolution.unconvertibleRange).toEqual({
      lowMinorPerMillion: 3_000,
      highMinorPerMillion: 6_000,
      currency: "USD",
    });
    expect(rpmBounds(resolution)).toBeNull();
  });

  it("leaves a range already in the base exactly as it is", () => {
    const resolution = resolve(STORED_RANGE, []);
    if (resolution.source !== "manual") throw new Error("expected the entered range");
    expect(resolution.range).toEqual(resolution.enteredRange);
  });
});

describe("turning a rate into money", () => {
  it("keeps a range a range, rounding outward", () => {
    const bounds = rpmBounds(resolve(STORED_RANGE, []))!;
    const money = projectRevenue(12_345_678, bounds);

    // Floor the low end, ceil the high end. Rounding both to nearest would let
    // a genuine range collapse to a point on a small view count, claiming a
    // precision the input never had.
    expect(money.lowMinor).toBe(Math.floor((12_345_678 * 3_000) / RPM_VIEW_BASIS));
    expect(money.highMinor).toBe(Math.ceil((12_345_678 * 6_000) / RPM_VIEW_BASIS));
    expect(money.lowMinor).toBeLessThan(money.highMinor);
  });

  /**
   * A MEASUREMENT STAYS ONE FIGURE, and this is the same rule as the one above
   * rather than an exception to it.
   *
   * Rounding outward is there to stop a genuine range collapsing into a point.
   * Applied to a point it does the opposite: floor and ceil of the identical
   * product differ by one minor unit whenever `views × rpm` is not an exact
   * multiple of 1,000,000, so a measured $0.056 would print as a one-cent
   * range on almost every view count. The card's whole at-a-glance signal is
   * that a measurement is one figure, so this is the arithmetic half of that.
   */
  it("keeps a measured point a point instead of manufacturing a one-cent spread", () => {
    const bounds = rpmBounds(resolve(NO_RANGE, [accepted(healthyChannel())]))!;
    expect(isRpmPoint(bounds)).toBe(true);

    // Every one of these is a view count where floor and ceil disagree.
    for (const views of [12_345_678, 40_000_001, 7_777_777, 1, 999_999]) {
      const money = projectRevenue(views, bounds);
      expect(money.lowMinor).toBe(money.highMinor);
      expect(money.lowMinor).toBe(
        Math.round((views * bounds.lowMinorPerMillion) / RPM_VIEW_BASIS),
      );
    }

    // The range case is untouched: it still rounds outward and still reads as
    // a range on the same view count.
    const range = rpmBounds(resolve(STORED_RANGE, []))!;
    expect(projectRevenue(12_345_678, range).lowMinor).toBeLessThan(
      projectRevenue(12_345_678, range).highMinor,
    );
  });

  it("produces integer minor units on both ends, never a float", () => {
    const bounds = rpmBounds(resolve(STORED_RANGE, []))!;
    for (const views of [1, 7, 999, 1_337, 250_001, 98_765_432]) {
      const money = projectRevenue(views, bounds);
      expect(Number.isInteger(money.lowMinor)).toBe(true);
      expect(Number.isInteger(money.highMinor)).toBe(true);
    }
  });

  it("prices the gap from the view difference rather than by subtracting totals", () => {
    const bounds = rpmBounds(resolve(STORED_RANGE, []))!;
    const value = calculateNicheValue({
      ourViews: 2_000_000,
      competitorViews: 8_000_000,
      bounds,
    });

    // Interval subtraction of the two projected totals would give
    // [lowTotal − highOurs, highTotal − lowOurs], which is far wider than
    // anybody means and can go negative even though both halves used the same
    // rate. The rate cancels, so it is applied after the subtraction.
    expect(value.gapRevenue).toEqual(projectRevenue(8_000_000, bounds));
    const naiveLow = value.trackedRevenue!.lowMinor - value.ourRevenue!.highMinor;
    expect(value.gapRevenue!.lowMinor).toBeGreaterThan(naiveLow);
  });

  it("reports a share of nothing as undefined rather than as zero", () => {
    const bounds = rpmBounds(resolve(STORED_RANGE, []))!;
    const value = calculateNicheValue({ ourViews: 0, competitorViews: 0, bounds });
    expect(value.capturePercent).toBeNull();
    // A tracked niche with no views really is worth nothing, and that is a
    // measurement rather than a guess — zero views priced at any rate is zero.
    expect(value.trackedRevenue).toEqual({ lowMinor: 0, highMinor: 0, currency: "USD" });
  });
});

describe("reading and writing a rate as text", () => {
  /**
   * The reason the money parser is not reused.
   *
   * `parseMoneyToMinor` rounds at the currency's own precision, so it reads
   * "0.045" as 5 cents — an 11% error in the rate, multiplied afterwards by a
   * whole niche's view count.
   */
  it("keeps three digits past the currency's own precision", () => {
    expect(parseRpmToMinorPerMillion("0.045", "USD")).toBe(4_500);
    expect(parseRpmToMinorPerMillion("1", "USD")).toBe(100_000);
    expect(parseRpmToMinorPerMillion("$0.03", "USD")).toBe(3_000);
    expect(parseRpmToMinorPerMillion("0,06", "USD")).toBe(6_000);
  });

  it("round-trips through the form field", () => {
    for (const stored of [4_500, 100_000, 3_000, 1]) {
      const text = rpmToInputText(stored, "USD");
      expect(parseRpmToMinorPerMillion(text, "USD")).toBe(stored);
    }
  });

  it("refuses what it cannot read rather than guessing at it", () => {
    expect(parseRpmToMinorPerMillion("", "USD")).toBeNull();
    expect(parseRpmToMinorPerMillion("abc", "USD")).toBeNull();
    expect(parseRpmToMinorPerMillion("1.2.3", "USD")).toBeNull();
    expect(parseRpmToMinorPerMillion("-1", "USD")).toBeNull();
  });

  it("bounds the rate per currency rather than at the money ceiling", () => {
    // $100 per 1,000 views, expressed at USD's five digits. The technical
    // ceiling is `MAX_MONEY_MINOR`, which would let a typo through as a rate
    // four orders of magnitude too large and still looking like a number.
    expect(maxRpmMinorPerMillion("USD")).toBe(MAX_RPM_MAJOR_PER_THOUSAND * 100_000);
    // JPY has no minor units, so its rate carries three digits, not five.
    expect(maxRpmMinorPerMillion("JPY")).toBe(MAX_RPM_MAJOR_PER_THOUSAND * 1_000);
  });
});
