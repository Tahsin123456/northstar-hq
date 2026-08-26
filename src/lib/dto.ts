/**
 * The wire contract between the API and the browser.
 *
 * Imported by both sides, so a change to a response shape is a compile error in
 * every component that consumed it rather than a runtime surprise.
 *
 * Two conventions worth stating:
 *   • Timestamps cross the wire as epoch milliseconds, not ISO strings. They
 *     land ready for arithmetic with no revive step, and the analytics engine
 *     compares integers in its hot path.
 *   • Absence is `null`, never `0` or `""`. A hidden subscriber count and a
 *     channel with zero subscribers are different facts.
 */

import type { AnalyticsVideo } from "@/lib/analytics/types";

/**
 * Whether the user operates a channel or is researching it.
 *
 * A two-state string rather than a boolean so the wire format stays
 * self-describing and a third state (e.g. "client") can be added without a
 * migration or a `isOwn === false` meaning two different things.
 */
export type OwnershipType = "own" | "competitor";

export const OWNERSHIP_TYPES: readonly OwnershipType[] = ["own", "competitor"];

export function isOwnershipType(value: unknown): value is OwnershipType {
  return value === "own" || value === "competitor";
}

/** A niche as referenced from a channel — just enough to render a chip. */
export interface NicheRefDTO {
  readonly id: string;
  readonly name: string;
  readonly colorIndex: number;
}

export interface NicheDTO extends NicheRefDTO {
  readonly slug: string;
  /**
   * Views required for a hit in this niche. `null` inherits the account
   * default — a 250K science niche and a 1M gaming niche are not comparable
   * on a single global number.
   */
  readonly hitThreshold: number | null;
  readonly sortOrder: number;
  /** Active tracked channels currently assigned to this niche. */
  readonly channelCount: number;
  readonly createdAt: number;
}

export interface ChannelDTO {
  readonly id: string;
  readonly youtubeChannelId: string;
  readonly handle: string | null;
  /** The channel's own YouTube title. */
  readonly title: string;
  /** User-supplied override, if they renamed it in the tracker. */
  readonly label: string | null;
  /** `label ?? title` — what the UI should render. */
  readonly displayName: string;
  readonly description: string;
  readonly avatarUrl: string | null;
  readonly bannerUrl: string | null;
  readonly country: string | null;

  /** `null` when the channel hides its subscriber count. */
  readonly subscriberCount: number | null;
  readonly hiddenSubscriberCount: boolean;
  /** Lifetime channel-wide totals, including long-form. Context only — these
   *  never feed a Shorts metric. */
  readonly lifetimeViewCount: number | null;
  readonly lifetimeVideoCount: number | null;

  readonly channelUrl: string;

  readonly lastFetchedAt: number | null;
  /** "never" | "success" | "error" */
  readonly lastFetchStatus: string;
  readonly lastFetchError: string | null;

  readonly addedAt: number;
  readonly isActive: boolean;

  /** Whether this is one of the user's own channels. Defaults to "competitor". */
  readonly ownershipType: OwnershipType;
  /** Niches this channel is filed under. Empty means unassigned. */
  readonly niches: readonly NicheRefDTO[];
}

/**
 * A video as the client consumes it. Extends the analytics engine's own input
 * shape, so a dataset row can be handed straight to `calculateChannelMetrics`
 * with no adaptation.
 */
export interface VideoDTO extends AnalyticsVideo {
  /** "short" | "not_short" | "uncertain" */
  readonly classification: string;
  readonly classificationConfidence: number;
  readonly isAvailable: boolean;
}

/** One channel plus every video of its stored history. */
export interface DatasetChannelDTO {
  readonly channel: ChannelDTO;
  readonly videos: readonly VideoDTO[];
  /** Videos stored but excluded from Shorts metrics (long-form + uncertain). */
  readonly excludedCount: number;
  /** Videos the classifier could not resolve. Surfaced for transparency. */
  readonly unclassifiedCount: number;
}

/**
 * The single payload the dashboard fetches.
 *
 * Everything the UI can ask — any period, any threshold, any sort, comparison,
 * channel detail — is derived from this in the browser. That is the mechanism
 * behind the "changing a filter must not hit YouTube" requirement: there is no
 * server round-trip to make, because the data is already local.
 */
export interface DatasetDTO {
  readonly channels: readonly DatasetChannelDTO[];
  /**
   * Every niche the user has defined, including empty ones — the filter menu
   * must list a niche that currently has no channels so it can be assigned to.
   */
  readonly niches: readonly NicheDTO[];
  /** Research layer, shipped in the same payload so every page shares one fetch. */
  readonly collections: readonly CollectionDTO[];
  readonly savedShorts: readonly SavedShortDTO[];
  readonly noteCounts: NoteCountsDTO;
  /** Whether snapshot history can support "views earned in period" yet. */
  readonly viewsDefinition: ViewsDefinitionDTO;
  /** How many days of history this payload covers. */
  readonly lookbackDays: number;
  /** When the server assembled it, epoch ms. */
  readonly generatedAt: number;
  /** Oldest `lastFetchedAt` across tracked channels — drives the freshness pill. */
  readonly oldestFetchedAt: number | null;
  readonly hasApiKey: boolean;
}

export interface SettingsDTO {
  readonly defaultThreshold: number;
  readonly defaultPeriodDays: number;
  readonly defaultSortKey: string;
  readonly defaultSortDirection: string;
  readonly lookbackDays: number;
  readonly refreshIntervalMinutes: number;
  readonly snapshotIntervalMinutes: number;
  readonly shortsProbeEnabled: boolean;
  readonly autoRefreshEnabled: boolean;
}

/** Server-side configuration the UI must reflect but cannot change. */
export interface RuntimeConfigDTO {
  readonly hasApiKey: boolean;
  readonly probeEnabledInEnv: boolean;
  readonly databaseProvider: "sqlite" | "postgresql";
  readonly lookbackDays: number;
  readonly maxUploadPages: number;
}

/** The preview shown before a channel is actually added. */
export interface ChannelPreviewDTO {
  readonly youtubeChannelId: string;
  readonly title: string;
  readonly handle: string | null;
  readonly avatarUrl: string | null;
  readonly description: string;
  readonly subscriberCount: number | null;
  readonly hiddenSubscriberCount: boolean;
  readonly videoCount: number | null;
  readonly viewCount: number | null;
  readonly channelUrl: string;
  /** True when this channel is already in the tracker. */
  readonly alreadyTracked: boolean;
  /** True when it was tracked before and soft-deleted — adding restores it. */
  readonly previouslyRemoved: boolean;
}

export interface RefreshResultDTO {
  readonly channelId: string;
  readonly status: "success" | "partial" | "error";
  readonly videosDiscovered: number;
  readonly videosUpdated: number;
  readonly shortsClassified: number;
  readonly snapshotsWritten: number;
  readonly quotaUnitsUsed: number;
  readonly markedUnavailable: number;
  readonly error: string | null;
  readonly durationMs: number;
}

export interface ExcludedVideoDTO {
  readonly youtubeVideoId: string;
  readonly title: string;
  readonly publishedAt: number;
  readonly durationSeconds: number;
  readonly views: number;
  readonly classification: string;
  readonly classificationConfidence: number;
  readonly classificationMethod: string;
  readonly classificationReason: string;
}

/** Uniform error envelope. Route handlers never return anything else on failure. */
export interface ApiErrorDTO {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// RESEARCH LAYER
// ---------------------------------------------------------------------------

export type NoteTargetType = "channel" | "niche" | "video";

export interface NoteDTO {
  readonly id: string;
  readonly targetType: NoteTargetType;
  readonly targetId: string;
  readonly body: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CollectionDTO {
  readonly id: string;
  readonly name: string;
  readonly colorIndex: number;
  readonly itemCount: number;
  readonly createdAt: number;
}

/**
 * A bookmarked Short.
 *
 * Carries both `viewsAtSave` and `currentViews` so the UI can render the
 * journey a Short took after it was spotted, e.g. "1.2M -> 4.8M". The saved
 * figure is a historical fact and is never recomputed.
 */
export interface SavedShortDTO {
  readonly id: string;
  readonly videoId: string;
  readonly youtubeVideoId: string;
  readonly title: string;
  readonly publishedAt: number;
  readonly durationSeconds: number;

  readonly channelId: string;
  readonly channelName: string;
  readonly channelHandle: string | null;
  readonly channelAvatarUrl: string | null;
  readonly ownershipType: OwnershipType;
  readonly niches: readonly NicheRefDTO[];

  readonly viewsAtSave: number;
  readonly currentViews: number;
  readonly channelMedianAtSave: number | null;
  readonly outlierMultipleAtSave: number | null;

  readonly savedAt: number;
  readonly collectionIds: readonly string[];
}

/** Note counts keyed by target id, so the UI can badge without extra queries. */
export interface NoteCountsDTO {
  readonly channels: Record<string, number>;
  readonly niches: Record<string, number>;
  readonly videos: Record<string, number>;
}

/**
 * How the app defines "total views" for a period.
 *
 * Surfaced to the client so the UI can state the definition rather than leaving
 * the reader to assume it matches YouTube Studio, which measures something
 * different.
 */
export interface ViewsDefinitionDTO {
  /** Whether snapshot history is dense enough to compute views *earned* in a period. */
  readonly canComputeViewsInPeriod: boolean;
  /** Hours of snapshot history collected so far. */
  readonly snapshotSpanHours: number;
  readonly snapshotCount: number;
  /** Distinct days on which snapshots were captured. */
  readonly snapshotDays: number;
}

/**
 * A note with enough context to be read and navigated from a central list,
 * without the reader having to remember which channel or Short it was about.
 */
export interface NoteWithContextDTO extends NoteDTO {
  /** Resolved display label for whatever the note is attached to. */
  readonly targetLabel: string;
  /** Channel context, present for channel notes and Short notes. */
  readonly channelId: string | null;
  readonly channelName: string | null;
  readonly channelAvatarUrl: string | null;
  /** Niche context: the niche itself, or the niches of the related channel. */
  readonly niches: readonly NicheRefDTO[];
  /** Video context, for notes attached to a single Short. */
  readonly videoId: string | null;
  readonly youtubeVideoId: string | null;
}

/**
 * A connected Google account, as the admin screen is allowed to see it.
 *
 * The absence of every token field is structural, not a filtering step:
 * `accessTokenEnc` and `refreshTokenEnc` are not properties of this type, so a
 * future edit cannot leak one by spreading a Prisma row into a response. The
 * mapper selects columns explicitly for the same reason.
 */
export interface YouTubeConnectionDTO {
  readonly id: string;
  /** Which Google account granted access — whose authorisation a sync depends on. */
  readonly googleAccountEmail: string | null;
  readonly channelTitle: string | null;
  readonly youtubeChannelId: string | null;
  /**
   * Space-separated scopes Google actually granted. Surfaced so a downgraded
   * grant (the user unticking a box on the consent screen) is visible here
   * rather than as an opaque 403 during the next sync.
   */
  readonly scope: string;
  /** "connected" | "needs_reauth" | "revoked" */
  readonly status: string;
  readonly lastError: string | null;
  readonly lastSyncAt: number | null;
  readonly connectedByName: string | null;
  readonly createdAt: number;
}

/**
 * Whether this deployment can offer the "Connect a Google account" button.
 *
 * Reported rather than assumed so the admin screen can name the missing
 * variables instead of rendering a button that fails on click — the OAuth
 * feature is optional and the app runs fully without it.
 */
export interface GoogleOAuthStatusDTO {
  readonly configured: boolean;
  /** Environment variable names still to be set, in the order to set them. */
  readonly missing: readonly string[];
  /**
   * The exact redirect URI to register in the Google Cloud console. Null when
   * it cannot be derived, which is itself the thing the admin must fix.
   */
  readonly redirectUri: string | null;
}

/**
 * Whether this deployment can send a Telegram notification, and what is
 * missing if it cannot.
 *
 * The two halves are reported separately because they are fixed in different
 * places by different people: the token is a deployment environment variable
 * an operator sets, the chat id is organization data an admin types into the
 * Settings form. Collapsing them into one boolean would send an admin hunting
 * through hosting configuration for something they could have fixed in the UI.
 *
 * NOTE WHAT IS NOT HERE. There is no `token` field and there never will be —
 * the bot token is reported as a boolean and nothing else. See
 * `src/server/services/telegram-env.ts`.
 */
export interface TelegramStatusDTO {
  /** TELEGRAM_BOT_TOKEN is set. The value itself is never disclosed. */
  readonly tokenConfigured: boolean;
  /** A destination chat has been configured for this organization. */
  readonly chatConfigured: boolean;
  /** Both halves are in place, so a message could actually be sent. */
  readonly configured: boolean;
  /** What is still to be set, in the order to set it. */
  readonly missing: readonly string[];
}

/**
 * Where this organization's notifications go.
 *
 * Mirrors the `NotificationSettings` row minus its bookkeeping columns. The
 * chat id is included because an admin has to be able to see and correct what
 * they typed; it is not a secret on its own — a bot can only post to a chat it
 * has been added to, and the thing that makes posting possible is the token,
 * which is not in this type.
 */
export interface NotificationSettingsDTO {
  readonly telegramChatId: string | null;
  readonly telegramEnabled: boolean;
  /** Lets an admin mute the monthly summary without disconnecting Telegram. */
  readonly payrollNotificationsEnabled: boolean;
}

/**
 * The outcome of one notification attempt, as the admin UI shows it.
 *
 * `skipped` is a first-class result rather than a failure: a run with
 * notifications switched off, or with no chat configured, did exactly what it
 * was asked to. Reporting that as an error would train an admin to ignore the
 * field that also reports real failures.
 */
export interface NotificationAttemptDTO {
  readonly status: "sent" | "failed" | "skipped" | "already_sent";
  /** Why it was skipped, or how it failed. Never contains a credential. */
  readonly detail: string | null;
  readonly attempts: number;
  readonly sentAt: number | null;
  /** How many Telegram messages the summary was split into. */
  readonly parts: number;
}

/**
 * The last payroll summary this organization tried to deliver.
 *
 * A separate type from `NotificationAttemptDTO` because the two answer
 * different questions. An *attempt* is what just happened in response to a
 * button the admin pressed a second ago; this is the standing state of the
 * delivery row — including one that failed unattended at midnight on the 1st,
 * with nobody watching. The brief is explicit that a failed delivery must be
 * visible after the fact, and a value that only exists in a mutation response
 * is not visible after the fact.
 *
 * WHAT IS NOT HERE: any payroll figure. Which month was announced, whether it
 * arrived and what went wrong are delivery facts; what it said is payroll, and
 * payroll lives behind `payroll.view` on the screens that hold it. `lastError`
 * is Telegram's own description with the bot token already scrubbed out by
 * `telegram-service.ts` — see `scrubToken` there.
 */
export interface PayrollNotificationStatusDTO {
  /** "telegram" today; the column exists so a second channel needs no migration. */
  readonly channel: string;
  /**
   * `skipped` is its own outcome, not a quiet success.
   *
   * A run with notifications muted, or with no chat id, cannot send — and until
   * it was recorded, the card went on showing the PREVIOUS month's delivery,
   * which reads as "this month went out fine". A skipped month is a month
   * nobody was told about, and the admin has to be able to see that.
   */
  readonly status: "pending" | "sent" | "failed" | "skipped";
  readonly attempts: number;
  /**
   * Why the last attempt failed, or — on a `skipped` row — what stopped it from
   * being attempted at all. Never contains a credential.
   */
  readonly lastError: string | null;
  readonly sentAt: number | null;
  /** When the row last moved — the only timestamp a failure has. */
  readonly updatedAt: number;
  readonly year: number;
  /** 1-12. */
  readonly month: number;
  /** "August 2026" — the period the message was about. */
  readonly periodLabel: string;
}
