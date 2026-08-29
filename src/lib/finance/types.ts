/**
 * Finance — shared types.
 *
 * The same contract as `src/lib/analytics/types.ts`, for the same reason: these
 * shapes are plain data with no Prisma and no React in them, so the summarising
 * code runs identically on the server (assembling the overview payload, or a
 * PDF export) and in the browser (when someone drags the date range). Dates are
 * epoch milliseconds so a JSON round-trip needs no revive step.
 *
 * MONEY IN THIS FILE IS ALWAYS MINOR UNITS. Fields ending in `Minor` are
 * integers — cents, kuruş — never a decimal amount. See `./money`.
 */

/** Which side of the ledger a row belongs to. */
export type FinanceKind = "revenue" | "expense";

export const FINANCE_KINDS: readonly FinanceKind[] = ["revenue", "expense"];

export function isFinanceKind(value: unknown): value is FinanceKind {
  return value === "revenue" || value === "expense";
}

/**
 * Narrows the stored string to the union at the boundary.
 *
 * `kind` is a plain String column for SQLite/PostgreSQL portability, so the
 * type safety has to be re-established when a row is read. An unrecognised
 * value falls back to "expense": counting an unknown row as money going out
 * understates profit, and a pessimistic financial figure is the safer error.
 */
export function toFinanceKind(value: string | null | undefined): FinanceKind {
  return isFinanceKind(value) ? value : "expense";
}

/**
 * The minimal projection the finance engine needs.
 *
 * Only `baseAmountMinor` appears, never the original `amountMinor`: every
 * aggregate is a sum across currencies, and summing figures in mixed currencies
 * is meaningless. The conversion happened once, when the entry was written, at
 * the rate in force that day — see `finance-service`.
 */
export interface FinanceAnalyticsEntry {
  readonly id: string;
  readonly kind: FinanceKind;
  /** The day the money moved, UTC midnight, epoch ms. */
  readonly occurredOn: number;
  /** Always positive; `kind` carries the direction. Base currency, minor units. */
  readonly baseAmountMinor: number;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly channelId: string | null;
  readonly channelName: string | null;
  /** Revenue only: "youtube_ads", "sponsorship", … */
  readonly platform: string | null;
}

/**
 * A financial entry as the client consumes it.
 *
 * Extends the engine's own input shape, so a row from the API can be handed
 * straight to `summarizeFinance` with no adaptation — the same trick
 * `VideoDTO` plays with `AnalyticsVideo`.
 *
 * Note what is *not* here: nothing from the entry's author beyond a display
 * name. No email, no user row.
 */
export interface FinanceEntryDTO extends FinanceAnalyticsEntry {
  /** What was actually transacted, in the currency it was transacted in. */
  readonly amountMinor: number;
  readonly currency: string;
  /** The converted figure, the currency it is in, and the rate used that day. */
  readonly baseCurrency: string;
  readonly exchangeRate: number;
  /** Expense only: who was paid. */
  readonly vendor: string | null;
  readonly notes: string | null;
  readonly createdByName: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * Where this row came from: "manual" | "youtube".
   *
   * An imported figure and a typed one are not the same kind of fact. The
   * screen has to be able to say which, because they answer "who put this
   * number here" differently and because only one of them can have its amount
   * edited — the other is rewritten by its connector on every sync.
   */
  readonly source: string;
  /**
   * True when the source may still revise the figure.
   *
   * YouTube's revenue metrics are explicitly subject to month-end adjustment,
   * so presenting one as settled cash would be wrong. Labelled rather than
   * hidden: the distinction between an estimate and a receipt is the reader's
   * to make, not ours to erase.
   */
  readonly isEstimated: boolean;
  /**
   * True when the source has STOPPED maintaining the figure.
   *
   * The third state, and not a shade of either of the other two. `isEstimated`
   * says "the source may still revise this"; a settled row says "this is final".
   * A month whose daily figures the connector will no longer total is neither:
   * the amount is the last one it could stand behind, no revision is coming, and
   * it was never settled cash. A screen that had only the first two to choose
   * from would have to assert one of them, and both are false.
   *
   * Derived on the server from the connector's mark rather than stored, because
   * there is no column for it (see `./unmaintained`). It is the screens' single
   * source for this state — nothing in the browser reads the note itself.
   */
  readonly isUnmaintained: boolean;
  /** What the amount was before the last revision, or null if it never moved. */
  readonly previousAmountMinor: number | null;
  /** How many times an import has changed this figure. */
  readonly revisionCount: number;
  readonly lastImportedAt: number | null;
}

export interface FinanceCategoryDTO {
  readonly id: string;
  readonly kind: FinanceKind;
  readonly name: string;
  readonly slug: string;
  readonly sortOrder: number;
  /** Archived categories stay readable so historical entries keep their label. */
  readonly isArchived: boolean;
  readonly entryCount: number;
  readonly createdAt: number;
}

export interface ExchangeRateDTO {
  readonly id: string;
  readonly fromCurrency: string;
  readonly toCurrency: string;
  readonly rate: number;
  /** "manual" | "<provider name>" — where the number came from. */
  readonly source: string;
  readonly updatedAt: number;
}

/** Just enough of a channel to label a row in the comparison table. */
export interface FinanceChannelRef {
  readonly id: string;
  readonly name: string;
}

/**
 * One slice of a breakdown — by category, by channel, by platform.
 *
 * `id` is `null` for the uncategorised / company-wide bucket, which is why
 * `label` exists separately rather than being derived by the caller: the reader
 * needs to see "Company-wide", not a blank cell.
 */
export interface FinanceBreakdownSlice {
  readonly id: string | null;
  readonly label: string;
  readonly amountMinor: number;
  /**
   * This slice's share of its breakdown's total, 0..1. `0` when the total is
   * zero — a share of nothing is genuinely zero here, unlike a margin, because
   * the slice really does account for none of the total.
   */
  readonly share: number;
  readonly entryCount: number;
}

export interface FinanceSummary {
  readonly range: { readonly startMs: number; readonly endMs: number };
  readonly revenueMinor: number;
  readonly expenseMinor: number;
  /** revenue - expense. Negative when the period lost money. */
  readonly netMinor: number;
  /** Percentage 0..100, or `null` when there was no revenue to take a share of. */
  readonly margin: number | null;
  readonly entryCount: number;
  readonly revenueByCategory: readonly FinanceBreakdownSlice[];
  readonly expenseByCategory: readonly FinanceBreakdownSlice[];
  readonly revenueByChannel: readonly FinanceBreakdownSlice[];
  /** Revenue split by platform. Expenses have no platform — they have a vendor. */
  readonly byPlatform: readonly FinanceBreakdownSlice[];
}

export interface FinanceSeriesPoint {
  readonly label: string;
  /** Bucket start, epoch ms (UTC). */
  readonly startMs: number;
  /** Bucket end, exclusive, epoch ms (UTC). */
  readonly endMs: number;
  readonly revenueMinor: number;
  readonly expenseMinor: number;
  readonly netMinor: number;
}

export interface FinanceChannelRow {
  readonly channelId: string;
  readonly channelName: string;
  readonly revenueMinor: number;
  readonly expenseMinor: number;
  readonly netMinor: number;
  /** `null` when the channel earned nothing in the window. */
  readonly margin: number | null;
  readonly entryCount: number;
}
