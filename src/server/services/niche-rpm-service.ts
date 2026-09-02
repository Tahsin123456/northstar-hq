import "server-only";

import { prisma } from "@/server/db";
import { actorCan } from "@/server/auth/dal";
import {
  getVisibleNicheIds,
  trackedChannelNicheFilter,
  type VisibleNiches,
} from "@/server/auth/niche-scope";
import { convertMinorBetween } from "@/lib/finance/money";
import {
  judgeRpmChannel,
  resolveNicheRpm,
  rpmWindowEndingAt,
  type NicheRpmRangeSource,
  type NicheRpmResolution,
  type RpmChannelEvidence,
  type RpmChannelOutcome,
  type RpmRevenueDay,
  type RpmWindow,
} from "@/lib/analytics/niche-rpm";
import { getCurrentOrgId, getCurrentOrgSettings } from "./user-service";
import { viewsGainedByChannel } from "./views-gained-service";

/**
 * =========================================================================
 * WHAT A NICHE PAYS — GATHERING THE EVIDENCE
 * =========================================================================
 *
 * `src/lib/analytics/niche-rpm.ts` decides which rate applies to a niche and
 * what a derived one has to prove first. This file does the reading: own
 * channels, their connections' monetization state, twenty-eight settled days of
 * revenue, the exchange rates needed to bring that revenue into the base
 * currency, and the view history to divide it by. It makes no judgements of its
 * own, which is what keeps the rule testable without a database.
 *
 * ONE PASS FOR THE WHOLE CATALOGUE. `listNiches` is called on the two reads
 * every signed-in person makes — `GET /api/niches` and the dataset — so a
 * per-niche resolution would multiply those into dozens of queries. Everything
 * below is batched across the organization and then split by niche in memory.
 *
 * TWO NARROWINGS, NOT ONE. `finance.view` decides whether any of this is
 * answered at all; `getVisibleNicheIds` decides which niches it is answered
 * FOR. The second is easy to forget here because `listNiches` returns the whole
 * taxonomy by design — but the economics hanging off those rows carry own
 * channel names, monetization state and, where a rate is derivable, the revenue
 * it was divided out of, so a niche-scoped member granted `finance.view` must
 * not receive them for niches they are not assigned to.
 *
 * ---------------------------------------------------------------------------
 * THE VIEW DENOMINATOR IS MEASURED ELSEWHERE
 * ---------------------------------------------------------------------------
 * The snapshot-delta measurement lives in `views-gained-service.ts`, shared
 * with the niche money figures so "views gained" can never mean two things on
 * two screens. What stays here is this caller's own reading of the result:
 * channel-wide (no format filter — the revenue it divides is what the whole
 * channel earned), and with a covered-nothing channel treated as ABSENT so it
 * resolves to `viewsGained: null` and the judge's `no_view_history` sentence.
 * Automatic refresh writes the `VideoSnapshot` series this depends on; a
 * channel still rejected for view history is one the history has not yet
 * grown to bracket, not a settings decision waiting to be made.
 */

/**
 * Who may see what a niche pays, and what the studio earns inside it.
 *
 * `finance.view`, NOT the `settings.manage` that guards the hit payment. The
 * two look alike and are not. A hit payment is a configured constant; a derived
 * RPM is `ChannelRevenueDay.estimatedRevenueMinor` divided by a view count that
 * is printed beside it, so anybody holding this can multiply back and read what
 * an own channel earned. The permission table already draws that line —
 * `finance.view` is "Read revenue, expenses, profit and margins" — and it is
 * grantable on its own, which is what lets a Head of Shorts be shown niche
 * economics without also being handed the organization's sync cadence,
 * lookback and currency.
 */
export async function mayReadNicheEconomics(): Promise<boolean> {
  return actorCan("finance.view");
}

/**
 * Every niche's resolved RPM, keyed by niche id.
 *
 * Returns `null` — not an empty map — when the caller may not see any of it, so
 * a caller cannot accidentally treat "withheld" as "every niche came back
 * unset". `listNiches` passes the absence straight through to the DTO.
 */
export async function resolveNicheRpmByNiche(options: {
  readonly niches: readonly (NicheRpmRangeSource & { readonly id: string })[];
  readonly nowMs?: number;
}): Promise<ReadonlyMap<string, NicheRpmResolution> | null> {
  if (!(await mayReadNicheEconomics())) return null;

  const [organizationId, settings, visibleNiches] = await Promise.all([
    getCurrentOrgId(),
    getCurrentOrgSettings(),
    /*
     * NICHE SCOPE, NOT ONLY ORGANIZATION SCOPE.
     *
     * `finance.view` answers "may this person see money at all". It does not
     * answer "which niches are theirs", and it is individually grantable — the
     * whole argument for gating on it rather than `settings.manage` is that a
     * niche-scoped Head of Shorts could hold it. Without this, such a person
     * would receive own-channel names, monetization state and, where a rate is
     * derivable, the revenue behind it for niches they are not assigned to.
     *
     * `listNiches` deliberately returns the whole organization taxonomy — an
     * editor still needs the labels to filter by — so the narrowing is applied
     * to the ECONOMICS attached to those rows rather than to the rows.
     */
    getVisibleNicheIds(),
  ]);
  const baseCurrency = settings.baseCurrency;
  const window = rpmWindowEndingAt(options.nowMs ?? Date.now());

  /*
   * The rate table is read only if some stored range actually needs it.
   *
   * Every range the dialog writes is in the organization's base currency of the
   * day, so a foreign one exists only after an admin switches the base — rare,
   * and worth an extra query when it happens rather than one on every page load
   * for every reader forever. `listNiches` is on the two reads every signed-in
   * person makes, which is why the cost of a query here is measured in the
   * whole team's page loads.
   */
  const needsRates = options.niches.some(
    (niche) =>
      typeof niche.rpmCurrency === "string" &&
      niche.rpmCurrency.trim() !== "" &&
      niche.rpmCurrency.trim().toUpperCase() !== baseCurrency.trim().toUpperCase(),
  );

  const [outcomesByNiche, ratesToBase] = await Promise.all([
    judgeOwnChannelsByNiche({ organizationId, baseCurrency, window, visibleNiches }),
    needsRates ? exchangeRatesToBase(organizationId, baseCurrency) : undefined,
  ]);

  const visible = visibleNiches === null ? null : new Set(visibleNiches);

  const resolved = new Map<string, NicheRpmResolution>();
  for (const niche of options.niches) {
    // Left out of the map entirely rather than answered with an empty
    // resolution: an absent entry becomes `rpm: null` on the DTO, which is
    // already this codebase's single meaning of "withheld", and the strip
    // renders nothing for it. An "unpriced" object would instead tell a
    // niche-scoped reader that a niche they cannot see has no rate, which is a
    // disclosure of its own.
    if (visible !== null && !visible.has(niche.id)) continue;
    resolved.set(
      niche.id,
      resolveNicheRpm({
        manual: niche,
        channels: outcomesByNiche.get(niche.id) ?? [],
        window,
        baseCurrency,
        /*
         * THE ASSUMPTION TRAVELS WITH THE RATE, and this line is the whole
         * delivery decision for engaged views.
         *
         * The money is projected in the browser, and `OrganizationSettings` is
         * read behind `settings.manage` — so without this the share would never
         * reach a `finance.view` reader through any payload that exists.
         * Widening the organization settings read to deliver it would hand
         * every employee the sync cadence and the lookback window to solve a
         * problem about a single integer. This resolution is already gated on
         * exactly the right permission, so the share rides on it and no client
         * can price views with a share that is stale or absent.
         */
        engagedViewShareBasisPoints: settings.engagedViewShareBasisPoints,
        ratesToBase,
      }),
    );
  }
  return resolved;
}

/**
 * Every own channel in the organization, judged once and filed under each niche
 * it belongs to.
 *
 * A CHANNEL IN TWO NICHES IS JUDGED ONCE AND COUNTED IN BOTH, which is correct
 * for a RATE: a channel filed under Gaming and GTA really does earn what it
 * earns in both. What must never be done with the result is to add the niche
 * totals together into a portfolio figure, because that would count the channel
 * twice; a portfolio number has to be built over distinct channels.
 */
async function judgeOwnChannelsByNiche(params: {
  organizationId: string;
  baseCurrency: string;
  window: RpmWindow;
  visibleNiches: VisibleNiches;
}): Promise<ReadonlyMap<string, RpmChannelOutcome[]>> {
  const { organizationId, baseCurrency, window, visibleNiches } = params;

  /*
   * `ownershipType: "own"` is the only claim of ownership this file will
   * accept, and it is a safe basis for a money figure because it is never set
   * by assertion — the OAuth path writes it after Google has confirmed the
   * account owns the channel.
   *
   * THE NICHE FILTER IS IN THE QUERY, beside the tenancy filter and for the
   * same reason `dataset-service` puts it there: filtering afterwards means the
   * rows were already loaded, and the next person to add a caller inherits the
   * narrowing instead of having to remember it.
   */
  const tracked = await prisma.trackedChannel.findMany({
    where: {
      organizationId,
      isActive: true,
      ownershipType: "own",
      ...trackedChannelNicheFilter(visibleNiches),
    },
    select: {
      channelId: true,
      channel: { select: { id: true, title: true, youtubeChannelId: true } },
      niches: { select: { nicheId: true } },
    },
  });

  const byNiche = new Map<string, RpmChannelOutcome[]>();
  if (tracked.length === 0) return byNiche;

  const channelIds = tracked.map((row) => row.channelId);
  const [connectionState, revenue, priorDays, viewsGained, rates] = await Promise.all([
    connectionStateByYouTubeChannel(organizationId),
    revenueDaysInWindow(organizationId, channelIds, window),
    channelsWithRevenueBefore(organizationId, channelIds, window),
    channelViewDeltas(organizationId, channelIds, window),
    exchangeRatesToBase(organizationId, baseCurrency),
  ]);
  const visible = visibleNiches === null ? null : new Set(visibleNiches);

  for (const row of tracked) {
    const held = revenue.get(row.channelId) ?? [];
    const converted: RpmRevenueDay[] = [];
    let currencyConvertible = true;

    for (const day of held) {
      if (day.currency === baseCurrency) {
        converted.push({ dayMs: day.dayMs, revenueMinor: day.revenueMinor });
        continue;
      }
      const rate = rates.get(day.currency);
      if (rate === undefined) {
        /*
         * Refused, not skipped, and refused for the whole channel.
         *
         * `resolveConversion` in the finance service throws rather than
         * inverting a rate an admin configured in the other direction, on the
         * grounds that a derived rate is a number nobody entered. The same
         * applies here, with one extra reason to be strict: dropping the days
         * we could not convert would leave a numerator smaller than the truth
         * over a denominator that is not, which understates the niche instead
         * of declining to price it.
         */
        currencyConvertible = false;
        break;
      }
      converted.push({
        dayMs: day.dayMs,
        revenueMinor: convertMinorBetween(
          day.revenueMinor,
          rate,
          day.currency,
          baseCurrency,
        ),
      });
    }

    const state = connectionState.get(row.channel.youtubeChannelId);
    const evidence: RpmChannelEvidence = {
      channelId: row.channel.id,
      channelName: row.channel.title,
      // No connection at all is not "unknown monetization", it is "we cannot
      // ask" — the same class of fact as a refused report, and it reaches
      // `judgeRpmChannel` through the sync status for that reason.
      monetizationStatus: state?.monetizationStatus ?? "unknown",
      revenueSyncStatus: state?.revenueSyncStatus ?? "never",
      revenueDays: converted,
      currencyConvertible,
      hasRevenueDayBeforeWindow: priorDays.has(row.channelId),
      viewsGained: viewsGained.get(row.channelId)?.viewsGained ?? null,
      snapshotCoverage: viewsGained.get(row.channelId)?.coverage ?? 0,
    };

    const outcome = judgeRpmChannel(evidence, window);
    for (const { nicheId } of row.niches) {
      // A channel that matched the filter did so through ONE of its niches, and
      // its other niches may be outside the reader's assignment. Filing the
      // outcome under those too would put the channel's name and monetization
      // state on a niche they cannot see.
      if (visible !== null && !visible.has(nicheId)) continue;
      const list = byNiche.get(nicheId);
      if (list) list.push(outcome);
      else byNiche.set(nicheId, [outcome]);
    }
  }

  return byNiche;
}

interface ConnectionState {
  readonly monetizationStatus: string;
  readonly revenueSyncStatus: string;
}

/**
 * Monetization and revenue-read state per YouTube channel id.
 *
 * Both facts live on `YouTubeConnection`, and one connection can cover several
 * channels through `YouTubeConnectionChannel` — so a channel's state is its
 * CONNECTION's state, which makes it a coarse proxy. That is why it is only
 * ever the first of the tests in `judgeRpmChannel` and never the deciding one:
 * the per-channel revenue days carry the real evidence.
 */
async function connectionStateByYouTubeChannel(
  organizationId: string,
): Promise<ReadonlyMap<string, ConnectionState>> {
  const connections = await prisma.youTubeConnection.findMany({
    where: { organizationId },
    select: {
      youtubeChannelId: true,
      monetizationStatus: true,
      revenueSyncStatus: true,
      coveredChannels: { select: { youtubeChannelId: true } },
    },
  });

  const map = new Map<string, ConnectionState>();
  for (const connection of connections) {
    const state: ConnectionState = {
      monetizationStatus: connection.monetizationStatus,
      revenueSyncStatus: connection.revenueSyncStatus,
    };
    if (connection.youtubeChannelId) map.set(connection.youtubeChannelId, state);
    for (const covered of connection.coveredChannels) {
      map.set(covered.youtubeChannelId, state);
    }
  }
  return map;
}

interface HeldRevenueDay {
  readonly dayMs: number;
  readonly revenueMinor: number;
  readonly currency: string;
}

async function revenueDaysInWindow(
  organizationId: string,
  channelIds: readonly string[],
  window: RpmWindow,
): Promise<ReadonlyMap<string, HeldRevenueDay[]>> {
  const rows = await prisma.channelRevenueDay.findMany({
    where: {
      organizationId,
      channelId: { in: [...channelIds] },
      day: { gte: new Date(window.startMs), lt: new Date(window.endMs) },
    },
    select: { channelId: true, day: true, estimatedRevenueMinor: true, currency: true },
    orderBy: { day: "asc" },
  });

  const map = new Map<string, HeldRevenueDay[]>();
  for (const row of rows) {
    const day: HeldRevenueDay = {
      dayMs: row.day.getTime(),
      revenueMinor: row.estimatedRevenueMinor,
      // Read off the row rather than assumed. The importer writes USD today —
      // `REPORTING_CURRENCY` — but the column is what the row means, and a
      // future connector that reports a payout currency must not be silently
      // read as dollars.
      currency: row.currency,
    };
    const list = map.get(row.channelId);
    if (list) list.push(day);
    else map.set(row.channelId, [day]);
  }
  return map;
}

/**
 * Which channels have any revenue day held strictly BEFORE the window.
 *
 * The proven-quiet day behind the "newly monetized" test. Without it, a channel
 * whose earnings appear to start on the window's first day is indistinguishable
 * from one whose import simply has not reached further back.
 */
async function channelsWithRevenueBefore(
  organizationId: string,
  channelIds: readonly string[],
  window: RpmWindow,
): Promise<ReadonlySet<string>> {
  const rows = await prisma.channelRevenueDay.groupBy({
    by: ["channelId"],
    where: {
      organizationId,
      channelId: { in: [...channelIds] },
      day: { lt: new Date(window.startMs) },
    },
  });
  return new Set(rows.map((row) => row.channelId));
}

/**
 * The one direction of conversion this organization has actually configured.
 *
 * Read once and used twice: to bring an own channel's revenue days into the
 * base before a rate is divided out of them, and to bring a HAND-ENTERED range
 * into the base before it prices anything. The second matters only after an
 * admin switches the base currency — the dialog always writes the base of the
 * day — but that is exactly the moment every stored range in the organization
 * becomes foreign at once, and `Niche.rpmCurrency` exists so that switch does
 * not silently reinterpret them.
 *
 * Only `fromCurrency -> base` rows are loaded. A `base -> fromCurrency` row is
 * NOT inverted to stand in, matching `resolveConversion`'s stated refusal to
 * derive a direction nobody entered.
 */
async function exchangeRatesToBase(
  organizationId: string,
  baseCurrency: string,
): Promise<ReadonlyMap<string, number>> {
  const rows = await prisma.exchangeRate.findMany({
    where: { organizationId, toCurrency: baseCurrency },
    select: { fromCurrency: true, rate: true },
  });
  const map = new Map<string, number>();
  for (const row of rows) {
    // A non-positive or non-finite stored rate is not a rate. Leaving it out
    // makes the channel unconvertible, which is the honest outcome — the
    // alternative is a converted total of zero presented as revenue.
    if (Number.isFinite(row.rate) && row.rate > 0) map.set(row.fromCurrency, row.rate);
  }
  return map;
}

interface ChannelViewDelta {
  readonly viewsGained: number;
  readonly coverage: number;
}

/**
 * This caller's reading of the shared views-gained measurement.
 *
 * The measurement itself — snapshot bracketing, the zero-baseline rule for
 * videos born inside the window, kept negative deltas, the dropped uncovered
 * video — lives in `views-gained-service.ts` and is shared with the niche
 * money figures, so "views gained" cannot mean two things on two screens.
 * Two decisions belong to THIS caller and are made here:
 *
 * CHANNEL-WIDE, WITH NO FORMAT FILTER, and that is deliberate rather than an
 * oversight. The revenue this will be divided into is what the whole channel
 * earned — the Analytics request sends no content-type filter, so long-form
 * and YouTube Premium are both in it. Filtering the denominator to Shorts
 * alone would inflate the rate by every long-form dollar, which on a channel
 * with a back catalogue is not a correction but a multiple.
 *
 * A CHANNEL WITH NOT ONE BRACKETED VIDEO IS ABSENT, NOT ZERO. A zero here
 * would be a measurement saying "this channel gained no views in twenty-eight
 * days", and dividing a month of revenue by it would produce either an
 * infinity or, worse, a rate that looked plausible. The absence becomes
 * `viewsGained: null`, which `judgeRpmChannel` reports as `no_view_history` —
 * a sentence an owner can act on, because the fix is waiting for the history
 * automatic refresh records to grow long enough to bracket the window. The
 * shared service keeps such channels in its map (the niche caller counts them
 * toward coverage), so the omission is re-applied at this boundary, where
 * that meaning belongs.
 */
async function channelViewDeltas(
  organizationId: string,
  channelIds: readonly string[],
  window: RpmWindow,
): Promise<ReadonlyMap<string, ChannelViewDelta>> {
  const gained = await viewsGainedByChannel({ organizationId, channelIds, window });

  const map = new Map<string, ChannelViewDelta>();
  for (const [channelId, entry] of gained) {
    if (entry.coveredVideos === 0) continue;
    map.set(channelId, {
      viewsGained: entry.viewsGained,
      coverage: entry.totalVideos === 0 ? 0 : entry.coveredVideos / entry.totalVideos,
    });
  }
  return map;
}
