/**
 * Dataset assembly — the payload that powers the entire client.
 *
 * WHY ONE BIG PAYLOAD
 * The product requirement is blunt: changing the threshold from 1M to 500K, or
 * the period from 30D to 90D, must not produce a YouTube request — or, ideally,
 * any request at all. The most robust way to guarantee that is to make it
 * structurally impossible: ship every stored video once, then derive every
 * metric in the browser with the same analytics engine the server uses. There
 * is no round-trip to accidentally introduce, because there is nothing left to
 * ask for.
 *
 * SIZE
 * Rows are projected down to the ten fields the engine actually reads. At the
 * scale this tool is for — a few dozen channels, a few thousand Shorts — that
 * is a few hundred KB before compression, fetched once per session and cached.
 * Thumbnails are omitted entirely and derived client-side from the video id,
 * which alone removes ~50 bytes a row.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { hasYouTubeApiKey } from "@/server/env";
import { errors } from "@/server/errors";
import { toChannelDTO, toExcludedVideoDTO, toVideoDTO } from "@/server/mappers";
import type { DatasetChannelDTO, DatasetDTO, ExcludedVideoDTO } from "@/lib/dto";
import { getCurrentOrgId, getCurrentOrgSettings } from "./user-service";
import { listNiches } from "./niche-service";
import { getNoteCounts, listCollections, listSavedShorts } from "./research-service";

const MS_PER_DAY = 86_400_000;

/**
 * "This snapshot belongs to a channel my organization actively tracks."
 *
 * VideoSnapshot has no tenant column of its own — it hangs off the canonical,
 * deduplicated Video/Channel rows that every organization shares. Reachability
 * through an active TrackedChannel is therefore the only thing that makes a
 * snapshot mine, and it is what keeps one team from reading a history another
 * team spent its YouTube quota collecting.
 */
function snapshotsVisibleTo(organizationId: string): Prisma.VideoSnapshotWhereInput {
  return {
    video: { channel: { trackedBy: { some: { organizationId, isActive: true } } } },
  };
}

/** The exact columns the analytics engine and Shorts table consume. */
const VIDEO_SELECT = {
  id: true,
  youtubeVideoId: true,
  title: true,
  publishedAt: true,
  viewCount: true,
  likeCount: true,
  commentCount: true,
  durationSeconds: true,
  isShort: true,
  classification: true,
  classificationConfidence: true,
  isAvailable: true,
} as const;

export async function buildDataset(
  options: { lookbackDays?: number } = {},
): Promise<DatasetDTO> {
  // How far back we keep videos decides how much shared quota a refresh spends
  // and how much history the canonical Video rows carry, so it is a team
  // setting: one person widening it would silently change everyone's dataset.
  const [organizationId, orgSettings] = await Promise.all([
    getCurrentOrgId(),
    getCurrentOrgSettings(),
  ]);
  const lookbackDays = options.lookbackDays ?? orgSettings.lookbackDays;
  const since = new Date(Date.now() - lookbackDays * MS_PER_DAY);

  const [tracked, niches, collections, savedShorts, noteCounts, viewsDefinition] =
    await Promise.all([
    // The team's tracker, not the caller's: two people in one organization must
    // open the dashboard on the same channels and the same numbers.
    prisma.trackedChannel.findMany({
      where: { organizationId, isActive: true },
      include: {
        niches: { include: { niche: true } },
        channel: {
          include: {
            videos: {
              where: { publishedAt: { gte: since } },
              select: VIDEO_SELECT,
              orderBy: { publishedAt: "desc" },
            },
          },
        },
      },
      orderBy: { addedAt: "asc" },
    }),
    // Shipped with the dataset so the niche filter, the Niches page and the
    // assignment menus all read from one payload. Niche filtering is then a
    // client-side predicate like every other filter — no refetch.
    listNiches(),
    listCollections(),
    listSavedShorts(),
    getNoteCounts(),
    getViewsDefinition(),
  ]);

  const channels: DatasetChannelDTO[] = tracked.map((row) => {
    const videos = row.channel.videos.map(toVideoDTO);
    return {
      channel: toChannelDTO(row.channel, row),
      videos,
      excludedCount: videos.filter((v) => !v.isShort).length,
      unclassifiedCount: videos.filter((v) => v.classification === "uncertain").length,
    };
  });

  const fetchTimes = channels
    .map((c) => c.channel.lastFetchedAt)
    .filter((value): value is number => value !== null);

  return {
    channels,
    niches,
    collections,
    savedShorts,
    noteCounts,
    viewsDefinition,
    lookbackDays,
    generatedAt: Date.now(),
    oldestFetchedAt: fetchTimes.length > 0 ? Math.min(...fetchTimes) : null,
    hasApiKey: hasYouTubeApiKey(),
  };
}

/**
 * Videos stored for a channel but *not* counted as Shorts, with the classifier's
 * reasoning.
 *
 * Kept out of the main dataset because the reasons are full sentences and only
 * matter when someone actively questions a number. Being able to answer "why
 * isn't this video in my hit rate?" with a specific, recorded reason is what
 * makes the classifier auditable rather than a black box.
 */
export async function getExcludedVideos(
  channelId: string,
  options: { startMs?: number; endMs?: number; limit?: number } = {},
): Promise<ExcludedVideoDTO[]> {
  const organizationId = await getCurrentOrgId();

  // Channel and Video rows are global and deduplicated, so this tracking row is
  // the entire access check: without it the caller's organization has no claim
  // on the channel, whoever on the team originally added it.
  const tracking = await prisma.trackedChannel.findFirst({
    where: { organizationId, channelId },
    select: { id: true },
  });
  if (!tracking) throw errors.notFound("channel");

  const rows = await prisma.video.findMany({
    where: {
      channelId,
      isShort: false,
      ...(options.startMs || options.endMs
        ? {
            publishedAt: {
              ...(options.startMs ? { gte: new Date(options.startMs) } : {}),
              ...(options.endMs ? { lt: new Date(options.endMs) } : {}),
            },
          }
        : {}),
    },
    select: {
      youtubeVideoId: true,
      title: true,
      publishedAt: true,
      durationSeconds: true,
      viewCount: true,
      classification: true,
      classificationConfidence: true,
      classificationMethod: true,
      classificationReason: true,
    },
    orderBy: { publishedAt: "desc" },
    take: options.limit ?? 200,
  });

  return rows.map(toExcludedVideoDTO);
}

export interface SnapshotPointDTO {
  readonly capturedAt: number;
  readonly views: number;
  readonly videoAgeHours: number;
}

/**
 * Snapshot history for one video.
 *
 * V1 does not chart this yet, but the collection mechanism runs on every
 * refresh, so the series is accumulating from day one. Reading it back is
 * exposed now so the data is verifiably real rather than a promised
 * table that nothing ever reads.
 */
export async function getVideoSnapshots(
  youtubeVideoId: string,
): Promise<SnapshotPointDTO[]> {
  const organizationId = await getCurrentOrgId();

  // Looked up by tracking reachability rather than by id alone. A YouTube video
  // id is public and guessable, so an unscoped lookup here would hand anyone
  // with an account the full history another organization paid quota to collect.
  // findFirst rather than findUnique because a unique lookup cannot carry a
  // relation filter — and folding the ownership test into the same query is
  // what makes "not tracked by us" indistinguishable from "does not exist",
  // so a 404 never confirms that some other team is watching this video.
  const video = await prisma.video.findFirst({
    where: {
      youtubeVideoId,
      channel: { trackedBy: { some: { organizationId, isActive: true } } },
    },
    select: {
      snapshots: {
        orderBy: { capturedAt: "asc" },
        select: { capturedAt: true, viewCount: true, videoAgeHours: true },
      },
    },
  });
  if (!video) throw errors.notFound("video");

  return video.snapshots.map((s) => ({
    capturedAt: s.capturedAt.getTime(),
    views: Number(s.viewCount),
    videoAgeHours: s.videoAgeHours,
  }));
}

/**
 * How much snapshot history exists, and therefore whether "views earned during
 * a period" is answerable at all.
 *
 * This is the honest answer to the Total Views question. The dashboard reports
 * the sum of *current* views of Shorts *uploaded* in the period. YouTube Studio
 * reports views *earned* in the period across the whole back catalogue —
 * including videos uploaded years ago. Those are different measurements and
 * will never agree.
 *
 * Computing the Studio-style number needs a view count for each video at both
 * ends of the window. VideoSnapshot has been collecting exactly that since the
 * feature shipped, but until it spans the requested window the honest response
 * is "not enough history yet", not an approximation built from current totals.
 *
 * All three reads are scoped to the caller's organization. Unscoped they would
 * describe the whole installation's coverage — leaking how much history other
 * tenants hold, and worse, promising a window this team's own channels cannot
 * actually bracket because somebody else's snapshots span it.
 */
export async function getViewsDefinition() {
  const organizationId = await getCurrentOrgId();
  const where = snapshotsVisibleTo(organizationId);

  const [count, first, last] = await Promise.all([
    prisma.videoSnapshot.count({ where }),
    prisma.videoSnapshot.findFirst({
      where,
      orderBy: { capturedAt: "asc" },
      select: { capturedAt: true },
    }),
    prisma.videoSnapshot.findFirst({
      where,
      orderBy: { capturedAt: "desc" },
      select: { capturedAt: true },
    }),
  ]);

  const spanMs =
    first && last ? last.capturedAt.getTime() - first.capturedAt.getTime() : 0;
  const spanHours = Math.floor(spanMs / 3_600_000);

  // A single day of captures cannot bracket even a 7-day window.
  const snapshotDays = Math.max(1, Math.ceil(spanHours / 24));

  return {
    canComputeViewsInPeriod: spanHours >= 24 * 7,
    snapshotSpanHours: spanHours,
    snapshotCount: count,
    snapshotDays: count === 0 ? 0 : snapshotDays,
  };
}
