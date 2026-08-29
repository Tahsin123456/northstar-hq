/**
 * Channel tracking — add, rename, remove, restore, list.
 *
 * Sits between the route handlers and both the database and the YouTube
 * integration. Route handlers do validation and serialisation; all the rules
 * about what tracking *means* live here.
 */

import { prisma } from "@/server/db";
import { errors } from "@/server/errors";
import { toChannelDTO } from "@/server/mappers";
import type {
  ChannelDTO,
  ChannelPreviewDTO,
  OwnershipType,
  RefreshResultDTO,
} from "@/lib/dto";
import { youtubeChannelUrl } from "@/lib/format";
import { getVisibleNicheIds, trackedChannelNicheFilter } from "@/server/auth/niche-scope";
import { setChannelNiches } from "./niche-service";
import { syncChannel, upsertChannel, type SyncOptions } from "./channel-sync";
import {
  buildChannelSyncOptions,
  buildSyncOptions,
  resolveChannelHitWindows,
} from "./sync-service";
import { resolveChannel } from "./youtube";
import { getCurrentOrgId, getCurrentOrgSettings, getScope } from "./user-service";

/**
 * Translates the organization's saved preferences into sync options.
 *
 * Without this the Settings page would be decorative: the lookback window,
 * snapshot interval and Shorts-probe switch would all be read from the
 * environment and the UI controls would do nothing.
 *
 * These three knobs are team settings rather than personal ones because they
 * spend a shared YouTube quota and write the shared canonical Video and
 * VideoSnapshot rows: if each director carried their own cadence, four people
 * would quadruple the API spend and interleave one append-only snapshot series
 * at four different intervals.
 *
 * The translation itself lives in sync-service, not here, because the scheduled
 * sweep needs exactly the same answer and has no session to derive it from. Two
 * copies would drift, and the symptom would be a channel whose history changes
 * shape depending on whether a person or the scheduler last touched it. This
 * function is now only the "which organization?" half.
 */
async function syncOptionsForCurrentOrg(
  channelId: string,
  trigger: SyncOptions["trigger"],
): Promise<SyncOptions> {
  return buildChannelSyncOptions(await getCurrentOrgId(), channelId, trigger);
}

/**
 * Resolve user input to a channel preview *without* tracking it.
 *
 * Costs 1–2 quota units and never writes a Channel row, so a user can paste,
 * look, and cancel without leaving debris in the database or burning quota on
 * a full video sync.
 */
export async function previewChannel(input: string): Promise<ChannelPreviewDTO> {
  const { channel } = await resolveChannel(input);
  const organizationId = await getCurrentOrgId();

  // "Already tracked" is a question about the team, not about the person
  // asking: if a colleague added this channel last month, pasting it again must
  // say so rather than offering to add a second tracking row for the same
  // tenant — which the organizationId_channelId unique would reject anyway.
  const existing = await prisma.channel.findUnique({
    where: { youtubeChannelId: channel.channelId },
    include: { trackedBy: { where: { organizationId } } },
  });

  const tracking = existing?.trackedBy[0] ?? null;

  return {
    youtubeChannelId: channel.channelId,
    title: channel.title,
    handle: channel.handle,
    avatarUrl: channel.avatarUrl,
    description: channel.description,
    subscriberCount: channel.hiddenSubscriberCount ? null : channel.subscriberCount,
    hiddenSubscriberCount: channel.hiddenSubscriberCount,
    videoCount: channel.videoCount,
    viewCount: channel.viewCount,
    channelUrl: youtubeChannelUrl(channel.handle, channel.channelId),
    alreadyTracked: tracking?.isActive === true,
    previouslyRemoved: tracking !== null && tracking.isActive === false,
  };
}

export interface AddChannelResult {
  readonly channel: ChannelDTO;
  readonly restored: boolean;
  readonly sync: RefreshResultDTO;
}

export interface AddChannelOptions {
  readonly ownershipType?: OwnershipType;
  readonly nicheIds?: readonly string[];
}

/**
 * Selects the tracking row plus its niche and content-type assignments, for DTO
 * mapping.
 *
 * Carries no tenant filter of its own, and must not grow one: the join rows
 * hang off a TrackedChannel that the surrounding query has already narrowed to
 * one organization, so scoping here would be a second, drift-prone copy of the
 * same rule. (The VIDEO side is the opposite case and does need its own filter;
 * see `dataset-service.videoSelect`.)
 *
 * Content types are back, and they are a SECOND, INDEPENDENT taxonomy on the
 * same row rather than a re-statement of the niches beside them: the niche says
 * which slice of the operation a channel belongs to, the content types say what
 * the team reckons it makes. Ids only — the catalogue travels once in the
 * dataset, so renaming a tag stays a one-row change.
 */
const TRACKED_WITH_NICHES = {
  niches: { include: { niche: true } },
  contentTypes: { select: { contentTypeId: true } },
} as const;

/**
 * Add a channel to the tracker and pull its history.
 *
 * Re-adding a previously removed channel *reactivates* the existing tracking
 * row instead of creating a new one, so the videos and snapshots collected
 * before removal are still there — the point of soft-deleting in the first
 * place.
 */
export async function addChannel(
  input: string,
  options: AddChannelOptions = {},
): Promise<AddChannelResult> {
  // Both halves of the scope: the organization decides what this row belongs
  // to, the user only signs it.
  const { organizationId, userId } = await getScope();
  const { channel: resolved } = await resolveChannel(input);

  const channelRow = await upsertChannel(resolved);

  const existingTracking = await prisma.trackedChannel.findUnique({
    where: { organizationId_channelId: { organizationId, channelId: channelRow.id } },
  });

  if (existingTracking?.isActive) {
    throw errors.alreadyTracked(existingTracking.label ?? channelRow.title);
  }

  const restored = existingTracking !== null;
  const ownershipType = options.ownershipType ?? "competitor";

  const tracking = restored
    ? await prisma.trackedChannel.update({
        where: { id: existingTracking.id },
        data: { isActive: true, removedAt: null, ownershipType },
      })
    : // `createdById` is a byline, not a claim: the row belongs to the
      // organization, and whoever added the channel gets the attribution
      // without gaining any exclusive right to rename or remove it.
      await prisma.trackedChannel.create({
        data: {
          organizationId,
          createdById: userId,
          channelId: channelRow.id,
          ownershipType,
        },
      });

  // Categorise before syncing, so the channel is filed correctly even if the
  // sync then fails — the user's organisational intent should not depend on
  // YouTube being reachable.
  if (options.nicheIds) {
    await setChannelNiches(channelRow.id, options.nicheIds);
  }

  // Pull history immediately: a channel that appears in the tracker with no
  // numbers reads as broken, even though it is only unsynced.
  const sync = await syncChannel(
    channelRow.id,
    await syncOptionsForCurrentOrg(channelRow.id, "initial"),
  );

  const refreshed = await prisma.channel.findUniqueOrThrow({
    where: { id: channelRow.id },
  });
  const trackingWithNiches = await prisma.trackedChannel.findUniqueOrThrow({
    where: { id: tracking.id },
    include: TRACKED_WITH_NICHES,
  });

  return {
    channel: toChannelDTO(refreshed, trackingWithNiches),
    restored,
    sync: toRefreshResultDTO(sync),
  };
}

export async function listTrackedChannels(
  options: { includeRemoved?: boolean } = {},
): Promise<ChannelDTO[]> {
  // The tracker is the team's, so everyone in the organization sees the same
  // list regardless of who added each channel — everyone, that is, whose role
  // is not niche-scoped. This list is `/api/channels`, gated on `analytics.view`
  // and therefore reachable by an editor, so it carries the same narrowing the
  // dataset does; without it the sidebar would be filtered and the endpoint
  // behind it would not.
  const [organizationId, visibleNiches] = await Promise.all([
    getCurrentOrgId(),
    getVisibleNicheIds(),
  ]);

  const rows = await prisma.trackedChannel.findMany({
    where: {
      organizationId,
      ...(options.includeRemoved ? {} : { isActive: true }),
      ...trackedChannelNicheFilter(visibleNiches),
    },
    include: { channel: true, ...TRACKED_WITH_NICHES },
    orderBy: { addedAt: "asc" },
  });

  return rows.map((row) => toChannelDTO(row.channel, row));
}

export async function getTrackedChannel(channelId: string): Promise<ChannelDTO> {
  const [organizationId, visibleNiches] = await Promise.all([
    getCurrentOrgId(),
    getVisibleNicheIds(),
  ]);

  // A lookup by id is exactly how frontend filtering gets bypassed: the list is
  // narrowed, but the id from someone else's link, a bookmark or a guess still
  // resolves. So the niche narrowing is part of the lookup, and a channel
  // outside the caller's niches is a 404 — the same answer as a channel this
  // organization does not track, which is what stops the endpoint confirming
  // that the channel exists at all.
  const row = await prisma.trackedChannel.findFirst({
    where: { organizationId, channelId, ...trackedChannelNicheFilter(visibleNiches) },
    include: { channel: true, ...TRACKED_WITH_NICHES },
  });

  if (!row) throw errors.notFound("channel");
  return toChannelDTO(row.channel, row);
}

/** Flip a tracked channel between "own" and "competitor". */
export async function setChannelOwnership(
  channelId: string,
  ownershipType: OwnershipType,
): Promise<ChannelDTO> {
  // Scoped to the organization, not the person who added the channel: whether
  // Northstar operates a channel is a fact about the company, so anyone on the
  // team with the permission to edit may correct it.
  const organizationId = await getCurrentOrgId();

  const tracking = await prisma.trackedChannel.findFirst({
    where: { organizationId, channelId },
  });
  if (!tracking) throw errors.notFound("channel");

  const updated = await prisma.trackedChannel.update({
    where: { id: tracking.id },
    data: { ownershipType },
    include: { channel: true, ...TRACKED_WITH_NICHES },
  });

  return toChannelDTO(updated.channel, updated);
}

/** Rename (label) a tracked channel. An empty string clears the override. */
export async function renameChannel(
  channelId: string,
  label: string | null,
): Promise<ChannelDTO> {
  // The label is the name the whole team reads in the dashboard, so it is
  // org-scoped like the row it lives on — not editable only by its author.
  const organizationId = await getCurrentOrgId();

  const tracking = await prisma.trackedChannel.findFirst({
    where: { organizationId, channelId },
  });
  if (!tracking) throw errors.notFound("channel");

  const normalized = label?.trim() ? label.trim() : null;

  const updated = await prisma.trackedChannel.update({
    where: { id: tracking.id },
    data: { label: normalized },
    include: { channel: true, ...TRACKED_WITH_NICHES },
  });

  return toChannelDTO(updated.channel, updated);
}

/**
 * Remove a channel from the tracker.
 *
 * Soft delete by design. The Video and VideoSnapshot rows are historical
 * observations that can never be re-collected — YouTube will not tell you what
 * a video had last Tuesday — so throwing them away to satisfy a UI action would
 * be destroying irreplaceable data. Flipping `isActive` hides the channel and
 * keeps every measurement, and re-adding it restores the full history.
 */
export async function removeChannel(channelId: string): Promise<ChannelDTO> {
  const organizationId = await getCurrentOrgId();

  const tracking = await prisma.trackedChannel.findFirst({
    where: { organizationId, channelId },
    include: { channel: true, ...TRACKED_WITH_NICHES },
  });
  if (!tracking) throw errors.notFound("channel");

  const updated = await prisma.trackedChannel.update({
    where: { id: tracking.id },
    data: { isActive: false, removedAt: new Date() },
    include: { channel: true, ...TRACKED_WITH_NICHES },
  });

  return toChannelDTO(updated.channel, updated);
}

export async function restoreChannel(channelId: string): Promise<ChannelDTO> {
  const organizationId = await getCurrentOrgId();

  const tracking = await prisma.trackedChannel.findFirst({
    where: { organizationId, channelId },
  });
  if (!tracking) throw errors.notFound("channel");

  const updated = await prisma.trackedChannel.update({
    where: { id: tracking.id },
    data: { isActive: true, removedAt: null },
    include: { channel: true, ...TRACKED_WITH_NICHES },
  });

  return toChannelDTO(updated.channel, updated);
}

export function toRefreshResultDTO(
  result: Awaited<ReturnType<typeof syncChannel>>,
): RefreshResultDTO {
  return {
    channelId: result.channelId,
    status: result.status,
    videosDiscovered: result.videosDiscovered,
    videosUpdated: result.videosUpdated,
    shortsClassified: result.shortsClassified,
    snapshotsWritten: result.snapshotsWritten,
    quotaUnitsUsed: result.quotaUnitsUsed,
    markedUnavailable: result.markedUnavailable,
    error: result.error,
    durationMs: result.durationMs,
  };
}

/** Manual single-channel refresh. Always runs — the user explicitly asked. */
export async function refreshChannel(channelId: string): Promise<RefreshResultDTO> {
  // Membership check, not an ownership check: the lookup exists to prove the
  // channel is in *this* organization's tracker before spending its quota on a
  // sync, and any member may refresh any of the team's channels.
  const organizationId = await getCurrentOrgId();

  const tracking = await prisma.trackedChannel.findFirst({
    where: { organizationId, channelId },
  });
  if (!tracking) throw errors.notFound("channel");

  const result = await syncChannel(
    channelId,
    await syncOptionsForCurrentOrg(channelId, "manual"),
  );
  return toRefreshResultDTO(result);
}

/**
 * Refresh every tracked channel that has gone stale.
 *
 * Staleness is honoured unless `force` is set — the deliberate "do not hammer
 * the YouTube API" guard. Channels are processed sequentially: a burst of
 * parallel refreshes is exactly the shape of traffic that trips rate limiting,
 * and the wall-clock difference is irrelevant for a background sweep.
 */
export async function refreshStaleChannels(
  options: { force?: boolean; maxChannels?: number } = {},
): Promise<RefreshResultDTO[]> {
  const organizationId = await getCurrentOrgId();
  const settings = await getCurrentOrgSettings();
  const syncOptions = await buildSyncOptions(organizationId, "auto");

  // The organization's configured staleness threshold, not the environment
  // default — the environment value is only the seed for a new installation.
  // Reading it per-user would make the guard meaningless: whoever had the
  // shortest interval would set the effective refresh rate for everyone, since
  // they all sweep the same shared channels.
  const staleBefore = new Date(Date.now() - settings.refreshIntervalMinutes * 60_000);

  // One sweep per organization covers the whole team's tracker, so the same
  // channel is never refreshed once per member.
  const tracked = await prisma.trackedChannel.findMany({
    where: {
      organizationId,
      isActive: true,
      ...(options.force
        ? {}
        : {
            channel: {
              OR: [{ lastFetchedAt: null }, { lastFetchedAt: { lt: staleBefore } }],
            },
          }),
    },
    include: { channel: { select: { id: true } } },
    orderBy: { addedAt: "asc" },
    take: options.maxChannels ?? 50,
  });

  // Windows for the whole batch in one query rather than one per channel: the
  // cadence has to be the channel's own, but working that out is a property of
  // the tracker, not of each refresh.
  const windows = await resolveChannelHitWindows(
    organizationId,
    tracked.map((row) => row.channelId),
  );

  const results: RefreshResultDTO[] = [];
  for (const row of tracked) {
    const result = await syncChannel(row.channelId, {
      ...syncOptions,
      hitWindowHours: windows.get(row.channelId) ?? null,
    });
    results.push(toRefreshResultDTO(result));
  }
  return results;
}
