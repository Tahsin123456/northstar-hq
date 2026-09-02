import "server-only";

import { prisma } from "@/server/db";
import { getVisibleNicheIds } from "@/server/auth/niche-scope";
import type { NicheViewsGainedDTO, NicheViewsGainedEntryDTO } from "@/lib/dto";
import type { NicheFormat } from "@/lib/niches/niche-format";
import { getCurrentOrgId } from "./user-service";
import { nicheFormatWhere } from "./niche-service";
import { viewsGainedByChannel, type ChannelViewsGained } from "./views-gained-service";

/**
 * =========================================================================
 * WHAT EACH NICHE GAINED — THE VIEW SIDE OF THE MONEY FIGURES
 * =========================================================================
 *
 * The niche earnings panel and the niche cards price "views GAINED during the
 * selected period" — every view the tracked channels earned in the window,
 * old uploads included — not the lifetime views of what happened to be
 * published in it. This service supplies those gains, grouped per niche, from
 * the shared snapshot-delta measurement in `views-gained-service.ts`.
 *
 * THE MEASURED SPAN IS THE COVERED SPAN, NEVER THE REQUESTED ONE. The app can
 * only measure from the day it started recording view history. When the
 * period reaches further back than the history does, the whole answer is
 * measured over `[max(startMs, earliest snapshot), endMs)` — applied
 * UNIFORMLY, because clamping per channel would sum deltas measured over
 * different spans into one figure no span describes. The clamp travels back
 * as `measuredFromMs` so every surface can say "measured over the last 9 of
 * 30 days" instead of presenting a partial span as the period.
 *
 * VIEW COUNTS ONLY. The rate stays on `NicheDTO.rpm` behind `finance.view`;
 * what this returns is the same class of numbers `analytics.view` already
 * covers on the dataset. The niche SCOPE still applies — a niche-scoped
 * reader's invisible niches are OMITTED from the response entirely, because
 * even a view total is a statement about a niche they were not assigned.
 */

/** The full row set the grouping core works over. */
interface MemberChannel {
  readonly channelId: string;
  readonly ownershipType: string;
}

/**
 * The pure grouping: member channels' measured gains, filed under each niche.
 *
 * A CHANNEL IN TWO NICHES COUNTS IN BOTH — correct for a per-niche figure,
 * exactly as `niche-rpm-service` states for rates, and the reason the
 * earnings builder downstream refuses to SUM niches sharing a channel.
 *
 * Own/competitor sums include only channels that measured something
 * (`coveredVideos > 0`): an unmeasured channel's zero is "we could not ask",
 * not "it gained nothing", so it contributes to the coverage denominator —
 * which every money caller holds a floor against — and to nothing else. The
 * coverage counts sum over ALL members for the same reason: leaving the dark
 * channels out would report a full-coverage niche whose biggest channel was
 * never measured.
 */
export function groupNicheViewsGained(
  nicheIds: readonly string[],
  membersByNiche: ReadonlyMap<string, readonly MemberChannel[]>,
  gainsByChannel: ReadonlyMap<string, ChannelViewsGained>,
): NicheViewsGainedEntryDTO[] {
  return nicheIds.map((nicheId) => {
    let ourViewsGained = 0;
    let competitorViewsGained = 0;
    let coveredVideos = 0;
    let totalVideos = 0;
    const ownChannelIds: string[] = [];

    for (const member of membersByNiche.get(nicheId) ?? []) {
      const gains = gainsByChannel.get(member.channelId);
      if (gains === undefined) continue;

      coveredVideos += gains.coveredVideos;
      totalVideos += gains.totalVideos;

      if (gains.coveredVideos === 0) continue;
      if (member.ownershipType === "own") {
        ourViewsGained += gains.viewsGained;
        // Only channels that MEASURED something: the ids feed the earnings
        // total's double-count check, and a channel contributing zero views to
        // two niches cannot double anything.
        ownChannelIds.push(member.channelId);
      } else {
        competitorViewsGained += gains.viewsGained;
      }
    }

    return {
      nicheId,
      ourViewsGained,
      competitorViewsGained,
      coveredVideos,
      totalVideos,
      ownChannelIds,
    };
  });
}

/**
 * Views gained per visible niche of one format, over the covered part of the
 * requested period.
 */
export async function getNicheViewsGained(options: {
  readonly format: NicheFormat;
  readonly startMs: number;
  /** Exclusive. */
  readonly endMs: number;
}): Promise<NicheViewsGainedDTO> {
  const { format, startMs, endMs } = options;
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

  const [nicheRows, earliest] = await Promise.all([
    prisma.niche.findMany({
      where: {
        organizationId,
        ...nicheFormatWhere(format),
        ...(visibleNiches === null ? {} : { id: { in: [...visibleNiches] } }),
      },
      select: { id: true },
    }),
    /*
     * The earliest usable baseline this organization's history holds, reached
     * through the same tracking join as everything else — the pattern
     * `history-service.ts` sets, and for its reason: unscoped, this would
     * report another team's oldest snapshot and promise history these
     * channels cannot support.
     */
    prisma.videoSnapshot.findFirst({
      where: {
        video: { channel: { trackedBy: { some: { organizationId, isActive: true } } } },
      },
      orderBy: { capturedAt: "asc" },
      select: { capturedAt: true },
    }),
  ]);

  const nicheIds = nicheRows.map((row) => row.id);
  const earliestSnapshotMs = earliest?.capturedAt.getTime() ?? null;
  const measuredFromMs =
    earliestSnapshotMs === null ? null : Math.max(startMs, earliestSnapshotMs);

  /*
   * NOTHING TO MEASURE IS SAID, NOT COMPUTED. With no snapshots at all, or a
   * period that ends before the history begins, every delta the measurement
   * could return would be the absence of a reading dressed as a zero. The
   * empty `niches` array is the no-history shape: a missing entry reads as
   * "unmeasured" downstream, which renders as words rather than as money.
   */
  if (measuredFromMs === null || measuredFromMs >= endMs) {
    return {
      requestedStartMs: startMs,
      endMs,
      measuredFromMs: null,
      earliestSnapshotMs,
      niches: [],
    };
  }

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

  /*
   * ONE measurement over every member channel, then grouped in memory. A
   * per-niche call would re-read the same channel's snapshots once per niche
   * it is filed under; this way a channel in two niches is measured once and
   * counted in both, mirroring how the RPM service judges it once.
   */
  const gainsByChannel: ReadonlyMap<string, ChannelViewsGained> =
    members.length === 0
      ? new Map<string, ChannelViewsGained>()
      : await viewsGainedByChannel({
          organizationId,
          channelIds: members.map((member) => member.channelId),
          window: { startMs: measuredFromMs, endMs },
          // The niche's format, unlike the RPM denominator: what is priced
          // here is one format's niche, so only that format's videos may be
          // measured — and an uncertain video is in neither format, per
          // `isVideoOfFormat`.
          format,
        });

  const inScope = new Set(nicheIds);
  const membersByNiche = new Map<string, MemberChannel[]>();
  for (const member of members) {
    const row: MemberChannel = {
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

  return {
    requestedStartMs: startMs,
    endMs,
    measuredFromMs,
    earliestSnapshotMs,
    niches: groupNicheViewsGained(nicheIds, membersByNiche, gainsByChannel),
  };
}
