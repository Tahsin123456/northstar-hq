import type {
  Channel,
  ChannelContentTypeRule,
  ContentType,
  Niche,
  OrganizationSettings,
  TrackedChannel,
  UserSettings,
  Video,
} from "@prisma/client";
import type {
  ChannelContentTypeRuleDTO,
  ChannelDataSource,
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
  VideoHitDTO,
} from "@/lib/dto";
import { isOwnershipType } from "@/lib/dto";
import { toNicheKind } from "@/lib/niches/niche-kind";
import type { HitOutcome } from "@/lib/analytics/hit-rate";
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

export function toNicheRefDTO(
  niche: Pick<Niche, "id" | "name" | "colorIndex" | "kind">,
): NicheRefDTO {
  return {
    id: niche.id,
    name: niche.name,
    colorIndex: niche.colorIndex,
    // Narrowed here rather than cast. The column is a portable `String`, and an
    // unreadable value has to read as "production" so a bad row over-counts
    // visibly instead of silently dropping a niche out of the studio's numbers.
    kind: toNicheKind(niche.kind),
  };
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
  /**
   * Whether this reader may see what a hit here PAYS.
   *
   * `GET /api/niches` is gated on `analytics.view`, which every employee role
   * holds, and it returns the whole catalogue. Carrying the rate unconditionally
   * would publish "a Red Dead hit pays $8, a GTA hit pays $5" to everybody — pay
   * configuration, on the one endpoint in the app that everybody reads.
   *
   * Defaults to false so a caller that has not thought about it discloses
   * nothing. The one ambiguity this creates — null meaning "not set" OR "not
   * yours to see" — has no consumer: every surface that reads the amount is
   * inside the admin section, and the "needs configuration" badge an employee
   * sees is computed from the threshold and the window, not from this.
   */
  options?: { readonly includePay?: boolean },
): NicheDTO {
  return {
    ...toNicheRefDTO(niche),
    slug: niche.slug,
    // Carried, never coerced. `null` is "nobody has said what a hit here is
    // worth" — a state every payroll surface reports, not a zero it pays.
    //
    // A WATCHLIST NICHE NEVER SHIPS A RATE, whatever is stored. Nobody is paid
    // for a niche the studio only watches, so a number on the wire could only
    // be rendered beside a bonus that cannot exist. The row keeps its value so
    // reclassifying a niche is reversible without destroying it.
    //
    // AND IT IS NOT WIDENED FOR THE ADMIN WHO MAY CONFIGURE IT, which was the
    // other way to keep that reversibility honest. This DTO's one list endpoint
    // is `analytics.view` — every employee role holds it — so a "carried for
    // whoever may set it" rate would reach the whole team, and a per-hit price
    // on a niche that pays no bonus is a number that can only mislead whoever
    // reads it. The reversibility is kept on the WRITE side instead:
    // `NicheThresholdForm` does not submit a payment field it was never given a
    // value for, and `updateNiche` leaves the column alone when no key arrives.
    hitPaymentMinor:
      options?.includePay !== true || toNicheKind(niche.kind) === "watchlist"
        ? null
        : niche.hitPaymentMinor,
    hitThreshold: niche.hitThreshold,
    hitWindowHours: niche.hitWindowHours,
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
 * THREE counts, because a tag attaches to a STRETCH of a channel's output and
 * DEVIATES on a Short, and those are three different facts. The rule count is
 * the one that describes reach — a tag with 6 rules labels every Short inside
 * those six windows, with no row per Short anywhere. The two video counts
 * describe only the exceptions: Shorts that carry the tag their rules do not
 * give them, and Shorts that refuse one their rules do. Reporting a single
 * "videoCount" here would state a fraction of the truth under a label that
 * claims to be all of it.
 */
export function toContentTypeDTO(
  contentType: ContentType,
  counts: {
    manualVideoCount: number;
    excludedVideoCount: number;
    channelRuleCount: number;
  },
): ContentTypeDTO {
  return {
    ...toContentTypeRefDTO(contentType),
    slug: contentType.slug,
    sortOrder: contentType.sortOrder,
    isActive: contentType.isActive,
    manualVideoCount: counts.manualVideoCount,
    excludedVideoCount: counts.excludedVideoCount,
    channelRuleCount: counts.channelRuleCount,
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
  niches?: Array<{ niche: Pick<Niche, "id" | "name" | "colorIndex" | "kind"> }>;
  /**
   * The channel's content-type RULES — what it made, and when.
   *
   * Optional like `niches` and unlike the video side's, and the difference is
   * the tenancy: `ChannelContentTypeRule` hangs off `TrackedChannel`, which is
   * already this organization's row, so a query that omits the relation is
   * simply not asking about tags. `VideoContentType` hangs off a globally
   * shared `Video`, where the same omission would silently publish another
   * team's Short as unclassified — which is why that one is required.
   */
  contentTypeRules?: ChannelContentTypeRuleProjection[];
};

/** The rule columns the DTO needs. Narrower than the row, and named so. */
export type ChannelContentTypeRuleProjection = Pick<
  ChannelContentTypeRule,
  | "id"
  | "contentTypeId"
  | "effectiveFrom"
  | "effectiveUntil"
  | "consecutiveOverrides"
  | "overrideStreakFrom"
  | "autoClosedAt"
>;

/**
 * One rule, with every `DateTime` flattened to epoch milliseconds.
 *
 * The flattening is not cosmetic. `resolveContentTypes` runs in the browser
 * against these same windows, and a `Date` that has been through JSON arrives
 * there as a STRING — where `publishedAt < effectiveUntil` silently becomes a
 * comparison between a number and a string and is false for every Short ever
 * published. Numbers on the wire mean the rule the client evaluates is the rule
 * the server wrote.
 */
export function toChannelContentTypeRuleDTO(
  rule: ChannelContentTypeRuleProjection,
): ChannelContentTypeRuleDTO {
  return {
    id: rule.id,
    contentTypeId: rule.contentTypeId,
    effectiveFrom: rule.effectiveFrom.getTime(),
    effectiveUntil: rule.effectiveUntil?.getTime() ?? null,
    consecutiveOverrides: rule.consecutiveOverrides,
    overrideStreakFrom: rule.overrideStreakFrom?.getTime() ?? null,
    autoClosedAt: rule.autoClosedAt?.getTime() ?? null,
  };
}

/**
 * @param dataSource Where this channel's figures were read from. Defaults to
 * "public", which is both the truth for every competitor and the correct answer
 * for any caller that has not asked — a channel is only ever read through a
 * connection when one demonstrably exists, so defaulting the other way would let
 * an omission ASSERT a connection that is not there. See `ChannelDataSource`.
 */
export function toChannelDTO(
  channel: Channel,
  tracked: TrackedChannelProjection | null,
  dataSource: ChannelDataSource = "public",
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
    dataSource,
    // Sorted by name because the join rows come back in insertion order, so
    // without this the chips on a channel silently reshuffle whenever somebody
    // re-saves the assignment.
    niches: (tracked?.niches ?? [])
      .map((assignment) => toNicheRefDTO(assignment.niche))
      .sort((a, b) => a.name.localeCompare(b.name)),
    /*
     * Sorted by when each rule STARTS, oldest first.
     *
     * Chronological rather than by tag name, because that is what these are: a
     * channel's history of what it made. A reader scanning them is following a
     * story — rankings, then cutscenes — and alphabetical order would shuffle it
     * into nonsense. `id` breaks the tie so two rules that start at the same
     * instant do not reshuffle between requests, which would defeat the client
     * memos that key on this array.
     */
    contentTypeRules: (tracked?.contentTypeRules ?? [])
      .map(toChannelContentTypeRuleDTO)
      .sort((a, b) => a.effectiveFrom - b.effectiveFrom || a.id.localeCompare(b.id)),
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
  /**
   * This organization's verdict on this video. At most one row.
   *
   * AN ARRAY BECAUSE THAT IS WHAT THE RELATION IS, and required for the same
   * reason `contentTypes` is required rather than optional. `Video` is a
   * globally deduplicated row shared between organizations and
   * `VideoHitEvaluation` carries `organizationId`, so these rows only mean
   * anything once narrowed to one tenant — `@@unique([organizationId, videoId])`
   * is what makes "at most one" true after that narrowing. An optional field
   * defaulting to `[]` would let a query that forgot the relation ship every
   * Short as unjudged, which reads on screen as a library nobody has scored.
   */
  hitEvaluations: Array<{
    outcome: string;
    thresholdApplied: number | null;
    windowHoursApplied: number | null;
    viewsAtWindow: bigint | null;
    observedAtHours: number | null;
  }>;
};

/**
 * The stored verdict, narrowed for the wire.
 *
 * NOTHING IS DECIDED HERE. The outcome string is read back exactly as the
 * evaluator wrote it, and an unrecognised value is treated as "unknown" — the
 * same narrowing `hit-evaluation-service` applies on the way in, and for the
 * same reason: the column is a plain String for SQLite/PostgreSQL portability,
 * so a value from a future migration this build has never heard of is possible,
 * and guessing which of four verdicts it meant would be worse than admitting
 * the row says nothing.
 */
function toVideoHitDTO(
  rows: VideoProjection["hitEvaluations"],
): VideoHitDTO | null {
  const row = rows[0];
  if (!row) return null;
  return {
    outcome: toHitOutcome(row.outcome),
    thresholdApplied: row.thresholdApplied,
    windowHoursApplied: row.windowHoursApplied,
    viewsAtWindow: bigIntToNumber(row.viewsAtWindow),
    observedAtHours: row.observedAtHours,
  };
}

function toHitOutcome(value: string): HitOutcome {
  return value === "hit" || value === "miss" || value === "pending" ? value : "unknown";
}

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
    hit: toVideoHitDTO(video.hitEvaluations),
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
