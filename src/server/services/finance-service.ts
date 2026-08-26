import "server-only";

import { z } from "zod";
import { prisma } from "@/server/db";
import { errors } from "@/server/errors";
import { recordAudit } from "@/server/audit/audit-service";
import type { AuditAction } from "@/lib/audit/actions";
import { pickGranularity } from "@/lib/analytics/series";
import type { DateRange, SeriesGranularity } from "@/lib/analytics/types";
import {
  CURRENCY_CODES,
  MAX_MONEY_MINOR,
  convertMinorBetween,
  formatMoney,
  isSupportedCurrency,
  normalizeCurrencyCode,
  profitMargin,
} from "@/lib/finance/money";
import {
  entriesInRange,
  financeByChannel,
  financeSeries,
  summarizeFinance,
} from "@/lib/finance/finance-analytics";
import {
  toFinanceKind,
  type ExchangeRateDTO,
  type FinanceCategoryDTO,
  type FinanceChannelRef,
  type FinanceChannelRow,
  type FinanceEntryDTO,
  type FinanceKind,
  type FinanceSeriesPoint,
  type FinanceSummary,
} from "@/lib/finance/types";
import { getCurrentOrgId, getCurrentOrgSettings, getScope } from "./user-service";

/**
 * =========================================================================
 * FINANCE — ENTRIES, CATEGORIES AND EXCHANGE RATES
 * =========================================================================
 *
 * THE CURRENCY RULE, WHICH IS THE WHOLE POINT OF THIS FILE
 * An entry stores what was actually transacted — `amountMinor` and `currency`,
 * exactly as typed — and, alongside it, the same amount converted into the
 * organization's base currency together with the rate used. Both are written
 * once, at the moment of entry, and the converted figure is never recomputed on
 * read.
 *
 * That redundancy is deliberate. If the base figure were derived at read time
 * from the current rate table, last quarter's signed-off report would quietly
 * change the next time an admin updated a rate, and nobody would be able to
 * explain why the number moved. Storing the rate makes every historical total
 * reproducible and auditable: the row itself says what it was worth and what it
 * was converted at.
 *
 * The corollary is that a missing rate is a hard error, not a default. Assuming
 * 1:1 for an unconfigured currency does not "degrade gracefully" — it fabricates
 * a financial figure that looks exactly as authoritative as a real one. So the
 * write is refused and the message says what to do about it.
 *
 * SCOPE
 * Every query here filters on `organizationId` from `getScope()`. `Channel` is
 * a *global* entity in this schema — the same YouTube channel row is shared by
 * every organization tracking it — so a `channelId` from a request is checked
 * against this organization's `TrackedChannel` rows before it is ever written.
 * Without that, a crafted id would file one team's spending against another
 * team's channel.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Ceiling on a single list response.
 *
 * The finance table is read whole into the browser, the way the dataset payload
 * is, so that changing a filter costs no round trip. That only works while the
 * payload is bounded; ten years of daily entries is still comfortably inside
 * this, and anything beyond it is an import gone wrong rather than a real
 * ledger.
 */
const MAX_ENTRIES = 5_000;

/**
 * Bounds on a manually entered rate.
 *
 * Not a judgement about which currencies exist — a guard against a fat-fingered
 * decimal point. A rate is wrong by orders of magnitude far more often than it
 * is genuinely extreme, and a misplaced zero here silently multiplies every
 * converted figure by ten.
 */
const MIN_EXCHANGE_RATE = 0.000_001;
const MAX_EXCHANGE_RATE = 1_000_000;

/** Entries this far out are almost certainly a typo in the year. */
const MIN_ENTRY_YEAR = 2000;
const MAX_FUTURE_DAYS = 366;

// ---------------------------------------------------------------------------
// SCHEMAS
// ---------------------------------------------------------------------------

const kindSchema = z.enum(["revenue", "expense"]);

/**
 * A currency the app is configured to handle.
 *
 * Validated against `CURRENCIES` rather than accepting any three letters,
 * because `minorUnits` is what turns "1234" into an amount — and for a code we
 * know nothing about, we would be guessing at the scale of the number.
 */
const currencySchema = z
  .string()
  .refine((value) => isSupportedCurrency(value), {
    message: `Currency must be one of ${CURRENCY_CODES.join(", ")}.`,
  })
  .transform((value) => normalizeCurrencyCode(value));

/**
 * The day the money moved.
 *
 * A calendar date, not a timestamp: "when did this transaction happen" has no
 * time-of-day answer that anyone records, and accepting one would make the day
 * an entry lands on depend on the reporter's timezone. Epoch milliseconds are
 * accepted too, for callers that already hold a date object, and are normalised
 * to the same UTC midnight.
 */
const occurredOnSchema = z.union([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Write dates as YYYY-MM-DD."),
  z.number().int(),
]);

const amountMinorSchema = z
  .number()
  .int("Amounts are whole minor units (cents), never fractions of one.")
  .positive("Enter an amount greater than zero.")
  // `kind` carries the direction of the money, so the amount itself is always
  // positive. A negative revenue row would subtract inside a sum that already
  // treats revenue as positive, double-negating it.
  .max(MAX_MONEY_MINOR, "That amount is too large to record as a single entry.");

const optionalIdSchema = z.string().trim().min(1).max(64).nullish();

export const financeEntryCreateSchema = z.object({
  kind: kindSchema,
  occurredOn: occurredOnSchema,
  amountMinor: amountMinorSchema,
  currency: currencySchema,
  categoryId: optionalIdSchema,
  channelId: optionalIdSchema,
  platform: z.string().trim().max(64).nullish(),
  vendor: z.string().trim().max(120).nullish(),
  notes: z.string().trim().max(2_000).nullish(),
});

export const financeEntryUpdateSchema = financeEntryCreateSchema.partial();

export type FinanceEntryCreateInput = z.infer<typeof financeEntryCreateSchema>;
export type FinanceEntryUpdateInput = z.infer<typeof financeEntryUpdateSchema>;

const categoryNameSchema = z
  .string()
  .trim()
  .min(1, "Give the category a name.")
  .max(48, "Category names must be 48 characters or fewer.");

export const financeCategoryCreateSchema = z.object({
  kind: kindSchema,
  name: categoryNameSchema,
  sortOrder: z.number().int().min(0).max(9_999).optional(),
});

/**
 * Rename and archive only.
 *
 * `sortOrder` is deliberately absent: nothing here writes it back, and a field
 * a route accepts but silently ignores is worse than one it rejects — the
 * caller believes the reorder saved.
 */
export const financeCategoryUpdateSchema = z.object({
  name: categoryNameSchema.optional(),
  isArchived: z.boolean().optional(),
});

export const exchangeRateInputSchema = z.object({
  fromCurrency: currencySchema,
  /** Defaults to the organization's base currency, which is the only pair conversion uses. */
  toCurrency: currencySchema.optional(),
  rate: z
    .number()
    .finite()
    .min(MIN_EXCHANGE_RATE, "That rate is too small to be a real conversion.")
    .max(MAX_EXCHANGE_RATE, "That rate looks like a misplaced decimal point."),
  source: z.string().trim().min(1).max(64).optional(),
});

/**
 * Accepts one rate or a table of them.
 *
 * The rates screen saves every row it shows in one request — a currency table
 * edited a cell at a time would leave the ledger half-converted between saves.
 */
export const exchangeRateUpsertSchema = z.union([
  z.object({ rates: z.array(exchangeRateInputSchema).min(1).max(50) }),
  exchangeRateInputSchema.transform((rate) => ({ rates: [rate] })),
]);

export const financeQuerySchema = z.object({
  startMs: z.coerce.number().int().optional(),
  endMs: z.coerce.number().int().optional(),
  days: z.coerce.number().int().min(1).max(3_650).optional(),
  kind: kindSchema.optional(),
  channelId: z.string().trim().min(1).max(64).optional(),
  categoryId: z.string().trim().min(1).max(64).optional(),
});

export type FinanceQuery = z.infer<typeof financeQuerySchema>;

/**
 * Query string -> validated filters.
 *
 * Lives here rather than in each route so the two read endpoints cannot drift
 * apart on what `days` or `kind` mean — and so an unparseable filter is a 400
 * with a sentence rather than a silently ignored parameter, which is how a user
 * ends up reading last month's totals believing they filtered them.
 */
export function parseFinanceQuery(request: Request): FinanceQuery {
  const parsed = financeQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) {
    throw errors.invalidInput(
      parsed.error.issues[0]?.message ?? "Those finance filters are not valid.",
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// ROW PROJECTIONS
// ---------------------------------------------------------------------------

/**
 * Columns are listed explicitly rather than taking the row.
 *
 * The house rule (never return a raw Prisma row) exists so that a column added
 * later cannot appear in an API response by default. `createdBy` is the sharp
 * edge here: the relation goes to `AppUser`, which holds `passwordHash`. Only
 * `name` is selected, so there is no path from this query to a credential.
 */
const ENTRY_SELECT = {
  id: true,
  kind: true,
  occurredOn: true,
  amountMinor: true,
  currency: true,
  baseAmountMinor: true,
  baseCurrency: true,
  exchangeRate: true,
  categoryId: true,
  channelId: true,
  platform: true,
  vendor: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  category: { select: { name: true } },
  channel: { select: { title: true } },
  createdBy: { select: { name: true } },
};

interface FinanceEntryRow {
  id: string;
  kind: string;
  occurredOn: Date;
  amountMinor: number;
  currency: string;
  baseAmountMinor: number;
  baseCurrency: string;
  exchangeRate: number;
  categoryId: string | null;
  channelId: string | null;
  platform: string | null;
  vendor: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  category: { name: string } | null;
  channel: { title: string } | null;
  createdBy: { name: string | null } | null;
}

function toFinanceEntryDTO(
  row: FinanceEntryRow,
  channelNames: ReadonlyMap<string, string>,
): FinanceEntryDTO {
  return {
    id: row.id,
    kind: toFinanceKind(row.kind),
    occurredOn: row.occurredOn.getTime(),
    baseAmountMinor: row.baseAmountMinor,
    categoryId: row.categoryId,
    categoryName: row.category?.name ?? null,
    channelId: row.channelId,
    // The team's own label wins over the YouTube title, so the finance table
    // names channels the same way every other screen does.
    channelName: row.channelId
      ? (channelNames.get(row.channelId) ?? row.channel?.title ?? null)
      : null,
    platform: row.platform,
    amountMinor: row.amountMinor,
    currency: row.currency,
    baseCurrency: row.baseCurrency,
    exchangeRate: row.exchangeRate,
    vendor: row.vendor,
    notes: row.notes,
    createdByName: row.createdBy?.name ?? null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

interface CategoryRow {
  id: string;
  kind: string;
  name: string;
  slug: string;
  sortOrder: number;
  isArchived: boolean;
  createdAt: Date;
  _count: { entries: number };
}

function toFinanceCategoryDTO(row: CategoryRow): FinanceCategoryDTO {
  return {
    id: row.id,
    kind: toFinanceKind(row.kind),
    name: row.name,
    slug: row.slug,
    sortOrder: row.sortOrder,
    isArchived: row.isArchived,
    entryCount: row._count.entries,
    createdAt: row.createdAt.getTime(),
  };
}

interface ExchangeRateRow {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  source: string;
  updatedAt: Date;
}

function toExchangeRateDTO(row: ExchangeRateRow): ExchangeRateDTO {
  return {
    id: row.id,
    fromCurrency: row.fromCurrency,
    toCurrency: row.toCurrency,
    rate: row.rate,
    source: row.source,
    updatedAt: row.updatedAt.getTime(),
  };
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

/** Same normalisation as niches: case- and whitespace-insensitive collision key. */
function toSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function startOfUtcDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function toUtcMidnight(value: string | number): Date {
  const ms =
    typeof value === "number" ? value : Date.parse(`${value}T00:00:00.000Z`);
  // `Date.parse` returns NaN for a well-formed but impossible date such as
  // 2026-02-31, which the regex on the schema cannot catch.
  if (!Number.isFinite(ms)) {
    throw errors.invalidInput("That is not a real date. Write it as YYYY-MM-DD.");
  }

  const normalized = new Date(startOfUtcDay(ms));
  if (normalized.getUTCFullYear() < MIN_ENTRY_YEAR) {
    throw errors.invalidInput(`Entries cannot be dated before ${MIN_ENTRY_YEAR}.`);
  }
  if (normalized.getTime() > startOfUtcDay(Date.now()) + MAX_FUTURE_DAYS * MS_PER_DAY) {
    throw errors.invalidInput("That date is more than a year in the future — check the year.");
  }
  return normalized;
}

/** Empty and whitespace-only free text is absence, and absence is `null`. */
function nullableText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Display names for every channel this organization has ever tracked.
 *
 * Includes channels that have since been removed from the tracker: their
 * historical costs and revenue are still in the ledger, and a row labelled with
 * a bare id is not something anyone can reconcile.
 */
async function getChannelNames(organizationId: string): Promise<Map<string, string>> {
  const tracked = await prisma.trackedChannel.findMany({
    where: { organizationId },
    select: { channelId: true, label: true, channel: { select: { title: true } } },
  });
  return new Map(tracked.map((row) => [row.channelId, row.label ?? row.channel.title]));
}

/**
 * The audit record for a money movement — and, deliberately, what it leaves out.
 *
 * The amount, both currencies and the rate are here because "who moved money,
 * how much, and what it was worth" is the entire reason finance is audited at
 * all. `notes` and `vendor` are not, and that is not squeamishness: they are
 * free text that routinely carries deal terms, rates and counterparty names,
 * and the audit log is readable by anyone holding `audit.view` — a different
 * and wider set of people than `finance.view`. Copying commercial detail into
 * the log would route it straight around the permission that exists to
 * protect it.
 */
function entryAuditMetadata(entry: {
  kind: string;
  occurredOn: Date;
  amountMinor: number;
  currency: string;
  baseAmountMinor: number;
  baseCurrency: string;
  exchangeRate: number;
  categoryId: string | null;
  channelId: string | null;
}): Record<string, unknown> {
  return {
    kind: entry.kind,
    occurredOn: entry.occurredOn.toISOString().slice(0, 10),
    amountMinor: entry.amountMinor,
    currency: entry.currency,
    baseAmountMinor: entry.baseAmountMinor,
    baseCurrency: entry.baseCurrency,
    exchangeRate: entry.exchangeRate,
    categoryId: entry.categoryId,
    channelId: entry.channelId,
  };
}

async function auditFinance(
  request: Request | undefined,
  payload: {
    action: AuditAction;
    summary: string;
    targetType: string;
    targetId: string;
    targetLabel?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const { organizationId, actor } = await getScope();
  await recordAudit(
    {
      organizationId,
      actorUserId: actor.userId,
      actorLabel: actor.name ?? actor.email,
      // Passed on every finance write even though only `finance.exported` is
      // currently on the network-context list. The decision about which actions
      // deserve an IP belongs to the audit module, not to each call site — so
      // adding one there must not require revisiting this file.
      request,
    },
    payload,
  );
}

/**
 * Turns an entered amount into its base-currency counterpart.
 *
 * Reads the rate once, here, and hands it back so it can be stored on the row.
 * The inverse of a configured rate is deliberately NOT used: an admin who set
 * "1 EUR = 1.08 USD" has stated one direction, and deriving USD -> EUR from it
 * would put a number in the ledger that nobody entered and that carries a
 * rounding error nobody chose.
 */
async function resolveConversion(params: {
  organizationId: string;
  amountMinor: number;
  currency: string;
  baseCurrency: string;
}): Promise<{ baseAmountMinor: number; baseCurrency: string; exchangeRate: number }> {
  const { organizationId, amountMinor, currency, baseCurrency } = params;

  if (currency === baseCurrency) {
    return { baseAmountMinor: amountMinor, baseCurrency, exchangeRate: 1 };
  }

  const configured = await prisma.exchangeRate.findUnique({
    where: {
      organizationId_fromCurrency_toCurrency: {
        organizationId,
        fromCurrency: currency,
        toCurrency: baseCurrency,
      },
    },
    select: { rate: true },
  });

  if (!configured || !Number.isFinite(configured.rate) || configured.rate <= 0) {
    throw errors.invalidInput(
      `No exchange rate is set for ${currency} to ${baseCurrency}. An admin needs to add one under Finance → Exchange rates before ${currency} entries can be recorded.`,
      { fromCurrency: currency, toCurrency: baseCurrency },
    );
  }

  const baseAmountMinor = convertMinorBetween(
    amountMinor,
    configured.rate,
    currency,
    baseCurrency,
  );

  if (baseAmountMinor <= 0) {
    throw errors.invalidInput(
      `At the configured rate that amount converts to zero ${baseCurrency}, so it would not appear in any total.`,
    );
  }
  if (baseAmountMinor > MAX_MONEY_MINOR) {
    throw errors.invalidInput(
      `Converted to ${baseCurrency} that amount is too large to record as a single entry. Split it across entries.`,
    );
  }

  return { baseAmountMinor, baseCurrency, exchangeRate: configured.rate };
}

/** A category id is only usable if it belongs to this org and to the same side of the ledger. */
async function assertCategory(
  organizationId: string,
  categoryId: string,
  kind: FinanceKind,
): Promise<{ id: string; name: string }> {
  const category = await prisma.financeCategory.findFirst({
    where: { id: categoryId, organizationId },
    select: { id: true, name: true, kind: true, isArchived: true },
  });
  if (!category) throw errors.notFound("finance category");

  if (toFinanceKind(category.kind) !== kind) {
    throw errors.invalidInput(
      `“${category.name}” is a ${category.kind} category, so it cannot be used on a ${kind} entry.`,
    );
  }
  // Archived categories keep labelling the entries already filed under them —
  // that is the whole reason they are archived rather than deleted — but they
  // are no longer offered for new ones.
  if (category.isArchived) {
    throw errors.invalidInput(`“${category.name}” has been archived. Pick a current category.`);
  }

  return { id: category.id, name: category.name };
}

/**
 * A channel id is only usable if THIS organization tracks it.
 *
 * `Channel` rows are global and shared between organizations, so the id alone
 * proves nothing about who may reference it. `TrackedChannel` is the org-scoped
 * table, and it is the one that decides.
 */
async function assertChannel(organizationId: string, channelId: string): Promise<string> {
  const tracked = await prisma.trackedChannel.findFirst({
    where: { organizationId, channelId },
    select: { channelId: true },
  });
  if (!tracked) throw errors.notFound("channel");
  return tracked.channelId;
}

// ---------------------------------------------------------------------------
// RANGE
// ---------------------------------------------------------------------------

/**
 * The window a finance query covers, `[startMs, endMs)`.
 *
 * With no explicit bounds it falls back to the organization's default period,
 * so the Finance page opens on the same window as every other screen rather
 * than inventing its own idea of "recent".
 *
 * The trailing window ends at tomorrow's UTC midnight, not today's. Entries are
 * stored at UTC midnight, so an exclusive end of *today's* midnight would drop
 * everything recorded today — the most likely thing someone is looking for
 * right after they enter it.
 */
export async function resolveFinanceRange(input: {
  startMs?: number | null;
  endMs?: number | null;
  days?: number | null;
}): Promise<DateRange> {
  const defaultEnd = startOfUtcDay(Date.now()) + MS_PER_DAY;

  if (typeof input.startMs === "number" && Number.isFinite(input.startMs)) {
    const endMs =
      typeof input.endMs === "number" && Number.isFinite(input.endMs) ? input.endMs : defaultEnd;
    if (endMs <= input.startMs) {
      throw errors.invalidInput("The end of the range has to come after its start.");
    }
    return { startMs: input.startMs, endMs };
  }

  const settings = await getCurrentOrgSettings();
  const days = input.days && input.days > 0 ? input.days : settings.defaultPeriodDays;
  const endMs =
    typeof input.endMs === "number" && Number.isFinite(input.endMs) ? input.endMs : defaultEnd;
  return { startMs: endMs - days * MS_PER_DAY, endMs };
}

// ---------------------------------------------------------------------------
// ENTRIES
// ---------------------------------------------------------------------------

export interface ListEntriesOptions {
  readonly range: DateRange;
  readonly kind?: FinanceKind | null;
  readonly channelId?: string | null;
  readonly categoryId?: string | null;
}

/**
 * The ledger for a period, plus whether the cap cut it short.
 *
 * The flag is not decoration. Every total on the Finance page is a sum over
 * this array, so a silently truncated list would understate revenue and profit
 * while looking completely normal — the single worst failure mode a financial
 * screen has. One extra row is fetched purely to detect the case, and the
 * caller is expected to say so out loud rather than render a confident wrong
 * number.
 */
export async function listEntriesPage(
  options: ListEntriesOptions,
): Promise<{ entries: FinanceEntryDTO[]; truncated: boolean }> {
  const organizationId = await getCurrentOrgId();

  const [rows, channelNames] = await Promise.all([
    prisma.financeEntry.findMany({
      where: {
        // The scope clause. Never taken from the request — an entry belongs to
        // the organization the caller's session resolves to, full stop.
        organizationId,
        occurredOn: {
          gte: new Date(options.range.startMs),
          lt: new Date(options.range.endMs),
        },
        ...(options.kind ? { kind: options.kind } : {}),
        ...(options.channelId ? { channelId: options.channelId } : {}),
        ...(options.categoryId ? { categoryId: options.categoryId } : {}),
      },
      // Newest transaction first; `createdAt` breaks ties so two entries on the
      // same day keep the order they were recorded in rather than shuffling.
      orderBy: [{ occurredOn: "desc" }, { createdAt: "desc" }],
      take: MAX_ENTRIES + 1,
      select: ENTRY_SELECT,
    }),
    getChannelNames(organizationId),
  ]);

  const truncated = rows.length > MAX_ENTRIES;
  return {
    entries: rows
      .slice(0, MAX_ENTRIES)
      .map((row) => toFinanceEntryDTO(row, channelNames)),
    truncated,
  };
}

/** The entries alone, for callers that already handle the cap or cannot exceed it. */
export async function listEntries(options: ListEntriesOptions): Promise<FinanceEntryDTO[]> {
  return (await listEntriesPage(options)).entries;
}

async function readEntryDTO(
  organizationId: string,
  entryId: string,
): Promise<FinanceEntryDTO> {
  const [row, channelNames] = await Promise.all([
    prisma.financeEntry.findFirst({
      where: { id: entryId, organizationId },
      select: ENTRY_SELECT,
    }),
    getChannelNames(organizationId),
  ]);
  if (!row) throw errors.notFound("finance entry");
  return toFinanceEntryDTO(row, channelNames);
}

export async function createEntry(
  input: FinanceEntryCreateInput,
  request?: Request,
): Promise<FinanceEntryDTO> {
  const { organizationId, userId } = await getScope();
  const settings = await getCurrentOrgSettings();
  const baseCurrency = normalizeCurrencyCode(settings.baseCurrency);

  const occurredOn = toUtcMidnight(input.occurredOn);

  const categoryId = input.categoryId
    ? (await assertCategory(organizationId, input.categoryId, input.kind)).id
    : null;
  const channelId = input.channelId
    ? await assertChannel(organizationId, input.channelId)
    : null;

  const conversion = await resolveConversion({
    organizationId,
    amountMinor: input.amountMinor,
    currency: input.currency,
    baseCurrency,
  });

  const entry = await prisma.financeEntry.create({
    data: {
      organizationId,
      kind: input.kind,
      occurredOn,
      amountMinor: input.amountMinor,
      currency: input.currency,
      baseAmountMinor: conversion.baseAmountMinor,
      baseCurrency: conversion.baseCurrency,
      exchangeRate: conversion.exchangeRate,
      categoryId,
      channelId,
      // Each side of the ledger owns one of these fields. Clearing the other
      // rather than storing it keeps the revenue-by-platform breakdown from
      // picking up a value someone typed into the wrong form state.
      platform: input.kind === "revenue" ? nullableText(input.platform) : null,
      vendor: input.kind === "expense" ? nullableText(input.vendor) : null,
      notes: nullableText(input.notes),
      // Attribution for the byline and the audit trail. Never read back as a
      // filter: a finance entry belongs to the organization, not to whoever
      // typed it, including after they leave.
      createdById: userId,
    },
    select: { id: true },
  });

  await auditFinance(request, {
    action: "finance.entry_created",
    summary: `Recorded a ${formatMoney(input.amountMinor, input.currency)} ${input.kind} entry`,
    targetType: "finance_entry",
    targetId: entry.id,
    targetLabel: input.kind,
    metadata: entryAuditMetadata({
      kind: input.kind,
      occurredOn,
      amountMinor: input.amountMinor,
      currency: input.currency,
      ...conversion,
      categoryId,
      channelId,
    }),
  });

  return readEntryDTO(organizationId, entry.id);
}

export async function updateEntry(
  entryId: string,
  input: FinanceEntryUpdateInput,
  request?: Request,
): Promise<FinanceEntryDTO> {
  const organizationId = await getCurrentOrgId();

  // Scoped read before write: an id from another organization must read as
  // "not found", never as somebody else's row.
  const existing = await prisma.financeEntry.findFirst({
    where: { id: entryId, organizationId },
    select: {
      id: true,
      kind: true,
      occurredOn: true,
      amountMinor: true,
      currency: true,
      baseAmountMinor: true,
      baseCurrency: true,
      exchangeRate: true,
      categoryId: true,
      channelId: true,
    },
  });
  if (!existing) throw errors.notFound("finance entry");

  const kind = input.kind ?? toFinanceKind(existing.kind);
  const amountMinor = input.amountMinor ?? existing.amountMinor;
  const currency = input.currency ?? existing.currency;
  // Moving an entry to the other side of the ledger invalidates the fields that
  // belong to the side it came from. Re-sending the same kind is not a move and
  // must not quietly wipe them.
  const kindChanged = kind !== toFinanceKind(existing.kind);

  const data: {
    kind?: string;
    occurredOn?: Date;
    amountMinor?: number;
    currency?: string;
    baseAmountMinor?: number;
    baseCurrency?: string;
    exchangeRate?: number;
    categoryId?: string | null;
    channelId?: string | null;
    platform?: string | null;
    vendor?: string | null;
    notes?: string | null;
  } = {};

  if (input.kind !== undefined) data.kind = kind;
  if (input.occurredOn !== undefined) data.occurredOn = toUtcMidnight(input.occurredOn);

  /**
   * The converted figure is recomputed only when the money itself changes.
   *
   * Editing a note or re-filing an entry under another category must not
   * re-rate it at today's rate — that would rewrite a historical figure as a
   * side effect of an unrelated edit, which is exactly what storing the rate
   * exists to prevent. When the amount or the currency does change, the entry
   * is a different transaction and is re-converted at the rate in force now.
   *
   * The test is on the VALUE, not on whether the field was present.
   * `financeEntryUpdateSchema` is `createSchema.partial()`, so a form that
   * submits the whole object — the normal shape of an edit dialog — sends
   * `amountMinor` and `currency` on every save even when the user only touched
   * the note. Keying off presence would silently re-rate the entry at today's
   * rate on any edit at all, and because the audit metadata records the new
   * figures the change would leave no trace. That is the one failure mode in
   * this file that quietly corrupts historical financial data.
   */
  const moneyChanged =
    amountMinor !== existing.amountMinor || currency !== existing.currency;

  if (moneyChanged) {
    const conversion = await resolveConversion({
      organizationId,
      amountMinor,
      currency,
      baseCurrency: normalizeCurrencyCode((await getCurrentOrgSettings()).baseCurrency),
    });
    data.amountMinor = amountMinor;
    data.currency = currency;
    data.baseAmountMinor = conversion.baseAmountMinor;
    data.baseCurrency = conversion.baseCurrency;
    data.exchangeRate = conversion.exchangeRate;
  }

  // A kind change invalidates the existing category — categories belong to one
  // side of the ledger — so it is re-checked even when the caller did not name
  // one. Better a 400 naming the mismatch than an expense filed under "Ad
  // revenue" because the form only sent the field that visibly changed.
  if (input.categoryId !== undefined || (kindChanged && existing.categoryId)) {
    const candidate = input.categoryId !== undefined ? input.categoryId : existing.categoryId;
    data.categoryId = candidate
      ? (await assertCategory(organizationId, candidate, kind)).id
      : null;
  }

  if (input.channelId !== undefined) {
    data.channelId = input.channelId
      ? await assertChannel(organizationId, input.channelId)
      : null;
  }

  if (input.platform !== undefined || kindChanged) {
    data.platform = kind === "revenue" ? nullableText(input.platform) : null;
  }
  if (input.vendor !== undefined || kindChanged) {
    data.vendor = kind === "expense" ? nullableText(input.vendor) : null;
  }
  if (input.notes !== undefined) data.notes = nullableText(input.notes);

  const updated = await prisma.financeEntry.update({
    where: { id: existing.id },
    data,
    select: {
      id: true,
      kind: true,
      occurredOn: true,
      amountMinor: true,
      currency: true,
      baseAmountMinor: true,
      baseCurrency: true,
      exchangeRate: true,
      categoryId: true,
      channelId: true,
    },
  });

  await auditFinance(request, {
    action: "finance.entry_updated",
    summary: `Updated a ${formatMoney(updated.amountMinor, updated.currency)} ${updated.kind} entry`,
    targetType: "finance_entry",
    targetId: updated.id,
    targetLabel: updated.kind,
    metadata: {
      ...entryAuditMetadata(updated),
      // What it was before, so the log answers "what changed", not just "what
      // it is now". Amount and currency only — the same free-text exclusion
      // applies to the previous values as to the current ones.
      previousAmountMinor: existing.amountMinor,
      previousCurrency: existing.currency,
    },
  });

  return readEntryDTO(organizationId, updated.id);
}

export async function deleteEntry(
  entryId: string,
  request?: Request,
): Promise<{ id: string }> {
  const organizationId = await getCurrentOrgId();

  const existing = await prisma.financeEntry.findFirst({
    where: { id: entryId, organizationId },
    select: {
      id: true,
      kind: true,
      occurredOn: true,
      amountMinor: true,
      currency: true,
      baseAmountMinor: true,
      baseCurrency: true,
      exchangeRate: true,
      categoryId: true,
      channelId: true,
    },
  });
  if (!existing) throw errors.notFound("finance entry");

  await prisma.financeEntry.delete({ where: { id: existing.id } });

  // The audit entry is what survives the row. It is written after the delete
  // and carries the amount precisely because there is nothing left to look up:
  // a deletion nobody can quantify afterwards is not an audit trail.
  await auditFinance(request, {
    action: "finance.entry_deleted",
    summary: `Deleted a ${formatMoney(existing.amountMinor, existing.currency)} ${existing.kind} entry`,
    targetType: "finance_entry",
    targetId: existing.id,
    targetLabel: existing.kind,
    metadata: entryAuditMetadata(existing),
  });

  return { id: existing.id };
}

// ---------------------------------------------------------------------------
// CATEGORIES
// ---------------------------------------------------------------------------

export async function listCategories(options?: {
  kind?: FinanceKind | null;
  includeArchived?: boolean;
}): Promise<FinanceCategoryDTO[]> {
  const organizationId = await getCurrentOrgId();

  const rows = await prisma.financeCategory.findMany({
    where: {
      organizationId,
      ...(options?.kind ? { kind: options.kind } : {}),
      // Archived categories are returned by default: the entry table still has
      // to render the label on every historical row filed under one.
      ...(options?.includeArchived === false ? { isArchived: false } : {}),
    },
    orderBy: [{ kind: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      kind: true,
      name: true,
      slug: true,
      sortOrder: true,
      isArchived: true,
      createdAt: true,
      _count: { select: { entries: true } },
    },
  });

  return rows.map(toFinanceCategoryDTO);
}

export async function createCategory(
  input: z.infer<typeof financeCategoryCreateSchema>,
  request?: Request,
): Promise<FinanceCategoryDTO> {
  const organizationId = await getCurrentOrgId();

  const name = input.name.trim();
  const slug = toSlug(name);

  // Uniqueness is per (organization, kind): a team may legitimately have a
  // "Sponsorship" on both sides of the ledger — income from one, agency fees
  // paid for another — and the schema's compound key says so.
  const clash = await prisma.financeCategory.findUnique({
    where: {
      organizationId_kind_slug: { organizationId, kind: input.kind, slug },
    },
    select: { name: true },
  });
  if (clash) {
    throw errors.invalidInput(`A ${input.kind} category called “${clash.name}” already exists.`);
  }

  const count = await prisma.financeCategory.count({
    where: { organizationId, kind: input.kind },
  });

  const created = await prisma.financeCategory.create({
    data: {
      organizationId,
      kind: input.kind,
      name,
      slug,
      sortOrder: input.sortOrder ?? count,
    },
    select: {
      id: true,
      kind: true,
      name: true,
      slug: true,
      sortOrder: true,
      isArchived: true,
      createdAt: true,
    },
  });

  await auditFinance(request, {
    action: "finance.category_created",
    summary: `Created the ${input.kind} category “${name}”`,
    targetType: "finance_category",
    targetId: created.id,
    targetLabel: name,
    metadata: { kind: input.kind, name },
  });

  return toFinanceCategoryDTO({ ...created, _count: { entries: 0 } });
}

export async function renameCategory(
  categoryId: string,
  name: string,
  request?: Request,
): Promise<FinanceCategoryDTO> {
  const organizationId = await getCurrentOrgId();

  const existing = await prisma.financeCategory.findFirst({
    where: { id: categoryId, organizationId },
    select: { id: true, kind: true, name: true, slug: true },
  });
  if (!existing) throw errors.notFound("finance category");

  const nextName = name.trim();
  const nextSlug = toSlug(nextName);

  if (nextSlug !== existing.slug) {
    const clash = await prisma.financeCategory.findUnique({
      where: {
        organizationId_kind_slug: { organizationId, kind: existing.kind, slug: nextSlug },
      },
      select: { name: true },
    });
    if (clash) {
      throw errors.invalidInput(
        `A ${existing.kind} category called “${clash.name}” already exists.`,
      );
    }
  }

  const updated = await prisma.financeCategory.update({
    where: { id: existing.id },
    data: { name: nextName, slug: nextSlug },
    select: {
      id: true,
      kind: true,
      name: true,
      slug: true,
      sortOrder: true,
      isArchived: true,
      createdAt: true,
      _count: { select: { entries: true } },
    },
  });

  await auditFinance(request, {
    action: "finance.category_updated",
    summary: `Renamed the ${existing.kind} category “${existing.name}” to “${nextName}”`,
    targetType: "finance_category",
    targetId: updated.id,
    targetLabel: nextName,
    metadata: { kind: existing.kind, previousName: existing.name, name: nextName },
  });

  return toFinanceCategoryDTO(updated);
}

/**
 * Archive — or restore — a category.
 *
 * Never a delete. The schema keeps `isArchived` precisely so that every entry
 * already filed under a category keeps its label: removing the row would blank
 * the category column on historical spending, and a report whose past changes
 * when you tidy up the present is not a report.
 */
export async function archiveCategory(
  categoryId: string,
  archived = true,
  request?: Request,
): Promise<FinanceCategoryDTO> {
  const organizationId = await getCurrentOrgId();

  const existing = await prisma.financeCategory.findFirst({
    where: { id: categoryId, organizationId },
    select: { id: true, kind: true, name: true, isArchived: true },
  });
  if (!existing) throw errors.notFound("finance category");

  const updated = await prisma.financeCategory.update({
    where: { id: existing.id },
    data: { isArchived: archived },
    select: {
      id: true,
      kind: true,
      name: true,
      slug: true,
      sortOrder: true,
      isArchived: true,
      createdAt: true,
      _count: { select: { entries: true } },
    },
  });

  await auditFinance(request, {
    // Restoring is a plain update: `category_archived` should mean what it
    // says, so that filtering the log for it returns archivals only.
    action: archived ? "finance.category_archived" : "finance.category_updated",
    summary: archived
      ? `Archived the ${existing.kind} category “${existing.name}”`
      : `Restored the ${existing.kind} category “${existing.name}”`,
    targetType: "finance_category",
    targetId: updated.id,
    targetLabel: existing.name,
    metadata: { kind: existing.kind, name: existing.name, isArchived: archived },
  });

  return toFinanceCategoryDTO(updated);
}

// ---------------------------------------------------------------------------
// EXCHANGE RATES
// ---------------------------------------------------------------------------

export async function listExchangeRates(): Promise<ExchangeRateDTO[]> {
  const organizationId = await getCurrentOrgId();

  const rows = await prisma.exchangeRate.findMany({
    where: { organizationId },
    orderBy: [{ fromCurrency: "asc" }, { toCurrency: "asc" }],
    select: {
      id: true,
      fromCurrency: true,
      toCurrency: true,
      rate: true,
      source: true,
      updatedAt: true,
    },
  });

  return rows.map(toExchangeRateDTO);
}

export async function upsertExchangeRate(
  input: z.infer<typeof exchangeRateInputSchema>,
  request?: Request,
): Promise<ExchangeRateDTO> {
  const organizationId = await getCurrentOrgId();
  const settings = await getCurrentOrgSettings();

  const fromCurrency = input.fromCurrency;
  const toCurrency = input.toCurrency ?? normalizeCurrencyCode(settings.baseCurrency);

  if (fromCurrency === toCurrency) {
    throw errors.invalidInput(
      `A currency's rate against itself is always 1, so ${fromCurrency} needs no entry here.`,
    );
  }

  const previous = await prisma.exchangeRate.findUnique({
    where: {
      organizationId_fromCurrency_toCurrency: { organizationId, fromCurrency, toCurrency },
    },
    select: { rate: true },
  });

  const row = await prisma.exchangeRate.upsert({
    where: {
      organizationId_fromCurrency_toCurrency: { organizationId, fromCurrency, toCurrency },
    },
    create: {
      organizationId,
      fromCurrency,
      toCurrency,
      rate: input.rate,
      source: input.source ?? "manual",
    },
    update: { rate: input.rate, source: input.source ?? "manual" },
    select: {
      id: true,
      fromCurrency: true,
      toCurrency: true,
      rate: true,
      source: true,
      updatedAt: true,
    },
  });

  await auditFinance(request, {
    action: "finance.rate_updated",
    summary: `Set 1 ${fromCurrency} = ${input.rate} ${toCurrency}`,
    targetType: "exchange_rate",
    targetId: row.id,
    targetLabel: `${fromCurrency}/${toCurrency}`,
    metadata: {
      fromCurrency,
      toCurrency,
      rate: input.rate,
      // The old value matters more here than almost anywhere else: a rate
      // change does not touch a single existing entry, so "what was it before"
      // is the only way to explain why entries either side of this moment
      // converted differently.
      previousRate: previous?.rate ?? null,
      source: input.source ?? "manual",
    },
  });

  return toExchangeRateDTO(row);
}

/** Applies a whole rate table in one call. See `exchangeRateUpsertSchema`. */
export async function upsertExchangeRates(
  input: z.infer<typeof exchangeRateUpsertSchema>,
  request?: Request,
): Promise<ExchangeRateDTO[]> {
  const results: ExchangeRateDTO[] = [];
  // Sequential rather than concurrent: each one audits, and a partial failure
  // should leave the rates that already applied in place with their log
  // entries intact rather than racing an unknown number of writes.
  for (const rate of input.rates) {
    results.push(await upsertExchangeRate(rate, request));
  }
  return results;
}

// ---------------------------------------------------------------------------
// OVERVIEW
// ---------------------------------------------------------------------------

export interface FinanceOverview {
  readonly baseCurrency: string;
  readonly range: { readonly startMs: number; readonly endMs: number };
  readonly granularity: SeriesGranularity;
  readonly summary: FinanceSummary;
  readonly series: readonly FinanceSeriesPoint[];
  readonly byChannel: readonly FinanceChannelRow[];
  readonly entries: readonly FinanceEntryDTO[];
  readonly categories: readonly FinanceCategoryDTO[];
  readonly channels: readonly FinanceChannelRef[];
  /** Which foreign currencies can currently be entered at all. */
  readonly rates: readonly ExchangeRateDTO[];
  /**
   * True when the period held more entries than one payload carries, which
   * means every total here is understated. The UI must say so rather than
   * present the figures as the period's result.
   */
  readonly truncated: boolean;
}

/**
 * Everything the Finance dashboard renders, in one request.
 *
 * Assembled server-side rather than left to the client for the same reason the
 * tracker dataset is: one query set, one consistent snapshot. The aggregation
 * itself is the shared pure engine, so the totals in this payload are computed
 * by exactly the same code the browser will re-run when the user narrows the
 * range.
 */
export async function getFinanceOverview(options: {
  range: DateRange;
}): Promise<FinanceOverview> {
  const organizationId = await getCurrentOrgId();
  const settings = await getCurrentOrgSettings();
  const baseCurrency = normalizeCurrencyCode(settings.baseCurrency);

  const [ledger, categories, rates, tracked] = await Promise.all([
    listEntriesPage({ range: options.range }),
    listCategories(),
    listExchangeRates(),
    prisma.trackedChannel.findMany({
      where: { organizationId, isActive: true },
      select: { channelId: true, label: true, channel: { select: { title: true } } },
    }),
  ]);

  const channels: FinanceChannelRef[] = tracked
    .map((row) => ({ id: row.channelId, name: row.label ?? row.channel.title }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const granularity = pickGranularity(options.range);
  const entries = ledger.entries;

  /**
   * The headline totals come from the database, not from the page above.
   *
   * `listEntriesPage` caps at MAX_ENTRIES and orders newest-first, so deriving
   * revenue and profit from that array would, past the cap, report the newest
   * N entries as if they were the whole period — an understated figure that
   * looks completely authoritative. A financial summary that is quietly wrong
   * is worse than one that refuses to render.
   *
   * A grouped aggregate has no such ceiling and costs one query, so the four
   * numbers a person actually reads off this screen are always exact. The
   * breakdowns below still come from the page, which is why `truncated` is
   * reported alongside them.
   */
  const totals = await prisma.financeEntry.groupBy({
    by: ["kind"],
    where: {
      organizationId,
      occurredOn: {
        gte: new Date(options.range.startMs),
        lt: new Date(options.range.endMs),
      },
    },
    _sum: { baseAmountMinor: true },
  });

  const exactRevenueMinor =
    totals.find((row) => row.kind === "revenue")?._sum.baseAmountMinor ?? 0;
  const exactExpenseMinor =
    totals.find((row) => row.kind === "expense")?._sum.baseAmountMinor ?? 0;

  const pagedSummary = summarizeFinance(entries, options.range);

  return {
    baseCurrency,
    range: { startMs: options.range.startMs, endMs: options.range.endMs },
    granularity,
    summary: {
      // Breakdowns keep the paged figures; the four headline numbers are
      // replaced with the exact ones.
      ...pagedSummary,
      revenueMinor: exactRevenueMinor,
      expenseMinor: exactExpenseMinor,
      netMinor: exactRevenueMinor - exactExpenseMinor,
      margin: profitMargin(exactRevenueMinor, exactExpenseMinor),
    },
    series: financeSeries(entries, options.range, granularity),
    // Pre-filtered: `financeByChannel` takes no range of its own, so the window
    // is applied here, once, with the same half-open bounds as the summary.
    byChannel: financeByChannel(entriesInRange(entries, options.range), channels),
    entries,
    categories,
    channels,
    rates,
    truncated: ledger.truncated,
  };
}
