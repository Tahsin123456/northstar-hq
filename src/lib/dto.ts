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
   * Views required for a hit in this niche.
   *
   * `null` means UNCONFIGURED — nobody has said what a hit is here yet. It does
   * NOT mean "inherit the organization default": the app used to read it that
   * way and printed a hit rate against a number no one had chosen. A niche in
   * this state reports no hit rate at all until an Admin sets one.
   */
  readonly hitThreshold: number | null;
  readonly sortOrder: number;
  /** Active tracked channels currently assigned to this niche. */
  readonly channelCount: number;
  /**
   * Who created the niche.
   *
   * Ships with every niche rather than only on the admin screen, because the
   * one place it matters most — an unconfigured niche an admin has to chase —
   * is a row an admin reads on a list they did not build. Nullable on both
   * halves: `createdById` is `SetNull`, so a niche outlives its author's
   * account and then has genuinely nobody to name.
   */
  readonly createdById: string | null;
  readonly createdByName: string | null;
  readonly createdAt: number;
}

/**
 * A content type as referenced from a chip — just enough to render one.
 *
 * Deliberately the same three fields as `NicheRefDTO` rather than a shared
 * base type. They are two independent taxonomies that happen to render alike
 * today; tying them together would mean a field one of them needs arrives on
 * the other for no reason.
 */
export interface ContentTypeRefDTO {
  readonly id: string;
  readonly name: string;
  readonly colorIndex: number;
}

export interface ContentTypeDTO extends ContentTypeRefDTO {
  readonly slug: string;
  readonly sortOrder: number;
  /**
   * False once archived. Archived types are still shipped to the client, and
   * must be: every Short already filed under one keeps its label, so the chip
   * still has to render — what changes is that the type stops being offered
   * for new work.
   */
  readonly isActive: boolean;
  /** Shorts currently filed under it, across the organization. */
  readonly videoCount: number;
  /**
   * Tracked channels tagged with it, across the organization.
   *
   * A content type is a tag on two different things — channels and Shorts — so
   * "how much is this in use?" has two answers and both are reported. The two
   * are independent: a channel tagged "Rankings" says what the team expects of
   * it, and the Shorts filed under "Rankings" say what it actually produced.
   */
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
  /**
   * Content types tagged on the channel itself — what the team says this
   * channel makes.
   *
   * A SEPARATE STATEMENT FROM WHAT ITS SHORTS ARE FILED UNDER, and deliberately
   * so: this is the editorial read on a channel ("they do Rankings"), while
   * `VideoDTO.contentTypeIds` is the record of what each Short actually was.
   * The two are allowed to disagree, and the disagreement is often the finding.
   *
   * Ids into `DatasetDTO.contentTypes`, for the same reason the video side ships
   * ids: the catalogue travels once and renaming a tag stays a one-row change.
   */
  readonly contentTypeIds: readonly string[];
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
  /**
   * Content types filed against this Short, as ids into `DatasetDTO.contentTypes`.
   *
   * Ids, not objects. This is the one field on the wire that is repeated a few
   * thousand times, and a `{ id, name, colorIndex }` per assignment would ship
   * the same forty names over and over. The catalogue travels once at the top
   * of the payload and the client joins — which is also what makes renaming a
   * type a one-row change rather than a rewrite of every video it touches.
   */
  readonly contentTypeIds: readonly string[];
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
  /**
   * The content-type catalogue, once, including archived types.
   *
   * Archived ones are included because `VideoDTO.contentTypeIds` can still
   * point at them — a Short filed under a since-archived type keeps its label,
   * and a catalogue that omitted the target would render it as a dangling id.
   * The client filters to `isActive` when it offers a choice, not when it
   * renders one already made.
   *
   * ONE FLAT, ORG-WIDE LIST — there is no per-niche narrowing to apply. Any of
   * these tags may go on any of the organization's channels or Shorts, so "what
   * may this picker offer?" is answered by this array alone (filtered to
   * `isActive`) with nothing to intersect it against. That is also why a picker
   * opened on the hundredth row of the Shorts table costs nothing: the whole
   * answer is already in the payload, and there is no per-video `/available`
   * request to make.
   */
  readonly contentTypes: readonly ContentTypeDTO[];
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

/**
 * =========================================================================
 * SETTINGS COME IN TWO KINDS, AND THEY ARE NOT ONE PAYLOAD
 * =========================================================================
 *
 * There used to be a single `SettingsDTO` carrying every field on
 * OrganizationSettings, served to anybody holding `analytics.view` — which is
 * everybody. An employee could read the sync cadence, the lookback window and
 * the probe switch, and the only thing stopping them WRITING them was a check
 * in one route handler. The split below is what makes that structurally
 * impossible rather than conventionally discouraged: the personal payload has
 * no field for an org-wide setting, so no handler can leak one by widening a
 * select or spreading an object.
 */

/**
 * What every member receives.
 *
 * Two of these four are organization-wide, and they are here on purpose. The
 * default threshold and default period are the numbers every chart on the
 * dashboard is drawn with; without them the app cannot render analytics the
 * person is entitled to see, and the authenticated layout already hands both to
 * the browser as props on `FiltersProvider`. Withholding them from the API
 * while shipping them in the HTML would be theatre, not a boundary. They are
 * READ-ONLY here — changing either goes through the organization endpoint.
 *
 * Everything else on OrganizationSettings — the cadences, the lookback, the
 * probe, the currency, the company name — is absent by design, because nothing
 * an employee's screen draws depends on it.
 */
export interface PersonalSettingsDTO {
  /** Personal: a display preference that cannot move anybody else's numbers. */
  readonly defaultSortKey: string;
  readonly defaultSortDirection: string;
  /** Organization-wide, read-only here. The dashboard cannot draw without it. */
  readonly defaultThreshold: number;
  readonly defaultPeriodDays: number;
}

/** Every field on OrganizationSettings. `settings.manage` only, read and write. */
export interface OrganizationSettingsDTO {
  readonly defaultThreshold: number;
  readonly defaultPeriodDays: number;
  readonly lookbackDays: number;
  readonly refreshIntervalMinutes: number;
  readonly snapshotIntervalMinutes: number;
  readonly shortsProbeEnabled: boolean;
  readonly autoRefreshEnabled: boolean;
  readonly baseCurrency: string;
  readonly companyName: string;
}

/**
 * Server-side configuration the UI must reflect but cannot change.
 *
 * Behind `settings.manage` with the rest of the org configuration: whether an
 * API key is set and which database is behind the app are facts about the
 * deployment, and an employee has no screen that needs either.
 */
export interface RuntimeConfigDTO {
  readonly hasApiKey: boolean;
  readonly probeEnabledInEnv: boolean;
  readonly databaseProvider: "sqlite" | "postgresql";
  readonly lookbackDays: number;
  readonly maxUploadPages: number;
}

/** The signed-in person's own account details. */
export interface MyProfileDTO {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
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

/**
 * The things a note can be ATTACHED TO.
 *
 * Deliberately narrower than `NoteKind` below. Anywhere a note hangs off
 * something — the panel on a channel page, the per-target list endpoint, the
 * note counts that badge a row — needs a target id to hang it on, and this is
 * the type that guarantees one exists. A general note has no id, so it cannot
 * appear in any of those places and the compiler says so.
 */
export type NoteTargetType = "channel" | "niche" | "video";

/**
 * What a note IS: attached to something, or attached to nothing.
 *
 * "general" is a fourth value of the same `Note.targetType` column, with all
 * three foreign keys left null — not a second note system. A thought worth
 * writing down does not always belong to a channel or a Short ("stop opening
 * on the logo"), and before this existed the only way to record one was to
 * file it against something it was not really about, which is worse than a
 * note with no context: it puts a wrong answer in the log's context column.
 */
export type NoteKind = NoteTargetType | "general";

/** Every kind, in the order the log's filter offers them. */
export const NOTE_KINDS: readonly NoteKind[] = ["channel", "niche", "video", "general"];

/**
 * WHO A NOTE IS FOR.
 *
 * "personal" is working memory: the author, plus an admin holding
 * `users.manage` who is accountable for the workspace. "shared" is team
 * research — but *not* team-wide reading. A shared note reaches the colleagues
 * who can already see the thing it is about, which for a note on a Red Dead
 * channel means whoever holds Red Dead and nobody else. Sharing a note is a
 * decision about a note; it must never work as a way to hand somebody a niche
 * they were never assigned.
 *
 * The rule itself lives on the server, in `noteScope()` — this type only names
 * the two values so the column, the parse and the screens agree on them.
 */
export type NoteVisibility = "personal" | "shared";

/** Both values, in the order the composer offers them: private first. */
export const NOTE_VISIBILITIES: readonly NoteVisibility[] = ["personal", "shared"];

/**
 * "Mine", as an author filter value.
 *
 * Here rather than in the service because it is part of the wire contract: the
 * log's filter menu sends it and `listAllNotes` resolves it. Safe as a sentinel
 * because every id in this app is a cuid, which no two-letter word collides
 * with — and it resolves against the SESSION, so "mine" cannot be aimed at
 * somebody else by editing the query string.
 */
export const AUTHOR_ME = "me";

/**
 * What a note attached to nothing is called.
 *
 * One string, shared by the server (which resolves it into `targetLabel`) and
 * the screens that badge and filter on it, so the log's heading, its filter
 * option and the row's own label can never drift into three near-synonyms.
 */
export const GENERAL_NOTE_LABEL = "General";

/**
 * What a byline says when the row has no author on record.
 *
 * "Unknown", and deliberately not "a deleted account", which is what this said
 * before. `createdById` is `SetNull`, so a departed author leaves BOTH the id
 * and the name null — but that is not the only way a row gets there. This
 * database began as a single-user prototype with no accounts at all, and rows
 * that predate authentication have exactly the same null. The two are
 * indistinguishable in the data, so naming a cause would be asserting one the
 * row cannot support. "Unknown" says the true thing: nobody recorded it.
 *
 * Printing nothing is the one option that is not available. Every byline is now
 * unconditional, so a blank would read as a rendering fault rather than as an
 * absence — and next to an Edit and a Delete button, a row whose owner is
 * unclear is the one worth labelling most.
 *
 * One string, like `GENERAL_NOTE_LABEL` above, because three screens print
 * attribution and three euphemisms for the same absence is how a reader stops
 * trusting any of them.
 */
export const UNKNOWN_AUTHOR_LABEL = "Unknown";

/**
 * ATTRIBUTION ON PERSONAL ROWS
 *
 * Notes, collections and saved Shorts are one person's working state, so the
 * server only ever sends back rows the reader owns — except for an admin
 * holding `users.manage`, who reads the whole team's. That is exactly the case
 * where an unlabelled row is dangerous: two "Ideas" folders, or a note the
 * admin assumes is their own and edits. So the byline travels with the row
 * rather than being something a screen can choose to omit.
 *
 * The id comes along with the name so the client can say "yours" without
 * string-matching a display name — two people can be called John Smith.
 *
 * Both are nullable because the author column is `SetNull`: research outlives
 * the account that made it, and a row whose author has been deleted has
 * genuinely nobody to name.
 */
export interface NoteDTO {
  readonly id: string;
  readonly targetType: NoteKind;
  /**
   * The id of whatever this note is attached to — and `""` for a general one,
   * which is attached to nothing.
   *
   * Read it through `targetType`, never by testing for emptiness: "general" is
   * the fact, the empty string is only its consequence.
   */
  readonly targetId: string;
  readonly body: string;
  /**
   * Personal, or shared with the colleagues who can already see its subject.
   *
   * On the row rather than inferred from "did this arrive in my list", because
   * both answers can put a note on your screen and only one of them means
   * other people can read it. A writer deciding whether to type something
   * candid needs to see which.
   */
  readonly visibility: NoteVisibility;
  readonly createdById: string | null;
  readonly createdByName: string | null;
  /** Epoch ms. The log prints it: the owner asked for the created date. */
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CollectionDTO {
  readonly id: string;
  readonly name: string;
  readonly colorIndex: number;
  readonly itemCount: number;
  readonly createdById: string | null;
  readonly createdByName: string | null;
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

  /** Whose shortlist this row is on. See the attribution note on `NoteDTO`. */
  readonly savedById: string | null;
  readonly savedByName: string | null;
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
  /**
   * Whether the grant covers YouTube's monetary Analytics scope.
   *
   * A boolean rather than something the screen derives from `scope`, because
   * the server already compares Google's answer against the exact scope string
   * and a second copy of that constant in the browser is a second thing to keep
   * in step. False is the normal state of every connection made before revenue
   * import existed — the screen says "reconnect to enable revenue", which is a
   * different sentence from "something failed".
   */
  readonly revenueScopeGranted: boolean;
  /**
   * "unknown" | "monetized" | "not_monetized"
   *
   * A channel below the Partner Programme threshold earns nothing YouTube will
   * report, which is a fact to display rather than an error to retry — but
   * "not_monetized" is only ever written when YouTube REFUSES a report to a
   * connection that has permission to read one. A window of zeros leaves this
   * at "unknown", because zeros are equally what a channel earning fractions of
   * a cent a day reports. See `revenueSyncStatus`.
   *
   * The refusal does not say WHY, and the name overstates it: the same 403
   * answers a channel outside the programme and a channel this Google account
   * no longer owns. The screen renders it as the refusal it is rather than as a
   * membership finding.
   */
  readonly monetizationStatus: string;
  /** "never" | "ok" | "error" | "no_scope" | "not_monetized" | "reported_zero" */
  readonly revenueSyncStatus: string;
  /** What went wrong, written so it names the next action. */
  readonly revenueSyncError: string | null;
  readonly lastRevenueSyncAt: number | null;
  /**
   * When the scheduler will next look, so "nothing has happened yet" is
   * distinguishable from "nothing is going to happen".
   */
  readonly nextSyncAt: number | null;
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
