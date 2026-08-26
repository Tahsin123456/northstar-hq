import type {
  ApiErrorDTO,
  ChannelDTO,
  ChannelPreviewDTO,
  DatasetDTO,
  CollectionDTO,
  ExcludedVideoDTO,
  GoogleOAuthStatusDTO,
  NicheDTO,
  NoteDTO,
  NoteTargetType,
  NoteWithContextDTO,
  OwnershipType,
  SavedShortDTO,
  RefreshResultDTO,
  RuntimeConfigDTO,
  SettingsDTO,
  YouTubeConnectionDTO,
} from "@/lib/dto";
import type {
  ExchangeRateDTO,
  FinanceCategoryDTO,
  FinanceEntryDTO,
  FinanceKind,
} from "@/lib/finance/types";

/**
 * Response and input types imported straight from the services that produce
 * them.
 *
 * `import type` is erased before anything is bundled, so pulling a shape out of
 * a `server-only` module adds no server code to the browser — the same trick
 * `session-provider.tsx` already plays with `ActorDTO`. The point is that these
 * are not a second, hand-copied description of the payload: if a field on
 * `AdminUserDTO` or `FinanceOverview` changes, this client stops compiling
 * rather than quietly returning a lie.
 */
import type {
  AdminDirectory,
  AdminOverview,
  AdminUserDTO,
  GrantsResult,
  InviteResult,
  RevokedInvitation,
} from "@/server/services/admin-service";
import type { AuditPage } from "@/server/audit/audit-service";
import type {
  FinanceEntryCreateInput,
  FinanceEntryUpdateInput,
  FinanceOverview,
} from "@/server/services/finance-service";

/**
 * Typed client for this app's own API.
 *
 * Its real job is turning the server's `{ error: { code, message } }` envelope
 * into a thrown `ApiError` carrying a message written for a person. Components
 * can then render `error.message` directly and be certain it is never a stack
 * trace, a Prisma exception or a raw Google API payload — those were filtered
 * out server-side and never crossed the wire.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** True when the fix is configuration rather than a retry. */
  get isConfiguration(): boolean {
    return this.code === "MISSING_API_KEY";
  }

  get isQuota(): boolean {
    return this.code === "QUOTA_EXCEEDED" || this.code === "RATE_LIMITED";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      ...init,
      // Belt and braces with the server's no-store header: this data is the
      // user's live tracker state and must never come from a cache.
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    // The request never reached the server — offline, DNS, dev server down.
    throw new ApiError(
      "NETWORK_ERROR",
      "Could not reach the server. Check that the app is still running and try again.",
      0,
    );
  }

  if (!response.ok) {
    let body: ApiErrorDTO | null = null;
    try {
      body = (await response.json()) as ApiErrorDTO;
    } catch {
      body = null;
    }

    throw new ApiError(
      body?.error?.code ?? "INTERNAL_ERROR",
      body?.error?.message ?? "Something went wrong. Try again in a moment.",
      response.status,
      body?.error?.details,
    );
  }

  return (await response.json()) as T;
}

/**
 * Builds a query string from optional filters, dropping anything unset.
 *
 * Written once rather than interpolated per-endpoint because `undefined` in a
 * template literal becomes the *string* "undefined", which the server would
 * then dutifully treat as a filter — a request that looks fine and silently
 * returns nothing. The admin and finance reads take up to six optional
 * parameters each, so that mistake had six places to happen.
 */
function queryString(
  params: Record<string, string | number | undefined | null>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

// ---------------------------------------------------------------------------
// REQUEST SHAPES
//
// Bodies and filters the server validates with Zod. Where the service exports
// the inferred type (`FinanceEntryCreateInput`) it is imported above rather
// than restated; the ones below have no exported counterpart, because inferring
// them would mean importing the *schema value* — real server code — into the
// browser bundle. Each mirrors the schema named in its comment.
// ---------------------------------------------------------------------------

/** Filters for GET /api/admin/audit. `limit` and `offset` are clamped server-side. */
export interface AuditLogQuery {
  readonly limit?: number;
  readonly offset?: number;
  /** An exact action, e.g. "auth.signed_out". */
  readonly action?: string;
  /** A whole family, e.g. "finance." — mutually useful with, not exclusive of, `action`. */
  readonly actionPrefix?: string;
  readonly actorUserId?: string;
}

/**
 * The window a finance read covers — `financeQuerySchema` in finance-service.
 *
 * Send `startMs`/`endMs` for an explicit window, or `days` for a trailing one.
 * With none of them the server falls back to the organization's default period,
 * which is the honest default for a first render but not something a screen
 * showing a date range should rely on.
 */
export interface FinanceRangeQuery {
  readonly startMs?: number;
  readonly endMs?: number;
  readonly days?: number;
}

export interface FinanceEntriesQuery extends FinanceRangeQuery {
  readonly kind?: FinanceKind;
  readonly channelId?: string;
  readonly categoryId?: string;
}

/** POST /api/finance/categories — `financeCategoryCreateSchema`. */
export interface FinanceCategoryInput {
  readonly kind: FinanceKind;
  readonly name: string;
  readonly sortOrder?: number;
}

/**
 * PATCH /api/finance/categories/:id — `financeCategoryUpdateSchema`.
 *
 * Rename and archive only. `sortOrder` is absent on purpose: the route does not
 * write it, and a field accepted but ignored is worse than one rejected.
 */
export interface FinanceCategoryPatch {
  readonly name?: string;
  readonly isArchived?: boolean;
}

/** One row of PUT /api/finance/rates — `exchangeRateInputSchema`. */
export interface ExchangeRateInput {
  readonly fromCurrency: string;
  /** Defaults server-side to the organization's base currency, the only pair conversion uses. */
  readonly toCurrency?: string;
  readonly rate: number;
  /** "manual" unless a provider supplied it. */
  readonly source?: string;
}

/** PATCH /api/admin/users/:id — `updateMemberSchema`. */
export interface MemberUpdate {
  readonly role?: string;
  /**
   * "invited" is deliberately not settable: it describes an account that has
   * never chosen a password, and moving somebody back to it would produce a
   * login nobody can complete.
   */
  readonly status?: "active" | "deactivated";
}

export const api = {
  /** The full tracker payload. Every filter is derived from this client-side. */
  getDataset: (): Promise<DatasetDTO> => request<DatasetDTO>("/api/dataset"),

  listChannels: (includeRemoved = false): Promise<{ channels: ChannelDTO[] }> =>
    request(`/api/channels?includeRemoved=${includeRemoved}`),

  resolveChannel: (input: string): Promise<ChannelPreviewDTO> =>
    request("/api/channels/resolve", {
      method: "POST",
      body: JSON.stringify({ input }),
    }),

  addChannel: (payload: {
    input: string;
    ownershipType?: OwnershipType;
    nicheIds?: readonly string[];
  }): Promise<{ channel: ChannelDTO; restored: boolean; sync: RefreshResultDTO }> =>
    request("/api/channels", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // --- Niches ---

  listNiches: (): Promise<{ niches: NicheDTO[] }> => request("/api/niches"),

  createNiche: (name: string): Promise<{ niche: NicheDTO }> =>
    request("/api/niches", { method: "POST", body: JSON.stringify({ name }) }),

  renameNiche: (id: string, name: string): Promise<{ niche: NicheDTO }> =>
    request(`/api/niches/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),

  /** `null` clears the override and returns the niche to the account default. */
  setNicheThreshold: (
    id: string,
    hitThreshold: number | null,
  ): Promise<{ niche: NicheDTO }> =>
    request(`/api/niches/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ hitThreshold }),
    }),

  deleteNiche: (id: string): Promise<{ unassignedChannels: number }> =>
    request(`/api/niches/${id}`, { method: "DELETE" }),

  setChannelNiches: (
    channelId: string,
    nicheIds: readonly string[],
  ): Promise<{ channel: ChannelDTO }> =>
    request(`/api/channels/${channelId}/niches`, {
      method: "PUT",
      body: JSON.stringify({ nicheIds }),
    }),

  setChannelOwnership: (
    channelId: string,
    ownershipType: OwnershipType,
  ): Promise<{ channel: ChannelDTO }> =>
    request(`/api/channels/${channelId}`, {
      method: "PATCH",
      body: JSON.stringify({ ownershipType }),
    }),

  renameChannel: (id: string, label: string | null): Promise<{ channel: ChannelDTO }> =>
    request(`/api/channels/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ label }),
    }),

  removeChannel: (id: string): Promise<{ channel: ChannelDTO }> =>
    request(`/api/channels/${id}`, { method: "DELETE" }),

  restoreChannel: (id: string): Promise<{ channel: ChannelDTO }> =>
    request(`/api/channels/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "restore" }),
    }),

  refreshChannel: (id: string): Promise<{ result: RefreshResultDTO }> =>
    request(`/api/channels/${id}/refresh`, { method: "POST" }),

  refreshAll: (
    force = false,
  ): Promise<{
    results: RefreshResultDTO[];
    refreshed: number;
    failed: number;
    quotaUnitsUsed: number;
  }> =>
    request("/api/refresh", {
      method: "POST",
      body: JSON.stringify({ force }),
    }),

  getExcludedVideos: (
    id: string,
    range?: { startMs: number; endMs: number },
  ): Promise<{ videos: ExcludedVideoDTO[] }> => {
    const params = range ? `?startMs=${range.startMs}&endMs=${range.endMs}` : "";
    return request(`/api/channels/${id}/excluded${params}`);
  },

  // --- History ---

  getHistoricalViews: (
    asOfMs: number,
    windowDays: number,
  ): Promise<{
    asOfMs: number;
    available: boolean;
    coverage: number;
    totalInWindow: number;
    covered: number;
    earliestSnapshotMs: number | null;
    videos: Array<{
      id: string;
      channelId: string;
      publishedAt: number;
      views: number;
      isShort: boolean;
    }>;
  }> =>
    request(`/api/history/views-as-of?asOfMs=${asOfMs}&windowDays=${windowDays}`),

  // --- Notes ---

  listNotes: (
    targetType: NoteTargetType,
    targetId: string,
  ): Promise<{ notes: NoteDTO[] }> =>
    request(`/api/notes?targetType=${targetType}&targetId=${encodeURIComponent(targetId)}`),

  listAllNotes: (): Promise<{ notes: NoteWithContextDTO[] }> => request("/api/notes/all"),

  createNote: (payload: {
    targetType: NoteTargetType;
    targetId: string;
    body: string;
  }): Promise<{ note: NoteDTO }> =>
    request("/api/notes", { method: "POST", body: JSON.stringify(payload) }),

  updateNote: (id: string, body: string): Promise<{ note: NoteDTO }> =>
    request(`/api/notes/${id}`, { method: "PATCH", body: JSON.stringify({ body }) }),

  deleteNote: (id: string): Promise<{ ok: boolean }> =>
    request(`/api/notes/${id}`, { method: "DELETE" }),

  // --- Collections ---

  listCollections: (): Promise<{ collections: CollectionDTO[] }> =>
    request("/api/collections"),

  createCollection: (name: string): Promise<{ collection: CollectionDTO }> =>
    request("/api/collections", { method: "POST", body: JSON.stringify({ name }) }),

  renameCollection: (id: string, name: string): Promise<{ collection: CollectionDTO }> =>
    request(`/api/collections/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),

  deleteCollection: (id: string): Promise<{ removedItems: number }> =>
    request(`/api/collections/${id}`, { method: "DELETE" }),

  // --- Saved Shorts ---

  listSaved: (): Promise<{ saved: SavedShortDTO[] }> => request("/api/saved"),

  saveShort: (payload: {
    videoId: string;
    channelMedianAtSave?: number | null;
    outlierMultipleAtSave?: number | null;
    collectionIds?: readonly string[];
  }): Promise<{ saved: SavedShortDTO }> =>
    request("/api/saved", { method: "POST", body: JSON.stringify(payload) }),

  unsaveShort: (videoId: string): Promise<{ ok: boolean }> =>
    request(`/api/saved/${videoId}`, { method: "DELETE" }),

  setSavedCollections: (
    videoId: string,
    collectionIds: readonly string[],
  ): Promise<{ saved: SavedShortDTO }> =>
    request(`/api/saved/${videoId}`, {
      method: "PUT",
      body: JSON.stringify({ collectionIds }),
    }),

  getSettings: (): Promise<{ settings: SettingsDTO; config: RuntimeConfigDTO }> =>
    request("/api/settings"),

  updateSettings: (update: Partial<SettingsDTO>): Promise<{ settings: SettingsDTO }> =>
    request("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(update),
    }),

  // --- Admin: the directory ---

  getAdminOverview: (): Promise<AdminOverview> => request("/api/admin/overview"),

  /**
   * Members and outstanding invitations, in two arrays.
   *
   * They stay separate because an invitation has no account behind it — nothing
   * to deactivate, no sessions, no role to change in place — and flattening the
   * two would put controls on a row that cannot answer them.
   */
  listAdminUsers: (): Promise<AdminDirectory> => request("/api/admin/users"),

  /**
   * The response carries `inviteUrl` exactly once, and on purpose: with no mail
   * provider configured, handing that link over by other means is the
   * documented path rather than a degraded one. Check `emailSent` and
   * `emailConfigured` to know which sentence to show.
   */
  inviteMember: (payload: {
    email: string;
    name?: string;
    role: string;
  }): Promise<InviteResult> =>
    request("/api/admin/users/invite", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  updateMember: (id: string, update: MemberUpdate): Promise<{ user: AdminUserDTO }> =>
    request(`/api/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(update),
    }),

  /**
   * Replaces the member's individual grants with exactly this set.
   *
   * PUT because the UI is a checklist: sending the whole set means the server's
   * answer is whatever the admin last saw, with no chance of a lost tick from
   * two half-applied requests.
   */
  setMemberGrants: (
    id: string,
    permissions: readonly string[],
  ): Promise<GrantsResult> =>
    request(`/api/admin/users/${id}/grants`, {
      method: "PUT",
      body: JSON.stringify({ permissions }),
    }),

  revokeInvitation: (id: string): Promise<{ invitation: RevokedInvitation }> =>
    request(`/api/admin/invitations/${id}`, { method: "DELETE" }),

  // --- Admin: the audit trail ---

  getAuditLog: (query: AuditLogQuery = {}): Promise<AuditPage> =>
    request(`/api/admin/audit${queryString({ ...query })}`),

  // --- Finance ---

  /** The whole Finance dashboard — totals, series, per-channel table, ledger. */
  getFinanceOverview: (query: FinanceRangeQuery = {}): Promise<FinanceOverview> =>
    request(`/api/finance/overview${queryString({ ...query })}`),

  /**
   * The ledger alone, filtered server-side.
   *
   * `truncated` is part of the payload rather than a detail to swallow: the
   * caller sums this array for its own totals, so it has to know when the array
   * is not the whole period. Render the warning; do not render a confident
   * understated number.
   */
  listFinanceEntries: (
    query: FinanceEntriesQuery = {},
  ): Promise<{ entries: FinanceEntryDTO[]; truncated: boolean }> =>
    request(`/api/finance/entries${queryString({ ...query })}`),

  createFinanceEntry: (
    payload: FinanceEntryCreateInput,
  ): Promise<{ entry: FinanceEntryDTO }> =>
    request("/api/finance/entries", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  /**
   * Changing the amount or currency re-converts at today's rate; changing
   * anything else leaves the stored conversion alone, so fixing a typo in a
   * note cannot move a historical figure.
   */
  updateFinanceEntry: (
    id: string,
    patch: FinanceEntryUpdateInput,
  ): Promise<{ entry: FinanceEntryDTO }> =>
    request(`/api/finance/entries/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deleteFinanceEntry: (id: string): Promise<{ id: string }> =>
    request(`/api/finance/entries/${id}`, { method: "DELETE" }),

  /** Archived categories are included — they are how old entries keep their label. */
  listFinanceCategories: (): Promise<{ categories: FinanceCategoryDTO[] }> =>
    request("/api/finance/categories"),

  createFinanceCategory: (
    payload: FinanceCategoryInput,
  ): Promise<{ category: FinanceCategoryDTO }> =>
    request("/api/finance/categories", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  updateFinanceCategory: (
    id: string,
    patch: FinanceCategoryPatch,
  ): Promise<{ category: FinanceCategoryDTO }> =>
    request(`/api/finance/categories/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  listExchangeRates: (): Promise<{ rates: ExchangeRateDTO[] }> =>
    request("/api/finance/rates"),

  /**
   * Sets the whole table in one request.
   *
   * The rates screen saves every row it shows together — a currency table
   * edited a cell at a time would leave the ledger half-converted between
   * saves. Existing entries are untouched either way: each stored the rate it
   * was converted at, so historical totals stay as they were reported.
   */
  setExchangeRates: (
    rates: readonly ExchangeRateInput[],
  ): Promise<{ rates: ExchangeRateDTO[] }> =>
    request("/api/finance/rates", {
      method: "PUT",
      body: JSON.stringify({ rates }),
    }),

  // --- YouTube connections ---

  /**
   * The connected Google accounts, plus whether this deployment can offer the
   * connect button at all. One response because the screen renders one of two
   * entirely different states, and a second round trip would show the wrong one
   * first.
   *
   * Starting a connection is not here: /api/youtube/connect answers with a 302
   * to Google's consent screen, which a fetch cannot follow. See
   * `YOUTUBE_CONNECT_PATH` in use-youtube-connections.ts.
   */
  listYouTubeConnections: (): Promise<{
    connections: readonly YouTubeConnectionDTO[];
    google: GoogleOAuthStatusDTO;
  }> => request("/api/youtube/connections"),

  /**
   * `revokedAtGoogle` is false when Google could not be reached. The local
   * tokens are gone either way, but the grant may still be standing in the
   * account's own security settings — say so rather than reporting a clean
   * disconnection.
   */
  disconnectYouTube: (
    id: string,
  ): Promise<{ ok: boolean; revokedAtGoogle: boolean }> =>
    request(`/api/youtube/connections/${id}`, { method: "DELETE" }),

  // --- Auth ---

  /** Always succeeds server-side: signing out when already signed out is not an error. */
  logout: (): Promise<{ ok: boolean }> =>
    request("/api/auth/logout", { method: "POST" }),
};
