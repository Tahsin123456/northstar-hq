import "server-only";

import { prisma } from "@/server/db";
import { isGoogleOAuthConfigured } from "@/server/auth/google-oauth-env";
import { normalizeCurrencyCode } from "@/lib/finance/money";
import {
  buildMonthRows,
  summariseRevenueTotals,
  type RevenueDayInput,
  type RevenueHeadline,
} from "@/lib/finance/youtube-revenue-rollup";

/**
 * =========================================================================
 * WHAT YOUTUBE PAID, BY CHANNEL AND BY MONTH — AND WHAT IS MISSING FROM IT
 * =========================================================================
 *
 * The owner asked for two things here and they are halves of one idea.
 *
 * FIRST: surface the revenue that is already being collected. `ChannelRevenueDay`
 * has been filling up since the revenue sync was built, with idempotency and
 * revision history, and until now the only thing that read it was the monthly
 * rollup into the ledger. A month's total was therefore visible as one ledger
 * line and the shape underneath it — which channel, which days moved — was
 * visible nowhere. This reads the daily table directly, per channel per month.
 *
 * SECOND, AND THE REASON THE FIRST IS SAFE: "a revenue figure that silently
 * omits an unconnected channel is worse than no figure." Absolutely right, and
 * it is the failure mode this shape is built to make impossible. A studio with
 * four channels and two connections would otherwise read a total off this screen
 * as THE total. So `channels` below lists every OWN channel in the tracker,
 * connected or not, and a channel with no connection appears in it explicitly —
 * with nothing in the money column, because nothing is known, rather than a zero
 * that would read as "this one earned nothing".
 *
 * WHY IT IS READ FROM THE DAILY ROWS AND NOT FROM THE LEDGER
 * The ledger entry is the rollup: one figure per channel per month, converted
 * into the organization's base currency at a configured rate. That is the right
 * thing to put in a profit total and the wrong thing to show here. This section
 * answers "what did YouTube actually report", so it reports YouTube's own
 * currency and YouTube's own figure, un-converted — the number that can be
 * checked against YouTube Studio. The two agreeing is meaningful; the two being
 * the same query would make the agreement vacuous.
 *
 * NO SESSION. The organization is a parameter, like every other module the
 * scheduler might one day reach.
 */

export interface YouTubeRevenueMonthRow {
  readonly channelId: string;
  readonly channelName: string;
  /** `YYYY-MM`, UTC — the same key the ledger rollup groups on. */
  readonly month: string;
  /**
   * Integer minor units of `currency`, summed from the daily rows.
   *
   * NOT converted to the organization's base currency, and never mixed: rows are
   * grouped by currency as well as by month, so a channel whose reporting
   * currency changed mid-month produces two visible rows rather than one
   * invented sum. The ledger is where conversion happens, with a rate an admin
   * configured and which is stored on the entry.
   */
  readonly amountMinor: number;
  readonly currency: string;
  /** Days of the month with a stored figure. Not the length of the month. */
  readonly dayCount: number;
  /**
   * How many of those days YouTube has revised at least once since we first
   * read them.
   *
   * Surfaced because it is the concrete form of the estimate caveat: "YouTube
   * revises these" is a warning, "YouTube has revised 4 days of this month" is
   * a fact about the number on the screen.
   */
  readonly revisedDayCount: number;
  /**
   * True when the selected period covers only part of this calendar month, so
   * the figure is part of a month rather than a month.
   *
   * Without it the table was quietly wrong on every default load: a 30-day
   * window clips the previous month, and the row rendered as that whole month
   * with a partial total under a footnote blaming YouTube for not having
   * finished computing it.
   */
  readonly clippedByPeriod: boolean;
}

/**
 * One of Northstar's own channels, and whether anything is reading its money.
 *
 * Every own channel appears, including the ones with no connection at all —
 * that absence is the whole point of the section.
 */
export interface YouTubeRevenueChannelStatus {
  readonly channelId: string;
  readonly channelName: string;
  /**
   * "none" when no connection names this channel. Otherwise the connection's
   * own status, so a grant that has expired is distinguishable from one that
   * was never made — different sentences, different fixes.
   */
  readonly connectionStatus: "none" | "connected" | "needs_reauth" | "revoked" | string;
  /** False for an unconnected channel, and for a grant that declined revenue. */
  readonly revenueScopeGranted: boolean;
  /**
   * "none" when unconnected; otherwise the connection's own revenue verdict —
   * "never" | "ok" | "error" | "no_scope" | "not_monetized" | "reported_zero".
   * Never collapsed to a boolean: those six are six different next steps.
   */
  readonly revenueSyncStatus: string;
  readonly lastRevenueSyncAt: number | null;
}

export interface YouTubeRevenueReport {
  /** False when this deployment cannot offer the connect flow at all. */
  readonly configured: boolean;
  /** Newest month first, then largest amount — see `getYouTubeRevenueReport`. */
  readonly months: readonly YouTubeRevenueMonthRow[];
  readonly channels: readonly YouTubeRevenueChannelStatus[];
  /**
   * Total, this month and previous month — computed over EVERY stored day, not
   * over the selected period.
   *
   * The owner asked for these three by name and none of them existed: the period
   * control offers 7/30/90/180 days and a custom range, so "this month" was
   * reachable only by hand-picking dates, and "total" not at all. They are
   * deliberately independent of the period selector, because a "this month"
   * figure that changes when somebody switches the window is not this month.
   */
  readonly headline: RevenueHeadline;
  /**
   * Own channels with nothing reading their revenue: no connection, or one that
   * has stopped working, or one without the revenue permission.
   *
   * Counted on the server rather than derived in the browser because it is the
   * number that qualifies the total beside it, and a caveat computed separately
   * from the figure it qualifies is a caveat that can disagree with it.
   */
  readonly uncoveredChannelCount: number;
}

/**
 * Revenue by channel and month over one window, plus what is not covered.
 *
 * `channelNames` comes from the caller because the caller — the finance overview
 * — has already read the tracker for its own per-channel table, and the names
 * must match it exactly. Two independent reads would eventually disagree about
 * a channel somebody renamed, and one screen showing a channel under two names
 * is a screen nobody trusts.
 */
export async function getYouTubeRevenueReport(options: {
  organizationId: string;
  range: { startMs: number; endMs: number };
  channelNames: ReadonlyMap<string, string>;
  /** Injectable so the headline months are deterministic in a test. */
  now?: number;
}): Promise<YouTubeRevenueReport> {
  const { organizationId, range, channelNames } = options;
  const nowMs = options.now ?? Date.now();

  const [days, allDays, ownChannels, connections] = await Promise.all([
    prisma.channelRevenueDay.findMany({
      // Half-open, exactly like every other finance window, so a day never
      // lands in two periods.
      where: {
        organizationId,
        day: { gte: new Date(range.startMs), lt: new Date(range.endMs) },
      },
      select: {
        channelId: true,
        day: true,
        estimatedRevenueMinor: true,
        currency: true,
        revisionCount: true,
        channel: { select: { title: true } },
      },
      orderBy: { day: "asc" },
    }),
    /**
     * Every stored day, for the three headline figures.
     *
     * A second read rather than a wider first one, because the two answer
     * different questions and must not be tempted into sharing a filter: the
     * table is about the selected period and the headline is about the calendar.
     *
     * Deliberately not `groupBy`. Three figures over two dimensions (month and
     * currency) would be three grouped queries or one with a computed month
     * expression Prisma cannot express portably, and the row count this reads is
     * one per channel per day — a handful of thousands for a studio with several
     * channels and years of history. Folding those in memory is cheaper than the
     * round trips, and it keeps the arithmetic in one tested function.
     */
    prisma.channelRevenueDay.findMany({
      where: { organizationId },
      select: { channelId: true, day: true, estimatedRevenueMinor: true, currency: true },
    }),
    prisma.trackedChannel.findMany({
      // Own channels only. A competitor has no revenue to read and never will —
      // listing them as "not connected" would invent a gap rather than report
      // one.
      where: { organizationId, isActive: true, ownershipType: "own" },
      select: {
        label: true,
        channelId: true,
        channel: { select: { title: true, youtubeChannelId: true } },
      },
    }),
    prisma.youTubeConnection.findMany({
      where: { organizationId, youtubeChannelId: { not: null } },
      select: {
        youtubeChannelId: true,
        status: true,
        revenueScopeGranted: true,
        revenueSyncStatus: true,
        lastRevenueSyncAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  // ---- Money, grouped by (channel, month, currency) -------------------------
  //
  // The grouping itself is `lib/finance/youtube-revenue-rollup`, which is where
  // the clipped-month rule and the headline arithmetic are pinned by tests.
  // This function's job is to read the rows and name the channels.

  const months = buildMonthRows(
    days.map(
      (row): RevenueDayInput => ({
        channelId: row.channelId,
        // The tracker's name first, so this table and the profit table above it
        // call the same channel the same thing. The YouTube title is the
        // fallback for a channel whose tracking row has since been removed —
        // its revenue is still real and still belongs on the screen.
        channelName: channelNames.get(row.channelId) ?? row.channel.title,
        dayMs: row.day.getTime(),
        amountMinor: row.estimatedRevenueMinor,
        currency: normalizeCurrencyCode(row.currency),
        revisionCount: row.revisionCount,
      }),
    ),
    range,
  );

  const headline = summariseRevenueTotals(
    allDays.map(
      (row): RevenueDayInput => ({
        channelId: row.channelId,
        // Not read by the headline, which sums across channels. Filled from the
        // tracker anyway rather than left blank, so the input type means the
        // same thing in both calls.
        channelName: channelNames.get(row.channelId) ?? "",
        dayMs: row.day.getTime(),
        amountMinor: row.estimatedRevenueMinor,
        currency: normalizeCurrencyCode(row.currency),
        revisionCount: 0,
      }),
    ),
    nowMs,
  );

  // ---- Coverage -------------------------------------------------------------

  const connectionByChannel = new Map(
    connections
      .filter((row): row is typeof row & { youtubeChannelId: string } =>
        row.youtubeChannelId !== null,
      )
      .map((row) => [row.youtubeChannelId, row]),
  );

  const channels: YouTubeRevenueChannelStatus[] = ownChannels
    .map((tracked) => {
      const connection = connectionByChannel.get(tracked.channel.youtubeChannelId) ?? null;
      return {
        channelId: tracked.channelId,
        channelName: tracked.label ?? tracked.channel.title,
        connectionStatus: connection?.status ?? "none",
        revenueScopeGranted: connection?.revenueScopeGranted ?? false,
        revenueSyncStatus: connection?.revenueSyncStatus ?? "none",
        lastRevenueSyncAt: connection?.lastRevenueSyncAt?.getTime() ?? null,
      };
    })
    .sort((a, b) => a.channelName.localeCompare(b.channelName));

  /**
   * Not covered means nothing is currently able to read this channel's money.
   *
   * Three ways to land here and they are deliberately pooled into one count,
   * because the reader's question at this point is "is the total below the whole
   * story?" and the answer is no in all three cases. The per-channel rows
   * underneath say which, and they say it in the connection's own words.
   *
   * Note what is NOT counted as uncovered: a connected channel whose revenue
   * came back as zeros, or one YouTube refused a report for. Those are channels
   * we successfully ASKED about — the total is not missing them, it includes
   * what they reported. Counting them here would turn "we have no figure" and
   * "the figure is nothing" back into the same sentence, which is the exact
   * conflation the revenue service is built to prevent.
   */
  const uncoveredChannelCount = channels.filter(
    (channel) =>
      channel.connectionStatus !== "connected" || !channel.revenueScopeGranted,
  ).length;

  return {
    configured: isGoogleOAuthConfigured(),
    months,
    channels,
    headline,
    uncoveredChannelCount,
  };
}
