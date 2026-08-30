import "server-only";

import { prisma } from "@/server/db";
import { isGoogleOAuthConfigured } from "@/server/auth/google-oauth-env";
import { normalizeCurrencyCode } from "@/lib/finance/money";

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

/** Groups a UTC day onto the `YYYY-MM` its revenue belongs to. */
function monthKey(day: Date): string {
  return day.toISOString().slice(0, 7);
}

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
}): Promise<YouTubeRevenueReport> {
  const { organizationId, range, channelNames } = options;

  const [days, ownChannels, connections] = await Promise.all([
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

  interface Bucket {
    channelId: string;
    channelName: string;
    month: string;
    currency: string;
    amountMinor: number;
    dayCount: number;
    revisedDayCount: number;
  }

  const buckets = new Map<string, Bucket>();

  for (const row of days) {
    const month = monthKey(row.day);
    const currency = normalizeCurrencyCode(row.currency);
    // Currency is part of the key rather than an assumption. Two currencies in
    // one channel-month is rare and pathological, and the honest rendering is
    // two rows — not a sum of unlike things, and not a silently dropped row.
    const key = `${row.channelId}:${month}:${currency}`;

    const existing = buckets.get(key);
    if (existing) {
      // Integer minor units, so this addition is exact.
      existing.amountMinor += row.estimatedRevenueMinor;
      existing.dayCount += 1;
      if (row.revisionCount > 0) existing.revisedDayCount += 1;
      continue;
    }

    buckets.set(key, {
      channelId: row.channelId,
      // The tracker's name first, so this table and the profit table above it
      // call the same channel the same thing. The YouTube title is the fallback
      // for a channel whose tracking row has since been removed — its revenue
      // is still real and still belongs on the screen.
      channelName: channelNames.get(row.channelId) ?? row.channel.title,
      month,
      currency,
      amountMinor: row.estimatedRevenueMinor,
      dayCount: 1,
      revisedDayCount: row.revisionCount > 0 ? 1 : 0,
    });
  }

  const months = [...buckets.values()].sort(
    (a, b) =>
      // Newest month first: the current month is the one anybody opens this to
      // look at. Then largest earner, then name, so the order is total rather
      // than "whatever the map happened to hold".
      b.month.localeCompare(a.month) ||
      b.amountMinor - a.amountMinor ||
      a.channelName.localeCompare(b.channelName),
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
    uncoveredChannelCount,
  };
}
