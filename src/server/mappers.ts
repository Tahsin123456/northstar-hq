import type {
  Channel,
  Niche,
  OrganizationSettings,
  TrackedChannel,
  UserSettings,
  Video,
} from "@prisma/client";
import type {
  ChannelDTO,
  ExcludedVideoDTO,
  NicheDTO,
  NicheRefDTO,
  OwnershipType,
  SettingsDTO,
  VideoDTO,
} from "@/lib/dto";
import { isOwnershipType } from "@/lib/dto";
import { youtubeChannelUrl } from "@/lib/format";

/**
 * Prisma row -> wire DTO.
 *
 * The one job that matters here is BigInt. Counters are stored as BigInt
 * because a channel's lifetime views comfortably exceed a 32-bit integer, but
 * `JSON.stringify` throws outright on a BigInt. Every one of them is converted
 * exactly once, here, at the boundary — so no route handler has to remember to
 * do it and no response can accidentally carry one through.
 *
 * The conversion is lossless in practice: Number.MAX_SAFE_INTEGER is ~9.0e15
 * and the most-viewed video on YouTube is ~1.6e10, five orders of magnitude
 * below the ceiling.
 */
export function bigIntToNumber(value: bigint | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function bigIntToNumberOrZero(value: bigint | null | undefined): number {
  return bigIntToNumber(value) ?? 0;
}

export function toNicheRefDTO(niche: Pick<Niche, "id" | "name" | "colorIndex">): NicheRefDTO {
  return { id: niche.id, name: niche.name, colorIndex: niche.colorIndex };
}

export function toNicheDTO(niche: Niche, channelCount: number): NicheDTO {
  return {
    ...toNicheRefDTO(niche),
    slug: niche.slug,
    hitThreshold: niche.hitThreshold,
    sortOrder: niche.sortOrder,
    channelCount,
    createdAt: niche.createdAt.getTime(),
  };
}

/**
 * Narrows the stored string to the union.
 *
 * The column is a plain String for SQLite/PostgreSQL portability, so the type
 * safety has to be re-established here at the boundary rather than assumed.
 * An unrecognised value falls back to "competitor" — the safe default, since
 * mislabelling a competitor as one of the user's own channels is the more
 * misleading error.
 */
function toOwnershipType(value: string | null | undefined): OwnershipType {
  return isOwnershipType(value) ? value : "competitor";
}

/** The tracking-row shape `toChannelDTO` needs, including its niche join rows. */
export type TrackedChannelProjection = Pick<
  TrackedChannel,
  "label" | "addedAt" | "isActive" | "ownershipType"
> & {
  niches?: Array<{ niche: Pick<Niche, "id" | "name" | "colorIndex"> }>;
};

export function toChannelDTO(
  channel: Channel,
  tracked: TrackedChannelProjection | null,
): ChannelDTO {
  const label = tracked?.label ?? null;
  return {
    id: channel.id,
    youtubeChannelId: channel.youtubeChannelId,
    handle: channel.handle,
    title: channel.title,
    label,
    displayName: label ?? channel.title,
    description: channel.description,
    avatarUrl: channel.avatarUrl,
    bannerUrl: channel.bannerUrl,
    country: channel.country,
    subscriberCount: channel.hiddenSubscriberCount
      ? null
      : bigIntToNumber(channel.subscriberCount),
    hiddenSubscriberCount: channel.hiddenSubscriberCount,
    lifetimeViewCount: bigIntToNumber(channel.viewCount),
    lifetimeVideoCount: bigIntToNumber(channel.videoCount),
    channelUrl: youtubeChannelUrl(channel.handle, channel.youtubeChannelId),
    lastFetchedAt: channel.lastFetchedAt?.getTime() ?? null,
    lastFetchStatus: channel.lastFetchStatus,
    lastFetchError: channel.lastFetchError,
    addedAt: tracked?.addedAt.getTime() ?? channel.createdAt.getTime(),
    isActive: tracked?.isActive ?? false,
    ownershipType: toOwnershipType(tracked?.ownershipType),
    niches: (tracked?.niches ?? [])
      .map((assignment) => toNicheRefDTO(assignment.niche))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The projection the dataset endpoint selects — narrower than a full row. */
export type VideoProjection = Pick<
  Video,
  | "id"
  | "youtubeVideoId"
  | "title"
  | "publishedAt"
  | "viewCount"
  | "likeCount"
  | "commentCount"
  | "durationSeconds"
  | "isShort"
  | "classification"
  | "classificationConfidence"
  | "isAvailable"
>;

export function toVideoDTO(video: VideoProjection): VideoDTO {
  return {
    id: video.id,
    youtubeVideoId: video.youtubeVideoId,
    title: video.title,
    publishedAt: video.publishedAt.getTime(),
    views: bigIntToNumberOrZero(video.viewCount),
    likes: bigIntToNumber(video.likeCount),
    comments: bigIntToNumber(video.commentCount),
    durationSeconds: video.durationSeconds,
    isShort: video.isShort,
    classification: video.classification,
    classificationConfidence: video.classificationConfidence,
    isAvailable: video.isAvailable,
  };
}

export type ExcludedVideoProjection = Pick<
  Video,
  | "youtubeVideoId"
  | "title"
  | "publishedAt"
  | "durationSeconds"
  | "viewCount"
  | "classification"
  | "classificationConfidence"
  | "classificationMethod"
  | "classificationReason"
>;

export function toExcludedVideoDTO(video: ExcludedVideoProjection): ExcludedVideoDTO {
  return {
    youtubeVideoId: video.youtubeVideoId,
    title: video.title,
    publishedAt: video.publishedAt.getTime(),
    durationSeconds: video.durationSeconds,
    views: bigIntToNumberOrZero(video.viewCount),
    classification: video.classification,
    classificationConfidence: video.classificationConfidence,
    classificationMethod: video.classificationMethod,
    classificationReason: video.classificationReason,
  };
}

/**
 * The two settings rows -> one flat DTO.
 *
 * Settings are stored in two tables because they have two different owners: a
 * sort direction is nobody else's business, while the hit threshold and the
 * sync cadence are numbers the whole team argues about and must therefore be
 * singular. The *client* has no stake in that split — the Settings page renders
 * one form — so the seam is closed here rather than pushed into every component
 * and hook. Which table a field came from is visible in this function alone.
 */
export function toSettingsDTO(
  userSettings: UserSettings,
  orgSettings: OrganizationSettings,
): SettingsDTO {
  return {
    // Team-wide: changing any of these changes a number somebody else sees.
    defaultThreshold: orgSettings.defaultThreshold,
    defaultPeriodDays: orgSettings.defaultPeriodDays,
    lookbackDays: orgSettings.lookbackDays,
    refreshIntervalMinutes: orgSettings.refreshIntervalMinutes,
    snapshotIntervalMinutes: orgSettings.snapshotIntervalMinutes,
    shortsProbeEnabled: orgSettings.shortsProbeEnabled,
    autoRefreshEnabled: orgSettings.autoRefreshEnabled,
    // Personal: display preferences that cannot move anyone else's numbers.
    defaultSortKey: userSettings.defaultSortKey,
    defaultSortDirection: userSettings.defaultSortDirection,
  };
}
