import { describe, expect, it } from "vitest";
import {
  MAX_MONEY_MINOR,
  convertMinor,
  convertMinorBetween,
  formatMoney,
  isSupportedCurrency,
  minorUnitsFor,
  normalizeCurrencyCode,
  parseMoneyToMinor,
  profitMargin,
} from "@/lib/finance/money";

/**
 * Money handling.
 *
 * Financial arithmetic fails quietly: a total that is wrong by a cent, or by a
 * factor of a hundred, still renders as a plausible number. These tests pin the
 * three things that would actually corrupt a report — the parse, the scale, and
 * the undefined-margin case.
 */

describe("parsing amounts to minor units", () => {
  it("reads a plain decimal", () => {
    expect(parseMoneyToMinor("1234.56", "USD")).toBe(123456);
    expect(parseMoneyToMinor("0.01", "USD")).toBe(1);
    expect(parseMoneyToMinor("12.30", "USD")).toBe(1230);
  });

  it("treats a bare integer as major units", () => {
    // Someone typing "1234" into an amount field means $1,234.00, not $12.34.
    // Getting this backwards is the classic hundred-fold error.
    expect(parseMoneyToMinor("1234", "USD")).toBe(123400);
    expect(parseMoneyToMinor("5", "USD")).toBe(500);
  });

  it("accepts both thousands conventions", () => {
    expect(parseMoneyToMinor("1,234.56", "USD")).toBe(123456);
    // European: dot groups thousands, comma is the decimal separator.
    expect(parseMoneyToMinor("1.234,56", "EUR")).toBe(123456);
  });

  it("tolerates surrounding noise", () => {
    expect(parseMoneyToMinor("  12.30  ", "USD")).toBe(1230);
    expect(parseMoneyToMinor("$5.00", "USD")).toBe(500);
  });

  it("returns null rather than guessing", () => {
    // Null is the signal the form uses to refuse the input. A parser that
    // guesses here writes a wrong number into the ledger and looks confident.
    for (const input of ["abc", "", "   ", "1.2.3,4", "1e3"]) {
      expect(parseMoneyToMinor(input, "USD")).toBeNull();
    }
  });

  it("refuses an amount too large to store", () => {
    expect(parseMoneyToMinor("99999999999999999999", "USD")).toBeNull();
  });

  it("respects a currency's own number of minor digits", () => {
    // Hardcoding 100 would be wrong for a zero-decimal currency, so the scale
    // comes from the currency definition.
    expect(minorUnitsFor("USD")).toBe(2);
    if (isSupportedCurrency("JPY")) {
      expect(minorUnitsFor("JPY")).toBe(0);
      expect(parseMoneyToMinor("1234", "JPY")).toBe(1234);
    }
  });
});

describe("currency codes", () => {
  it("normalises case and whitespace", () => {
    expect(normalizeCurrencyCode(" usd ")).toBe("USD");
    expect(normalizeCurrencyCode("Try")).toBe("TRY");
  });

  it("recognises the configured currencies", () => {
    for (const code of ["USD", "EUR", "TRY"]) {
      expect(isSupportedCurrency(code)).toBe(true);
    }
    expect(isSupportedCurrency("XYZ")).toBe(false);
  });
});

describe("conversion", () => {
  it("returns whole minor units", () => {
    // A fractional cent cannot be stored and must not be carried around as a
    // float that later rounds differently in two places.
    const converted = convertMinor(10_000, 0.917);
    expect(Number.isInteger(converted)).toBe(true);
    expect(converted).toBe(9170);
  });

  it("is exact at a rate of 1", () => {
    expect(convertMinor(123456, 1)).toBe(123456);
  });

  it("carries the scale between currencies with different minor digits", () => {
    if (!isSupportedCurrency("JPY")) return;
    // $10.00 at 150 JPY/USD is ¥1,500 — 1500 minor units, not 150000. Getting
    // this wrong is a hundred-fold error that looks like a plausible total.
    expect(convertMinorBetween(1000, 150, "USD", "JPY")).toBe(1500);
  });
});

describe("profit margin", () => {
  it("computes margin as a percentage of revenue", () => {
    expect(profitMargin(100_000, 25_000)).toBeCloseTo(75, 5);
    expect(profitMargin(1000, 500)).toBeCloseTo(50, 5);
  });

  it("is null when there is no revenue, never zero", () => {
    // The same rule the analytics engine applies to a hit rate with no Shorts:
    // a ratio with a zero denominator is undefined, and rendering it as 0%
    // states something false. The UI shows an em dash for null.
    expect(profitMargin(0, 400_000)).toBeNull();
    expect(profitMargin(0, 0)).toBeNull();
  });

  it("goes negative when expenses exceed revenue", () => {
    // A loss must read as a loss rather than clamping at zero.
    const margin = profitMargin(50_000, 75_000);
    expect(margin).not.toBeNull();
    expect(margin as number).toBeLessThan(0);
  });
});

describe("formatting", () => {
  it("renders minor units as an amount", () => {
    const formatted = formatMoney(123456, "USD");
    expect(formatted).toContain("1,234");
    expect(formatted).toMatch(/\$|USD/);
  });

  it("renders zero and negative amounts", () => {
    expect(formatMoney(0, "USD")).toMatch(/0/);
    expect(formatMoney(-500, "USD")).toMatch(/-|\(/);
  });

  it("round-trips a parsed amount", () => {
    // The property that matters day to day: what someone types is what the
    // ledger shows back to them, and typing that back in gives the same figure.
    // The formatted string keeps its currency symbol and grouping separators —
    // parseMoneyToMinor is expected to cope with both, which is the point.
    for (const input of ["1234.56", "0.01", "999.99", "1,000.00"]) {
      const minor = parseMoneyToMinor(input, "USD");
      expect(minor).not.toBeNull();
      expect(minor as number).toBeLessThanOrEqual(MAX_MONEY_MINOR);
      expect(parseMoneyToMinor(formatMoney(minor as number, "USD"), "USD")).toBe(minor);
    }
  });
});
