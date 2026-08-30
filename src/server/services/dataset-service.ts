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
import { getVisibleNicheIds, trackedChannelNicheFilter } from "@/server/auth/niche-scope";
import { getCurrentOrgId, getCurrentOrgSettings } from "./user-service";
import { listNiches } from "./niche-service";
import { listContentTypes } from "./content-type-service";
import { getNoteCounts, listCollections, listSavedShorts } from "./research-service";
import { channelDataSources } from "./youtube-oauth-service";

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

/**
 * The exact columns the analytics engine and Shorts table consume.
 *
 * A FUNCTION, not a constant, and that is the whole point of it. Every scalar
 * here belongs to the global, deduplicated `Video` row and is the same for
 * everyone — but `contentTypes` is this organization's classification of that
 * shared row, and `VideoContentType` carries `organizationId` for exactly that
 * reason. Selecting the relation unfiltered would ship every team's labels for
 * a Short to every other team tracking the same channel. Taking the scope as a
 * parameter means the filter cannot be forgotten: there is no version of this
 * select that compiles without one.
 */
function videoSelect(organizationId: string) {
  return {
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
    /*
     * DEVIATIONS, not tags — and `state` is what says which kind.
     *
     * These rows exist only where a Short DIFFERS from its channel: one per tag
     * it carries that the channel does not, one per tag it refuses that the
     * channel does. For the overwhelming majority of Shorts there are none at
     * all, which is what keeps this select cheap on a payload carrying a few
     * thousand videos — and is the whole reason the channel is left as the live
     * source instead of being copied down.
     *
     * Ids only. The catalogue travels once at the top of the payload; see the
     * note on `VideoDTO.manualContentTypeIds`.
     */
    contentTypes: {
      where: { organizationId },
      select: { contentTypeId: true, state: true },
    },
    /*
     * THIS ORGANIZATION'S VERDICT ON THIS SHORT, and the tenant filter is as
     * load-bearing here as it is above.
     *
     * A hit is a bar reached inside a window, and both halves are one team's
     * niche setting. `Video` is a global deduplicated row, so an unfiltered
     * select would ship another organization's judgement of a shared Short and
     * the dashboard would render somebody else's definition of success.
     *
     * At most one row survives the filter —
     * `@@unique([organizationId, videoId])` — so `take: 1` is a statement of
     * that rather than a limit, and it keeps the query planner from fetching a
     * list it will always find one of.
     *
     * SELECTED FOR EVERY VIDEO, including long-form, because filtering by
     * `isShort` here would save nothing: long-form has no evaluation row, so
     * the join returns empty for it either way, and a second condition would
     * only be one more thing that could disagree with the evaluator.
     */
    hitEvaluations: {
      where: { organizationId },
      take: 1,
      select: {
        outcome: true,
        thresholdApplied: true,
        windowHoursApplied: true,
        viewsAtWindow: true,
        observedAtHours: true,
      },
    },
  } as const;
}

export async function buildDataset(
  options: { lookbackDays?: number } = {},
): Promise<DatasetDTO> {
  // How far back we keep videos decides how much shared quota a refresh spends
  // and how much history the canonical Video rows carry, so it is a team
  // setting: one person widening it would silently change everyone's dataset.
  const [organizationId, orgSettings, visibleNiches] = await Promise.all([
    getCurrentOrgId(),
    getCurrentOrgSettings(),
    // Resolved here rather than trusted from the client. Every metric on the
    // dashboard is derived in the browser from this one payload, so whatever a
    // niche-scoped member is not entitled to must be absent from it — hiding it
    // afterwards would still have shipped the rows.
    getVisibleNicheIds(),
  ]);
  const lookbackDays = options.lookbackDays ?? orgSettings.lookbackDays;
  const since = new Date(Date.now() - lookbackDays * MS_PER_DAY);

  const [
    tracked,
    niches,
    contentTypes,
    collections,
    savedShorts,
    noteCounts,
    viewsDefinition,
  ] = await Promise.all([
    // The team's tracker, not the caller's: two people in one organization must
    // open the dashboard on the same channels and the same numbers.
    prisma.trackedChannel.findMany({
      // Two independent narrowings, both in the query: the organization decides
      // whose tracker this is, the niche filter decides which of it this member
      // is entitled to. A niche-scoped member with no assignments matches no
      // rows at all — see `trackedChannelNicheFilter`.
      where: { organizationId, isActive: true, ...trackedChannelNicheFilter(visibleNiches) },
      include: {
        niches: { include: { niche: true } },
        /*
         * The channel's content-type RULES — what it made, and between when
         * and when.
         *
         * THE LIVE SOURCE for every Short beneath it: the client resolves each
         * video's deviations against the rules that cover ITS publish date, so
         * applying a tag here appears on the whole back catalogue with nothing
         * written per Short, and a rule retiring un-labels exactly the uploads
         * after the switch. See `src/lib/content-types/resolve.ts`.
         *
         * EVERY rule, closed and retired ones included. Shipping only the open
         * ones would un-label a year of Shorts in the browser while the database
         * still knew better — and would leave the UI unable to offer the
         * one-click re-open, which is the thing that makes an automatic
         * retirement safe to have at all.
         *
         * No tenant filter here and none needed: `ChannelContentTypeRule` hangs
         * off the `TrackedChannel` this query has already narrowed to one
         * organization. The video side below is the opposite case.
         */
        contentTypeRules: {
          select: {
            id: true,
            contentTypeId: true,
            effectiveFrom: true,
            effectiveUntil: true,
            consecutiveOverrides: true,
            overrideStreakFrom: true,
            autoClosedAt: true,
          },
        },
        channel: {
          include: {
            videos: {
              where: { publishedAt: { gte: since } },
              select: videoSelect(organizationId),
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
    // THE catalogue — one flat, org-wide list, and the same read the
    // management screen makes. There is nothing to group and nothing to
    // narrow: any of these tags may go on any channel or Short, so the client
    // resolves the ids the rules and deviations above carry, and builds a
    // picker's options, from this one array.
    //
    // Archived types included, and a RETIRED RULE is a second reason for it: a
    // closed rule still labels a back catalogue, so the catalogue has to be able
    // to resolve every id those rules carry as well as every id the videos do.
    // Omitting them would render historical classifications as dangling ids.
    // The client narrows to `isActive` when it offers a choice, not when it
    // renders one already made.
    listContentTypes({ includeInactive: true }),
    // The three PERSONAL reads in an otherwise global payload. Everything
    // above describes the operation and is the same for the whole team;
    // collections, saves and note badges belong to one person, and each of
    // these narrows to the caller inside its own `where` — see the ownership
    // note at the top of research-service. They travel in this payload because
    // the Saved page, the bookmark button and the note badges are all client
    // derivations of it, and no API response here is cacheable (`no-store` in
    // `src/server/http.ts`), so one person's rows cannot be served to another.
    listCollections(),
    listSavedShorts(),
    getNoteCounts(),
    getViewsDefinition(),
  ]);

  /**
   * Where each channel's numbers came from, for the whole payload in one query.
   *
   * After the tracker read rather than inside it: the answer depends on this
   * organization's YouTube connections, which are a different table with no
   * relation to `TrackedChannel` (they are keyed on the YOUTUBE channel id, not
   * on our row id, because a connection exists before any channel row does).
   * Resolving it per channel would be one query each; this is one for the lot,
   * and it mints no tokens — see `channelDataSources`.
   */
  const dataSources = await channelDataSources(
    organizationId,
    tracked.map((row) => row.channel.youtubeChannelId),
  );

  const channels: DatasetChannelDTO[] = tracked.map((row) => {
    const videos = row.channel.videos.map(toVideoDTO);
    return {
      channel: toChannelDTO(
        row.channel,
        row,
        dataSources.get(row.channel.youtubeChannelId) ?? "public",
      ),
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
    contentTypes,
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
  const [organizationId, visibleNiches] = await Promise.all([
    getCurrentOrgId(),
    getVisibleNicheIds(),
  ]);

  // Channel and Video rows are global and deduplicated, so this tracking row is
  // the entire access check: without it the caller's organization has no claim
  // on the channel, whoever on the team originally added it.
  //
  // The niche filter belongs in the same lookup rather than in a second check
  // afterwards. A channel id is right there in the URL of the dashboard, so
  // this endpoint is precisely where a niche-scoped member would otherwise read
  // a channel the list never showed them — and folding the two conditions into
  // one query means "not ours" and "not yours" produce the identical 404.
  const tracking = await prisma.trackedChannel.findFirst({
    where: { organizationId, channelId, ...trackedChannelNicheFilter(visibleNiches) },
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
  const [organizationId, visibleNiches] = await Promise.all([
    getCurrentOrgId(),
    getVisibleNicheIds(),
  ]);

  // Looked up by tracking reachability rather than by id alone. A YouTube video
  // id is public and guessable, so an unscoped lookup here would hand anyone
  // with an account the full history another organization paid quota to collect.
  // findFirst rather than findUnique because a unique lookup cannot carry a
  // relation filter — and folding the ownership test into the same query is
  // what makes "not tracked by us" indistinguishable from "does not exist",
  // so a 404 never confirms that some other team is watching this video. The
  // niche condition rides *inside* the `some`, on the tracking row that carries
  // the assignments, for the same reason it is in the lookup above: a video id
  // is guessable, so a niche-scoped member must not be able to reach the
  // history of a channel outside their niches by asking for it directly.
  const video = await prisma.video.findFirst({
    where: {
      youtubeVideoId,
      channel: {
        trackedBy: {
          some: { organizationId, isActive: true, ...trackedChannelNicheFilter(visibleNiches) },
        },
      },
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
