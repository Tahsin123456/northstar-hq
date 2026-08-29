import "server-only";

import { prisma } from "@/server/db";
import { AppError, errors, toAppError } from "@/server/errors";
import { recordAudit } from "@/server/audit/audit-service";
import { MAX_MONEY_MINOR, minorUnitsFor, normalizeCurrencyCode } from "@/lib/finance/money";
// The mark lives beside the finance types, not here, because the ledger has to
// read the same string this file writes. See `lib/finance/unmaintained.ts`.
import { UNMAINTAINED_NOTE_PREFIX } from "@/lib/finance/unmaintained";
import { ensureImportCategory, upsertImportedEntry } from "./finance-service";
import { getOrgSettings } from "./user-service";
import { getValidAccessToken } from "./youtube-oauth-service";

/**
 * =========================================================================
 * YOUTUBE REVENUE — READING IT, STORING IT, AND WHAT IT IS NOT
 * =========================================================================
 *
 * WHERE THE NUMBER COMES FROM
 * Not from the YouTube Data API this app already talks to. There is no revenue
 * field anywhere in `channels.list` or `videos.list`, and no amount of
 * `youtube.readonly` produces one. Revenue lives in a different product — the
 * YouTube Analytics API, `GET youtubeanalytics.googleapis.com/v2/reports` —
 * behind a different scope, and it is read with the channel owner's OAuth token
 * rather than with the shared API key. That is why this module exists beside
 * `youtube/client.ts` instead of inside it: same vendor, different API,
 * different credential, different failure modes.
 *
 * THE FIGURE IS AN ESTIMATE AND THIS FILE NEVER PRETENDS OTHERWISE
 * Google states plainly that these metrics are subject to month-end adjustment.
 * A day's revenue moving after the fact is the normal case, not a fault, so
 * every daily row carries `previousEstimatedRevenueMinor` and a `revisionCount`
 * and every ledger entry is written with `isEstimated: true`. A revision is
 * visible by design; nothing here overwrites a number as though it had always
 * been that.
 *
 * FOUR THINGS THAT ARE NOT THE SAME, AND ARE NEVER CONFLATED
 *   • "reported_zero" — we asked, Google ANSWERED, and every day in the window
 *     came back zero. That is an observation, and it is the whole of what we
 *     have: the likeliest reason is a channel outside the Partner Programme,
 *     but a channel earning fractions of a cent a day sends the same zeros.
 *     The reason is offered as a reason, never recorded as a finding.
 *   • "not_monetized" — Google REFUSED to produce a revenue report for a
 *     connection whose grant provably covers one. That refusal is evidence; a
 *     window of zeros is not. What it is evidence OF is narrower than the name
 *     suggests: Google answers the same way for a channel outside the Partner
 *     Programme and for one this account no longer owns, and does not say
 *     which. So it is the refusal that gets displayed, not a verdict on the
 *     channel. A fact to display, not an error.
 *   • "no_scope"      — we were never given permission to ask. The honest
 *     answer is "we could not ask", and it is NOT zero.
 *   • "error"         — we asked and something went wrong. Says what and what
 *     to do about it.
 * Reporting any of the four as "$0.00 revenue" would be a fabricated figure
 * sitting in a financial report, which is the one outcome this module exists to
 * prevent.
 *
 * NO SESSION, BY CONSTRUCTION
 * Nothing here calls `getScope()` or `getCurrentOrgId()`. The organization is
 * always a parameter, and settings come from `getOrgSettings(organizationId)`.
 * The caller is a scheduler with no cookie; one session-dependent call would
 * make the nightly import throw 401 in production and pass every test that
 * happened to run signed in.
 */

const ANALYTICS_ENDPOINT = "https://youtubeanalytics.googleapis.com/v2/reports";

const REQUEST_TIMEOUT_MS = 20_000;

const MS_PER_DAY = 86_400_000;

/**
 * The metrics requested, in the order Google documents them.
 *
 * `estimatedRevenue` is the total — ads plus YouTube Premium — and is the one
 * that reaches the ledger. The other two are stored alongside it because
 * "where did this month's money come from" is the first question anybody asks
 * of a revenue line, and re-querying history to answer it later is not
 * possible: the Analytics API only reports what a channel earns going forward.
 */
const METRICS = ["estimatedRevenue", "estimatedAdRevenue", "estimatedRedPartnerRevenue"] as const;

/**
 * The currency figures are requested in, and the currency they are stored in.
 *
 * The Analytics API converts monetary metrics to whatever `currency` asks for
 * and defaults to USD. Sending it explicitly rather than relying on that
 * default means the stored `currency` is a fact about the request we made, not
 * an assumption about a default that could change under us — and every
 * `ChannelRevenueDay` in the table is then directly comparable.
 *
 * It is deliberately NOT the organization's base currency. Asking Google to do
 * the conversion would put an unverifiable rate, chosen by a third party and
 * recorded nowhere, inside a financial report. The base figure is produced by
 * this app's own `resolveConversion` instead, from a rate an admin configured
 * and which is stored on the entry — the same path every manual entry takes,
 * and the same one that refuses to guess when no rate exists.
 */
const REPORTING_CURRENCY = "USD";

/**
 * How far back each run re-reads.
 *
 * YouTube's figures for roughly the last three days are incomplete, and the
 * whole current month is still subject to adjustment at its close. Fetching
 * only days we have never seen would therefore freeze every figure at its
 * least accurate value — the first thing YouTube said, before the revisions
 * that were always coming. Re-reading a trailing window plus the current month
 * is what lets a revision actually land, and it costs the same single API call.
 */
const TRAILING_DAYS = 10;

/** The category imported revenue is filed under. Created once, then reused. */
const REVENUE_CATEGORY_NAME = "YouTube Ad Revenue";

/** `FinanceEntry.source` for everything this module writes. */
export const YOUTUBE_SOURCE = "youtube";

/** How the audit trail names this connector. */
const ACTOR_LABEL = "YouTube revenue sync";

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

/**
 * Mirrors `YouTubeConnection.revenueSyncStatus`.
 *
 * "reported_zero" is deliberately separate from "not_monetized": one is a
 * report we received, the other is a refusal we interpreted. See the header.
 */
export type RevenueSyncStatus =
  | "never"
  | "ok"
  | "error"
  | "no_scope"
  | "not_monetized"
  | "reported_zero";

/** Mirrors `YouTubeConnection.monetizationStatus`. */
export type MonetizationStatus = "unknown" | "monetized" | "not_monetized";

export interface RevenueWindow {
  /** Inclusive, UTC. */
  readonly startDate: Date;
  /** Inclusive, UTC. */
  readonly endDate: Date;
  /**
   * When the scheduler will look again. Recorded on the connection so the admin
   * screen can distinguish "nothing has happened yet" from "nothing is going
   * to happen".
   */
  readonly nextSyncAt?: Date | null;
}

export interface RevenueFetchResult {
  readonly connectionId: string;
  readonly label: string;
  /** The internal `Channel.id`, once resolved. */
  readonly channelId: string | null;
  readonly status: RevenueSyncStatus;
  readonly monetizationStatus: MonetizationStatus;
  /** Daily rows written or refreshed. */
  readonly daysWritten: number;
  /** Of those, how many carried a figure different from the one on file. */
  readonly daysRevised: number;
  /** Total across the fetched window, minor units of `currency`. */
  readonly totalMinor: number;
  readonly currency: string;
  /** Present for every status except "ok"; written so it names the next action. */
  readonly message: string | null;
}

export interface RevenueSyncError {
  readonly connectionId: string | null;
  readonly label: string;
  readonly message: string;
}

export interface FinanceRollupSummary {
  readonly entriesCreated: number;
  readonly entriesRevised: number;
  readonly entriesUnchanged: number;
  readonly errors: readonly RevenueSyncError[];
}

export interface RevenueSyncSummary {
  readonly organizationId: string;
  readonly connectionsConsidered: number;
  /** Connections that returned a report. */
  readonly connectionsSynced: number;
  /** Skipped without an API call — no scope, or needing re-authorisation. */
  readonly connectionsSkipped: number;
  readonly failed: number;
  readonly daysWritten: number;
  readonly daysRevised: number;
  readonly entriesCreated: number;
  readonly entriesRevised: number;
  readonly errors: readonly RevenueSyncError[];
}

// ---------------------------------------------------------------------------
// DATES
// ---------------------------------------------------------------------------

function startOfUtcDay(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** `YYYY-MM-DD`, the only date shape the Analytics API accepts. */
function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` from a report row -> UTC midnight, or null if it is not a date.
 *
 * YouTube's `day` dimension is the channel's own reporting day, which is
 * Pacific time, not UTC. Storing it at UTC midnight does not pretend otherwise:
 * the date STRING is preserved exactly as reported, and midnight is only the
 * canonical instant this codebase parks a date on (the same convention
 * `FinanceEntry.occurredOn` uses). Shifting the value to "correct" the timezone
 * would move revenue between days — and, at a month boundary, between monthly
 * entries — for no gain, since Google's day is the unit it will revise.
 */
function parseDay(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** The `YYYY-MM` a day belongs to — the key a monthly rollup groups on. */
function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** UTC midnight on the last day of the month containing `date`. */
function lastDayOfMonth(date: Date): Date {
  // Day 0 of the *next* month is the last day of this one, and `Date.UTC`
  // handles the December rollover and February's length without a table.
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

/**
 * The window one run re-reads: the trailing days, extended back to the first of
 * the current month whenever that is earlier.
 *
 * `endDate` is today rather than three days ago. YouTube simply returns fewer
 * rows for days it has not finished computing, and asking for them costs
 * nothing — whereas guessing at the lag and stopping short would mean the most
 * recent complete day is never read until the following run.
 */
export function revenueWindowFor(now: Date = new Date()): { startDate: Date; endDate: Date } {
  const today = startOfUtcDay(now.getTime());
  const trailingStart = today - TRAILING_DAYS * MS_PER_DAY;
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

  return {
    startDate: new Date(Math.min(trailingStart, monthStart)),
    endDate: new Date(today),
  };
}

// ---------------------------------------------------------------------------
// MONEY
// ---------------------------------------------------------------------------

/**
 * A reported figure -> integer minor units, or null if it cannot be read.
 *
 * The Analytics API returns money as a JSON number, so a float is what arrives
 * whether we like it or not; this is the boundary where it stops being one and
 * every sum downstream is exact.
 *
 * WHY THE ROUNDING IS DONE ON DIGITS AND NOT ON THE NUMBER
 * Both obvious approaches are wrong in the same direction. `Math.round(v * 100)`
 * multiplies a value that is already imprecise by a value that cannot represent
 * the result. `v.toFixed(2)` looks like it fixes that and does not: it rounds
 * the EXACT binary value, and the double nearest 1.005 is 1.00499999999…, so
 * `(1.005).toFixed(2)` is "1.00". A cent lost that way is a cent somebody
 * reconciles against a payout statement and cannot find.
 *
 * `String(v)` gives the shortest decimal that round-trips to the same double —
 * "1.005" — which is the closest thing available to the text Google actually
 * sent, since JSON.parse threw the original away. Rounding that digit string
 * half-away-from-zero is the same technique `parseMoneyToMinor` uses on typed
 * input, and for the same reason.
 *
 * (It cannot simply CALL `parseMoneyToMinor`. That function reads human input,
 * where a three-digit tail means a thousands group — "1.234" is 1234 — which is
 * exactly the wrong reading of a machine float, where 1.234 is one and a bit.)
 *
 * The digit count comes from the currency rather than a hardcoded 100, the same
 * reason `minorUnitsFor` exists at all: JPY has no minor unit, and assuming two
 * would report ¥1,200 as ¥12.
 *
 * Null rather than zero for anything unreadable. Zero is a revenue figure, and
 * inventing one from a malformed response is exactly the fabrication this
 * module refuses to make.
 */
export function toMinorUnits(value: unknown, currency: string): number | null {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) return null;

  const digits = minorUnitsFor(currency);

  // Below half a minor unit the correctly rounded answer is zero whatever the
  // notation. Handled first so a figure small enough that JavaScript prints it
  // in exponential form ("1e-7") is rounded rather than read as malformed —
  // and so every value that reaches the digit code below is one `String`
  // renders positionally.
  if (Math.abs(numeric) < 0.5 / 10 ** digits) return 0;

  const text = Math.abs(numeric).toString();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;

  const [whole, fraction = ""] = text.split(".");
  const kept = fraction.slice(0, digits).padEnd(digits, "0");
  const dropped = fraction.slice(digits);

  let magnitude = Number(`${whole}${kept}`);
  if (!Number.isSafeInteger(magnitude)) return null;
  // Half away from zero, so a figure and a clawback of the same size round to
  // the same magnitude — `Math.round` sends 2.5 to 3 but -2.5 to -2.
  if (dropped.length > 0 && Number(dropped[0]) >= 5) magnitude += 1;

  if (!Number.isSafeInteger(magnitude) || magnitude > MAX_MONEY_MINOR) return null;
  return numeric < 0 ? -magnitude : magnitude;
}

// ---------------------------------------------------------------------------
// THE ANALYTICS CALL
// ---------------------------------------------------------------------------

interface AnalyticsColumnHeader {
  readonly name?: string;
  readonly columnType?: string;
  readonly dataType?: string;
}

interface AnalyticsReport {
  readonly columnHeaders?: readonly AnalyticsColumnHeader[];
  readonly rows?: readonly (readonly unknown[])[];
  readonly error?: AnalyticsErrorDetail;
}

interface AnalyticsErrorDetail {
  readonly code?: number;
  readonly message?: string;
  readonly status?: string;
  readonly errors?: readonly { readonly reason?: string; readonly message?: string }[];
}

interface AnalyticsResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: AnalyticsReport;
}

/**
 * One outbound Analytics request. Exactly one, with no retry loop.
 *
 * The Data API client next door retries with backoff; this one deliberately
 * does not. A revenue sync runs on the same schedule as everything else and the
 * next run is minutes away, so a transient failure costs a delay rather than a
 * gap — while a retry loop would multiply the per-connection call budget by
 * three for a figure that is not urgent. The quota rule for this job is one
 * call per connection per run, and it is kept here rather than trusted to
 * callers.
 */
async function requestReport(
  accessToken: string,
  params: Record<string, string>,
): Promise<AnalyticsResponse> {
  const url = new URL(ANALYTICS_ENDPOINT);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        // The credential goes in the header, never in the query string: URLs
        // reach access logs and error reports, and this one is a live token.
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
      cache: "no-store",
    });

    let body: AnalyticsReport = {};
    try {
      body = (await response.json()) as AnalyticsReport;
    } catch {
      // A non-JSON body is an outage, not a protocol to interpret. `ok` and
      // `status` carry the outcome on their own.
    }

    return { ok: response.ok, status: response.status, body };
  } catch (caught) {
    if (caught instanceof Error && caught.name === "AbortError") {
      throw new AppError("NETWORK_ERROR", "YouTube Analytics did not respond in time.", {
        cause: caught,
      });
    }
    throw errors.network(caught);
  } finally {
    clearTimeout(timeout);
  }
}

interface FailureVerdict {
  readonly status: Extract<RevenueSyncStatus, "error" | "no_scope" | "not_monetized">;
  readonly message: string;
  /** True when Google itself says the grant does not cover this report. */
  readonly scopeRejected: boolean;
}

/**
 * What a failed Analytics response actually means, in this app's vocabulary.
 *
 * The hard case is 403, which Google uses for three unrelated situations. The
 * reason string separates two of them outright — a spent quota and an explicit
 * "insufficient permissions". The third is the interesting one: a channel
 * outside the Partner Programme has no monetary report to give, and Google
 * refuses the request rather than answering with zeros.
 *
 * This is reached only when the stored scope string PROVES the monetary scope
 * was granted, which is what makes the inference safe: permission is not in
 * question, so a refusal is about the channel. The message says exactly that
 * reasoning out loud rather than asserting a fact we did not receive.
 *
 * "About the channel" is as far as the evidence goes, and that is deliberate.
 * Two different situations land here — a channel outside the Partner Programme,
 * and a channel the Google account behind this connection no longer owns — and
 * the response does not tell them apart: same 403, same reason code, and a body
 * that names neither the channel nor the account. Splitting the verdict would
 * mean inventing a distinction Google does not report, so the status stays one
 * status and the message names both readings with the next action for each.
 * Every screen that renders this state reports the refusal, not a membership
 * finding; see the Monetisation column on Admin → YouTube.
 */
function describeAnalyticsFailure(response: AnalyticsResponse): FailureVerdict {
  const detail = response.body.error;
  const reason = detail?.errors?.[0]?.reason ?? detail?.status ?? "";
  const upstream = detail?.message ?? `HTTP ${response.status}`;

  if (response.status === 401) {
    return {
      status: "error",
      message:
        "Google rejected the stored credentials for this connection. Reconnect the account from " +
        "Admin → YouTube to restore revenue syncing.",
      scopeRejected: false,
    };
  }

  if (response.status === 403) {
    if (/quotaExceeded|dailyLimitExceeded/i.test(reason)) {
      return {
        status: "error",
        message:
          "The YouTube Analytics quota for this project is used up for the day. Revenue will be " +
          "read again on the next run after the quota resets; nothing already imported is affected.",
        scopeRejected: false,
      };
    }
    if (/rateLimitExceeded|userRateLimitExceeded/i.test(reason)) {
      return {
        status: "error",
        message:
          "YouTube is rate-limiting this account right now. The next scheduled run will try again.",
        scopeRejected: false,
      };
    }
    /**
     * The discriminator is the REASON CODE, not the word "insufficient".
     *
     * Both 403s say "insufficient" in their human message — a missing scope
     * reads "Request had insufficient authentication scopes", and a channel
     * outside the programme reads "Insufficient permissions to access this
     * report". Matching on the prose would file every non-monetised channel as
     * a permissions problem and send its owner round a consent flow that
     * changes nothing. The machine-readable reason separates them cleanly, and
     * the one message phrase matched here is the scope error's own wording.
     */
    if (
      /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions|insufficientScope|unauthorized_client/i.test(
        reason,
      ) ||
      /insufficient authentication scopes/i.test(upstream)
    ) {
      return {
        status: "no_scope",
        message:
          "Google refused the revenue report because this connection lacks the permission to read " +
          "it. Reconnect the account and leave every permission ticked on the consent screen.",
        scopeRejected: true,
      };
    }
    return {
      status: "not_monetized",
      /*
       * TWO READINGS, AND THE REFUSAL DOES NOT SAY WHICH.
       *
       * Google returns the same 403 with the same reason code whether the
       * channel is outside the Partner Programme or the connected account no
       * longer owns it, and the body names neither the channel nor the account.
       * The codes that ARE machine-readable — quota, rate limit, scope — are
       * routed out above this branch, so there is nothing left to narrow on.
       *
       * An earlier version of this message led with the Partner Programme
       * reading and added "nothing here needs fixing", relegating the ownership
       * case to a trailing sentence. That is the worse way round to be wrong: a
       * studio whose channel moved to a different Google account would read
       * "nothing needs fixing" about the one thing that did, and go on believing
       * a monetised channel simply earns nothing. So both readings are stated
       * evenly, and the one with an action attached is named first.
       */
      message:
        "YouTube refused a revenue report for this channel even though permission to read one was " +
        "granted. That refusal has two possible meanings and it does not say which: either the " +
        "Google account behind this connection no longer owns the channel — in which case " +
        "reconnect using the account that does — or the channel is not in the YouTube Partner " +
        "Programme, in which case there is genuinely no revenue to report and the next run will " +
        "pick the figures up if it joins.",
      scopeRejected: false,
    };
  }

  if (response.status === 429) {
    return {
      status: "error",
      message:
        "YouTube is rate-limiting this account right now. The next scheduled run will try again.",
      scopeRejected: false,
    };
  }

  if (response.status === 400) {
    return {
      status: "error",
      message:
        "YouTube rejected the revenue request as malformed. This usually means the channel " +
        "identifier on this connection is no longer valid — reconnect the account.",
      scopeRejected: false,
    };
  }

  return {
    status: "error",
    message: `YouTube Analytics returned an unexpected error (HTTP ${response.status}). The next scheduled run will try again.`,
    scopeRejected: false,
  };
}

// ---------------------------------------------------------------------------
// PARSING THE REPORT
// ---------------------------------------------------------------------------

interface DailyRevenue {
  readonly day: Date;
  readonly estimatedRevenueMinor: number;
  readonly estimatedAdRevenueMinor: number;
  readonly estimatedRedPartnerRevenueMinor: number;
}

/**
 * `columnHeaders` + `rows` -> typed daily figures.
 *
 * The columns are located BY NAME. Google returns the metrics in the order they
 * were requested today, and building on that would work perfectly until the day
 * it silently did not — at which point ad revenue would be filed as total
 * revenue and the ledger would be wrong with no error anywhere. The header row
 * exists precisely so the response can be self-describing; using it costs one
 * map and removes an entire class of silent corruption.
 *
 * A row with an unreadable value is dropped whole rather than partially
 * salvaged. Half a row is a made-up row.
 */
export function readReport(
  report: AnalyticsReport,
  currency: string,
): { days: DailyRevenue[]; malformedRows: number } {
  const columns = new Map<string, number>();
  for (const [index, header] of (report.columnHeaders ?? []).entries()) {
    if (header?.name) columns.set(header.name, index);
  }

  const dayIndex = columns.get("day");
  const revenueIndex = columns.get("estimatedRevenue");
  if (dayIndex === undefined || revenueIndex === undefined) {
    throw errors.upstream(
      "YouTube Analytics returned a report without the day and revenue columns that were asked " +
        "for, so it could not be read. The next scheduled run will try again.",
    );
  }

  const adIndex = columns.get("estimatedAdRevenue");
  const redIndex = columns.get("estimatedRedPartnerRevenue");

  const days: DailyRevenue[] = [];
  let malformedRows = 0;

  for (const row of report.rows ?? []) {
    const day = parseDay(row[dayIndex]);
    const estimatedRevenueMinor = toMinorUnits(row[revenueIndex], currency);
    const estimatedAdRevenueMinor =
      adIndex === undefined ? 0 : toMinorUnits(row[adIndex], currency);
    const estimatedRedPartnerRevenueMinor =
      redIndex === undefined ? 0 : toMinorUnits(row[redIndex], currency);

    if (
      day === null ||
      estimatedRevenueMinor === null ||
      estimatedAdRevenueMinor === null ||
      estimatedRedPartnerRevenueMinor === null
    ) {
      malformedRows += 1;
      continue;
    }

    days.push({
      day,
      estimatedRevenueMinor,
      estimatedAdRevenueMinor,
      estimatedRedPartnerRevenueMinor,
    });
  }

  return { days, malformedRows };
}

// ---------------------------------------------------------------------------
// WRITING THE DAILY ROWS
// ---------------------------------------------------------------------------

/**
 * Upserts a window of days on `(organizationId, channelId, day)`.
 *
 * The existing rows are read first, in one query, so a CHANGED figure can be
 * recognised as a change: `previousEstimatedRevenueMinor` keeps what the day
 * used to say and `revisionCount` counts how often it has moved. Without that
 * read the upsert would still be idempotent and the history would still be
 * silently rewritten — and "YouTube revised this day down by $40 last Tuesday"
 * is exactly the thing somebody reconciling a payout needs to be able to see.
 *
 * `revisionCount` counts revisions, not runs: an unchanged day only has its
 * `fetchedAt` refreshed.
 */
async function writeDailyRows(params: {
  organizationId: string;
  channelId: string;
  connectionId: string;
  currency: string;
  days: readonly DailyRevenue[];
}): Promise<{ written: number; revised: number }> {
  const { organizationId, channelId, connectionId, currency, days } = params;
  if (days.length === 0) return { written: 0, revised: 0 };

  const dayTimes = days.map((entry) => entry.day);
  const existing = await prisma.channelRevenueDay.findMany({
    where: { organizationId, channelId, day: { in: dayTimes } },
    select: { day: true, estimatedRevenueMinor: true },
  });
  const previousByDay = new Map(
    existing.map((row) => [row.day.getTime(), row.estimatedRevenueMinor]),
  );

  const fetchedAt = new Date();
  let revised = 0;

  for (const entry of days) {
    const previous = previousByDay.get(entry.day.getTime());
    const changed = previous !== undefined && previous !== entry.estimatedRevenueMinor;
    if (changed) revised += 1;

    await prisma.channelRevenueDay.upsert({
      where: {
        organizationId_channelId_day: { organizationId, channelId, day: entry.day },
      },
      create: {
        organizationId,
        channelId,
        connectionId,
        day: entry.day,
        estimatedRevenueMinor: entry.estimatedRevenueMinor,
        estimatedAdRevenueMinor: entry.estimatedAdRevenueMinor,
        estimatedRedPartnerRevenueMinor: entry.estimatedRedPartnerRevenueMinor,
        currency,
        fetchedAt,
      },
      update: {
        connectionId,
        estimatedRevenueMinor: entry.estimatedRevenueMinor,
        estimatedAdRevenueMinor: entry.estimatedAdRevenueMinor,
        estimatedRedPartnerRevenueMinor: entry.estimatedRedPartnerRevenueMinor,
        currency,
        fetchedAt,
        ...(changed
          ? { previousEstimatedRevenueMinor: previous, revisionCount: { increment: 1 } }
          : {}),
      },
    });
  }

  return { written: days.length, revised };
}

// ---------------------------------------------------------------------------
// ONE CONNECTION
// ---------------------------------------------------------------------------

/** Everything a run records about how a connection's revenue read went. */
async function recordConnectionOutcome(
  connectionId: string,
  outcome: {
    status: RevenueSyncStatus;
    monetizationStatus?: MonetizationStatus;
    message?: string | null;
    succeeded: boolean;
    nextSyncAt?: Date | null;
  },
): Promise<void> {
  const now = new Date();
  await prisma.youTubeConnection.update({
    where: { id: connectionId },
    data: {
      revenueSyncStatus: outcome.status,
      // Truncated for the same reason `lastError` is: an upstream message is
      // not a field this app controls the length of.
      revenueSyncError: outcome.message ? outcome.message.slice(0, 500) : null,
      ...(outcome.monetizationStatus ? { monetizationStatus: outcome.monetizationStatus } : {}),
      ...(outcome.succeeded
        ? {
            lastRevenueSyncAt: now,
            // Also the connection's general "last successfully used" marker. A
            // completed Analytics report proves the stored credentials still
            // work, which is the question this column was always answering.
            lastSyncAt: now,
          }
        : {}),
      ...(outcome.nextSyncAt !== undefined ? { nextSyncAt: outcome.nextSyncAt } : {}),
    },
  });
}

/**
 * Reads one connection's revenue for a window and stores it.
 *
 * Every exit records a status on the connection, including the ones that never
 * reach Google. A connection that silently does nothing is indistinguishable
 * from a channel that earned nothing, and the whole point of the status column
 * is that those are different sentences.
 *
 * Takes a connection id that the caller resolved from an org-scoped query — the
 * same contract `getValidAccessToken` works to, and the reason this function
 * does not take an organization of its own to filter on.
 */
export async function fetchRevenueForConnection(
  connectionId: string,
  window: RevenueWindow,
): Promise<RevenueFetchResult> {
  const connection = await prisma.youTubeConnection.findUnique({
    where: { id: connectionId },
    select: {
      id: true,
      organizationId: true,
      youtubeChannelId: true,
      channelTitle: true,
      googleAccountEmail: true,
      status: true,
      revenueScopeGranted: true,
      monetizationStatus: true,
    },
  });
  if (!connection) throw errors.notFound("YouTube connection");

  const label = connection.channelTitle ?? connection.googleAccountEmail ?? "Google account";
  // Left `undefined` when the caller did not supply one, so a one-off manual
  // read does not erase the scheduled time the last sweep recorded. An explicit
  // `null` still clears it, which is the caller saying so rather than omitting.
  const nextSyncAt = window.nextSyncAt;

  // Captured by `fail` below, so a failure that happens AFTER the channel was
  // resolved still reports which channel it was about.
  let resolvedChannelId: string | null = null;

  const fail = async (
    status: Extract<RevenueSyncStatus, "error" | "no_scope" | "not_monetized">,
    message: string,
    monetizationStatus?: MonetizationStatus,
  ): Promise<RevenueFetchResult> => {
    await recordConnectionOutcome(connection.id, {
      status,
      message,
      monetizationStatus,
      // "not_monetized" is a completed read, not a failure: we asked and got a
      // definitive answer, so the connection has demonstrably been used.
      succeeded: status === "not_monetized",
      nextSyncAt,
    });
    return {
      connectionId: connection.id,
      label,
      channelId: resolvedChannelId,
      status,
      monetizationStatus: monetizationStatus ?? toMonetizationStatus(connection.monetizationStatus),
      daysWritten: 0,
      daysRevised: 0,
      totalMinor: 0,
      currency: REPORTING_CURRENCY,
      message,
    };
  };

  // Checked before anything is spent. A connection made before the monetary
  // scope was ever requested must say "reconnect to enable revenue" every night
  // rather than burning a call to be told 403 every night.
  if (!connection.revenueScopeGranted) {
    return fail(
      "no_scope",
      "This connection was authorised before Northstar HQ could read revenue, or the revenue " +
        "permission was declined. Reconnect the Google account and leave every permission ticked " +
        "to enable revenue.",
    );
  }

  if (connection.status !== "connected") {
    return fail(
      "error",
      "This connection needs to be reconnected before anything can be read from it, including " +
        "revenue. Reconnect the Google account from Admin → YouTube.",
    );
  }

  if (!connection.youtubeChannelId) {
    return fail(
      "error",
      "This Google account does not own a YouTube channel, so there is no channel whose revenue " +
        "could be read. Connect the account that owns the channel instead.",
    );
  }

  // `Channel` is global and shared between organizations; the row this
  // connection's revenue belongs to is found by its YouTube id. The tenancy
  // comes from the connection, which was itself read org-scoped by the caller,
  // and every row written below carries `organizationId` explicitly.
  const channel = await prisma.channel.findUnique({
    where: { youtubeChannelId: connection.youtubeChannelId },
    select: { id: true },
  });
  if (!channel) {
    return fail(
      "error",
      "This channel is not in the tracker yet, so there is nowhere to file its revenue. It will " +
        "appear after the next channel sync, and revenue will follow on the run after that.",
    );
  }
  resolvedChannelId = channel.id;

  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(connection.id);
  } catch (caught) {
    // `getValidAccessToken` has already recorded `needs_reauth` and a readable
    // reason on the connection when the grant is gone. Repeating its message
    // here keeps the revenue column self-explanatory.
    return fail("error", toAppError(caught).userMessage);
  }

  let response: AnalyticsResponse;
  try {
    response = await requestReport(accessToken, {
      /**
       * The channel is named explicitly rather than with `channel==MINE`.
       *
       * `MINE` resolves to whichever channel the token's account is currently
       * acting as, which for an account that owns several is not a stable
       * answer — and this row's revenue is filed against one specific Channel
       * id. Naming the channel means a report either belongs to the channel we
       * are storing it under or fails outright, instead of quietly attributing
       * one channel's earnings to another.
       */
      ids: `channel==${connection.youtubeChannelId}`,
      startDate: formatDay(window.startDate),
      endDate: formatDay(window.endDate),
      metrics: METRICS.join(","),
      dimensions: "day",
      currency: REPORTING_CURRENCY,
      sort: "day",
    });
  } catch (caught) {
    return fail("error", toAppError(caught).userMessage);
  }

  if (!response.ok) {
    const verdict = describeAnalyticsFailure(response);

    // Google is the authority on what the grant covers. When it says the scope
    // is missing, the stored flag was wrong — clear it so the UI stops
    // promising revenue and starts asking for a reconnection.
    if (verdict.scopeRejected) {
      await prisma.youTubeConnection.update({
        where: { id: connection.id },
        data: { revenueScopeGranted: false },
      });
    }

    return fail(
      verdict.status,
      verdict.message,
      verdict.status === "not_monetized" ? "not_monetized" : undefined,
    );
  }

  let parsed: { days: DailyRevenue[]; malformedRows: number };
  try {
    parsed = readReport(response.body, REPORTING_CURRENCY);
  } catch (caught) {
    return fail("error", toAppError(caught).userMessage);
  }

  const written = await writeDailyRows({
    organizationId: connection.organizationId,
    channelId: channel.id,
    connectionId: connection.id,
    currency: REPORTING_CURRENCY,
    days: parsed.days,
  });

  const totalMinor = parsed.days.reduce((sum, entry) => sum + entry.estimatedRevenueMinor, 0);
  const previousMonetization = toMonetizationStatus(connection.monetizationStatus);

  /**
   * What a window of zeros means, and — the part that matters — what it does not.
   *
   * Nothing at all, over a window that always spans the current month, is what
   * a channel outside the Partner Programme looks like when Google answers
   * rather than refusing. It is much the likeliest reading. It is not the only
   * one: `toMinorUnits` floors a sub-half-cent day to zero exactly as it
   * should, so a small channel earning fractions of a cent a day produces a
   * genuinely all-zero window, and so does a channel that joined the programme
   * this morning. Filing any of those as "not in the Partner Programme" states
   * a finding we were never given.
   *
   * So the run records what it OBSERVED — "reported_zero" — and leaves the
   * monetisation verdict at "unknown". What does establish membership is Google
   * refusing the report outright under a grant that provably covers it, which
   * `describeAnalyticsFailure` handles and which is re-asserted on every run;
   * once Google answers instead of refusing, the evidence behind an older
   * "not_monetized" has gone with it, and the column should stop claiming it.
   *
   * A channel that HAS reported revenue is still never demoted by a lean
   * window: a quiet ten days is a quiet ten days, not an exit from the
   * programme. Either way the daily rows are written exactly as received —
   * zeros included — so nothing is inferred into the data itself. This decides
   * only what the admin screen says.
   */
  const monetizationStatus: MonetizationStatus =
    totalMinor > 0 || previousMonetization === "monetized" ? "monetized" : "unknown";

  const status: RevenueSyncStatus = totalMinor > 0 ? "ok" : "reported_zero";

  // Both ends of the window are named, so the sentences below are checkable
  // against YouTube Studio instead of being claims about an unstated period.
  const observedFrom = formatDay(window.startDate);
  const observedTo = formatDay(window.endDate);

  const malformedNote =
    parsed.malformedRows > 0
      ? `${parsed.malformedRows} day${parsed.malformedRows === 1 ? "" : "s"} in YouTube's ` +
        "response could not be read and were skipped rather than guessed at. The next run " +
        "re-reads the same window, so a one-off will correct itself."
      : null;

  const message =
    status !== "reported_zero"
      ? malformedNote
      : malformedNote
        ? // Zeros AND days that could not be read is not a report of zero; it is
          // a partial read that happened to total zero. "YouTube reported no
          // revenue" would be the same overreach this state exists to avoid,
          // one level down — the days we could not read might have carried some.
          `Every day YouTube returned between ${observedFrom} and ${observedTo} was zero — but ` +
          `not every day could be read. ${malformedNote}`
        : monetizationStatus === "monetized"
          ? `YouTube reported no revenue for this channel between ${observedFrom} and ` +
            `${observedTo}. This channel has reported revenue before, so nothing here needs ` +
            "fixing — it earned nothing YouTube could report over those days."
          : `YouTube reported no revenue for this channel between ${observedFrom} and ` +
            `${observedTo}. The likeliest explanation is that it is not in the YouTube Partner ` +
            "Programme — but that is a reading of the zeros, not something YouTube said: a " +
            "channel earning fractions of a cent a day reports the same. Nothing needs fixing " +
            "either way; figures appear on their own once there are any."

  await recordConnectionOutcome(connection.id, {
    status,
    monetizationStatus,
    message,
    succeeded: true,
    nextSyncAt,
  });

  return {
    connectionId: connection.id,
    label,
    channelId: channel.id,
    status,
    monetizationStatus,
    daysWritten: written.written,
    daysRevised: written.revised,
    totalMinor,
    currency: REPORTING_CURRENCY,
    message,
  };
}

function toMonetizationStatus(value: string): MonetizationStatus {
  return value === "monetized" || value === "not_monetized" ? value : "unknown";
}

// ---------------------------------------------------------------------------
// DAILY ROWS -> THE LEDGER
// ---------------------------------------------------------------------------

interface MonthGroup {
  readonly channelId: string;
  readonly youtubeChannelId: string;
  readonly channelTitle: string;
  readonly month: string;
  readonly occurredOn: Date;
  readonly totalMinor: number;
  readonly currency: string;
}

/**
 * The whole note, with whatever the entry already said kept underneath it.
 *
 * Anything already in `notes` is carried rather than overwritten: an imported
 * row's note is one of the two fields a person IS allowed to edit, so it can be
 * somebody's own annotation, and the newline is what `restoredNote` uses to
 * hand it back verbatim when the month starts totalling again.
 */
export function unmaintainedNote(month: string, carried: string | null): string {
  const head =
    `${UNMAINTAINED_NOTE_PREFIX} ${month}'s daily figures are stored in more than one currency, ` +
    "so the sync will not add them together. The amount above is the last one it could stand " +
    "behind and is no longer being re-checked. Clear that month's daily revenue rows and let the " +
    "next sync re-read them.";
  return carried ? `${head}\n${carried}` : head;
}

/** What `notes` should say once the month totals again: exactly what it said before. */
export function restoredNote(marked: string): string | null {
  const newline = marked.indexOf("\n");
  return newline === -1 ? null : marked.slice(newline + 1);
}

/**
 * Rolls the daily rows up into one `FinanceEntry` per channel per month.
 *
 * WHY MONTHLY AND NOT DAILY
 * A daily entry would put ~30 rows per channel per month into a ledger whose
 * other rows are invoices and salaries, and would bury every hand-entered
 * figure under machine output. YouTube also pays monthly, so the month is the
 * unit anybody actually reconciles against a bank statement.
 *
 * WHY THE WHOLE MONTH IS RE-SUMMED
 * The rollup reads every stored day in each affected month, not just the days
 * this run happened to fetch. A month's total is a property of the month; a
 * total accumulated from whichever days a particular run saw would drift the
 * first time a run was interrupted.
 *
 * `since` defaults to the first of the PREVIOUS month, which is always at or
 * before the start of the fetch window, so a late revision to last month's
 * figures reaches the ledger rather than sitting in the daily table.
 */
export async function syncRevenueToFinance(
  organizationId: string,
  options: { since?: Date } = {},
): Promise<FinanceRollupSummary> {
  const now = new Date();
  const since =
    options.since ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  const rows = await prisma.channelRevenueDay.findMany({
    where: { organizationId, day: { gte: since } },
    select: {
      channelId: true,
      day: true,
      estimatedRevenueMinor: true,
      currency: true,
      channel: { select: { youtubeChannelId: true, title: true } },
    },
    orderBy: { day: "asc" },
  });

  const errorsOut: RevenueSyncError[] = [];
  const groups = new Map<string, MonthGroup>();
  // Only reported once per (channel, month) rather than once per day.
  const mixedCurrency = new Set<string>();

  for (const row of rows) {
    const month = monthKey(row.day);
    const key = `${row.channelId}:${month}`;
    const currency = normalizeCurrencyCode(row.currency);
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        channelId: row.channelId,
        youtubeChannelId: row.channel.youtubeChannelId,
        channelTitle: row.channel.title,
        month,
        occurredOn: lastDayOfMonth(row.day),
        totalMinor: row.estimatedRevenueMinor,
        currency,
      });
      continue;
    }

    // Adding unlike currencies would produce a number that is not an amount of
    // anything. It can only happen if the reporting currency changed under a
    // month already in the table, and the honest response is to refuse the sum
    // and say so rather than to pick one of them.
    if (existing.currency !== currency) {
      mixedCurrency.add(key);
      continue;
    }

    groups.set(key, { ...existing, totalMinor: existing.totalMinor + row.estimatedRevenueMinor });
  }

  for (const key of mixedCurrency) {
    const group = groups.get(key);
    groups.delete(key);

    /**
     * Refusing to sum the month is right; leaving last month's total sitting in
     * the ledger looking current is not.
     *
     * The error below reaches the caller and the audit log, but neither is where
     * this figure gets read. It is read on Finance → Entries, where it still
     * counts toward revenue and net profit. Left to itself the row would also
     * still carry "Est", whose tooltip says "YouTube may yet revise this" — the
     * opposite of the truth, which is that nothing is going to revise it until
     * somebody clears the daily rows. So the entry is told to say so itself, and
     * the ledger reads the mark and shows the row as what it now is: a former
     * estimate nobody is maintaining, which is neither a live estimate nor
     * settled cash. One row, one claim.
     *
     * The figure is deliberately NOT removed or zeroed: it was the real total
     * for the days that agreed, and deleting it would swap a stale number for a
     * wrong one.
     */
    if (group) await markMonthUnmaintained(organizationId, group);

    errorsOut.push({
      connectionId: null,
      label: group?.channelTitle ?? "Channel",
      message:
        `${group?.channelTitle ?? "This channel"}'s ${group?.month ?? "monthly"} revenue is stored ` +
        "in more than one currency, so it cannot be totalled into a single entry. Clear that " +
        "month's daily revenue rows and let the next sync re-read them.",
    });
  }

  if (groups.size === 0) {
    return { entriesCreated: 0, entriesRevised: 0, entriesUnchanged: 0, errors: errorsOut };
  }

  const category = await ensureImportCategory(organizationId, "revenue", REVENUE_CATEGORY_NAME);

  /**
   * Months an earlier run marked as no longer maintained, keyed by external id.
   *
   * Read once for the whole rollup rather than once per month: the mark is rare
   * enough that this usually returns nothing, and the alternative is a query
   * against every month the sync touches on every run to answer "was this one
   * marked?" — for which the answer is almost always no.
   *
   * A mark that outlives the problem is the same failure as the one it exists to
   * fix, in the other direction: it would tell an admin a live figure is stale.
   * So it comes off in the same run that successfully totals the month again.
   */
  const markedRows = await prisma.financeEntry.findMany({
    where: {
      organizationId,
      source: YOUTUBE_SOURCE,
      notes: { startsWith: UNMAINTAINED_NOTE_PREFIX },
    },
    select: { id: true, externalId: true, notes: true },
  });
  const marked = new Map<string, { id: string; notes: string }>();
  for (const row of markedRows) {
    if (row.externalId && row.notes) marked.set(row.externalId, { id: row.id, notes: row.notes });
  }

  let entriesCreated = 0;
  let entriesRevised = 0;
  let entriesUnchanged = 0;

  for (const group of groups.values()) {
    // A month that has only ever reported zero has nothing to record. Creating
    // a $0.00 entry for every non-monetised channel every month would fill the
    // ledger with rows asserting a figure nobody needs to see. A month that
    // HAS an entry is still updated below, so a figure revised down to zero is
    // corrected rather than left standing.
    if (group.totalMinor === 0) {
      const alreadyRecorded = await prisma.financeEntry.findUnique({
        where: {
          organizationId_source_externalId: {
            organizationId,
            source: YOUTUBE_SOURCE,
            externalId: externalIdFor(group),
          },
        },
        select: { id: true },
      });
      if (!alreadyRecorded) continue;
    }

    try {
      const result = await upsertImportedEntry({
        organizationId,
        source: YOUTUBE_SOURCE,
        externalId: externalIdFor(group),
        kind: "revenue",
        // The month's last day. Stable — it does not move as the month
        // progresses, so the entry never jumps between reporting periods on a
        // re-run — and it is the date the month's earnings are settled against.
        occurredOn: group.occurredOn,
        amountMinor: group.totalMinor,
        currency: group.currency,
        categoryId: category.id,
        channelId: group.channelId,
        platform: "youtube_ads",
        notes: `Imported from YouTube Analytics. Estimated ${group.month} revenue, subject to YouTube's month-end adjustment.`,
        isEstimated: true,
        actorLabel: ACTOR_LABEL,
      });

      if (result.created) entriesCreated += 1;
      else if (result.revised) entriesRevised += 1;
      else entriesUnchanged += 1;

      // The month totalled, so the connector is standing behind this figure
      // again and the warning has to go — restored to whatever the note said
      // before the mark, which may be an annotation somebody typed.
      const wasMarked = marked.get(externalIdFor(group));
      if (wasMarked) {
        // `updateMany`, so an entry somebody deleted between the read above and
        // this write is a no-op rather than a thrown P2025 that would take the
        // whole rollup — and every other channel's month — down with it.
        await prisma.financeEntry.updateMany({
          where: { id: wasMarked.id },
          data: { notes: restoredNote(wasMarked.notes) },
        });
      }
    } catch (caught) {
      // The commonest cause by far is a missing exchange rate: the ledger's
      // base currency is not USD and nobody has configured a USD rate. The
      // manual path refuses to assume 1:1 and so does this one — but silently
      // skipping would leave a month of real revenue missing with no
      // explanation anywhere, so it is surfaced as an actionable error.
      errorsOut.push({
        connectionId: null,
        label: `${group.channelTitle} — ${group.month}`,
        message: toAppError(caught).userMessage,
      });
    }
  }

  return { entriesCreated, entriesRevised, entriesUnchanged, errors: errorsOut };
}

/** The idempotency key: one entry per channel per month, forever. */
function externalIdFor(group: Pick<MonthGroup, "youtubeChannelId" | "month">): string {
  return `${YOUTUBE_SOURCE}:${group.youtubeChannelId}:${group.month}`;
}

/**
 * Says on the entry itself that this month is no longer being re-totalled.
 *
 * `notes` and not a new column: the ledger already renders it on every row, and
 * an admin looking at the figure is looking at that line. It is also the one
 * place a sentence can be put without asking the reader to know what a flag
 * means. The mark's format is shared with the ledger rather than private here —
 * `lib/finance/unmaintained.ts` — so the screen reads the state instead of
 * re-deriving it from prose.
 *
 * Only the note moves. Amount and currency are left exactly as the last good run
 * wrote them, because they are still the true record of what that run found.
 * `isEstimated` is left alone too, and that is a decision rather than an
 * oversight: clearing it would promote a figure nobody is re-checking to settled
 * cash, which is the larger of the two lies. The row is a former estimate, and
 * the mark is what lets the ledger say exactly that instead of choosing between
 * "revisable" and "final".
 */
async function markMonthUnmaintained(organizationId: string, group: MonthGroup): Promise<void> {
  const existing = await prisma.financeEntry.findUnique({
    where: {
      organizationId_source_externalId: {
        organizationId,
        source: YOUTUBE_SOURCE,
        externalId: externalIdFor(group),
      },
    },
    select: { id: true, notes: true },
  });

  // Never imported, so there is no figure standing anywhere to be believed. The
  // run's error is the whole of what needs saying about this month.
  if (!existing) return;

  // Already marked. Rewriting the same sentence every hour would push
  // `updatedAt` forward and make a standing problem look like something that
  // just happened, every time anybody looked.
  if (existing.notes?.startsWith(UNMAINTAINED_NOTE_PREFIX)) return;

  // `updateMany` for the same reason as the un-marking above: this runs inside
  // the rollup, and a row deleted since the read a moment ago is not a reason to
  // fail every other channel's month.
  await prisma.financeEntry.updateMany({
    where: { id: existing.id },
    data: { notes: unmaintainedNote(group.month, existing.notes?.trim() ? existing.notes : null) },
  });
}

// ---------------------------------------------------------------------------
// ONE ORGANIZATION
// ---------------------------------------------------------------------------

/**
 * Reads revenue for every connection in one workspace, then rolls it up.
 *
 * The entry point the scheduler and the manual button both use, so there is one
 * definition of "sync revenue" rather than one per caller. One connection's
 * failure never stops the others: a channel that left the Partner Programme
 * must not be able to stop the rest of the team's figures arriving.
 *
 * `connectionId` narrows the READ to a single account and nothing else.
 * Somebody who has just reconnected one channel wants to know whether that
 * channel now works, and spending an Analytics call on every other connection
 * to answer it wastes a finite upstream allowance on a question nobody asked.
 * The rollup afterwards is deliberately NOT narrowed: it re-sums whole months
 * from the daily table, is idempotent, and may be carrying a revision from an
 * earlier run of another channel that has not reached the ledger yet. Scoping
 * it to one channel would make "sync this one" a way to strand another one's
 * figures.
 *
 * The narrowing is an extra `where` on an already organization-scoped query, so
 * an id belonging to another workspace matches nothing — and is reported as a
 * missing connection rather than as an empty, successful-looking run.
 */
export async function syncRevenueForOrganization(
  organizationId: string,
  options: {
    trigger: "cron" | "manual";
    request?: Request | null;
    connectionId?: string | null;
  } = { trigger: "cron" },
): Promise<RevenueSyncSummary> {
  const connections = await prisma.youTubeConnection.findMany({
    where: {
      organizationId,
      ...(options.connectionId ? { id: options.connectionId } : {}),
    },
    select: { id: true, channelTitle: true, googleAccountEmail: true, status: true },
    orderBy: { createdAt: "asc" },
  });

  // Only when one was named. An organization with no connections at all is an
  // ordinary empty run; an id that resolved to nothing is a caller pointing at
  // something that is not theirs or no longer exists, and answering that with
  // "synced 0 connections" would report success for a request that did nothing.
  if (options.connectionId && connections.length === 0) {
    throw errors.notFound("YouTube connection");
  }

  const settings = await getOrgSettings(organizationId);
  const window = revenueWindowFor();
  const nextSyncAt = new Date(Date.now() + settings.refreshIntervalMinutes * 60_000);

  const errorsOut: RevenueSyncError[] = [];
  let connectionsSynced = 0;
  let connectionsSkipped = 0;
  let failed = 0;
  let daysWritten = 0;
  let daysRevised = 0;

  for (const connection of connections) {
    const label = connection.channelTitle ?? connection.googleAccountEmail ?? "Google account";
    try {
      const result = await fetchRevenueForConnection(connection.id, { ...window, nextSyncAt });

      daysWritten += result.daysWritten;
      daysRevised += result.daysRevised;

      // A window that reported nothing is still a completed read: Google
      // answered and its zeros are now in the daily table. Counting it as
      // skipped would file a connection this run demonstrably read alongside
      // the ones it never reached — and would sit in the same audit record as a
      // non-zero `daysWritten` that came from it.
      if (result.status === "ok" || result.status === "reported_zero") connectionsSynced += 1;
      else if (result.status === "error" && connection.status === "connected") {
        failed += 1;
        errorsOut.push({
          connectionId: connection.id,
          label,
          message: result.message ?? "Revenue could not be read.",
        });
      } else if (result.status === "error") {
        // The connection was already flagged as needing re-authorisation before
        // this run started, and the revenue column now says so too. Counting it
        // as a new failure would write an identical "revenue sync failed" audit
        // entry every hour until somebody reconnects — a log that repeats one
        // known fact forever is a log nobody reads the day something new
        // happens.
        connectionsSkipped += 1;
      } else {
        // "no_scope" and "not_monetized" are states to display, not failures to
        // count. Both already carry an explanation on the connection.
        connectionsSkipped += 1;
      }
    } catch (caught) {
      // Reaching here means something structural — the connection row vanished
      // mid-run, or the database went away. Neither is a reason to abandon the
      // remaining connections.
      failed += 1;
      errorsOut.push({ connectionId: connection.id, label, message: toAppError(caught).userMessage });
    }
  }

  // Runs even when every connection failed: a revision to an earlier month may
  // already be sitting in the daily table waiting to reach the ledger, and it
  // should not be held hostage by today's upstream problem.
  const rollup = await syncRevenueToFinance(organizationId, { since: firstOfPreviousMonth(window.startDate) });
  errorsOut.push(...rollup.errors);

  const summary: RevenueSyncSummary = {
    organizationId,
    connectionsConsidered: connections.length,
    connectionsSynced,
    connectionsSkipped,
    failed: failed + rollup.errors.length,
    daysWritten,
    daysRevised,
    entriesCreated: rollup.entriesCreated,
    entriesRevised: rollup.entriesRevised,
    errors: errorsOut,
  };

  await auditRevenueRun(summary, options);
  return summary;
}

/** The earlier of the fetch window's start and the first of the previous month. */
function firstOfPreviousMonth(windowStart: Date): Date {
  const now = new Date();
  const previousMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  return new Date(Math.min(previousMonth, windowStart.getTime()));
}

/**
 * One audit entry per run, and only when the run did something.
 *
 * An hourly "revenue sync ran, nothing changed" would bury the log in a
 * description of work that did not happen — the same reasoning that keeps the
 * channel scheduler quiet when nothing was due. What is recorded is money
 * entering the ledger from outside, which is the only record of where a figure
 * nobody typed came from.
 *
 * Counts only, never amounts. `audit.view` is a wider permission than
 * `finance.view`, and the per-entry `finance.entry_imported` records — which do
 * carry figures — are redacted for a reader without it. Putting a total in a
 * `youtube.*` summary would route the same information straight around that.
 */
async function auditRevenueRun(
  summary: RevenueSyncSummary,
  options: {
    trigger: "cron" | "manual";
    request?: Request | null;
    connectionId?: string | null;
  },
): Promise<void> {
  const changed =
    summary.entriesCreated > 0 || summary.entriesRevised > 0 || summary.daysRevised > 0;
  const failedOutright = summary.failed > 0;
  if (!changed && !failedOutright) return;

  const context = {
    organizationId: summary.organizationId,
    actorUserId: null,
    actorLabel: options.trigger === "cron" ? ACTOR_LABEL : "Manual revenue sync",
    request: options.request ?? null,
  };

  const metadata = {
    trigger: options.trigger,
    // Which connections the run was allowed to look at. Without this, a
    // one-connection run and a sweep of a workspace that happens to have one
    // connection leave identical records, and "why was only that channel read?"
    // becomes unanswerable from the log.
    scope: options.connectionId ? "connection" : "organization",
    connectionId: options.connectionId ?? null,
    connectionsConsidered: summary.connectionsConsidered,
    connectionsSynced: summary.connectionsSynced,
    connectionsSkipped: summary.connectionsSkipped,
    failed: summary.failed,
    daysWritten: summary.daysWritten,
    daysRevised: summary.daysRevised,
    entriesCreated: summary.entriesCreated,
    entriesRevised: summary.entriesRevised,
  };

  if (changed) {
    await recordAudit(context, {
      action: "youtube.revenue_synced",
      summary:
        `Imported YouTube revenue for ${summary.connectionsSynced} channel` +
        `${summary.connectionsSynced === 1 ? "" : "s"}: ${summary.entriesCreated} new monthly ` +
        `entr${summary.entriesCreated === 1 ? "y" : "ies"}, ${summary.entriesRevised} revised.`,
      targetType: "organization",
      targetId: summary.organizationId,
      metadata,
    });
  }

  if (failedOutright) {
    await recordAudit(context, {
      action: "youtube.revenue_sync_failed",
      summary: `YouTube revenue sync could not complete for ${summary.failed} connection${
        summary.failed === 1 ? "" : "s"
      }. ${summary.errors[0]?.message ?? ""}`.trim(),
      targetType: "organization",
      targetId: summary.organizationId,
      metadata: {
        ...metadata,
        // Labels and messages, no amounts: these are this app's own sentences,
        // written to be read back by whoever has to fix the connection.
        failures: summary.errors.map((error) => `${error.label}: ${error.message}`).slice(0, 10),
      },
    });
  }
}
