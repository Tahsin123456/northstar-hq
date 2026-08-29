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
import { isUnmaintainedNote } from "@/lib/finance/unmaintained";
import { getCurrentOrgId, getCurrentOrgSettings, getOrgSettings, getScope } from "./user-service";

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
  source: true,
  isEstimated: true,
  previousAmountMinor: true,
  revisionCount: true,
  lastImportedAt: true,
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
  source: string;
  isEstimated: boolean;
  previousAmountMinor: number | null;
  revisionCount: number;
  lastImportedAt: Date | null;
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
    source: row.source,
    isEstimated: row.isEstimated,
    // Read here, once, so no screen has to parse the note for itself — and only
    // on an imported row, because the mark is a connector's statement about its
    // own figure. A hand-typed note that happens to open the same way is the
    // author's own sentence and is left to speak for itself.
    isUnmaintained: row.source !== "manual" && isUnmaintainedNote(row.notes),
    previousAmountMinor: row.previousAmountMinor,
    revisionCount: row.revisionCount,
    lastImportedAt: row.lastImportedAt?.getTime() ?? null,
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
 * How a finance entry is named in an audit summary — WITHOUT its amount.
 *
 * The figure used to be in the sentence: "Recorded a $4,100.00 revenue entry".
 * That put it beyond every permission check. `metadata` is redacted on read by
 * key, exactly, for a reader who lacks `finance.view` (see
 * `moneyPermissionFor` and `stripMoneyKeys`); the summary was returned verbatim
 * to anyone holding `audit.view`, which is individually grantable and therefore
 * a strictly wider group. An admin handing somebody the log to investigate an
 * incident was handing them every transaction value in the company, in prose.
 *
 * So the summary now identifies the entry rather than quoting it: which side of
 * the ledger, and the day it belongs to. That is enough to find the row — the
 * event also carries `targetId` — and a reader entitled to the figure still
 * reads it off `amountMinor` in the metadata sitting beside this line. The date
 * is the ISO day the metadata already uses, and stays ISO on purpose: a
 * locale-formatted date is one more thing that varies by whoever's process
 * wrote the row.
 */
function entryAuditLabel(entry: { kind: string; occurredOn: Date }): string {
  return `${entry.kind} entry dated ${isoDay(entry.occurredOn)}`;
}

/** The day part of a timestamp, as the log writes dates everywhere. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The audit record for a money movement — and, deliberately, what it leaves out.
 *
 * The amount, both currencies and the rate are here because "who moved money,
 * how much, and what it was worth" is the entire reason finance is audited at
 * all. They are here AND NOWHERE ELSE in the entry, which is what makes them
 * redactable: `listAuditEvents` strips these keys for a reader without
 * `finance.view`, and it can only do that for figures that live in a named
 * field rather than in a sentence.
 *
 * `notes` and `vendor` are not here, and that is not squeamishness: they are
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
    occurredOn: isoDay(entry.occurredOn),
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

/**
 * Refuses a hand edit that the next import would undo.
 *
 * WHY AN IMPORTED AMOUNT IS NOT EDITABLE
 * A YouTube row is written from `(organization, source, externalId)` and
 * rewritten on every sync. If somebody corrected the amount by hand, the next
 * run would overwrite the correction, the correction would be re-applied, and
 * the two would fight — silently, on a schedule, with the ledger telling a
 * different story depending on which ran last. The honest resolution is that
 * the connector owns the figure and the person owns everything around it.
 *
 * So the identity of the transaction is frozen — how much, in what currency,
 * which side of the ledger, when, and which channel it belongs to, all of which
 * either ARE the imported fact or are part of the key that finds the row again.
 * `platform` is frozen for the same mechanical reason: the import rewrites it.
 * Notes and category stay editable, because those are the team's own
 * annotations and nothing in the sync path touches them.
 *
 * THE TEST IS ON THE VALUE, NOT ON WHETHER THE FIELD WAS SENT.
 * `financeEntryUpdateSchema` is `createSchema.partial()` and the edit dialog
 * submits the whole object, so every save carries `amountMinor` whether or not
 * the user touched it. Keying off presence would make an imported entry's notes
 * un-editable — a guard that blocks the permitted edit and reads as a bug.
 */
function assertImportedEntryEditable(
  existing: {
    source: string;
    kind: string;
    occurredOn: Date;
    amountMinor: number;
    currency: string;
    channelId: string | null;
    platform: string | null;
  },
  input: FinanceEntryUpdateInput,
): void {
  if (existing.source === "manual") return;

  const changed: string[] = [];
  if (input.amountMinor !== undefined && input.amountMinor !== existing.amountMinor) {
    changed.push("the amount");
  }
  if (
    input.currency !== undefined &&
    normalizeCurrencyCode(input.currency) !== normalizeCurrencyCode(existing.currency)
  ) {
    changed.push("the currency");
  }
  if (input.kind !== undefined && input.kind !== toFinanceKind(existing.kind)) {
    changed.push("whether it is revenue or an expense");
  }
  if (
    input.occurredOn !== undefined &&
    toUtcMidnight(input.occurredOn).getTime() !== existing.occurredOn.getTime()
  ) {
    changed.push("the date");
  }
  if (input.channelId !== undefined && (input.channelId ?? null) !== existing.channelId) {
    changed.push("the channel");
  }
  if (input.platform !== undefined && nullableText(input.platform) !== existing.platform) {
    changed.push("the platform");
  }

  if (changed.length === 0) return;

  throw errors.invalidInput(
    `This entry was imported from YouTube, so ${changed.join(", ")} cannot be edited here — the ` +
      "next sync would overwrite the change. Its notes and category are yours to edit. If the " +
      "figure itself is wrong, correct it with a separate manual entry so both numbers stay " +
      "visible.",
    { source: existing.source },
  );
}

/**
 * Refuses a delete that the next import would undo — and that would take the
 * revision history with it.
 *
 * THE SAME DOOR AS THE EDIT GUARD, ON THE OTHER SIDE OF THE ROOM.
 * `assertImportedEntryEditable` above blocks correcting an imported figure by
 * hand because the connector owns it and the next run would overwrite the
 * correction. Deleting the row is that same argument with a wider blast radius,
 * so the two guards have to say the same thing or the restriction is theatre:
 * whatever cannot be edited because a sync would rewrite it cannot be deleted
 * because a sync would re-create it.
 *
 * IT DOES NOT EVEN STAY DELETED. `upsertImportedEntry` finds its row by the
 * unique `(organizationId, source, externalId)` key. Remove the row and that
 * `findUnique` returns null, the CREATE branch runs, and the month is written
 * back — a deletion undone on a schedule, by nobody, with no page to show it
 * happening.
 *
 * AND IT COMES BACK POORER THAN IT LEFT. A created row starts at
 * `previousAmountMinor: null` and `revisionCount: 0`. Those two columns are the
 * only record that a figure ever moved — that YouTube reported one number for
 * August and later reported another — and they cannot be reconstructed from
 * anywhere, because the Analytics API reports what a month is worth now, not
 * what it was previously said to be worth. So the round trip through delete
 * silently erases the history of every revision made to that month and returns
 * a row that claims to have always been its current value. Losing an audit
 * trail should not be something that happens behind a button labelled "Delete".
 *
 * The message names the mechanism rather than the rule, for the same reason the
 * edit guard does, and it names the ways out — annotate it, offset it, or stop
 * the import at its source. An admin looking at a figure they believe is wrong
 * has a real need here; refusing without answering it just moves the problem.
 */
function assertImportedEntryDeletable(existing: { source: string }): void {
  if (existing.source === "manual") return;

  // Named rather than assumed: `source` is free text on the schema and
  // "youtube" is only today's connector. Telling somebody their Stripe row came
  // from YouTube would be worse than saying nothing — and so would sending them
  // to the YouTube screen to turn it off.
  const isYouTube = existing.source === "youtube";
  const label = isYouTube ? "YouTube" : existing.source;
  const howToStop = isYouTube
    ? "To stop importing a channel's revenue altogether, disconnect its Google account under " +
      "Admin → YouTube"
    : `To stop importing these figures altogether, disconnect ${label} where it was connected`;

  throw errors.invalidInput(
    `This entry was imported from ${label}, so it cannot be deleted here — and deleting it ` +
      "would not keep it away. The next sync looks the row up by its external id, would not " +
      "find it, and would write the month back from scratch: the record of every figure " +
      `${label} has already revised for that month would be lost in the process. Its notes ` +
      "and category are yours to edit. If the amount is wrong, record a separate manual entry " +
      `for the difference so both numbers stay visible. ${howToStop} — the entries already in ` +
      "the ledger stay exactly where they are.",
    { source: existing.source },
  );
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
    summary: `Recorded a ${entryAuditLabel({ kind: input.kind, occurredOn })}`,
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
      platform: true,
      source: true,
    },
  });
  if (!existing) throw errors.notFound("finance entry");

  // Before anything is computed: an imported row's figures belong to the
  // connector that wrote them, and a correction here would be overwritten on
  // the next sync.
  assertImportedEntryEditable(existing, input);

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
    summary: `Updated a ${entryAuditLabel(updated)}`,
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

/**
 * Removes a typed entry. Only a typed one.
 *
 * `source` is selected for the same reason `updateEntry` selects it: this is
 * the other half of the imported-row guard, and a delete that did not read the
 * column would be a hole beside a locked door. See
 * `assertImportedEntryDeletable` for what the sync does with a row that is no
 * longer there.
 */
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
      source: true,
    },
  });
  if (!existing) throw errors.notFound("finance entry");

  // Before the row is touched: a connector-owned entry is not this endpoint's
  // to remove, and the removal would not survive the next sync anyway.
  assertImportedEntryDeletable(existing);

  await prisma.financeEntry.delete({ where: { id: existing.id } });

  // The audit entry is what survives the row. It is written after the delete
  // and carries the amount precisely because there is nothing left to look up:
  // a deletion nobody can quantify afterwards is not an audit trail. The amount
  // lives in `metadata` and not in the summary, so "nobody can quantify it"
  // stops meaning "unless they only hold audit.view".
  await auditFinance(request, {
    action: "finance.entry_deleted",
    summary: `Deleted a ${entryAuditLabel(existing)}`,
    targetType: "finance_entry",
    targetId: existing.id,
    targetLabel: existing.kind,
    metadata: entryAuditMetadata(existing),
  });

  return { id: existing.id };
}

// ---------------------------------------------------------------------------
// IMPORTED ENTRIES
//
// Rows a connector owns rather than a person. Everything here takes its
// organization as a PARAMETER and never reads a session: the caller is a
// scheduled job with no cookie, and one accidental `getScope()` would make the
// nightly import throw 401 in production while passing every test that happened
// to run signed in.
//
// The write still goes through `resolveConversion`, which is the point of
// putting this in finance-service instead of in the connector. There is exactly
// one place in this system that decides what a foreign amount is worth in the
// base currency, and an importer with its own copy would be a second one —
// free, in time, to assume a rate that the manual path refuses to assume.
// ---------------------------------------------------------------------------

/** What a connector needs in order to write one entry it owns. */
export interface ImportedEntryInput {
  readonly organizationId: string;
  /** The connector's name. Matches `FinanceEntry.source` and the unique index. */
  readonly source: string;
  /** Stable key for this row, e.g. `youtube:UC123:2026-08`. */
  readonly externalId: string;
  readonly kind: FinanceKind;
  /** Already normalised to UTC midnight by the caller. */
  readonly occurredOn: Date;
  readonly amountMinor: number;
  readonly currency: string;
  readonly categoryId: string;
  readonly channelId: string | null;
  readonly platform: string | null;
  /** Written only on create, so a note added afterwards is never overwritten. */
  readonly notes?: string | null;
  /** True when the source may still revise this figure. */
  readonly isEstimated?: boolean;
  /** How the audit trail names the connector, e.g. "YouTube revenue sync". */
  readonly actorLabel: string;
}

export interface ImportedEntryResult {
  readonly id: string;
  readonly created: boolean;
  /** True when this run overwrote a DIFFERENT figure than the one on file. */
  readonly revised: boolean;
  readonly amountMinor: number;
  readonly previousAmountMinor: number | null;
  readonly revisionCount: number;
}

/**
 * The category an importer files under, created once and then reused.
 *
 * Looked up by slug INCLUDING archived rows. If somebody archived "YouTube Ad
 * Revenue", creating a second one on the next sync would give the ledger two
 * categories with the same name and split the history between them; filing
 * under the archived one keeps every month in the same place. Archiving stops a
 * category being offered for new manual entries, which is a statement about the
 * form, not about rows that already belong there.
 */
export async function ensureImportCategory(
  organizationId: string,
  kind: FinanceKind,
  name: string,
): Promise<{ id: string; name: string }> {
  const trimmed = name.trim();
  const slug = toSlug(trimmed);
  const key = { organizationId_kind_slug: { organizationId, kind, slug } };

  const existing = await prisma.financeCategory.findUnique({
    where: key,
    select: { id: true, name: true },
  });
  if (existing) return existing;

  const count = await prisma.financeCategory.count({ where: { organizationId, kind } });

  try {
    return await prisma.financeCategory.create({
      data: { organizationId, kind, name: trimmed, slug, sortOrder: count },
      select: { id: true, name: true },
    });
  } catch {
    // Two runs racing on a first-ever sync both miss the read and both insert.
    // The unique index is what makes that safe; re-reading is what makes it
    // invisible. A throw here would fail an import over a collision whose
    // desired outcome — one category with this name — has just been reached.
    const raced = await prisma.financeCategory.findUnique({
      where: key,
      select: { id: true, name: true },
    });
    if (raced) return raced;
    throw errors.internal(new Error(`could not create the “${trimmed}” finance category`));
  }
}

/**
 * Writes one connector-owned entry, creating it or revising it in place.
 *
 * THE IDEMPOTENCY IS THE UNIQUE INDEX, NOT A CHECK.
 * `@@unique([organizationId, source, externalId])` is what makes re-running a
 * sync safe. This function reads that key and then creates or updates, so a
 * month imported ten times is one row; a `findFirst` on shape — same channel,
 * same total — would produce a second row the first time a figure was revised,
 * which is precisely when a duplicate is hardest to notice.
 *
 * A CHANGED FIGURE IS RECORDED AS A CHANGE.
 * YouTube states its revenue metrics are subject to month-end adjustment, so a
 * value moving is expected. `previousAmountMinor` and `revisionCount` mean the
 * row can say "this used to be something else" instead of silently appearing to
 * have always been the new number — and the audit entry is written only when
 * the figure actually moved, so an hourly no-op sync does not bury the log.
 */
export async function upsertImportedEntry(
  input: ImportedEntryInput,
): Promise<ImportedEntryResult> {
  const { organizationId } = input;
  const currency = normalizeCurrencyCode(input.currency);

  if (!Number.isSafeInteger(input.amountMinor)) {
    throw errors.invalidInput("An imported amount must be a whole number of minor units.");
  }
  if (Math.abs(input.amountMinor) > MAX_MONEY_MINOR) {
    throw errors.invalidInput(
      `The imported ${input.externalId} figure is too large to record as a single entry.`,
    );
  }
  if (!isSupportedCurrency(currency)) {
    throw errors.invalidInput(
      `${currency || "That currency"} is not one this app is configured to handle, so an imported ` +
        "amount in it cannot be scaled correctly. Add it to CURRENCIES in lib/finance/money.ts.",
    );
  }

  const settings = await getOrgSettings(organizationId);
  const baseCurrency = normalizeCurrencyCode(settings.baseCurrency);

  const existing = await prisma.financeEntry.findUnique({
    where: {
      organizationId_source_externalId: {
        organizationId,
        source: input.source,
        externalId: input.externalId,
      },
    },
    select: {
      id: true,
      amountMinor: true,
      currency: true,
      baseCurrency: true,
      exchangeRate: true,
      revisionCount: true,
      occurredOn: true,
      categoryId: true,
      channelId: true,
    },
  });

  /**
   * Zero takes its own path, because `resolveConversion` refuses one on purpose.
   *
   * For a TYPED entry, an amount that converts to zero is a mistake worth
   * stopping — somebody meant to record money and recorded none. An imported
   * zero is not a mistake: it is the source saying "nothing here", and it has to
   * be able to overwrite a figure that has since been revised away. Nothing is
   * being assumed by skipping the rate lookup, because zero converts to zero at
   * every rate; the previous row's rate is carried forward only so the column
   * stays comparable month to month.
   */
  const conversion =
    input.amountMinor === 0
      ? {
          baseAmountMinor: 0,
          baseCurrency,
          exchangeRate:
            existing && existing.baseCurrency === baseCurrency ? existing.exchangeRate : 1,
        }
      : await resolveConversion({
          organizationId,
          amountMinor: input.amountMinor,
          currency,
          baseCurrency,
        });

  const now = new Date();
  const platform = input.kind === "revenue" ? nullableText(input.platform) : null;

  const auditImport = async (
    action: AuditAction,
    summary: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> => {
    await recordAudit(
      {
        organizationId,
        // Null, and deliberately so: nobody did this. Attributing an imported
        // row to whichever admin happened to connect the Google account would
        // be a fabricated byline on a financial record.
        actorUserId: null,
        actorLabel: input.actorLabel,
      },
      { action, summary, targetType: "finance_entry", targetId, metadata },
    );
  };

  if (!existing) {
    const created = await prisma.financeEntry.create({
      data: {
        organizationId,
        kind: input.kind,
        occurredOn: input.occurredOn,
        amountMinor: input.amountMinor,
        currency,
        baseAmountMinor: conversion.baseAmountMinor,
        baseCurrency: conversion.baseCurrency,
        exchangeRate: conversion.exchangeRate,
        categoryId: input.categoryId,
        channelId: input.channelId,
        platform,
        notes: nullableText(input.notes ?? null),
        source: input.source,
        externalId: input.externalId,
        isEstimated: input.isEstimated ?? true,
        lastImportedAt: now,
        createdById: null,
      },
      select: { id: true },
    });

    await auditImport(
      "finance.entry_imported",
      `Imported a ${entryAuditLabel({ kind: input.kind, occurredOn: input.occurredOn })} ` +
        `from ${input.source}`,
      created.id,
      {
        ...entryAuditMetadata({
          kind: input.kind,
          occurredOn: input.occurredOn,
          amountMinor: input.amountMinor,
          currency,
          ...conversion,
          categoryId: input.categoryId,
          channelId: input.channelId,
        }),
        source: input.source,
        externalId: input.externalId,
      },
    );

    return {
      id: created.id,
      created: true,
      revised: false,
      amountMinor: input.amountMinor,
      previousAmountMinor: null,
      revisionCount: 0,
    };
  }

  const revised =
    existing.amountMinor !== input.amountMinor ||
    normalizeCurrencyCode(existing.currency) !== currency;

  const updated = await prisma.financeEntry.update({
    where: { id: existing.id },
    data: {
      occurredOn: input.occurredOn,
      amountMinor: input.amountMinor,
      currency,
      baseAmountMinor: conversion.baseAmountMinor,
      baseCurrency: conversion.baseCurrency,
      exchangeRate: conversion.exchangeRate,
      channelId: input.channelId,
      platform,
      isEstimated: input.isEstimated ?? true,
      lastImportedAt: now,
      // Only on a real change, so `revisionCount` counts revisions rather than
      // counting how many times the scheduler ran.
      ...(revised
        ? { previousAmountMinor: existing.amountMinor, revisionCount: { increment: 1 } }
        : {}),
      // `categoryId` and `notes` are pointedly absent. Re-filing an imported row
      // and annotating it are the two edits a person IS allowed to make (see
      // `assertImportedEntryEditable`), and a sync that rewrote them would undo
      // the edit it just permitted.
    },
    select: { id: true, revisionCount: true },
  });

  if (revised) {
    await auditImport(
      "finance.entry_revised",
      // The two figures the word "revised" refers to are in the metadata below
      // as `previousAmountMinor` and `amountMinor`, where a reader without
      // `finance.view` does not get them. Spelling "from X to Y" out here would
      // have handed the whole revision to anyone with `audit.view`, which is
      // the wider group.
      `${input.source} revised a ${entryAuditLabel({
        kind: input.kind,
        occurredOn: input.occurredOn,
      })}`,
      updated.id,
      {
        ...entryAuditMetadata({
          kind: input.kind,
          occurredOn: input.occurredOn,
          amountMinor: input.amountMinor,
          currency,
          ...conversion,
          categoryId: existing.categoryId,
          channelId: input.channelId,
        }),
        source: input.source,
        externalId: input.externalId,
        previousAmountMinor: existing.amountMinor,
        previousCurrency: existing.currency,
        revisionCount: updated.revisionCount,
      },
    );
  }

  return {
    id: updated.id,
    created: false,
    revised,
    amountMinor: input.amountMinor,
    previousAmountMinor: revised ? existing.amountMinor : null,
    revisionCount: updated.revisionCount,
  };
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
  /**
   * How much of the exact revenue total above is a figure a connector may still
   * revise, rather than money that has settled.
   *
   * Reported as its own number rather than left for the client to add up from
   * `entries`, for the same reason the headline totals are: the entry list is
   * capped, so a browser-side sum of estimated rows would understate the caveat
   * on exactly the busy periods where it matters most. It comes out of the same
   * grouped aggregate as the totals, so the two cannot disagree.
   *
   * `revenueMinor` INCLUDES this — it is a share of that figure, never an
   * addition to it. Zero means every figure in the period is settled, which is
   * a different statement from "we do not know", and the dashboard says nothing
   * at all in that case rather than reassuring the reader about nothing.
   */
  readonly estimated: {
    readonly revenueMinor: number;
    readonly entryCount: number;
  };
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
    // Grouped by estimate-ness as well as by side, which costs nothing — at most
    // four rows come back — and means the "part of this is an estimate" caveat
    // is derived from the same exact aggregate as the figure it qualifies. A
    // second query could see a different moment and put a caveat on the page
    // that does not match the number above it.
    by: ["kind", "isEstimated"],
    where: {
      organizationId,
      occurredOn: {
        gte: new Date(options.range.startMs),
        lt: new Date(options.range.endMs),
      },
    },
    _sum: { baseAmountMinor: true },
    _count: { _all: true },
  });

  let exactRevenueMinor = 0;
  let exactExpenseMinor = 0;
  let estimatedRevenueMinor = 0;
  let estimatedEntryCount = 0;

  for (const row of totals) {
    const amount = row._sum.baseAmountMinor ?? 0;
    if (toFinanceKind(row.kind) === "revenue") {
      exactRevenueMinor += amount;
      if (row.isEstimated) {
        estimatedRevenueMinor += amount;
        estimatedEntryCount += row._count._all;
      }
    } else {
      exactExpenseMinor += amount;
    }
  }

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
    estimated: {
      revenueMinor: estimatedRevenueMinor,
      entryCount: estimatedEntryCount,
    },
  };
}
