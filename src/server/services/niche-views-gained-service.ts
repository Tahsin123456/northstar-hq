import "server-only";

import { prisma } from "@/server/db";
import { getVisibleNicheIds } from "@/server/auth/niche-scope";
import type { NicheViewsGainedDTO } from "@/lib/dto";
import type { NicheFormat } from "@/lib/niches/niche-format";
import {
  computeNicheViewsGained,
  shortsShareOf,
  type ChannelGainsSource,
  type ChannelReading,
  type NicheMember,
} from "@/lib/analytics/channel-views-gained";
import { getCurrentOrgId } from "./user-service";
import { nicheFormatWhere } from "./niche-service";

/**
 * =========================================================================
 * WHAT EACH NICHE GAINED — THE VIEW SIDE OF THE MONEY FIGURES
 * =========================================================================
 *
 * The niche earnings panel and the niche cards price "views GAINED during the
 * selected period" — every view the tracked channels earned in the window,
 * old uploads included — at the niche's rate. This service loads what that
 * needs and hands it to the pure core in `channel-views-gained.ts`, which is
 * where the rules live and are tested.
 *
 * THE BASIS IS THE CHANNEL COUNTER, NOT THE VIDEOS. YouTube reports one
 * lifetime view count per channel, over every upload however old, and the
 * sync records it as a `ChannelViewSnapshot` on every run. The figure is one
 * subtraction per channel between two of those readings. The per-video
 * snapshot delta in `views-gained-service.ts` is NOT used here any more — it
 * serves the derived RPM, whose denominator must be the exact views the
 * revenue was paid on, and it is the wrong tool for this figure: it can only
 * see videos inside the lookback, and its coverage floor blacked out every
 * niche whenever the sweep had reached the channels a few hours apart.
 *
 * WHAT IS LOADED, and why each thing:
 *
 *   • the format's visible niches and their member channels, through the same
 *     tracking join every other tenant read uses;
 *   • each member channel's readings — its `ChannelViewSnapshot` rows inside
 *     `[startMs − 60d, endMs]` PLUS the live pair (`channels.viewCount` at
 *     `channels.lastFetchedAt`), which is a reading YouTube actually returned
 *     at a known instant and which the series deliberately does not
 *     duplicate;
 *   • each member channel's Shorts share, from its stored videos grouped by
 *     `isShort` and `classification` — the owner's decision for splitting a
 *     channel-wide counter between a Shorts niche and a Long Form one, with
 *     unresolved videos in neither side, exactly as `isVideoOfFormat` reads
 *     them.
 *
 * THE MEASURED SPAN IS THE COVERED SPAN, NEVER THE REQUESTED ONE. The app can
 * only measure from the instant every measurable channel holds a reading —
 * the MAX of first readings, and the core says at length why the max and not
 * the min. The clamp travels back as `measuredFromMs` so every surface can
 * say "measured over the last 9 of 30 days" instead of presenting a partial
 * span as the period.
 *
 * VIEW COUNTS ONLY. The rate stays on `NicheDTO.rpm` behind `finance.view`;
 * what this returns is the same class of numbers `analytics.view` already
 * covers on the dataset. The niche SCOPE still applies — a niche-scoped
 * reader's invisible niches are OMITTED from the response entirely, because
 * even a view total is a statement about a niche they were not assigned.
 */

/**
 * How far before the period's start a reading may sit and still bracket it.
 *
 * Bounded so the question about one month does not load a channel's whole
 * series; far wider than any sync cadence the app offers, so it only ever
 * excludes a channel the collector has genuinely stopped seeing — which is
 * then unmeasured rather than assumed to have stood still.
 */
export const CHANNEL_READING_LOOKBACK_DAYS = 60;

const DAY_MS = 86_400_000;

/**
 * Views gained per visible niche of one format, over the covered part of the
 * requested period.
 */
export async function getNicheViewsGained(options: {
  readonly format: NicheFormat;
  readonly startMs: number;
  /** Exclusive. */
  readonly endMs: number;
  /**
   * The present instant. Injected so a test can pin the tail lag and the
   * "period not closed yet" clamp without reaching for the clock; production
   * leaves it alone.
   */
  readonly nowMs?: number;
}): Promise<NicheViewsGainedDTO> {
  const { format, startMs, endMs } = options;
  const nowMs = options.nowMs ?? Date.now();
  const [organizationId, visibleNiches] = await Promise.all([
    getCurrentOrgId(),
    /*
     * The niche scope, applied to the QUERY below rather than to the answer.
     * `analytics.view` gates the route; this decides which niches it is
     * answered FOR. Invisible niches are left out of the response entirely —
     * the same absence-not-empty rule `NicheDTO.rpm` follows — so a scoped
     * reader cannot learn even the view totals of a niche that is not theirs.
     */
    getVisibleNicheIds(),
  ]);

  const nicheRows = await prisma.niche.findMany({
    where: {
      organizationId,
      ...nicheFormatWhere(format),
      ...(visibleNiches === null ? {} : { id: { in: [...visibleNiches] } }),
    },
    select: { id: true },
  });

  const nicheIds = nicheRows.map((row) => row.id);

  const members =
    nicheIds.length === 0
      ? []
      : await prisma.trackedChannel.findMany({
          where: {
            organizationId,
            isActive: true,
            // Membership in one of the format's visible niches, in the query
            // beside the tenancy filter — the same placement every other
            // tracked-channel read uses, so the next caller inherits the
            // narrowing instead of having to remember it.
            niches: { some: { nicheId: { in: nicheIds } } },
          },
          select: {
            channelId: true,
            ownershipType: true,
            niches: { select: { nicheId: true } },
          },
        });

  const memberChannelIds = [...new Set(members.map((member) => member.channelId))];

  const lookbackFromMs = startMs - CHANNEL_READING_LOOKBACK_DAYS * DAY_MS;
  const lookbackFrom = new Date(lookbackFromMs);
  const endDate = new Date(endMs);

  /*
   * ONE read of the channel series over every member channel, then measured
   * in memory. A per-niche call would re-read the same channel's series once
   * per niche it is filed under; this way a channel in two niches is measured
   * once and counted in both, mirroring how the RPM service judges it once.
   *
   * `trackedBy` is the tenancy: `Channel` and `ChannelViewSnapshot` are global
   * deduplicated rows with no organization column, and the tracking join is
   * what makes the series ours to read.
   */
  const [channelRows, shareRows] =
    memberChannelIds.length === 0
      ? [[], []]
      : await Promise.all([
          prisma.channel.findMany({
            where: {
              id: { in: memberChannelIds },
              trackedBy: { some: { organizationId, isActive: true } },
            },
            select: {
              id: true,
              // The live pair — a reading at its own instant. See the header.
              viewCount: true,
              lastFetchedAt: true,
              viewSnapshots: {
                where: { capturedAt: { gte: lookbackFrom, lte: endDate } },
                select: { capturedAt: true, viewCount: true },
                orderBy: { capturedAt: "asc" },
              },
            },
          }),
          /*
           * The Shorts share, from counts rather than rows: the number of
           * positively-identified Shorts and the number of
           * positively-identified long-form videos per channel. Grouped on
           * BOTH columns because the two formats are decided from different
           * columns — `isShort` for Shorts, `classification === "not_short"`
           * for long-form — and an uncertain video must land in neither.
           */
          prisma.video.groupBy({
            by: ["channelId", "isShort", "classification"],
            where: { channelId: { in: memberChannelIds } },
            _count: { _all: true },
          }),
        ]);

  const shortsCount = new Map<string, number>();
  const longformCount = new Map<string, number>();
  for (const row of shareRows) {
    const count = row._count._all;
    if (row.isShort === true) {
      shortsCount.set(row.channelId, (shortsCount.get(row.channelId) ?? 0) + count);
    }
    if (row.classification === "not_short") {
      longformCount.set(row.channelId, (longformCount.get(row.channelId) ?? 0) + count);
    }
  }

  const channels: ChannelGainsSource[] = channelRows.map((row) => {
    const readings: ChannelReading[] = row.viewSnapshots.map((snapshot) => ({
      capturedMs: snapshot.capturedAt.getTime(),
      views: Number(snapshot.viewCount),
    }));
    /*
     * The live counter, admitted on the same bounds as the stored rows. It is
     * usually the same reading the sync also filed as a row — same instant to
     * within the five-minute bucket — and the core treats two readings at one
     * instant as one; what it adds is the most recent reading when the last
     * sync's row has not yet been written, and nothing when the channel has
     * not been fetched inside the reach.
     */
    if (row.viewCount !== null && row.lastFetchedAt !== null) {
      const fetchedMs = row.lastFetchedAt.getTime();
      if (fetchedMs >= lookbackFromMs && fetchedMs <= endMs) {
        readings.push({ capturedMs: fetchedMs, views: Number(row.viewCount) });
      }
    }
    return {
      channelId: row.id,
      readings,
      shortsShare: shortsShareOf(
        shortsCount.get(row.id) ?? 0,
        longformCount.get(row.id) ?? 0,
      ),
    };
  });

  const inScope = new Set(nicheIds);
  const membersByNiche = new Map<string, NicheMember[]>();
  for (const member of members) {
    const row: NicheMember = {
      channelId: member.channelId,
      ownershipType: member.ownershipType,
    };
    for (const { nicheId } of member.niches) {
      // A channel matched the filter through ONE of its niches; its other
      // memberships may be outside this format or this reader's scope, and
      // filing gains under those would leak exactly what the query excluded.
      if (!inScope.has(nicheId)) continue;
      const list = membersByNiche.get(nicheId);
      if (list) list.push(row);
      else membersByNiche.set(nicheId, [row]);
    }
  }

  return computeNicheViewsGained({
    format,
    requestedStartMs: startMs,
    endMs,
    nowMs,
    nicheIds,
    membersByNiche,
    channels,
  });
}
