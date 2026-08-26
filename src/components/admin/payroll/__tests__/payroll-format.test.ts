import { describe, expect, it } from "vitest";

import {
  payDateFor,
  periodForMonth,
  periodLabel,
} from "@/lib/payroll/payroll-engine";
import {
  formatRunTotal,
  formatRunTotalWithRecords,
  formatUtcDay,
  isStoredRecord,
  periodSentence,
  periodState,
  periodWindowSentence,
  subtotalsByCurrency,
} from "../payroll-format";
import type {
  PayrollPeriodHeaderDTO,
  PayrollRecordDTO,
  PayrollTotalsDTO,
} from "@/server/services/payroll-service";

/**
 * The payroll screens' display helpers.
 *
 * Worth testing rather than eyeballing, because both things this file does are
 * silent when they go wrong: a date rendered off by one day still looks like a
 * date, and a total summed across currencies still looks like money. Neither
 * would produce an error, and both would be believed.
 *
 * The period headers are built with the engine's own `periodForMonth`,
 * `payDateFor` and `periodLabel` rather than with hand-written timestamps, so
 * these assertions are pinned to the same window convention the calculation
 * uses. A change to what a period means would break this file too, which is
 * the intended behaviour.
 */

function header(
  year: number,
  month: number,
  overrides: Partial<PayrollPeriodHeaderDTO> = {},
): PayrollPeriodHeaderDTO {
  const window = periodForMonth(year, month);
  return {
    year,
    month,
    label: periodLabel(window),
    startsAt: window.startsAtMs,
    endsAt: window.endsAtMs,
    payOn: payDateFor(window),
    status: "finalized",
    isDraft: false,
    hasEnded: true,
    finalizedAt: null,
    finalizedByName: null,
    ...overrides,
  };
}

function record(
  overrides: Partial<PayrollRecordDTO> & { userId: string },
): PayrollRecordDTO {
  return {
    id: "rec_1",
    employeeName: "Someone",
    employeeEmail: "someone@example.com",
    role: "short_form_editor",
    roleLabel: "Short-form editor",
    baseSalaryMinor: 0,
    hitPaymentMinor: 0,
    hitCount: 0,
    hitBonusMinor: 0,
    adjustmentMinor: 0,
    adjustmentReason: null,
    totalMinor: 0,
    currency: "USD",
    paymentStatus: "pending",
    paidAt: null,
    byNiche: [],
    hits: [],
    ...overrides,
  };
}

function totals(overrides: Partial<PayrollTotalsDTO> = {}): PayrollTotalsDTO {
  return {
    employeeCount: 0,
    hitCount: 0,
    baseSalaryMinor: 0,
    hitBonusMinor: 0,
    adjustmentMinor: 0,
    totalMinor: 0,
    paidMinor: 0,
    pendingMinor: 0,
    currency: "USD",
    currencyMixed: false,
    ...overrides,
  };
}

describe("formatUtcDay", () => {
  it("reads the day out of the UTC calendar, not the local one", () => {
    // The exact case the helper exists for: `payOn` is UTC midnight on the 1st,
    // and a local-time getter would call this 31 August anywhere west of
    // Greenwich.
    expect(formatUtcDay(Date.UTC(2026, 8, 1))).toBe("1 September");
    expect(formatUtcDay(Date.UTC(2026, 8, 1), { withYear: true })).toBe(
      "1 September 2026",
    );
  });

  it("does not fall over on a value that is not a date", () => {
    expect(formatUtcDay(Number.NaN)).toBe("—");
  });
});

describe("periodSentence", () => {
  it("states the month and the day it is paid", () => {
    expect(periodSentence(header(2026, 8))).toBe("August 2026 · paid 1 September");
  });

  it("keeps the year on the pay date when payday falls in the next one", () => {
    // December is paid on 1 January. Without the year this reads as a payment
    // eleven months in the past.
    expect(periodSentence(header(2026, 12))).toBe(
      "December 2026 · paid 1 January 2027",
    );
  });
});

describe("periodWindowSentence", () => {
  it("closes the half-open window on the last day it actually covers", () => {
    // `endsAt` is the first instant of September; the period's last day is the
    // millisecond before it, not the day `endsAt` names.
    expect(periodWindowSentence(header(2026, 8))).toBe("1 – 31 August 2026");
  });

  it("handles a February and a year boundary", () => {
    expect(periodWindowSentence(header(2026, 2))).toBe("1 – 28 February 2026");
    expect(periodWindowSentence(header(2026, 12))).toBe("1 – 31 December 2026");
  });
});

describe("periodState", () => {
  it("calls a draft a draft whatever the stored status says", () => {
    // `isDraft` is the field that answers "is this number still moving?", and
    // it is the one the service sets from the same branch that decides whether
    // to recalculate. It has to win.
    const state = periodState(header(2026, 8, { isDraft: true, status: "open" }));
    expect(state.tone).toBe("draft");
    expect(state.meaning).toContain("keep moving");
  });

  it("distinguishes finalized from paid", () => {
    expect(periodState(header(2026, 8, { status: "finalized" })).tone).toBe(
      "finalized",
    );
    expect(periodState(header(2026, 8, { status: "paid" })).tone).toBe("paid");
  });
});

describe("currency handling", () => {
  it("formats a single-currency run normally", () => {
    expect(formatRunTotal(totals({ totalMinor: 400_000, currency: "USD" }))).toBe(
      "$4,000.00",
    );
  });

  it("refuses to put one symbol on a sum across currencies", () => {
    // The service sums minor units and flags the mix rather than converting,
    // because payroll has no rate table. Cents added to euro cents is not an
    // amount of money, so there is no figure to stamp a symbol on.
    expect(formatRunTotal(totals({ totalMinor: 700_000, currencyMixed: true }))).toBeNull();
  });

  it("splits a mixed run per currency, largest first", () => {
    const records = [
      record({ userId: "a", currency: "EUR", totalMinor: 100_000 }),
      record({ userId: "b", currency: "USD", totalMinor: 400_000 }),
      record({ userId: "c", currency: "USD", totalMinor: 200_000 }),
    ];

    expect(subtotalsByCurrency(records)).toEqual([
      { currency: "USD", totalMinor: 600_000, employeeCount: 2 },
      { currency: "EUR", totalMinor: 100_000, employeeCount: 1 },
    ]);

    expect(
      formatRunTotalWithRecords(totals({ currencyMixed: true }), records),
    ).toBe("$6,000.00 USD  +  €1,000.00 EUR");
  });
});

describe("isStoredRecord", () => {
  it("separates a stored row from a live calculation", () => {
    // A draft period's figures have no id — there is nothing to PATCH — and
    // this guard is what keeps the adjust and mark-paid controls off them.
    expect(isStoredRecord(record({ userId: "a", id: "rec_1" }))).toBe(true);
    expect(isStoredRecord(record({ userId: "a", id: null }))).toBe(false);
  });
});
