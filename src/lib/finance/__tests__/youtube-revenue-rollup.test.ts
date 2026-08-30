import { describe, expect, it } from "vitest";
import {
  buildMonthRows,
  isMonthClipped,
  monthWindow,
  summariseRevenueTotals,
  type RevenueDayInput,
} from "@/lib/finance/youtube-revenue-rollup";

/**
 * =========================================================================
 * THE TWO WAYS A REVENUE TABLE LIES WITHOUT ANYTHING LOOKING WRONG
 * =========================================================================
 *
 * FIRST: a month the selected window only clips, rendered as the whole month.
 * The daily rows are filtered to the period and then grouped by calendar month,
 * so on the default 30-day window "July" is whatever fortnight of July the
 * window happens to touch — presented under a full-month heading, with a
 * footnote that blamed YouTube for not having finished computing the missing
 * days. For a month that ended weeks ago that explanation is not incomplete, it
 * is false. The figure is right; the label is wrong, which is the harder kind of
 * wrong to notice.
 *
 * SECOND: "total / this month / previous month" are calendar quantities, and the
 * only period control this app has is a trailing window. A "this month" derived
 * from the selector would change when somebody switched from 30 days to 90 —
 * same label, different quantity. These are computed over every stored day and
 * are deliberately independent of it.
 *
 * Pure arithmetic, no database: these are the calculations somebody acts on.
 */

const JULY = Date.UTC(2026, 6, 1);
const AUGUST = Date.UTC(2026, 7, 1);
const SEPTEMBER = Date.UTC(2026, 8, 1);
const DAY = 86_400_000;

function day(overrides: Partial<RevenueDayInput> = {}): RevenueDayInput {
  return {
    channelId: "chan_1",
    channelName: "Northstar Shorts",
    dayMs: JULY,
    amountMinor: 1_000,
    currency: "USD",
    revisionCount: 0,
    ...overrides,
  };
}

describe("a month the period only partly covers is marked as part of a month", () => {
  it("marks the month the window starts inside", () => {
    // The default shape: a trailing 30-day window opening mid-July.
    const range = { startMs: JULY + 15 * DAY, endMs: AUGUST + 14 * DAY };

    expect(isMonthClipped("2026-07", range)).toBe(true);
  });

  it("marks the current month, which every trailing window cuts short", () => {
    const range = { startMs: JULY + 15 * DAY, endMs: AUGUST + 14 * DAY };

    expect(isMonthClipped("2026-08", range)).toBe(true);
  });

  it("does NOT mark a month the window contains whole", () => {
    const range = { startMs: JULY, endMs: SEPTEMBER };

    expect(isMonthClipped("2026-07", range)).toBe(false);
    expect(isMonthClipped("2026-08", range)).toBe(false);
  });

  it("carries the mark onto the row, which is where the table reads it", () => {
    const range = { startMs: JULY + 15 * DAY, endMs: AUGUST + 14 * DAY };
    const rows = buildMonthRows(
      [
        day({ dayMs: JULY + 20 * DAY, amountMinor: 500 }),
        day({ dayMs: AUGUST + 2 * DAY, amountMinor: 700 }),
      ],
      range,
    );

    // Newest month first, per the sort.
    expect(rows.map((row) => row.month)).toEqual(["2026-08", "2026-07"]);
    expect(rows.every((row) => row.clippedByPeriod)).toBe(true);
  });

  it("December rolls into the next January rather than becoming month 13", () => {
    expect(monthWindow("2026-12")).toEqual({
      startMs: Date.UTC(2026, 11, 1),
      endMs: Date.UTC(2027, 0, 1),
    });
  });
});

describe("grouping is exact, and never mixes currencies", () => {
  it("sums integer minor units per channel, month and currency", () => {
    const range = { startMs: JULY, endMs: AUGUST };
    const rows = buildMonthRows(
      [
        day({ dayMs: JULY, amountMinor: 1_005 }),
        day({ dayMs: JULY + DAY, amountMinor: 2_003, revisionCount: 2 }),
        day({ dayMs: JULY + 2 * DAY, amountMinor: 4_00, currency: "EUR" }),
      ],
      range,
    );

    const usd = rows.find((row) => row.currency === "USD");
    const eur = rows.find((row) => row.currency === "EUR");

    expect(usd?.amountMinor).toBe(3_008);
    expect(usd?.dayCount).toBe(2);
    // Days YouTube has revised, not the number of revisions.
    expect(usd?.revisedDayCount).toBe(1);
    // Two rows rather than one invented sum of unlike things.
    expect(eur?.amountMinor).toBe(400);
  });
});

describe("total, this month and previous month", () => {
  // Mid-August, so "this month" is partly elapsed and "previous month" is July.
  const now = AUGUST + 9 * DAY;

  const days = [
    day({ dayMs: Date.UTC(2025, 10, 3), amountMinor: 9_999 }),
    day({ dayMs: JULY + DAY, amountMinor: 2_500 }),
    day({ dayMs: JULY + 2 * DAY, amountMinor: 1_500 }),
    day({ dayMs: AUGUST, amountMinor: 700 }),
    day({ dayMs: AUGUST + DAY, amountMinor: 300 }),
  ];

  it("names the months it is reporting rather than leaving the reader to assume", () => {
    const headline = summariseRevenueTotals(days, now);

    expect(headline.thisMonthKey).toBe("2026-08");
    expect(headline.previousMonthKey).toBe("2026-07");
  });

  it("totals every stored day, including months outside any sensible window", () => {
    const headline = summariseRevenueTotals(days, now);

    expect(headline.total).toEqual([{ currency: "USD", amountMinor: 14_999 }]);
    expect(headline.thisMonth).toEqual([{ currency: "USD", amountMinor: 1_000 }]);
    expect(headline.previousMonth).toEqual([{ currency: "USD", amountMinor: 4_000 }]);
  });

  it("crosses the year boundary backwards without inventing month zero", () => {
    const january = Date.UTC(2026, 0, 14);
    const headline = summariseRevenueTotals(
      [day({ dayMs: Date.UTC(2025, 11, 20), amountMinor: 600 })],
      january,
    );

    expect(headline.thisMonthKey).toBe("2026-01");
    expect(headline.previousMonthKey).toBe("2025-12");
    expect(headline.previousMonth).toEqual([{ currency: "USD", amountMinor: 600 }]);
  });

  /**
   * The distinction the whole revenue subsystem is built on. A month with no
   * stored day is not a month that earned nothing — it is a month nobody has a
   * figure for, and the screen renders an em dash rather than a zero. An empty
   * list is what carries that: a `0` here would be indistinguishable from a
   * genuine zero and would be rendered as money.
   */
  it("reports a month with nothing stored as absent, not as zero", () => {
    const headline = summariseRevenueTotals([day({ dayMs: JULY, amountMinor: 100 })], now);

    expect(headline.thisMonth).toEqual([]);
    expect(headline.previousMonth).toEqual([{ currency: "USD", amountMinor: 100 }]);
  });

  it("keeps currencies apart, largest first", () => {
    const headline = summariseRevenueTotals(
      [
        day({ dayMs: AUGUST, amountMinor: 100, currency: "TRY" }),
        day({ dayMs: AUGUST + DAY, amountMinor: 900, currency: "USD" }),
      ],
      now,
    );

    expect(headline.thisMonth).toEqual([
      { currency: "USD", amountMinor: 900 },
      { currency: "TRY", amountMinor: 100 },
    ]);
  });
});
