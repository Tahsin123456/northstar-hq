import { formatMoney } from "@/lib/finance/money";
import { EM_DASH } from "@/lib/format";
import type {
  PayrollPeriodHeaderDTO,
  PayrollRecordDTO,
  PayrollTotalsDTO,
} from "@/server/services/payroll-service";

/**
 * Display helpers shared by the payroll screens.
 *
 * Pure functions with no React in them, so the two pages and the four dialogs
 * that show a period cannot end up describing the same month in three
 * different ways.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE DATES ARE FORMATTED IN UTC, BY HAND
 * ─────────────────────────────────────────────────────────────────────────────
 * `startsAt`, `endsAt` and `payOn` are calendar dates stored as UTC midnight —
 * they are not instants, they are days. Passing one to `formatDate` renders it
 * in the viewer's local zone, and for anybody west of Greenwich UTC midnight on
 * 1 September is still 31 August. The screen would then tell an admin in New
 * York that August's payroll is paid on 31 August, which is both wrong and
 * exactly the kind of off-by-one nobody double-checks.
 *
 * The month names are hardcoded for the second half of the same reason, and it
 * is the reason `payroll-message.ts` gives for hardcoding its own: the date on
 * this screen and the date in the Telegram message are the same claim about the
 * same day, and neither should depend on the locale of whatever process
 * happened to render it.
 */

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** A stored calendar date -> "1 September" or "1 September 2026". */
export function formatUtcDay(ms: number, options: { withYear?: boolean } = {}): string {
  if (!Number.isFinite(ms)) return EM_DASH;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return EM_DASH;

  const day = date.getUTCDate();
  const month = MONTH_NAMES[date.getUTCMonth()] ?? "";
  return options.withYear ? `${day} ${month} ${date.getUTCFullYear()}` : `${day} ${month}`;
}

/**
 * The period, stated plainly: "August 2026 · paid 1 September".
 *
 * The year comes back onto the pay date only when it is not the period's own —
 * December is paid in January, and dropping the year there would read as a
 * payment four weeks in the past.
 */
export function periodSentence(period: PayrollPeriodHeaderDTO): string {
  const payYear = new Date(period.payOn).getUTCFullYear();
  return `${period.label} · paid ${formatUtcDay(period.payOn, {
    withYear: payYear !== period.year,
  })}`;
}

/**
 * The half-open window as a closed one a person can read: "1 – 31 August 2026".
 *
 * `endsAt` is exclusive — the first instant of the following month — so the
 * last day the period actually covers is the millisecond before it, never the
 * day `endsAt` itself names. Getting that wrong would advertise a window a day
 * wider than the one the Shorts were counted in.
 *
 * A payroll period is always one calendar month, so the month name is printed
 * once. It is still derived from both ends rather than assumed, because a
 * sentence that says "1 – 31 August" for a window that is not in August would
 * be a confident lie about which Shorts were counted.
 */
export function periodWindowSentence(period: PayrollPeriodHeaderDTO): string {
  const lastDayMs = period.endsAt - 1;
  const start = new Date(period.startsAt);
  const end = new Date(lastDayMs);

  const sameMonth =
    start.getUTCFullYear() === end.getUTCFullYear() &&
    start.getUTCMonth() === end.getUTCMonth();

  const from = sameMonth
    ? String(start.getUTCDate())
    : formatUtcDay(period.startsAt);

  return `${from} – ${formatUtcDay(lastDayMs, { withYear: true })}`;
}

// ---------------------------------------------------------------------------
// MONEY ACROSS CURRENCIES
// ---------------------------------------------------------------------------

export interface CurrencySubtotal {
  readonly currency: string;
  readonly totalMinor: number;
  readonly employeeCount: number;
}

/**
 * Per-currency subtotals, for a run that pays people in more than one.
 *
 * The service flags `currencyMixed` rather than converting, because payroll has
 * no rate table and inventing one would fabricate a figure. That leaves the UI
 * with a sum of minor units that is not an amount of money in any currency —
 * cents added to yen — so it must never be stamped with a symbol.
 *
 * Splitting the run into one honest figure per currency is the alternative to
 * showing nothing at all. Sorted by size so the dominant currency leads.
 */
export function subtotalsByCurrency(
  records: readonly PayrollRecordDTO[],
): readonly CurrencySubtotal[] {
  const byCurrency = new Map<string, { totalMinor: number; employeeCount: number }>();

  for (const record of records) {
    const existing = byCurrency.get(record.currency);
    if (existing) {
      existing.totalMinor += record.totalMinor;
      existing.employeeCount += 1;
    } else {
      byCurrency.set(record.currency, {
        totalMinor: record.totalMinor,
        employeeCount: 1,
      });
    }
  }

  return [...byCurrency.entries()]
    .map(([currency, sums]) => ({ currency, ...sums }))
    .sort((a, b) => b.totalMinor - a.totalMinor);
}

/**
 * A run's headline total.
 *
 * Returns `null` — not a number — when the run mixes currencies and the caller
 * has no records to split. `null` is rendered as an em dash next to a "mixed
 * currencies" note, which is the honest answer: there is no single total, and
 * a confident figure with one currency's symbol on it would be a fabrication.
 */
export function formatRunTotal(totals: PayrollTotalsDTO): string | null {
  if (totals.currencyMixed) return null;
  return formatMoney(totals.totalMinor, totals.currency);
}

/**
 * The same figure with the per-currency split filled in where the caller holds
 * the records to compute it: "$12,000 + €3,400".
 */
export function formatRunTotalWithRecords(
  totals: PayrollTotalsDTO,
  records: readonly PayrollRecordDTO[],
): string {
  if (!totals.currencyMixed) return formatMoney(totals.totalMinor, totals.currency);

  const parts = subtotalsByCurrency(records);
  if (parts.length === 0) return EM_DASH;

  return parts
    .map((part) => formatMoney(part.totalMinor, part.currency, { withCode: true }))
    .join("  +  ");
}

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------

export interface PeriodState {
  /** "Live draft" / "Finalized" / "Paid". */
  readonly label: string;
  /** One sentence saying what that state means for the figures on screen. */
  readonly meaning: string;
  readonly tone: "draft" | "finalized" | "paid";
}

/**
 * What state a period is in, in words.
 *
 * `isDraft` rather than `status` decides the first branch, because it is the
 * field that answers the question a reader actually has — "is this number still
 * moving?" — and the service sets it from the same place it decides whether to
 * recalculate or read from storage.
 */
export function periodState(period: PayrollPeriodHeaderDTO): PeriodState {
  if (period.isDraft) {
    return {
      label: "Live draft",
      tone: "draft",
      meaning:
        "Calculated just now from current view counts. These figures will keep moving until the period is finalized.",
    };
  }

  if (period.status === "paid") {
    return {
      label: "Paid",
      tone: "paid",
      meaning: "Finalized and recorded as paid out. These are stored figures, not a recalculation.",
    };
  }

  return {
    label: "Finalized",
    tone: "finalized",
    meaning:
      "Frozen as the record of what was owed. These are stored figures — nothing here is recalculated.",
  };
}

/**
 * A record that exists as a row, and can therefore be adjusted or marked paid.
 *
 * `PayrollRecordDTO.id` is null while a period is a live calculation — there is
 * nothing in the database to point an update at yet. A type guard rather than a
 * `!` at the call site, so the compiler is the thing that stops an adjustment
 * being wired to a draft figure instead of a developer remembering to check.
 */
export type StoredPayrollRecord = PayrollRecordDTO & { readonly id: string };

export function isStoredRecord(record: PayrollRecordDTO): record is StoredPayrollRecord {
  return record.id !== null;
}
