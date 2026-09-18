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
  ChannelDataSource,
  ChannelDTO,
  ChannelPreviewDTO,
  OwnershipType,
  RefreshResultDTO,
} from "@/lib/dto";
import { youtubeChannelUrl } from "@/lib/format";
import { getVisibleNicheIds, trackedChannelNicheFilter } from "@/server/auth/niche-scope";
import { requireFormat } from "@/server/auth/format-scope";
import { requireActor } from "@/server/auth/dal";
import { DEFAULT_NICHE_FORMAT, type NicheFormat } from "@/lib/niches/niche-format";
import { addChannelNiches } from "./niche-service";
import { evaluateHitsQuietly } from "./hit-evaluation-service";
import {
  syncChannel,
  upsertChannel,
  type SyncOptions,
} from "./channel-sync";
import {
  buildChannelSyncOptions,
  buildSyncOptions,
  resolveChannelHitWindows,
} from "./sync-service";
import { resolveChannel } from "./youtube";
import { channelDataSources, resolveChannelCredential } from "./youtube-oauth-service";
import { getCurrentOrgId, getCurrentOrgSettings, getScope } from "./user-service";

/**
 * Where one channel's figures come from, for the single-channel mappers below.
 *
 * A thin wrapper over the batch form so every one of them asks the same
 * question the same way. It mints no tokens and touches one small table, which
 * is what makes it cheap enough to sit on a rename.
 */
async function dataSourceFor(
  organizationId: string,
  youtubeChannelId: string,
): Promise<ChannelDataSource> {
  const sources = await channelDataSources(organizationId, [youtubeChannelId]);
  return sources.get(youtubeChannelId) ?? "public";
}

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
  /**
   * The third outcome beside created and restored: the channel was in the
   * tracker already and this call FILED it under the requested niches instead
   * of adding it. Nothing else about it changed — not its ownership, not its
   * existing filings — and no sync ran, which is why `sync` is null exactly
   * then. See the branch in `addChannel` for why "add" means this.
   */
  readonly alreadyTracked: boolean;
  readonly sync: RefreshResultDTO | null;
}

export interface AddChannelOptions {
  readonly ownershipType?: OwnershipType;
  readonly nicheIds?: readonly string[];
  /**
   * Which side of the operation the caller is adding from.
   *
   * Decides where the channel is listed when it ends up with NO niches, which
   * is a permitted outcome — the picker says so outright. Absent means Shorts,
   * so every caller that predates the Long Form product keeps its behaviour.
   */
  readonly format?: NicheFormat;
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
 * Content types are a SECOND, INDEPENDENT taxonomy on the same row rather than a
 * re-statement of the niches beside them: the niche says which slice of the
 * operation a channel belongs to, the rules say what the team reckons it made
 * and BETWEEN WHEN AND WHEN.
 *
 * THE WHOLE RULE ROW, not just the tag id, and every rule rather than the open
 * ones. The client resolves each Short against the rules covering its publish
 * date, so the dates are not metadata about the answer — they ARE the answer;
 * and a closed rule is what keeps a back catalogue correctly labelled after the
 * channel moved on. Shipping only the ids would un-label every Short in the
 * browser that the database still knows about, and shipping only the open rules
 * would do the same to everything published before the last switch.
 *
 * The catalogue itself still travels once in the dataset, so renaming a tag
 * stays a one-row change.
 */
const TRACKED_WITH_NICHES = {
  niches: { include: { niche: true } },
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
} as const;

/**
 * How long a first sync may spend classifying before it settles for what
 * duration and aspect ratio can tell it.
 *
 * Sized against the route's own `maxDuration` of 120 seconds, not the
 * platform default: the walk, the statistics calls, the writes and the hit
 * evaluation all have to fit in what is left, and a request that returns
 * slightly under-classified beats one the platform kills outright.
 */
const INITIAL_SYNC_CLASSIFY_BUDGET_MS = 45_000;

/**
 * Which side of the operation an add is being made from, refused if the
 * caller has no business on it.
 *
 * THE SAME GATE FILING MEETS. A shorts-role account holding `channels.manage`
 * must not be able to post `format: "longform"` and put an unfiled channel on
 * a roster their own product does not show them — the mirror of the check
 * `setChannelNiches` runs before it files anything under a niche of the other
 * format. The route is not the boundary: this service is reachable from any
 * server caller.
 *
 * Absent means Shorts, so every request that predates the Long Form product
 * resolves exactly as it always did, and an unqualified add by an admin still
 * lands where it always landed.
 */
async function resolveAddedFormat(
  format: NicheFormat | undefined,
): Promise<NicheFormat> {
  if (format === undefined) return DEFAULT_NICHE_FORMAT;
  const actor = await requireActor();
  requireFormat(actor.role, format);
  return format;
}

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
    /*
     * ALREADY TRACKED. Asked only to add it, this is the refusal it always
     * was: the channel is there, and a second row would be a duplicate. Asked
     * to add it UNDER NICHES, it is filed under them instead — the whole of
     * what "add" can still usefully mean for a channel the tracker holds, and
     * the only route a Long Form niche has to a channel the Shorts side
     * tracked first: the Long Form roster does not list such a channel until
     * it is filed, and the Shorts picker offers no Long Form niches to file it
     * under. Before this branch, that channel could not be filed anywhere.
     *
     * ADDITIVE, deliberately — `addChannelNiches`, never `setChannelNiches`.
     * The caller sees only its own side's filings and must not be able to
     * send them back short. Nothing else changes: `ownershipType` is ignored
     * here rather than applied, because the dialog's default is "competitor"
     * and re-adding an own channel from the other side must not demote it;
     * and no sync runs, because the channel already has its history and the
     * next sweep judges its videos under the new niche's rule.
     */
    if (!options.nicheIds || options.nicheIds.length === 0) {
      throw errors.alreadyTracked(existingTracking.label ?? channelRow.title);
    }
    await addChannelNiches(channelRow.id, options.nicheIds);

    const filed = await prisma.trackedChannel.findUniqueOrThrow({
      where: { id: existingTracking.id },
      include: TRACKED_WITH_NICHES,
    });
    return {
      channel: toChannelDTO(
        channelRow,
        filed,
        await dataSourceFor(organizationId, channelRow.youtubeChannelId),
      ),
      restored: false,
      alreadyTracked: true,
      sync: null,
    };
  }

  const restored = existingTracking !== null;
  /*
   * Ownership is what was asked for. When nothing was, a RESTORED row keeps
   * what it had — a channel the studio marked as its own does not become a
   * competitor because the request that brought it back said nothing about
   * it — and only a genuinely new row falls back to "competitor".
   */
  const ownershipType =
    options.ownershipType ?? (existingTracking ? existingTracking.ownershipType : "competitor");

  /*
   * WHICH ROSTER THIS CHANNEL LANDS ON IF IT ENDS UP WITH NO NICHES.
   *
   * Written on a restore as well as a create, unlike `ownershipType` above,
   * and the asymmetry is deliberate: ownership can be DEMOTED by a careless
   * default, so silence there has to mean "keep what you had". This cannot
   * demote anything — a channel with niches is listed by its niches whatever
   * this says — so the honest answer is the side of the person who just
   * brought it back, which is also the only roster they can see it on.
   */
  const addedFormat = await resolveAddedFormat(options.format);

  const tracking = restored
    ? await prisma.trackedChannel.update({
        where: { id: existingTracking.id },
        data: { isActive: true, removedAt: null, ownershipType, addedFormat },
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
          addedFormat,
        },
      });

  /*
   * Categorise before syncing, so the channel is filed correctly even if the
   * sync then fails — the user's organisational intent should not depend on
   * YouTube being reachable.
   *
   * ADDITIVE ON EVERY PATH, for the restore's sake. A soft-removed channel
   * keeps its join rows, and the dialog restoring it shows only its own side's
   * niches — so a wholesale set from the Long Form dialog would have quietly
   * stripped every Shorts filing the moment an admin restored the channel
   * there. "Comes back intact" is what the roster promises about a restore,
   * and the filings are part of intact. On a brand-new row there is nothing
   * to keep, so additive and set are the same write.
   */
  if (options.nicheIds && options.nicheIds.length > 0) {
    await addChannelNiches(channelRow.id, options.nicheIds);
  }

  /*
   * Pull history immediately: a channel that appears in the tracker with no
   * numbers reads as broken, even though it is only unsynced.
   *
   * ON A DEADLINE, because this is the one sync a person waits on. A first
   * sync classifies EVERY video the channel has, and Shorts classification
   * probes each one over the network; with no aggregate bound that ran past
   * the platform's 300-second ceiling and the POST died with a 504 — the
   * channel added, the roster not updated, and nothing to show for the wait.
   *
   * Videos the deadline cuts off are classified from duration and aspect ratio
   * instead of the probe, which lands them as "uncertain" — and `syncChannel`
   * re-probes exactly the uncertain ones next time, so the hourly sweep
   * finishes the job. A slower answer, never a wrong one.
   */
  const sync = await syncChannel(channelRow.id, {
    ...(await syncOptionsForCurrentOrg(channelRow.id, "initial")),
    deadlineMs: Date.now() + INITIAL_SYNC_CLASSIFY_BUDGET_MS,
  });

  /*
   * JUDGE NOW THE VIDEOS EXIST — the other half of the filing above.
   *
   * The filing deliberately precedes the sync so the user's organisational
   * intent survives an unreachable YouTube, and its own re-judge therefore
   * runs over a channel with NO videos: the evaluator finds nothing to look
   * at and writes nothing. The sync then imports the whole history against a
   * niche rule that nothing has applied to it, and no other path on this
   * request looks again — only the hourly sweep does.
   *
   * The screen that produced was the one this pair of calls exists to
   * prevent: ten long-form videos in the period, no verdict rows, and
   * `resolveHitDisplayState` reading that silence as "Not configured" over a
   * niche the owner had just configured.
   *
   * Cheap and safe to run twice: the narrowing is this one channel and the
   * upsert is keyed on (organization, video), so the second pass can only add
   * the rows the first could not see.
   */
  await evaluateHitsQuietly(
    organizationId,
    { channelIds: [channelRow.id] },
    "channel added",
  );

  const refreshed = await prisma.channel.findUniqueOrThrow({
    where: { id: channelRow.id },
  });
  const trackingWithNiches = await prisma.trackedChannel.findUniqueOrThrow({
    where: { id: tracking.id },
    include: TRACKED_WITH_NICHES,
  });

  return {
    // The source the sync REPORTS, not one looked up again afterwards. This run
    // is the only thing that has actually read the channel, so its answer is
    // the observation rather than a second guess at it — and the two can differ
    // by a grant that expired between them.
    channel: toChannelDTO(refreshed, trackingWithNiches, sync.dataSource),
    restored,
    alreadyTracked: false,
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

  // One query for the whole list rather than one per row.
  const sources = await channelDataSources(
    organizationId,
    rows.map((row) => row.channel.youtubeChannelId),
  );

  return rows.map((row) =>
    toChannelDTO(row.channel, row, sources.get(row.channel.youtubeChannelId) ?? "public"),
  );
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
  return toChannelDTO(
    row.channel,
    row,
    await dataSourceFor(organizationId, row.channel.youtubeChannelId),
  );
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

  return toChannelDTO(
    updated.channel,
    updated,
    await dataSourceFor(organizationId, updated.channel.youtubeChannelId),
  );
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

  return toChannelDTO(
    updated.channel,
    updated,
    await dataSourceFor(organizationId, updated.channel.youtubeChannelId),
  );
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

  return toChannelDTO(
    updated.channel,
    updated,
    await dataSourceFor(organizationId, updated.channel.youtubeChannelId),
  );
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

  return toChannelDTO(
    updated.channel,
    updated,
    await dataSourceFor(organizationId, updated.channel.youtubeChannelId),
  );
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
    dataSource: result.dataSource,
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

  // A manual refresh is somebody asking "is it right yet?", so it settles the
  // verdicts over the readings it has just taken rather than leaving them an
  // hour behind the numbers beside them. Same containment as everywhere else:
  // the refresh succeeded and must be reported as such.
  await evaluateHitsQuietly(organizationId, { channelIds: [channelId] }, "manual refresh");

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
    include: { channel: { select: { id: true, youtubeChannelId: true } } },
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
      hitWindowHours: windows.get(row.channelId)?.shortsWindowHours ?? null,
      longformWindowHours: windows.get(row.channelId)?.longformWindowHours ?? null,
      // Per channel and immediately before the request, for the same reasons as
      // the scheduled sweep: the source is a per-channel fact, and a token
      // resolved at the top of a long loop can expire before the end of it.
      credential: await resolveChannelCredential(organizationId, row.channel.youtubeChannelId),
    });
    results.push(toRefreshResultDTO(result));
  }

  /*
   * Then settle the verdicts over everything this sweep just read — once for
   * the organization rather than once per channel, and after the loop rather
   * than inside it, for the reason the scheduled sweep gives at its own call:
   * a Short that was pending at the top of the run may have had its window
   * shut and its deciding reading taken in the same pass.
   *
   * Skipped entirely when nothing was refreshed. There are no new readings to
   * judge, and the hourly sweep is already re-deciding the library anyway.
   */
  if (results.length > 0) {
    await evaluateHitsQuietly(organizationId, {}, "refresh all");
  }

  return results;
}
