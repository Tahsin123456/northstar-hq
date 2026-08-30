/**
 * Channel synchronisation — the pipeline that turns a YouTube channel into
 * rows this app can analyse.
 *
 *   uploads playlist walk  ->  video statistics  ->  Shorts classification
 *                          ->  upsert  ->  snapshot  ->  audit run
 *
 * QUOTA DISCIPLINE
 * `search.list` (100 units) is never used here. Walking the uploads playlist
 * costs 1 unit per 50 videos and `videos.list` another 1 unit per 50, so a
 * channel with 300 uploads inside the lookback window costs about 13 units out
 * of a 10,000/day allowance. Paging stops as soon as the playlist — which is
 * ordered newest-first — passes the lookback cutoff.
 *
 * CLASSIFICATION CACHING
 * Whether a video is a Short is immutable in practice, so a confident verdict
 * is computed once and never recomputed. Only new videos and previously
 * *unresolved* ones are re-examined. This is what keeps the redirect probe to
 * a handful of requests per refresh rather than one per video per refresh.
 */

import type { Channel, Prisma } from "@prisma/client";
import type { ChannelDataSource } from "@/lib/dto";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { AppError, toAppError, type AppErrorCode } from "@/server/errors";
import {
  classifyVideos,
  MIN_SHORT_CONFIDENCE,
  QuotaLedger,
  youtubeClient,
} from "./youtube";
import type {
  VideoClassification,
  YouTubeChannel,
  YouTubeCredential,
  YouTubeVideo,
} from "./youtube";
import { snapshotIntervalMinutes } from "@/lib/sync/snapshot-cadence";

/**
 * =========================================================================
 * WHOSE AUTHORITY THIS SYNC READS WITH
 * =========================================================================
 *
 * Resolved by the CALLER and handed in, never looked up here — the same contract
 * `hitWindowHours` works to, and for the same reason. This module is the
 * fetch/classify/persist pipeline for ONE channel and has no organization: which
 * connections exist, and whether one of them owns this channel, are questions
 * about a tracker. Deciding it here would also mean the Refresh button and the
 * scheduled sweep each answering it separately, which is exactly how two paths
 * start disagreeing about the same channel.
 *
 * The three cases are `youtube-oauth-service.resolveChannelCredential`'s, and the
 * long note there is where the reasoning lives. What this file does with them:
 *
 *   • "public"                 — the shared API key, unchanged. Every competitor,
 *                                and any own channel nobody has connected yet.
 *   • "connection"             — the account's own grant, on every Data API call
 *                                the sync makes.
 *   • "connection_unavailable" — REFUSE. Not a fallback to the key; a recorded
 *                                failure. See `syncChannel`.
 */
export type ChannelCredential =
  | { readonly source: "public" }
  | {
      readonly source: "connection";
      readonly credential: YouTubeCredential;
      /** The account or channel name, for messages that have to name it. */
      readonly label: string;
    }
  | {
      readonly source: "connection_unavailable";
      readonly connectionId: string;
      readonly label: string;
      /** Already written for a person to read; surfaced verbatim. */
      readonly reason: string;
    };

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;
/** Chunk size for batched writes — keeps SQLite transactions comfortably sized. */
const WRITE_CHUNK = 50;

export interface SyncOptions {
  readonly lookbackDays?: number;
  readonly maxPages?: number;
  readonly snapshotIntervalMinutes?: number;
  /**
   * The hit window that judges this channel's Shorts, in hours, or null when
   * none of its niches has a complete rule.
   *
   * The snapshot cadence is derived from it: dense inside the window, sparse
   * outside. It arrives as an option rather than being looked up here because
   * this module is the fetch/classify/persist pipeline for ONE channel and has
   * no business knowing about niches — and because both callers, the Refresh
   * button and the scheduled sweep, must pass the same value or the history of
   * a channel would depend on which path last touched it.
   */
  readonly hitWindowHours?: number | null;
  readonly trigger?: "manual" | "auto" | "initial";
  /** Re-run classification even for already-confident videos. */
  readonly forceReclassify?: boolean;
  /**
   * Whether the Shorts URL probe may run. Supplied by the caller from the
   * user's settings; falls back to the environment default when omitted.
   */
  readonly probeEnabled?: boolean;
  /**
   * Which credential reads this channel — see `ChannelCredential`.
   *
   * Omitting it means the shared API key, which keeps every existing caller and
   * every test working unchanged: a channel nobody has connected is read exactly
   * as it always was.
   */
  readonly credential?: ChannelCredential;
}

export interface SyncResult {
  readonly channelId: string;
  readonly status: "success" | "partial" | "error";
  readonly videosDiscovered: number;
  readonly videosUpdated: number;
  readonly shortsClassified: number;
  readonly snapshotsWritten: number;
  readonly quotaUnitsUsed: number;
  readonly markedUnavailable: number;
  readonly reachedPlaylistEnd: boolean;
  readonly error: string | null;
  /**
   * The machine code behind `error`, or null on success.
   *
   * `error` is a sentence written for a person. A caller that has to *decide*
   * something from a failure — the scheduled sweep working out whether the
   * daily quota is gone and it should stop rather than fail twenty-four more
   * channels the same way — needs the code. Without it the only available
   * signal is the prose, and a guard that depends on matching prose is one
   * copy-edit away from silently switching itself off.
   */
  readonly errorCode: AppErrorCode | null;
  readonly durationMs: number;
  /**
   * Which credential this run actually read with.
   *
   * Reported rather than inferred by the caller, because the caller asked for a
   * source and did not necessarily get one: a run handed a "connection"
   * credential still reports "connection", but a run refused for a broken
   * connection reports "connection_unavailable" — and a refresh summary that
   * said "public" over either of those would misdescribe where the numbers on
   * the screen came from.
   */
  readonly dataSource: ChannelDataSource;
}

/**
 * The credential's own name for itself, as it reaches a DTO.
 *
 * A straight mapping today, and worth keeping as a function rather than a cast:
 * the two enums answer different questions — one is "what should read this", the
 * other is "what did" — and the day they diverge, this is the one place that has
 * to change.
 */
function sourceOf(credential: ChannelCredential): ChannelDataSource {
  switch (credential.source) {
    case "connection":
      return "connection";
    case "connection_unavailable":
      return "connection_unavailable";
    default:
      return "public";
  }
}

function toBigInt(value: number | null | undefined): bigint | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return BigInt(Math.max(0, Math.trunc(value)));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Upsert the channel record itself from a freshly fetched YouTube payload. */
export async function upsertChannel(source: YouTubeChannel): Promise<Channel> {
  const data = {
    handle: source.handle,
    title: source.title,
    customUrl: source.customUrl,
    description: source.description,
    avatarUrl: source.avatarUrl,
    bannerUrl: source.bannerUrl,
    country: source.country,
    subscriberCount: toBigInt(source.subscriberCount),
    hiddenSubscriberCount: source.hiddenSubscriberCount,
    viewCount: toBigInt(source.viewCount),
    videoCount: toBigInt(source.videoCount),
    uploadsPlaylistId: source.uploadsPlaylistId,
    channelPublishedAt: source.publishedAt,
  } satisfies Prisma.ChannelUpdateInput;

  return prisma.channel.upsert({
    where: { youtubeChannelId: source.channelId },
    create: { youtubeChannelId: source.channelId, ...data },
    update: data,
  });
}

/**
 * Fetch, classify and persist a channel's recent uploads.
 *
 * Never throws for upstream failures: the outcome is recorded on the channel
 * row and in a ChannelRefreshRun, and returned as a `SyncResult` with
 * `status: "error"`. The caller decides how loudly to complain — a background
 * sweep should not blow up because one channel was deleted.
 */
export async function syncChannel(
  channelRowId: string,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const startedAt = Date.now();
  const ledger = new QuotaLedger();

  const channel = await prisma.channel.findUnique({ where: { id: channelRowId } });
  if (!channel) {
    throw new AppError("NOT_FOUND", "That channel is not in the database.");
  }

  // Absent means the shared key, which is what every channel nobody has
  // connected has always used and still uses.
  const credential = options.credential ?? { source: "public" };
  const dataSource = sourceOf(credential);
  // Present only on the connection path, and `undefined` on the key path so the
  // client sets `key=` exactly as it did before.
  const apiCredential = credential.source === "connection" ? credential.credential : undefined;

  const run = await prisma.channelRefreshRun.create({
    data: {
      channelId: channel.id,
      status: "running",
      trigger: options.trigger ?? "manual",
    },
  });

  const counters = {
    videosDiscovered: 0,
    videosUpdated: 0,
    shortsClassified: 0,
    snapshotsWritten: 0,
    markedUnavailable: 0,
  };
  let reachedPlaylistEnd = false;

  try {
    /**
     * ---- 0. Refuse to read an own channel through the wrong door -----------
     *
     * A channel whose connection has stopped working does NOT get read with the
     * shared key instead. The owner asked that their own channels' data come
     * from the connected account and not from an external source, and a public
     * read would succeed — quietly substituting a different, weaker source and
     * leaving the dashboard full of plausible numbers with nothing to say the
     * ground had shifted.
     *
     * Failing here instead records the reason on the channel row, turns
     * `lastFetchStatus` to "error" and reports `connection_unavailable` to every
     * screen, so the figures visibly stop rather than invisibly change meaning.
     * Nothing already collected is touched; reconnecting resumes it.
     *
     * Thrown rather than returned early so it takes the ordinary failure path —
     * the ChannelRefreshRun row, the channel's `lastFetchError` and the
     * `SyncResult` are all written by the catch below, and a second copy of that
     * bookkeeping is a second thing to keep correct.
     */
    if (credential.source === "connection_unavailable") {
      throw new AppError("NOT_CONFIGURED", credential.reason);
    }

    // ---- 1. Refresh channel-level metadata (subscribers move constantly) ---
    const [fresh] = await youtubeClient.getChannelsByIds(
      [channel.youtubeChannelId],
      ledger,
      apiCredential,
    );
    if (!fresh) {
      throw new AppError(
        "CHANNEL_NOT_FOUND",
        "YouTube no longer returns this channel. It may have been deleted, renamed or made private.",
      );
    }
    const updatedChannel = await upsertChannel(fresh);

    const uploadsPlaylistId = updatedChannel.uploadsPlaylistId ?? fresh.uploadsPlaylistId;
    if (!uploadsPlaylistId) {
      throw new AppError(
        "UPSTREAM_ERROR",
        "This channel does not expose a public uploads playlist, so its videos cannot be read.",
      );
    }

    // ---- 2. Walk the uploads playlist back to the lookback cutoff ----------
    const lookbackDays = options.lookbackDays ?? env.lookbackDays;
    const cutoff = new Date(Date.now() - lookbackDays * MS_PER_DAY);

    const { entries, reachedEnd } = await youtubeClient.listUploads(uploadsPlaylistId, {
      stopBefore: cutoff,
      maxPages: options.maxPages ?? env.maxUploadPages,
      ledger,
      credential: apiCredential,
    });
    reachedPlaylistEnd = reachedEnd;
    counters.videosDiscovered = entries.length;

    const discoveredIds = [...new Set(entries.map((e) => e.videoId))];

    // ---- 3. Statistics for everything in the window -----------------------
    const videos = discoveredIds.length > 0
      ? await youtubeClient.getVideos(discoveredIds, ledger, apiCredential)
      : [];

    // ---- 4. Classify only what actually needs it --------------------------
    const existing = await prisma.video.findMany({
      where: { youtubeVideoId: { in: discoveredIds } },
      select: {
        youtubeVideoId: true,
        classification: true,
        classificationConfidence: true,
        isShort: true,
        classificationMethod: true,
        classificationReason: true,
        aspectRatio: true,
      },
    });
    const existingByVideoId = new Map(existing.map((v) => [v.youtubeVideoId, v]));

    const needsClassification = videos.filter((video) => {
      if (options.forceReclassify) return true;
      const prior = existingByVideoId.get(video.videoId);
      if (!prior) return true;
      // Retry anything we previously failed to resolve — the probe may have
      // been throttled or offline last time.
      if (prior.classification === "uncertain") return true;
      return prior.classificationConfidence < MIN_SHORT_CONFIDENCE;
    });

    const classifications = await classifyVideos(needsClassification, {
      probeEnabled: options.probeEnabled,
    });
    counters.shortsClassified = classifications.size;

    // ---- 5. Persist videos + snapshots ------------------------------------
    // The organization's interval is no longer the whole story: it is the
    // starting point that `snapshotIntervalMinutes` bends by age, so a Short
    // inside its window is sampled densely and one past it is barely sampled at
    // all. See `@/lib/sync/snapshot-cadence` for what that costs in rows.
    const baseIntervalMinutes = options.snapshotIntervalMinutes ?? 360;
    const hitWindowHours = options.hitWindowHours ?? null;

    const latestSnapshots = await prisma.video.findMany({
      where: { youtubeVideoId: { in: discoveredIds } },
      select: {
        id: true,
        youtubeVideoId: true,
        viewCount: true,
        snapshots: {
          orderBy: { capturedAt: "desc" },
          take: 1,
          select: { capturedAt: true, viewCount: true },
        },
      },
    });
    const snapshotStateByVideoId = new Map(
      latestSnapshots.map((v) => [v.youtubeVideoId, v]),
    );

    const now = new Date();

    for (const batch of chunk(videos, WRITE_CHUNK)) {
      const operations: Prisma.PrismaPromise<unknown>[] = [];

      for (const video of batch) {
        const classification =
          classifications.get(video.videoId) ??
          reuseExistingClassification(existingByVideoId.get(video.videoId));

        const videoData = buildVideoData(
          video,
          updatedChannel.id,
          classification,
          now,
        );

        operations.push(
          prisma.video.upsert({
            where: { youtubeVideoId: video.videoId },
            create: videoData.create,
            update: videoData.update,
          }),
        );
        counters.videosUpdated += 1;
      }

      await prisma.$transaction(operations);
    }

    // Snapshots run after the upsert so brand-new videos already have a row.
    const persisted = await prisma.video.findMany({
      where: { youtubeVideoId: { in: discoveredIds } },
      // `isShort` comes back because the cadence depends on it: only a Short is
      // judged by a window, so only a Short gets the dense schedule. Long-form
      // keeps the organization's flat interval exactly as before.
      select: { id: true, youtubeVideoId: true, publishedAt: true, isShort: true },
    });
    const rowIdByVideoId = new Map(persisted.map((v) => [v.youtubeVideoId, v]));

    const snapshotRows: Prisma.VideoSnapshotCreateManyInput[] = [];
    for (const video of videos) {
      const row = rowIdByVideoId.get(video.videoId);
      if (!row) continue;

      const previous = snapshotStateByVideoId.get(video.videoId);
      const lastCaptured = previous?.snapshots[0]?.capturedAt ?? null;
      const lastViews = previous?.snapshots[0]?.viewCount ?? null;

      const ageHours = Math.max(
        0,
        Math.floor((now.getTime() - video.publishedAt.getTime()) / MS_PER_HOUR),
      );
      const intervalMs =
        snapshotIntervalMinutes({
          ageHours,
          windowHours: row.isShort ? hitWindowHours : null,
          baseIntervalMinutes,
        }) * MS_PER_MINUTE;

      const dueByTime =
        lastCaptured === null || now.getTime() - lastCaptured.getTime() >= intervalMs;
      const changed = lastViews === null || lastViews !== BigInt(Math.trunc(video.viewCount));

      // Write only when the interval has elapsed *and* something moved. A
      // stalled video does not need an identical row however dense the schedule
      // says to be — which is what keeps an hourly cadence inside the window
      // from turning into 24 identical rows a day for a Short nobody is
      // watching.
      if (!dueByTime || !changed) continue;

      snapshotRows.push({
        videoId: row.id,
        viewCount: BigInt(Math.trunc(video.viewCount)),
        likeCount: toBigInt(video.likeCount),
        commentCount: toBigInt(video.commentCount),
        videoAgeHours: ageHours,
        capturedAt: now,
      });
    }

    for (const batch of chunk(snapshotRows, WRITE_CHUNK)) {
      await prisma.videoSnapshot.createMany({ data: batch });
      counters.snapshotsWritten += batch.length;
    }

    // ---- 6. Flag videos YouTube stopped returning -------------------------
    // Present in the uploads playlist but absent from videos.list means
    // private, deleted or region-blocked. Keep the row (its history is real
    // data) but stop counting it.
    const returnedIds = new Set(videos.map((v) => v.videoId));
    const vanished = discoveredIds.filter((id) => !returnedIds.has(id));
    if (vanished.length > 0) {
      const result = await prisma.video.updateMany({
        where: { youtubeVideoId: { in: vanished }, isAvailable: true },
        data: { isAvailable: false, statsFetchedAt: now },
      });
      counters.markedUnavailable = result.count;
    }

    // ---- 7. Close out -----------------------------------------------------
    await prisma.channel.update({
      where: { id: channel.id },
      data: { lastFetchedAt: now, lastFetchStatus: "success", lastFetchError: null },
    });

    await prisma.channelRefreshRun.update({
      where: { id: run.id },
      data: {
        status: "success",
        finishedAt: new Date(),
        videosDiscovered: counters.videosDiscovered,
        videosUpdated: counters.videosUpdated,
        shortsClassified: counters.shortsClassified,
        snapshotsWritten: counters.snapshotsWritten,
        quotaUnitsUsed: ledger.total,
      },
    });

    return {
      channelId: channel.id,
      status: "success",
      ...counters,
      quotaUnitsUsed: ledger.total,
      reachedPlaylistEnd,
      error: null,
      errorCode: null,
      durationMs: Date.now() - startedAt,
      dataSource,
    };
  } catch (caught) {
    const appError = toAppError(caught);
    console.error(
      `[channel-sync] ${channel.youtubeChannelId} failed: ${appError.code} — ${appError.message}`,
    );

    await prisma.channel
      .update({
        where: { id: channel.id },
        data: { lastFetchStatus: "error", lastFetchError: appError.userMessage },
      })
      .catch(() => undefined);

    await prisma.channelRefreshRun
      .update({
        where: { id: run.id },
        data: {
          status: "error",
          finishedAt: new Date(),
          error: appError.userMessage,
          videosDiscovered: counters.videosDiscovered,
          videosUpdated: counters.videosUpdated,
          shortsClassified: counters.shortsClassified,
          snapshotsWritten: counters.snapshotsWritten,
          quotaUnitsUsed: ledger.total,
        },
      })
      .catch(() => undefined);

    return {
      channelId: channel.id,
      status: "error",
      ...counters,
      quotaUnitsUsed: ledger.total,
      reachedPlaylistEnd,
      error: appError.userMessage,
      errorCode: appError.code,
      durationMs: Date.now() - startedAt,
      dataSource,
    };
  }
}

type ExistingClassification = {
  classification: string;
  classificationConfidence: number;
  isShort: boolean;
  classificationMethod: string;
  classificationReason: string;
  aspectRatio: number | null;
};

/** Carries a cached verdict forward untouched when re-classification is skipped. */
function reuseExistingClassification(
  prior: ExistingClassification | undefined,
): VideoClassification | null {
  if (!prior) return null;
  return {
    videoId: "",
    classification: prior.classification as VideoClassification["classification"],
    isShort: prior.isShort,
    confidence: prior.classificationConfidence,
    method: prior.classificationMethod as VideoClassification["method"],
    reason: prior.classificationReason,
    aspectRatio: prior.aspectRatio,
  };
}

function buildVideoData(
  video: YouTubeVideo,
  channelRowId: string,
  classification: VideoClassification | null,
  now: Date,
): { create: Prisma.VideoUncheckedCreateInput; update: Prisma.VideoUncheckedUpdateInput } {
  const shared = {
    title: video.title,
    description: video.description.slice(0, 5000),
    publishedAt: video.publishedAt,
    durationIso: video.durationIso,
    durationSeconds: video.durationSeconds ?? 0,
    thumbnailUrl: video.thumbnailUrl,
    videoUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
    viewCount: BigInt(Math.max(0, Math.trunc(video.viewCount))),
    likeCount: toBigInt(video.likeCount),
    commentCount: toBigInt(video.commentCount),
    playerWidth: video.playerWidth,
    playerHeight: video.playerHeight,
    isAvailable: true,
    statsFetchedAt: now,
  };

  // Only overwrite classification columns when we actually classified. A
  // skipped (cached) verdict must not be clobbered with defaults.
  const classificationFields = classification
    ? {
        isShort: classification.isShort,
        classification: classification.classification,
        classificationConfidence: classification.confidence,
        classificationMethod: classification.method,
        classificationReason: classification.reason,
        classifiedAt: now,
        aspectRatio: classification.aspectRatio,
      }
    : {};

  return {
    create: {
      youtubeVideoId: video.videoId,
      channelId: channelRowId,
      ...shared,
      isShort: classification?.isShort ?? false,
      classification: classification?.classification ?? "uncertain",
      classificationConfidence: classification?.confidence ?? 0,
      classificationMethod: classification?.method ?? "none",
      classificationReason: classification?.reason ?? "Not yet classified.",
      classifiedAt: classification ? now : null,
      aspectRatio: classification?.aspectRatio ?? null,
    },
    update: {
      channelId: channelRowId,
      ...shared,
      ...classificationFields,
    },
  };
}
