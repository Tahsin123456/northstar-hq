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
import type { HitOutcome } from "@/lib/analytics/hit-rate";
import type { NicheRpmResolution } from "@/lib/analytics/niche-rpm";
import type { NicheKind } from "@/lib/niches/niche-kind";

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

/**
 * =========================================================================
 * WHICH DOOR THIS CHANNEL'S NUMBERS CAME THROUGH
 * =========================================================================
 *
 * The owner's instruction was unambiguous: "My own channels data should only
 * come from that [the connected account], not from external API or sources."
 * Competitors have no such door and keep using the public Data API with the
 * shared key, because there is no other way to see them.
 *
 * That makes the SOURCE a property a reader has to be able to see, not an
 * implementation detail — a figure read with the channel owner's own
 * authorisation and a figure scraped from the public API are different claims
 * about the same channel, and the second is the one the owner asked not to rely
 * on for their own channels.
 *
 *   • "connection"            — read with the connected account's own OAuth
 *                               grant. Authoritative, and spends that account's
 *                               quota rather than the shared key's.
 *   • "connection_unavailable" — this channel HAS a connection and it has
 *                               stopped working. The sync refuses to run rather
 *                               than falling back to the public API, so these
 *                               figures are frozen at the last good read. This
 *                               value is the whole reason the enum is not a
 *                               boolean: "we use the connection" and "we would
 *                               use the connection but cannot" are the two
 *                               states an owner has to be able to tell apart,
 *                               and collapsing them is how a frozen channel
 *                               passes for a healthy one.
 *   • "public"                — the public Data API. Correct and permanent for
 *                               a competitor; for an own channel it means nobody
 *                               has connected the account that owns it yet, and
 *                               the screen says so.
 */
export type ChannelDataSource = "connection" | "connection_unavailable" | "public";

export function isChannelDataSource(value: unknown): value is ChannelDataSource {
  return value === "connection" || value === "connection_unavailable" || value === "public";
}

/**
 * A niche as referenced from a channel — enough to render a chip, plus the one
 * fact a chip does not need.
 *
 * `kind` is here rather than only on the full `NicheDTO` because the question
 * it answers is asked about CHANNELS: "is this channel part of the work the
 * studio is accountable for, or is it something we watch?" That is decided from
 * `channel.niches`, in a pure predicate, in memory, on every scoped screen. The
 * alternative was to hand each of those call sites the niche catalogue and let
 * it join — and a call site that forgot would silently pool watchlist channels
 * back into the portfolio, which is the exact number this field exists to fix.
 * One extra short string per niche per channel is a cheap way to make that
 * unforgettable.
 */
export interface NicheRefDTO {
  readonly id: string;
  readonly name: string;
  readonly colorIndex: number;
  /** "production" | "watchlist". See src/lib/niches/niche-kind.ts. */
  readonly kind: NicheKind;
}

export interface NicheDTO extends NicheRefDTO {
  readonly slug: string;
  /**
   * What ONE hit in this niche pays, in minor units.
   *
   * `null` means UNCONFIGURED, exactly as the two rule columns below do: nobody
   * has said what a hit here is worth, so nothing in it can pay. It is never
   * read as zero and never falls back to the employee's own rate — the rate is
   * a property of the work, not of the person, and a niche that cannot say what
   * a hit is worth is reported before anybody finalizes a payroll run rather
   * than quietly paying nothing.
   *
   * Always `null` on a watchlist niche as far as any screen is concerned: see
   * `hitPaymentMinor` on the Prisma model and `payableRateFor` in the payroll
   * engine. A stored value is kept rather than cleared when a niche is
   * reclassified, so flipping a production niche to watchlist and back does not
   * destroy a number an admin chose — but nothing reads it while it is one.
   */
  readonly hitPaymentMinor: number | null;
  /**
   * Views required for a hit in this niche.
   *
   * `null` means UNCONFIGURED — nobody has said what a hit is here yet. It does
   * NOT mean "inherit the organization default": the app used to read it that
   * way and printed a hit rate against a number no one had chosen. A niche in
   * this state reports no hit rate at all until an Admin sets one.
   */
  readonly hitThreshold: number | null;
  /**
   * How long a Short has to reach that threshold, in hours.
   *
   * The other half of the rule, and `null` means the same thing it means above:
   * UNCONFIGURED. A niche needs both before anything in it can be scored —
   * "a million views" with no clock is the lifetime comparison this product
   * replaced, and it reported the publishing calendar as if it were quality.
   */
  readonly hitWindowHours: number | null;
  /**
   * What 1,000 views in this niche are worth, and on what basis.
   *
   * `null` MEANS WITHHELD, and only that. "Nobody has said" is a value of the
   * union itself — `{ source: "none" }` — carrying the reason why, so the two
   * can never be confused the way an unqualified null would let them be. A
   * reader who may see niche economics always gets an object; a reader who may
   * not always gets `null` and no surface for them renders the strip at all.
   *
   * WITHHELD BEHIND `finance.view`, not behind `settings.manage`. A derived
   * rate is `ChannelRevenueDay.estimatedRevenueMinor` divided by a view count —
   * it is company revenue, and multiplying it back by the view count printed
   * beside it reconstructs what an own channel earned. `GET /api/niches` and
   * `GET /api/dataset` are both gated on `analytics.view`, which every employee
   * role holds, so anything on this DTO that is not deliberately withheld is
   * published to the entire team. See `niche-rpm-disclosure.test.ts`.
   *
   * The hand-entered range is withheld on the same gate rather than a weaker
   * one: it is the studio's own commercial estimate of what a market pays, and
   * splitting the two would put a "$0.03–$0.06" beside a blank on the same card
   * and invite somebody to work out which niches earn.
   */
  readonly rpm: NicheRpmResolution | null;
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
  /**
   * Shorts carrying this tag MANUALLY — over and above what their channel gives
   * them.
   *
   * NOT "how many Shorts have this tag". That number is no longer a row count
   * and never can be: a tag on a channel reaches every Short the channel has
   * published and every one it publishes tomorrow, without a row existing for
   * any of them. Naming this `manualVideoCount` rather than leaving it as
   * `videoCount` is deliberate — the rename is what forced every reader of the
   * old field to be re-examined instead of quietly reporting a fraction of the
   * truth under the old label.
   */
  readonly manualVideoCount: number;
  /**
   * Shorts REFUSING this tag — the tombstones.
   *
   * Reported because deleting the type destroys them, and an exclusion is
   * exactly as much a human judgement as an assignment: somebody looked at a
   * Short their channel had labelled and said no. A delete that silently
   * dropped them would let the tag come back on those Shorts the moment
   * anybody re-created it.
   */
  readonly excludedVideoCount: number;
  /**
   * Channel rules that hand this tag out, across the organization.
   *
   * A content type is a tag on two different things — stretches of a channel's
   * output, and individual Shorts — so "how much is this in use?" has two
   * answers and both are reported. The two are not independent: a rule is what
   * REACHES the Shorts, and the per-Short rows above only record where a Short
   * departs from what its rules say.
   *
   * RULES, NOT CHANNELS, and the difference is real rather than pedantic: one
   * channel may legitimately carry "Ranking until March" and "Ranking again from
   * September", which is two rules and two stretches of history this tag would
   * take with it if it were deleted. Counting channels would report one and
   * understate what a delete destroys. Closed and retired rules are counted too,
   * for the same reason — they still label a back catalogue.
   */
  readonly channelRuleCount: number;
  readonly createdAt: number;
}

/**
 * One `ChannelContentTypeRule` — "everything this channel made between these
 * dates is a Funny Meme".
 *
 * THE LIVE SOURCE FOR EVERY SHORT IN ITS WINDOW, and the reason a Short's tags
 * can change without a single row being written against the Short. See
 * `src/lib/content-types/resolve.ts`, which turns a channel's rules and one
 * publish date into the inherited half of that Short's tags, for the server and
 * the browser alike.
 *
 * THE STREAK FIELDS TRAVEL TOO, and they are not decoration. A rule that retires
 * itself is indistinguishable from a bug unless the UI can say so — which needs
 * `autoClosedAt` to tell a self-retirement from somebody closing it by hand, and
 * `effectiveUntil` to say the date the channel actually changed rather than the
 * date anybody noticed. `consecutiveOverrides` is what lets a reader see a rule
 * that is one removal away from retiring, before it happens rather than after.
 */
export interface ChannelContentTypeRuleDTO {
  readonly id: string;
  /** Into `DatasetDTO.contentTypes`, like every other content-type reference. */
  readonly contentTypeId: string;
  readonly effectiveFrom: number;
  /** `null` while the rule is still claiming new uploads. */
  readonly effectiveUntil: number | null;
  readonly consecutiveOverrides: number;
  readonly overrideStreakFrom: number | null;
  /**
   * Set when the streak closed it, cleared when somebody re-opens it.
   *
   * `effectiveUntil !== null && autoClosedAt === null` is therefore a rule
   * somebody closed deliberately, which reads very differently on a channel page
   * and must not be presented as the app having decided something.
   */
  readonly autoClosedAt: number | null;
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
  /**
   * Where the figures above were actually read from — see `ChannelDataSource`.
   *
   * Derived per request from the workspace's YouTube connections rather than
   * stored on the row, and that is deliberate: the answer changes the moment a
   * grant is revoked or restored, and a stored column would go on asserting
   * "connection" about a channel nothing can read any more. Nothing about this
   * field is a preference — it is a report of what happened.
   */
  readonly dataSource: ChannelDataSource;
  /** Niches this channel is filed under. Empty means unassigned. */
  readonly niches: readonly NicheRefDTO[];
  /**
   * What the team says this channel makes, AND WHEN IT MADE IT.
   *
   * THE LIVE SOURCE FOR EVERY SHORT ON THIS CHANNEL, not merely an editorial
   * note beside them. A Short's effective tags are
   *
   *     (the rules covering its publish date − its exclusions) ∪ its manual tags
   *
   * so applying a tag to the channel reaches its whole back catalogue and
   * everything it publishes next, with nothing written per Short. See
   * `src/lib/content-types/resolve.ts`, where that is computed for both the
   * server and the browser.
   *
   * THIS REPLACES A FLAT `contentTypeIds` ARRAY, and the array was not merely
   * less expressive — it was wrong in a way that got worse the longer it was
   * right. A channel that switched format in March went on handing "Ranking" to
   * every upload after it, and the only fix available was to untag the channel,
   * which took the label off the year of rankings that genuinely were rankings.
   * A window keeps both halves of that history true at once.
   *
   * EVERY rule, including closed and retired ones. A closed rule is what makes
   * the back catalogue resolve correctly, so dropping it from the payload would
   * un-label a year of Shorts in the browser while the database still knew
   * better — and it is also the state the UI has to render to offer the one-click
   * re-open.
   */
  readonly contentTypeRules: readonly ChannelContentTypeRuleDTO[];
}

/**
 * =========================================================================
 * THE VERDICT, AS IT SHIPS
 * =========================================================================
 *
 * One `VideoHitEvaluation` row, narrowed to what a screen actually renders.
 *
 * WHY IT TRAVELS AT ALL. A hit is `hitThreshold` views reached within
 * `hitWindowHours` of publishing. The evidence for that is a snapshot series in
 * the database; the answer is worked out once by the evaluator and materialised
 * per (organization, video). The client cannot derive it — it has neither the
 * series nor any business holding one — so the answer has to come with the row.
 * Without it every dashboard number would be a lifetime comparison again, which
 * is the bug this whole change exists to remove.
 *
 * THE CLIENT MUST NOT RECOMPUTE A VERDICT FROM THIS. It reads `outcome` and
 * renders. `evaluateHit` is the only thing that decides, it runs on the server,
 * and a browser that re-derived would be a second definition with a different
 * clock — the exact fork the rule has one home to prevent.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY, because this ships for every video and
 * the app's zero-refetch property depends on the payload staying small:
 *
 *   • `windowClosesAt` — derivable exactly, and by the same arithmetic the
 *     evaluator used: `publishedAt + windowHours × 3,600,000`. See
 *     `windowClosesAt()` in the analytics engine, which is the function that
 *     produced the stored column in the first place. Shipping a timestamp whose
 *     two inputs are already on the row would be paying for a third copy.
 *   • `nicheId` — the channel already carries its niches, and no surface needs
 *     to know which of them won the tie-break. The RULE that applied is what a
 *     reader has to see, and that is right here.
 *   • `evaluatedAt` — an operational fact about the evaluator, not about the
 *     Short. It belongs in the run summary the cron logs.
 *
 * Five fields for a few thousand rows, and empty on none of them: a Short with
 * no verdict ships `hit: null` rather than an object full of nulls.
 */
export interface VideoHitDTO {
  /** "hit" | "miss" | "pending" | "unknown". Never coerced, never defaulted. */
  readonly outcome: HitOutcome;
  /**
   * The rule as it stood WHEN THE VERDICT WAS REACHED, not the niche's setting
   * today.
   *
   * Both `null` together is the unscoreable case — the Short's channel sat in
   * no niche with both halves of a rule, so the evaluator recorded "unknown"
   * with nothing to record beside it. That pair of nulls is the only way a
   * reader tells "nobody was recording during the window" apart from "nobody
   * has configured this niche", and the two send an admin to different places.
   *
   * They are also what keeps a badge honest after an admin moves a niche from
   * seven days to fourteen: February's Shorts go on showing the bar that
   * actually judged them.
   */
  readonly thresholdApplied: number | null;
  readonly windowHoursApplied: number | null;
  /**
   * What was seen inside the window, and how old the Short was when it was
   * seen.
   *
   * `null` on both for most Shorts on this account, and that is the honest
   * state rather than a gap in the payload: a miss inferred from "lifetime is
   * still under the bar" never observed anything, and only 59 of 1,904 Shorts
   * have any reading inside seven days of publishing. `observedAtHours` is the
   * field that stops a verdict overstating itself — "still short at hour 167"
   * and "still short at hour 6" are very different evidence for the same word.
   */
  readonly viewsAtWindow: number | null;
  readonly observedAtHours: number | null;
}

/**
 * A video as the client consumes it. Extends the analytics engine's own input
 * shape, so a dataset row can be handed straight to `calculateChannelMetrics`
 * with no adaptation.
 */
export interface VideoDTO extends AnalyticsVideo {
  /**
   * The stored verdict, or `null` when this Short has none yet.
   *
   * `null` is a real state, not a defect: the evaluator runs inside the sync
   * cron, so a Short discovered ten minutes ago genuinely has no answer, and
   * long-form videos never get one because a hit is a Shorts concept. Every
   * metric treats it as `unscoreable` — excluded from both halves of the rate
   * and counted where a reader can see it — rather than as a miss.
   */
  readonly hit: VideoHitDTO | null;
  /** "short" | "not_short" | "uncertain" */
  readonly classification: string;
  readonly classificationConfidence: number;
  readonly isAvailable: boolean;
  /**
   * =======================================================================
   * DEVIATIONS FROM THE CHANNEL — NOT THIS SHORT'S EFFECTIVE TAGS
   * =======================================================================
   *
   * There used to be one `contentTypeIds` array here meaning "this Short's
   * tags". That is now ambiguous, so it is gone: a Short's tags are
   *
   *     (what its publish date inherits − `excludedContentTypeIds`) ∪ `manualContentTypeIds`
   *
   * and the join is done by `resolveContentTypes` in
   * `src/lib/content-types/resolve.ts`, which both the server and the browser
   * import. Consumers resolve `ChannelDTO.contentTypeRules` against THIS row's
   * `publishedAt` first; that is what keeps the rules the LIVE source rather
   * than a thing that was copied onto these rows once — and what makes a rule
   * retiring reach every upload after the switch and none before it.
   *
   * A PRECOMPUTED EFFECTIVE LIST WOULD BE WRONG HERE, not merely redundant. It
   * would be a snapshot taken when the server assembled the payload: the client
   * re-slices this dataset in memory for the whole session without refetching,
   * so a channel tag added or removed in that time would reach nothing already
   * shipped. Two short arrays that describe only the exceptions cannot go stale
   * in that way, because they do not restate what the channel says.
   *
   * Ids, not objects, for the same reason the catalogue ships once: this is the
   * field repeated a few thousand times on the wire. And both arrays are EMPTY
   * for the overwhelming majority of Shorts — a Short that agrees with its
   * channel records nothing at all, which is the entire point.
   */
  readonly manualContentTypeIds: readonly string[];
  /** Tags this Short refuses. A tombstone survives the channel dropping the tag. */
  readonly excludedContentTypeIds: readonly string[];
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
   * Archived ones are included because a channel tag or a Short's manual row
   * can still point at them — a Short filed under a since-archived type keeps
   * its label, and a catalogue that omitted the target would render it as a
   * dangling id. The client filters to `isActive` when it offers a choice, not
   * when it renders one already made.
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
  /**
   * What share of raw views YouTube pays a Short against, in basis points.
   * 5,000 is 50.00%. See `OrganizationSettings.engagedViewShareBasisPoints`.
   *
   * HERE FOR THE EDITOR, NOT FOR THE READER. This payload is `settings.manage`,
   * which is where the value is CHANGED. Every surface that PRICES views reads
   * the same share off `NicheDTO.rpm` instead, where it is gated on
   * `finance.view` and travels welded to the rate it scales — so a card can
   * never project money with a share that arrived from somewhere else, or not
   * at all.
   */
  readonly engagedViewShareBasisPoints: number;
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
  /**
   * Which credential this particular run read with.
   *
   * On the result and not only on the channel, because the two answer different
   * questions and a refresh is exactly when they diverge: the channel says what
   * we would use, this says what was used. A run that reports
   * "connection_unavailable" read nothing at all — it refused rather than
   * falling back — and a toast saying "refreshed" over that would be the one
   * sentence on the screen that is not true.
   */
  readonly dataSource: ChannelDataSource;
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

  /**
   * A YouTube Short quoted by this note, from OUTSIDE the tracker.
   *
   * Not `targetId` and not the `video` context on `NoteWithContextDTO`: those
   * name a `Video` row this organization tracks, and this names a competitor's
   * Short that is deliberately not in the database. A note can carry both — a
   * note filed against our channel, quoting theirs, is the comparison that
   * prompted it.
   *
   * `externalVideoId` is the fact; `externalUrl` is a rendering of it that the
   * server composed from the id (see `lib/youtube-url.ts` for why it is stored
   * rather than derived here, and why the pasted string is never kept). Both
   * are null together — a half-attached Short is not a state that exists.
   */
  readonly externalVideoId: string | null;
  readonly externalUrl: string | null;
  /**
   * Best-effort metadata, and null is ordinary rather than exceptional: no Data
   * API key configured, quota spent, or a private video. The thumbnail needs no
   * lookup at all, so a titleless Short still renders as one.
   */
  readonly externalTitle: string | null;
  readonly externalChannelTitle: string | null;

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
 * One channel a connection's grant provably covers.
 *
 * WHY THIS IS A LIST AND NOT THE SINGLE `channelTitle` BELOW. A connection row
 * is keyed on exactly one channel — the one Google scoped the consent to — but
 * one Google account can own several, and `YouTubeConnectionChannel` is the
 * record of which ones this grant was actually shown to own. The admin screen
 * used to render the keyed channel alone, so an account covering three channels
 * read as an account covering one, and the two extra channels were named
 * nowhere on the screen that exists to say what a connection can reach.
 *
 * Read from stored rows rather than from Google, unlike `OwnChannelDTO`: this
 * has to be answerable for a connection whose grant has stopped working, which
 * is precisely the connection whose reader most needs to know which channels
 * went dark with it.
 *
 * IDENTITY ONLY — NO FIGURES, DELIBERATELY. This carries what names a channel
 * (title, handle, avatar, link) and nothing that measures one. Every other
 * own-channel surface pairs its numbers with `ChannelDTO.dataSource`, because a
 * `Channel` row is globally deduplicated (`youtubeChannelId @unique`, not
 * org-scoped) and `upsertChannel` writes it from whichever workspace synced
 * last — including a workspace with no connection, whose sync runs on the
 * shared public API key. A subscriber count copied out of that row onto THIS
 * card could therefore be a public-key figure sitting under a sentence about
 * this account's own authorisation, which is the one thing this feature was
 * told not to do. The card's question is "which channels does this grant
 * cover", not "how big are they" — the channels screen answers the second one,
 * with the provenance label attached.
 */
export interface YouTubeConnectionChannelDTO {
  readonly youtubeChannelId: string;
  /**
   * Null when the coverage row was written without one and the channel has
   * never been synced. Rendered as the stated absence it is rather than as an
   * invented name.
   */
  readonly title: string | null;
  readonly handle: string | null;
  readonly avatarUrl: string | null;
  readonly channelUrl: string;
  /**
   * True for the one channel the connection ROW is keyed on — the channel the
   * account was connected as, and the only one a fresh connection has.
   */
  readonly isPrimary: boolean;
  /**
   * When Google last confirmed this grant covers this channel, epoch ms.
   *
   * Null for a channel known only from the connection's own column, which is
   * the state of every connection a deployment made before the coverage table
   * existed and the backfill did not reach. Null therefore means "not recorded",
   * never "not confirmed".
   */
  readonly confirmedAt: number | null;
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
  /**
   * The ONE channel this connection row is keyed on. Kept because the unique
   * key and every Analytics call are built on it — but it is not the answer to
   * "which channels does this account cover", which is `coveredChannels`.
   */
  readonly channelTitle: string | null;
  readonly youtubeChannelId: string | null;
  /**
   * Every channel this grant covers, primary first, then in the order Google
   * confirmed them.
   *
   * Deduplicated on the YouTube id: the primary channel is normally BOTH the
   * connection's own column and a coverage row, because
   * `linkConnectionToTrackedChannel` writes the two in consecutive statements,
   * and listing it twice would read as two channels.
   *
   * Empty is a real and honest state — an account can authorise access and own
   * no channel — so the screen states that rather than showing a blank area
   * under a green "connected" badge.
   */
  readonly coveredChannels: readonly YouTubeConnectionChannelDTO[];
  /**
   * Space-separated scopes Google actually granted. Surfaced so a downgraded
   * grant (the user unticking a box on the consent screen) is visible here
   * rather than as an opaque 403 during the next sync.
   */
  readonly scope: string;
  /** "connected" | "needs_reauth" | "revoked" */
  readonly status: string;
  readonly lastError: string | null;
  /**
   * The last time this connection was used successfully for ANYTHING — a
   * channel sync or a revenue read.
   *
   * It used to be written only by a successful revenue report, which made
   * "Never synced" the permanent reading for any connection without the
   * monetary scope, however well its channel was syncing. Both halves that
   * spend the grant now write it, so the field means what its label says.
   */
  readonly lastSyncAt: number | null;
  /**
   * "never" | "ok" | "error" — the last CHANNEL/VIDEO sync through this
   * connection, as distinct from `status`.
   *
   * `status` is about the grant ("Google will not honour these credentials");
   * this is about the run (channel deleted, quota exhausted, a 403 that is not
   * a dead token). Kept apart so a screen never tells somebody to reconnect a
   * working account because a channel was deleted.
   */
  readonly channelSyncStatus: string;
  readonly channelSyncError: string | null;
  readonly lastChannelSyncAt: number | null;
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
  /**
   * Whether the configured credentials LOOK like Google credentials.
   *
   * "Configured" only ever meant "the variable is non-empty", which is a much
   * weaker claim than it reads as: a secret pasted with its surrounding quotes,
   * or with `GOOGLE_CLIENT_SECRET=` still attached, or a value replaced in the
   * Google console months ago, all satisfy it. Every one of those then fails at
   * the very END of the consent flow — Google builds the consent screen from
   * the client id alone, so the approval looks perfect and only the exchange
   * behind it is refused.
   *
   * That left no way to inspect what the deployment actually holds. This is
   * that way. It reports shape only, never the value.
   */
  readonly credentials: readonly CredentialShapeDTO[];
}

/**
 * A described-but-never-disclosed credential.
 *
 * Safe to serialise to an admin screen: the length of a secret and the fixed
 * vendor prefix every Google secret shares (`GOCSPX-`) narrow nothing, and the
 * problems listed are about punctuation the person accidentally included. The
 * VALUE is never carried on this object, so no future consumer can render it by
 * accident.
 */
export interface CredentialShapeDTO {
  /** The environment variable, so the fix names the thing to edit. */
  readonly name: string;
  readonly present: boolean;
  readonly length: number;
  /**
   * The leading characters, only ever from a fixed, non-secret vendor prefix
   * (`GOCSPX-`) — and empty unless the value starts with one. A value that does
   * NOT begin with a known prefix has nothing shown, because there the leading
   * characters would be secret material rather than a vendor constant.
   */
  readonly prefix: string;
  /** Plain-English problems detected in the shape. Empty means it looks right. */
  readonly problems: readonly string[];
}

/**
 * =========================================================================
 * A CHANNEL THE CONNECTED ACCOUNT OWNS, OFFERED FOR ADDING
 * =========================================================================
 *
 * The owner asked for this by name in an earlier round and again in this one:
 * after connecting, their own channels should be discoverable and addable
 * WITHOUT anybody pasting a channel id. Pasting an id to add a channel Google
 * has just told us the account owns is asking the person to prove something the
 * app already knows — and it is the one step where a typo silently tracks
 * somebody else's channel as your own.
 *
 * Read live from `channels?mine=true` on the connection's own token rather than
 * from a stored table, so a channel created since the connection was made shows
 * up without a reconnection, and a channel that left the account stops being
 * offered. That is also why there is no id of our own on this type: until it is
 * added there is no `TrackedChannel` row for it to have one.
 */
export interface OwnChannelDTO {
  /** Which connection reported it — the account whose grant will read it. */
  readonly connectionId: string;
  readonly googleAccountEmail: string | null;
  readonly youtubeChannelId: string;
  readonly title: string;
  readonly handle: string | null;
  readonly avatarUrl: string | null;
  /** `null` when the channel hides it, exactly as everywhere else. */
  readonly subscriberCount: number | null;
  readonly hiddenSubscriberCount: boolean;
  readonly videoCount: number | null;
  /** Already in this workspace's tracker and active. */
  readonly alreadyTracked: boolean;
  /**
   * Tracked once and removed since. Adding restores the row and every Short and
   * snapshot collected before, rather than starting the history again.
   */
  readonly previouslyRemoved: boolean;
  /**
   * Tracked, but filed as a competitor.
   *
   * A real and slightly embarrassing state: somebody added their own channel by
   * pasting a link before the account was ever connected, and it took the
   * default. Worth naming because adding it from here does not create anything —
   * it corrects the label, which is what makes the channel start reading through
   * the connection.
   */
  readonly trackedAsCompetitor: boolean;
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
