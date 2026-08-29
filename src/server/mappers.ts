import type {
  Channel,
  ContentType,
  Niche,
  OrganizationSettings,
  TrackedChannel,
  UserSettings,
  Video,
} from "@prisma/client";
import type {
  ChannelDTO,
  ContentTypeDTO,
  ContentTypeRefDTO,
  ExcludedVideoDTO,
  NicheDTO,
  NicheRefDTO,
  OrganizationSettingsDTO,
  OwnershipType,
  PersonalSettingsDTO,
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

/**
 * The author columns a niche's byline needs.
 *
 * Structural rather than the Prisma user type: callers select three columns,
 * and typing the parameter as the whole `AppUser` would invite one of them to
 * hand over a row carrying a password hash.
 */
type NicheAuthorRow = { name: string | null; email: string | null } | null | undefined;

/**
 * `createdBy` is optional so the many places that map a niche without joining
 * its author keep working unchanged. The byline is then `null` — which the UI
 * renders as "Unknown", never as a blank that reads like an anonymous row.
 */
export function toNicheDTO(
  niche: Niche,
  channelCount: number,
  createdBy?: NicheAuthorRow,
): NicheDTO {
  return {
    ...toNicheRefDTO(niche),
    slug: niche.slug,
    hitThreshold: niche.hitThreshold,
    sortOrder: niche.sortOrder,
    channelCount,
    createdById: niche.createdById,
    // Name, then email, then nothing. A person who has not set a display name
    // is still a person, and "Created by" followed by a blank reads as
    // anonymous — the exact thing attribution exists to prevent.
    createdByName: createdBy ? (createdBy.name ?? createdBy.email ?? null) : null,
    createdAt: niche.createdAt.getTime(),
  };
}

export function toContentTypeRefDTO(
  contentType: Pick<ContentType, "id" | "name" | "colorIndex">,
): ContentTypeRefDTO {
  return {
    id: contentType.id,
    name: contentType.name,
    colorIndex: contentType.colorIndex,
  };
}

/**
 * The full catalogue entry, with its usage count.
 *
 * The count is a parameter rather than a field read off the row because it is
 * the answer to a filtered question — this organization's videos — that only
 * the query knows how to ask. Passing it in keeps the one place that decides
 * what "in use" means (content-type-service) from being quietly duplicated
 * here.
 *
 * THREE counts, because a tag now attaches to a channel and DEVIATES on a
 * Short, and those are three different facts. The channel count is the one that
 * describes reach — a tag on 6 channels labels every Short those channels have
 * published, with no row per Short anywhere. The two video counts describe only
 * the exceptions: Shorts that carry the tag their channel does not give them,
 * and Shorts that refuse the one it does. Reporting a single "videoCount" here
 * would state a fraction of the truth under a label that claims to be all of
 * it.
 */
export function toContentTypeDTO(
  contentType: ContentType,
  counts: { manualVideoCount: number; excludedVideoCount: number; channelCount: number },
): ContentTypeDTO {
  return {
    ...toContentTypeRefDTO(contentType),
    slug: contentType.slug,
    sortOrder: contentType.sortOrder,
    isActive: contentType.isActive,
    manualVideoCount: counts.manualVideoCount,
    excludedVideoCount: counts.excludedVideoCount,
    channelCount: counts.channelCount,
    createdAt: contentType.createdAt.getTime(),
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

/** The tracking-row shape `toChannelDTO` needs, including its join rows. */
export type TrackedChannelProjection = Pick<
  TrackedChannel,
  "label" | "addedAt" | "isActive" | "ownershipType"
> & {
  niches?: Array<{ niche: Pick<Niche, "id" | "name" | "colorIndex"> }>;
  /**
   * The channel's content-type tags.
   *
   * Optional like `niches` and unlike the video side's, and the difference is
   * the tenancy: `ChannelContentType` hangs off `TrackedChannel`, which is
   * already this organization's row, so a query that omits the relation is
   * simply not asking about tags. `VideoContentType` hangs off a globally
   * shared `Video`, where the same omission would silently publish another
   * team's Short as unclassified — which is why that one is required.
   */
  contentTypes?: Array<{ contentTypeId: string }>;
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
    // Sorted by name because the join rows come back in insertion order, so
    // without this the chips on a channel silently reshuffle whenever somebody
    // re-saves the assignment.
    niches: (tracked?.niches ?? [])
      .map((assignment) => toNicheRefDTO(assignment.niche))
      .sort((a, b) => a.name.localeCompare(b.name)),
    // Sorted for the same reason the video side is: stable chip order, and a
    // stable array for the client memos that key on it.
    contentTypeIds: (tracked?.contentTypes ?? [])
      .map((assignment) => assignment.contentTypeId)
      .sort(),
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
> & {
  /**
   * The caller's own content-type DEVIATIONS for this video — never its tags.
   *
   * `state` comes with the id and is not optional, because a row is meaningless
   * without it: the same shape means "carries this tag" and "refuses this tag"
   * depending on that one column, and a projection that dropped it would be
   * read as the first by anything that compiled.
   *
   * REQUIRED, not optional like the join rows on `TrackedChannelProjection`.
   * `Video` is a global, deduplicated row shared between organizations, so
   * these join rows only mean anything once they have been narrowed to one
   * tenant — and an optional field defaulting to `[]` would let a query that
   * forgot the relation ship a Short as agreeing with its channel when the team
   * had explicitly said otherwise. Making it required turns that omission into
   * a compile error.
   */
  contentTypes: Array<{ contentTypeId: string; state: string }>;
};

export function toVideoDTO(video: VideoProjection): VideoDTO {
  /*
   * Split by state, and nothing is resolved here.
   *
   * The mapper's job is to report the two kinds of deviation the row can be;
   * turning them into the Short's actual tags needs the CHANNEL, which this
   * function does not have and deliberately is not given. Resolution happens in
   * `src/lib/content-types/resolve.ts`, once, where the browser can reach it —
   * see the note on `VideoDTO.manualContentTypeIds` for why a precomputed
   * effective list must not travel on the wire.
   *
   * An unrecognised state is treated as neither. The column is a plain String
   * for SQLite/PostgreSQL portability, so a value written by a future migration
   * this build has never heard of is possible, and guessing which of the two
   * opposite meanings it has would be worse than ignoring it.
   */
  const manualContentTypeIds: string[] = [];
  const excludedContentTypeIds: string[] = [];

  for (const row of video.contentTypes) {
    if (row.state === "manual") manualContentTypeIds.push(row.contentTypeId);
    else if (row.state === "excluded") excludedContentTypeIds.push(row.contentTypeId);
  }

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
    // Sorted so a re-save cannot reorder the chips on a Short, and so a
    // client memoising on these arrays does not invalidate for no reason.
    manualContentTypeIds: manualContentTypeIds.sort(),
    excludedContentTypeIds: excludedContentTypeIds.sort(),
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
 * What every member may see: their own preferences, plus the two org-wide
 * defaults the dashboard is drawn with.
 *
 * This used to be one flat DTO carrying every field on OrganizationSettings,
 * on the reasoning that the client had no stake in which table a field came
 * from. It turned out to have one: the payload went to everyone holding
 * `analytics.view`, so the sync cadence and the lookback window — organization
 * configuration an employee has no screen for — travelled with the two numbers
 * they actually need. The seam is now open on purpose, and it is a permission
 * boundary rather than a storage detail.
 *
 * The two organization fields here are deliberate and minimal: without them a
 * chart cannot pick a threshold or a period, and `(app)/layout.tsx` already
 * hands both to the browser to seed `FiltersProvider`. They are read-only in
 * this direction — `toOrganizationSettingsDTO` is the only way to see the rest,
 * and writing any of them goes through `settings.manage`.
 */
export function toPersonalSettingsDTO(
  userSettings: UserSettings,
  orgSettings: OrganizationSettings,
): PersonalSettingsDTO {
  return {
    defaultSortKey: userSettings.defaultSortKey,
    defaultSortDirection: userSettings.defaultSortDirection,
    defaultThreshold: orgSettings.defaultThreshold,
    defaultPeriodDays: orgSettings.defaultPeriodDays,
  };
}

/**
 * The whole organization row. `settings.manage` only.
 *
 * Fields are listed one by one rather than spread, so a column added to
 * OrganizationSettings later does not arrive in a payload by default — the same
 * reasoning the payroll queries use for salaries.
 */
export function toOrganizationSettingsDTO(
  orgSettings: OrganizationSettings,
): OrganizationSettingsDTO {
  return {
    defaultThreshold: orgSettings.defaultThreshold,
    defaultPeriodDays: orgSettings.defaultPeriodDays,
    lookbackDays: orgSettings.lookbackDays,
    refreshIntervalMinutes: orgSettings.refreshIntervalMinutes,
    snapshotIntervalMinutes: orgSettings.snapshotIntervalMinutes,
    shortsProbeEnabled: orgSettings.shortsProbeEnabled,
    autoRefreshEnabled: orgSettings.autoRefreshEnabled,
    baseCurrency: orgSettings.baseCurrency,
    companyName: orgSettings.companyName,
  };
}
