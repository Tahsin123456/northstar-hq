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
 * WHAT THIS RETURNS TODAY, ON THIS DEPLOYMENT
 * ---------------------------------------------------------------------------
 * `{ source: "none" }` or `{ source: "manual" }` for every niche, and that is
 * the correct answer rather than a degraded one. `OrganizationSettings.
 * autoRefreshEnabled` is false, so nothing is writing `VideoSnapshot` rows; with
 * no view history there is no denominator, every own channel is rejected with
 * `no_view_history`, and the hand-entered range is the only path to a number.
 * The reason travels to the screen so an owner can see that the missing piece
 * is a settings decision rather than a bug.
 */

const DAY_MS = 86_400_000;

/**
 * How far before the window's start a view reading may be and still bracket it.
 *
 * A video's views at the window's start come from the last snapshot taken at or
 * before that instant. Searching backwards without limit would mean loading a
 * channel's entire snapshot history to answer a question about one month, so
 * the search is bounded — and a video whose most recent reading is older than
 * this is treated as UNCOVERED rather than as having stood still.
 *
 * The bound is deliberately far wider than any sync cadence the app offers, so
 * it only ever excludes a video the collector has genuinely stopped seeing. The
 * cost of being wrong is bounded in the safe direction as well: an uncovered
 * video is dropped from the denominator, which the coverage floor in
 * `judgeRpmChannel` then measures and refuses if too much of the library is
 * missing.
 */
const SNAPSHOT_LOOKBACK_DAYS = 60;

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
    viewsGainedByChannel(organizationId, channelIds, window),
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
 * Views gained across the window, per own channel, from the snapshot series.
 *
 * THE ONLY HONEST SOURCE FOR THIS NUMBER, and the reason the whole derived rate
 * is unavailable today. `Channel.viewCount` and `Video.viewCount` are lifetime
 * totals that are overwritten on every sync, so neither can say what a period
 * earned; `ChannelRevenueDay` carries no view metric. `VideoSnapshot` is the
 * only append-only series, and with `autoRefreshEnabled` false nothing is
 * writing to it.
 *
 * CHANNEL-WIDE, WITH NO `isShort` FILTER, and that is deliberate rather than an
 * oversight. The revenue this will be divided into is what the whole channel
 * earned — the Analytics request sends no content-type filter, so long-form and
 * YouTube Premium are both in it. Filtering the denominator to Shorts alone
 * would inflate the rate by every long-form dollar, which on a channel with a
 * back catalogue is not a correction but a multiple.
 *
 * A VIDEO WITH NO READING AT THE WINDOW'S START IS DROPPED, NOT ZERO-BASED.
 * Its views at that instant are genuinely unknown, and assuming zero would
 * credit the window with a lifetime of views. Dropping shrinks the denominator
 * and therefore inflates the rate, which is why the count of dropped videos is
 * returned as `coverage` and why `judgeRpmChannel` refuses below 90%.
 */
async function viewsGainedByChannel(
  organizationId: string,
  channelIds: readonly string[],
  window: RpmWindow,
): Promise<ReadonlyMap<string, ChannelViewDelta>> {
  const endDate = new Date(window.endMs);
  const lookbackFrom = new Date(window.startMs - SNAPSHOT_LOOKBACK_DAYS * DAY_MS);

  const videos = await prisma.video.findMany({
    where: {
      channelId: { in: [...channelIds] },
      publishedAt: { lt: endDate },
      // Reachability through this organization's own tracker. `Video` and
      // `VideoSnapshot` are global deduplicated rows with no tenant column, so
      // this is the only thing that makes the history ours to read.
      channel: { trackedBy: { some: { organizationId, isActive: true } } },
    },
    select: {
      id: true,
      channelId: true,
      publishedAt: true,
      snapshots: {
        where: { capturedAt: { gte: lookbackFrom, lt: endDate } },
        select: { capturedAt: true, viewCount: true },
        orderBy: { capturedAt: "asc" },
      },
    },
  });

  const totals = new Map<string, { gained: number; covered: number; total: number }>();

  for (const video of videos) {
    const bucket = totals.get(video.channelId) ?? { gained: 0, covered: 0, total: 0 };
    bucket.total += 1;

    // Views at the window's close: the last reading taken before it. The
    // current lifetime total is NOT a substitute — it is today's number, and
    // using it would credit the window with everything earned since.
    const atEnd = lastAtOrBefore(video.snapshots, window.endMs);

    if (atEnd !== null) {
      if (video.publishedAt !== null && video.publishedAt.getTime() >= window.startMs) {
        // Published inside the window, so it started at nothing. This is the
        // one case where a zero baseline is a fact rather than an assumption.
        bucket.gained += atEnd;
        bucket.covered += 1;
      } else {
        const atStart = lastAtOrBefore(video.snapshots, window.startMs);
        if (atStart !== null) {
          // Views can fall when YouTube purges inflated counts, and a negative
          // delta is real. It is kept rather than clamped: clamping every
          // negative to zero would bias the denominator upward and the rate
          // downward, one video at a time.
          bucket.gained += atEnd - atStart;
          bucket.covered += 1;
        }
      }
    }

    totals.set(video.channelId, bucket);
  }

  const map = new Map<string, ChannelViewDelta>();
  for (const [channelId, bucket] of totals) {
    /*
     * NOT ONE READING BRACKETS THIS WINDOW, so there is no delta — absent, not
     * zero.
     *
     * This is the branch that runs today, for every own channel. A zero here
     * would be a measurement saying "this channel gained no views in
     * twenty-eight days", and dividing a month of revenue by it would produce
     * either an infinity or, worse, a rate that looked plausible. The absence
     * becomes `viewsGained: null`, which `judgeRpmChannel` reports as
     * `no_view_history` — a sentence an owner can act on, because the action is
     * turning on automatic refresh.
     */
    if (bucket.covered === 0) continue;
    map.set(channelId, {
      viewsGained: bucket.gained,
      coverage: bucket.total === 0 ? 0 : bucket.covered / bucket.total,
    });
  }

  return map;
}

/** The last reading at or before an instant, in views, or null when there is none. */
function lastAtOrBefore(
  snapshots: readonly { capturedAt: Date; viewCount: bigint }[],
  atMs: number,
): number | null {
  let best: { capturedAt: Date; viewCount: bigint } | null = null;
  for (const snapshot of snapshots) {
    const capturedMs = snapshot.capturedAt.getTime();
    if (capturedMs > atMs) continue;
    if (best === null || capturedMs > best.capturedAt.getTime()) best = snapshot;
  }
  return best === null ? null : Number(best.viewCount);
}
