/**
 * =========================================================================
 * MONEY — REPRESENTATION, PARSING AND FORMATTING
 * =========================================================================
 *
 * Amounts are INTEGER MINOR UNITS everywhere: cents, kuruş, pence. Never a
 * float. `0.1 + 0.2 !== 0.3` in binary floating point, and a monthly total that
 * is a cent off is not a rounding curiosity — it is a bug report from whoever
 * reconciles the bank statement. Integers make addition exact, so every sum in
 * the finance engine is exact by construction rather than by luck.
 *
 * The one place a float is allowed is *display*: `minor / 10 ** minorUnits`
 * happens at the last moment, feeds `Intl.NumberFormat`, and its result is
 * never stored or re-summed.
 *
 * ISOMORPHIC ON PURPOSE
 * No `server-only`, no Prisma, no I/O. The entry form parses what the user
 * types with the same `parseMoneyToMinor` the API validates with, so the number
 * the field shows and the number the server stores cannot disagree — which is
 * the entire class of bug that "the UI said $1,234 and the row says $1.23"
 * belongs to.
 *
 * Everything here is pure and total: no throws, no ambient state, `null` for
 * "that is not a number I can read".
 */

import { EM_DASH, formatCompactNumber } from "@/lib/format";
import { roundTo } from "@/lib/analytics/stats";

export interface CurrencyDefinition {
  /** ISO 4217, uppercase. */
  readonly code: string;
  readonly symbol: string;
  readonly name: string;
  /**
   * Digits after the decimal point. Stored per currency rather than assumed to
   * be 2: JPY, KRW and ISK have none at all, so a hardcoded `100` would render
   * ¥1,200 as ¥12.00 and — far worse — parse an entered ¥1,200 as 120,000
   * minor units. TRY, USD, EUR and GBP happening to agree on 2 is a fact about
   * those four currencies, not a fact about money.
   */
  readonly minorUnits: number;
}

/**
 * The currencies the entry form offers.
 *
 * JPY is included even though Northstar is unlikely to invoice in yen: it is
 * the zero-decimal case, and keeping a real one in the list means the
 * `minorUnits` code path is exercised rather than being dead defensive code
 * that quietly rots.
 */
export const CURRENCIES: readonly CurrencyDefinition[] = [
  { code: "USD", symbol: "$", name: "US Dollar", minorUnits: 2 },
  { code: "EUR", symbol: "€", name: "Euro", minorUnits: 2 },
  { code: "TRY", symbol: "₺", name: "Turkish Lira", minorUnits: 2 },
  { code: "GBP", symbol: "£", name: "British Pound", minorUnits: 2 },
  { code: "JPY", symbol: "¥", name: "Japanese Yen", minorUnits: 0 },
];

export const CURRENCY_CODES: readonly string[] = CURRENCIES.map((c) => c.code);

const CURRENCY_BY_CODE: ReadonlyMap<string, CurrencyDefinition> = new Map(
  CURRENCIES.map((currency) => [currency.code, currency]),
);

/** What an unknown-but-well-formed ISO code is assumed to use. */
const DEFAULT_MINOR_UNITS = 2;

/**
 * The largest amount that fits the database columns.
 *
 * `FinanceEntry.amountMinor` and `baseAmountMinor` are Prisma `Int`, i.e.
 * signed 32-bit, on both SQLite and PostgreSQL. That is ~$21.47m per entry.
 * The ceiling is exported so the browser can refuse an over-large figure while
 * the user is still typing, and so the server rejects it with a sentence
 * instead of letting the driver throw or — on SQLite — silently store
 * something else.
 */
export const MAX_MONEY_MINOR = 2_147_483_647;

export function normalizeCurrencyCode(code: string): string {
  return typeof code === "string" ? code.trim().toUpperCase() : "";
}

export function findCurrency(code: string): CurrencyDefinition | null {
  return CURRENCY_BY_CODE.get(normalizeCurrencyCode(code)) ?? null;
}

/** True only for a currency this app is configured to handle. */
export function isSupportedCurrency(code: string): boolean {
  return CURRENCY_BY_CODE.has(normalizeCurrencyCode(code));
}

/**
 * Minor digits for a code, defaulting to 2 for anything unrecognised.
 *
 * Defaulting rather than returning null keeps every caller total. An
 * unrecognised code can only reach here from historical data — the write path
 * validates against `CURRENCIES` — and rendering an old row with two decimals
 * is a better failure than rendering nothing.
 */
export function minorUnitsFor(code: string): number {
  return findCurrency(code)?.minorUnits ?? DEFAULT_MINOR_UNITS;
}

export function symbolFor(code: string): string {
  return findCurrency(code)?.symbol ?? normalizeCurrencyCode(code);
}

// ---------------------------------------------------------------------------
// PARSING
// ---------------------------------------------------------------------------

/** Longer than any legitimate amount; a guard against pathological input. */
const MAX_INPUT_LENGTH = 32;

/** "1,234,567" style grouping — the only shape a thousands separator may take. */
function hasValidGrouping(value: string, separator: "," | "."): boolean {
  const pattern = separator === "," ? /^\d{1,3}(?:,\d{3})*$/ : /^\d{1,3}(?:\.\d{3})*$/;
  return pattern.test(value);
}

/** Removes a leading/trailing symbol or ISO code the user pasted along with the number. */
function stripCurrencyMarkers(text: string, currency: string): string {
  const code = normalizeCurrencyCode(currency);
  const symbol = findCurrency(code)?.symbol;

  let result = text;
  for (const marker of [symbol, code]) {
    if (!marker) continue;
    const upper = result.toUpperCase();
    if (upper.startsWith(marker.toUpperCase())) result = result.slice(marker.length);
    else if (upper.endsWith(marker.toUpperCase())) result = result.slice(0, -marker.length);
  }
  return result;
}

/**
 * Text a human typed -> integer minor units, or `null` if it cannot be read.
 *
 * Accepts the three shapes people actually enter: "1,234.56" (English),
 * "1.234,56" and "1234,56" (European comma decimal), and plain "1234".
 * Also tolerates spaces and apostrophes as thousands separators, the currency
 * symbol or code, a leading sign, and the accounting convention where
 * parentheses mean negative.
 *
 * TELLING A THOUSANDS SEPARATOR FROM A DECIMAL POINT
 * With both separators present it is unambiguous: the *rightmost* one is the
 * decimal point and the other groups thousands. With only one, the tie-breaker
 * is the length of the tail. Exactly three trailing digits — "1,234", "1.234" —
 * is read as a thousands group, because a currency with two minor digits has no
 * three-decimal amount to express; anything else is a decimal fraction. That
 * rule is disabled for a hypothetical three-decimal currency, where "1.234"
 * genuinely is a fractional amount. A leading zero ("0.500") also rules
 * grouping out, since nobody writes a thousands group starting from zero.
 *
 * Excess precision is rounded half-away-from-zero rather than rejected:
 * "1.005" in a 2-decimal currency is 101 minor units. The rounding is done on
 * digit strings, so it is not subject to the float representation error that
 * makes `Math.round(1.005 * 100)` return 100.
 */
export function parseMoneyToMinor(input: string, currency: string): number | null {
  if (typeof input !== "string") return null;
  const minorUnits = minorUnitsFor(currency);

  // Strip presentation, not value. The whitespace class already covers U+00A0
  // and U+202F — the non-breaking and narrow spaces `Intl` itself emits as
  // group separators — which matters because the commonest "unparseable" input
  // is a figure the user copied straight back out of one of our own tables.
  // The apostrophe is the Swiss thousands separator.
  let text = input.replace(/\s/g, "").replace(/['’]/g, "");
  if (!text || text.length > MAX_INPUT_LENGTH) return null;

  let sign = 1;

  // Accounting negatives: "(1,234.56)" is -1234.56. Checked before the symbol
  // strip so "($5.00)" works too.
  const parenthesised = /^\((.*)\)$/.exec(text);
  if (parenthesised) {
    sign = -1;
    text = parenthesised[1];
  }

  text = stripCurrencyMarkers(text, currency);

  if (text.startsWith("-") || text.startsWith("−")) {
    sign = -sign;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }

  // A second pass: "$ -5.00" leaves the sign inside the symbol.
  text = stripCurrencyMarkers(text, currency);

  if (!text || !/^[0-9.,]+$/.test(text)) return null;

  let integerPart: string;
  let fractionPart: string;

  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");

  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: the rightmost is the decimal point, no guessing needed.
    const decimalIndex = Math.max(lastComma, lastDot);
    const decimalSeparator = text[decimalIndex] as "," | ".";
    const groupSeparator: "," | "." = decimalSeparator === "," ? "." : ",";

    const head = text.slice(0, decimalIndex);
    fractionPart = text.slice(decimalIndex + 1);

    // Two decimal points ("1.2.3,4") is not a number.
    if (head.includes(decimalSeparator)) return null;
    if (!hasValidGrouping(head, groupSeparator)) return null;
    integerPart = head.split(groupSeparator).join("");
  } else if (lastComma >= 0 || lastDot >= 0) {
    const separator: "," | "." = lastComma >= 0 ? "," : ".";
    const parts = text.split(separator);
    const tail = parts[parts.length - 1] ?? "";
    const head = parts.slice(0, -1).join(separator);

    const looksGrouped =
      parts.length > 2 ||
      (tail.length === 3 &&
        minorUnits !== 3 &&
        head.length > 0 &&
        !head.startsWith("0"));

    if (looksGrouped) {
      if (!hasValidGrouping(text, separator)) return null;
      integerPart = parts.join("");
      fractionPart = "";
    } else {
      integerPart = parts[0] ?? "";
      fractionPart = tail;
    }
  } else {
    integerPart = text;
    fractionPart = "";
  }

  if (integerPart === "" && fractionPart === "") return null;

  // Digit-string arithmetic, so no float ever sees the value.
  const whole = integerPart === "" ? "0" : integerPart;
  const kept = fractionPart.slice(0, minorUnits).padEnd(minorUnits, "0");
  const dropped = fractionPart.slice(minorUnits);

  let magnitude = Number(`${whole}${kept}`);
  if (!Number.isFinite(magnitude)) return null;
  if (dropped.length > 0 && Number(dropped[0]) >= 5) magnitude += 1;
  if (!Number.isSafeInteger(magnitude)) return null;

  // `sign * 0` would be -0 for a parenthesised zero, which serialises as 0 but
  // compares oddly. Normalise it away.
  return magnitude === 0 ? 0 : sign * magnitude;
}

// ---------------------------------------------------------------------------
// FORMATTING
// ---------------------------------------------------------------------------

export interface FormatMoneyOptions {
  /** Defaults to the runtime locale, so the server and browser agree by default. */
  readonly locale?: string;
  /** Drop the fractional part entirely: "$1,235" rather than "$1,234.56". */
  readonly hideMinorUnits?: boolean;
  /** `"always"` is what a net-profit or delta column wants. */
  readonly signDisplay?: "auto" | "always" | "never" | "exceptZero";
  /** Append the ISO code — worth it wherever several currencies are listed together. */
  readonly withCode?: boolean;
}

/**
 * Minor units -> a string a person can read.
 *
 * The fraction digits come from our own `CURRENCIES` table rather than from
 * `Intl`'s, so the number of decimals shown always matches the number of
 * decimals stored. If the two ever disagreed, a total would look like it had
 * been rounded when it had not.
 */
export function formatMoney(
  minor: number,
  currency: string,
  options: FormatMoneyOptions = {},
): string {
  if (!Number.isFinite(minor)) return EM_DASH;

  const code = normalizeCurrencyCode(currency);
  const minorUnits = minorUnitsFor(code);
  const fractionDigits = options.hideMinorUnits ? 0 : minorUnits;

  const suppressSign = options.signDisplay === "never";
  // Display-only float: divided once, formatted, never summed.
  const value = (suppressSign ? Math.abs(minor) : minor) / 10 ** minorUnits;

  const formatted = formatWithIntl(value, code, fractionDigits, options, suppressSign);
  return options.withCode && code ? `${formatted} ${code}` : formatted;
}

function formatWithIntl(
  value: number,
  code: string,
  fractionDigits: number,
  options: FormatMoneyOptions,
  suppressSign: boolean,
): string {
  // `style: "currency"` throws a RangeError on anything that is not a
  // well-formed ISO code, and a historical row could carry one. Falling back
  // beats failing a whole dashboard render over a bad three letters.
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat(options.locale, {
        style: "currency",
        currency: code,
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
        ...(suppressSign || !options.signDisplay ? {} : { signDisplay: options.signDisplay }),
      }).format(value);
    } catch {
      /* fall through to the manual path */
    }
  }

  const digits = new Intl.NumberFormat(options.locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(Math.abs(value));

  const explicitPlus = options.signDisplay === "always" || options.signDisplay === "exceptZero";
  const sign = value < 0 ? "-" : explicitPlus && value > 0 ? "+" : "";
  return `${sign}${symbolFor(code)}${digits}`;
}

/**
 * A chart-label-sized amount: "$120K", "-€1.2M".
 *
 * Axis ticks and bar labels are read as a scale rather than as exact figures,
 * and the precise value is always one hover away in the tooltip — so this
 * deliberately throws away the minor units instead of squeezing "$120,450.00"
 * into 40 pixels.
 */
export function formatMoneyCompact(minor: number, currency: string): string {
  if (!Number.isFinite(minor)) return EM_DASH;

  const code = normalizeCurrencyCode(currency);
  const units = minor / 10 ** minorUnitsFor(code);
  // The sign is applied outside the symbol ("-$5K", not "$-5K"), which means
  // the magnitude is what gets compacted.
  const sign = units < 0 ? "-" : "";
  return `${sign}${symbolFor(code)}${formatCompactNumber(Math.abs(units))}`;
}

// ---------------------------------------------------------------------------
// ARITHMETIC
// ---------------------------------------------------------------------------

/**
 * Applies an exchange rate to a minor amount, rounding half away from zero.
 *
 * Half-away-from-zero rather than JavaScript's default half-up so that a
 * revenue line and a refund of the same size round to the same magnitude.
 * `Math.round` alone is asymmetric: it sends 2.5 to 3 but -2.5 to -2, which
 * would make a converted total depend on the order of its signs.
 *
 * ASSUMES BOTH CURRENCIES HAVE THE SAME MINOR-UNIT SCALE. That holds for the
 * pairs this app actually converts between, but not for USD -> JPY. Use
 * `convertMinorBetween` when both codes are known; it is the one that adjusts
 * for the scale difference.
 *
 * Total by construction: non-finite input yields 0. The service validates
 * rates long before this point, so that branch is a floor, not a data path.
 */
export function convertMinor(minor: number, rate: number): number {
  if (!Number.isFinite(minor) || !Number.isFinite(rate)) return 0;
  const product = minor * rate;
  if (!Number.isFinite(product)) return 0;
  const magnitude = Math.round(Math.abs(product));
  return product < 0 ? -magnitude : magnitude;
}

/**
 * Converts between two currencies that may not share a minor-unit scale.
 *
 * `rate` converts one *major* unit of `from` into one *major* unit of `to`, so
 * a minor-to-minor conversion has to carry the 10^(toDigits - fromDigits)
 * factor. Without it, converting $10.00 to yen at 150 would produce ¥150,000
 * — a hundredfold error that looks entirely plausible in a table of yen.
 */
export function convertMinorBetween(
  minor: number,
  rate: number,
  fromCurrency: string,
  toCurrency: string,
): number {
  const scale = 10 ** (minorUnitsFor(toCurrency) - minorUnitsFor(fromCurrency));
  return convertMinor(minor, rate * scale);
}

/**
 * Net profit as a percentage of revenue, or `null` when there is no revenue.
 *
 * The `null` matters for the same reason `calculateHitRate` returns one for a
 * channel with no Shorts: a margin with a zero denominator is undefined, not
 * 0%. Reporting 0% for a month with $4,000 of expenses and no income asserts
 * "we broke even", when the truth is "we spent $4,000 and earned nothing" —
 * and the UI renders `null` as an em dash precisely so nobody reads the second
 * as the first.
 */
export function profitMargin(revenueMinor: number, expenseMinor: number): number | null {
  if (!Number.isFinite(revenueMinor) || !Number.isFinite(expenseMinor)) return null;
  if (revenueMinor === 0) return null;
  return roundTo(((revenueMinor - expenseMinor) / revenueMinor) * 100, 2);
}
