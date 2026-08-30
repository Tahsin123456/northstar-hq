import { AppError, errors } from "@/server/errors";
import { env, requireYouTubeApiKey } from "@/server/env";
import { parseIsoDuration } from "./parse-duration";
import type {
  RawApiErrorBody,
  RawChannelItem,
  RawListResponse,
  RawPlaylistItem,
  RawThumbnails,
  RawVideoItem,
  UploadsPlaylistEntry,
  YouTubeChannel,
  YouTubeVideo,
} from "./types";

const API_BASE = "https://www.googleapis.com/youtube/v3";

/**
 * Documented quota cost per endpoint, in units. The default daily allowance is
 * 10,000. Note `search.list` at 100 — 100x the alternatives — which is why the
 * video pipeline walks the uploads playlist instead and why the resolver only
 * falls back to search when nothing cheaper can identify a channel.
 */
export const QUOTA_COST = {
  channelsList: 1,
  playlistItemsList: 1,
  videosList: 1,
  searchList: 100,
} as const;

/**
 * Running total of quota spent by one logical operation (e.g. "refresh this
 * channel"), so a refresh can record what it actually cost and the UI can show
 * it. Not a limiter — an accountant.
 */
export class QuotaLedger {
  private spent = 0;
  private readonly breakdown = new Map<string, number>();

  charge(endpoint: keyof typeof QUOTA_COST): void {
    const cost = QUOTA_COST[endpoint];
    this.spent += cost;
    this.breakdown.set(endpoint, (this.breakdown.get(endpoint) ?? 0) + cost);
  }

  get total(): number {
    return this.spent;
  }

  toJSON(): { total: number; breakdown: Record<string, number> } {
    return { total: this.spent, breakdown: Object.fromEntries(this.breakdown) };
  }
}

/**
 * =========================================================================
 * WHO IS ASKING — THE SHARED KEY, OR ONE CHANNEL'S OWNER
 * =========================================================================
 *
 * Every call in this file used to authenticate the same way: the shared
 * `YOUTUBE_API_KEY`, which reads public data about anybody. That is still the
 * only way to see a competitor, and nothing about competitors changes.
 *
 * It is NOT how Northstar's own channels should be read. The owner was explicit
 * that their own channels' data must come from the account they connected and
 * not from an external key, and they are right on the merits as well: a request
 * carrying the channel owner's own grant is the authoritative reading, it is not
 * limited to what YouTube shows the public, and it is charged to the OAuth
 * client's own project rather than to the key every competitor refresh is also
 * spending.
 *
 * (Charged to that project, note — not to nobody. Data API quota belongs to a
 * Google Cloud project, so whether these units come out of the same 10,000 as
 * the API key depends entirely on whether the key and the OAuth client were
 * created in the same project. The ledger therefore goes on counting them: they
 * are real units, and a refresh that reports a cost of zero because it happened
 * to use a bearer token would be lying about what it spent.)
 *
 * A credential is a plain access token plus the connection it came from. It is
 * resolved by the CALLER — `channel-sync.ts`, from `resolveChannelCredential` —
 * and never by this module: deciding which channels are ours is a question about
 * one organization's tracker, and a fetch client that answered it would need a
 * tenancy it has no business holding.
 */
export interface YouTubeCredential {
  /** A live access token. Minted and refreshed by `youtube-oauth-service`. */
  readonly accessToken: string;
  /** Which connection it came from, for error messages that name the account. */
  readonly connectionId: string;
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;
const REQUEST_TIMEOUT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Maps a Google API error envelope onto the app's error taxonomy.
 *
 * The important distinction is `quotaExceeded` (daily allowance gone — retrying
 * is useless and rude, surface it and stop) versus `rateLimitExceeded`
 * (momentary throttle — back off and retry). Both arrive as HTTP 403, so the
 * reason string is the only way to tell them apart.
 */
function mapApiError(
  status: number,
  body: RawApiErrorBody | null,
  authorisedByConnection: boolean,
): AppError {
  const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? "";
  const upstreamMessage = body?.error?.message ?? `HTTP ${status}`;

  /**
   * A dead bearer token, which only a connection-authorised call can produce.
   *
   * Mapped explicitly, and to a NON-retryable code, because the default branch
   * below would treat it as UPSTREAM_ERROR and retry it three times with
   * backoff — three identical rejections and a second of sleep to learn what
   * the first one already said. `MISSING_API_KEY` is this codebase's "correctly
   * built, not yet authorised" code (503 with a setup message) rather than a
   * fault, which is exactly what a grant that needs re-consenting is.
   */
  if (status === 401 && authorisedByConnection) {
    return new AppError(
      // NOT_CONFIGURED and deliberately NOT `MISSING_API_KEY`, which is in the
      // scheduled sweep's RUN_ENDING_CODES. That set exists for failures every
      // REMAINING channel would share — a bad shared key, a spent quota — and a
      // dead grant is the opposite: it belongs to exactly one channel, and the
      // competitor refreshes queued behind it are completely unaffected. Ending
      // the run here would let one expired connection freeze the whole tracker.
      "NOT_CONFIGURED",
      "Google rejected this channel's connection while reading it. The account needs to be " +
        "reconnected from Admin → YouTube before this channel can be synced again.",
      { internalMessage: `YouTube 401 (${reason}) on a connection-authorised call: ${upstreamMessage}` },
    );
  }

  if (status === 403) {
    if (/quotaExceeded|dailyLimitExceeded/i.test(reason)) return errors.quotaExceeded();
    if (/rateLimitExceeded|userRateLimitExceeded/i.test(reason)) return errors.rateLimited();
    /**
     * A refused grant, told apart from a refused key by which one we sent.
     *
     * The branch below names the API key and tells the reader to go and check
     * it — advice that would send somebody auditing a key that was not involved
     * in the request at all. The two failures have completely different fixes
     * (re-consent versus fix the key), so the discriminator is the credential
     * this call actually carried, which is a fact rather than an inference.
     */
    if (authorisedByConnection) {
      return new AppError(
        // Per-channel, not run-ending — same reasoning as the 401 above.
        "NOT_CONFIGURED",
        "Google refused to read this channel with the connected account's authorisation. " +
          "Reconnect the account from Admin → YouTube, leaving every permission ticked.",
        { internalMessage: `YouTube 403 (${reason}) on a connection-authorised call: ${upstreamMessage}` },
      );
    }

    if (/keyInvalid|badRequest|forbidden|accessNotConfigured|API_KEY/i.test(reason + upstreamMessage)) {
      return new AppError(
        "MISSING_API_KEY",
        "The YouTube API rejected this API key. Check that the key is correct, that YouTube Data API v3 is enabled for its project, and that any key restrictions allow server-side use.",
        { internalMessage: `YouTube 403 (${reason}): ${upstreamMessage}` },
      );
    }
    return new AppError("FORBIDDEN", "YouTube refused this request.", {
      internalMessage: `YouTube 403 (${reason}): ${upstreamMessage}`,
    });
  }

  if (status === 429) return errors.rateLimited();

  if (status === 404) {
    return new AppError("CHANNEL_NOT_FOUND", "YouTube has no record of that resource.", {
      internalMessage: `YouTube 404: ${upstreamMessage}`,
    });
  }

  if (status === 400) {
    return new AppError(
      "INVALID_INPUT",
      "YouTube rejected the request as malformed. This usually means the channel or video identifier is not valid.",
      { internalMessage: `YouTube 400 (${reason}): ${upstreamMessage}` },
    );
  }

  return new AppError("UPSTREAM_ERROR", "YouTube returned an unexpected error. Try again shortly.", {
    internalMessage: `YouTube ${status} (${reason}): ${upstreamMessage}`,
  });
}

function isRetryable(error: AppError): boolean {
  // Daily quota is not retryable — it will not recover for hours.
  return (
    error.code === "RATE_LIMITED" ||
    error.code === "UPSTREAM_ERROR" ||
    error.code === "NETWORK_ERROR"
  );
}

/**
 * Single place where an outbound YouTube Data API call happens.
 *
 * `credential` decides how it is authorised, and it is one or the other rather
 * than both: sending a bearer token AND a `key` parameter makes Google's
 * behaviour depend on which it decides to honour, which is not a thing to leave
 * to chance on a request whose whole point is *whose* authority it carries.
 * `requireYouTubeApiKey()` is therefore called only on the key path — so a
 * deployment that has connected an account but never set a shared key can still
 * read its own channels, which is precisely the setup the owner described.
 */
async function apiRequest<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  ledger: QuotaLedger | undefined,
  endpoint: keyof typeof QUOTA_COST,
  credential?: YouTubeCredential,
): Promise<T> {
  const url = new URL(`${API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  if (!credential) url.searchParams.set("key", requireYouTubeApiKey());

  const headers: Record<string, string> = { Accept: "application/json" };
  // In the header, never the query string: URLs reach access logs and error
  // reports, and this one is a live credential. Same rule as the Analytics
  // client in youtube-revenue-service.ts.
  if (credential) headers.Authorization = `Bearer ${credential.accessToken}`;

  let lastError: AppError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers,
        cache: "no-store",
      });

      // The quota is charged by Google on receipt, whether or not we like the
      // answer — so record it before branching on status.
      ledger?.charge(endpoint);

      if (response.ok) {
        return (await response.json()) as T;
      }

      let body: RawApiErrorBody | null = null;
      try {
        body = (await response.json()) as RawApiErrorBody;
      } catch {
        body = null;
      }

      lastError = mapApiError(response.status, body, credential !== undefined);
      if (!isRetryable(lastError) || attempt === MAX_ATTEMPTS) throw lastError;
    } catch (caught) {
      if (caught instanceof AppError) {
        lastError = caught;
        if (!isRetryable(caught) || attempt === MAX_ATTEMPTS) throw caught;
      } else if (caught instanceof Error && caught.name === "AbortError") {
        lastError = new AppError("NETWORK_ERROR", "The request to YouTube timed out.", {
          cause: caught,
        });
        if (attempt === MAX_ATTEMPTS) throw lastError;
      } else {
        lastError = errors.network(caught);
        if (attempt === MAX_ATTEMPTS) throw lastError;
      }
    } finally {
      clearTimeout(timeout);
    }

    // Exponential backoff with jitter, so parallel refreshes do not resynchronise.
    const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);
    await sleep(backoff + Math.floor(Math.random() * 200));
  }

  throw lastError ?? errors.internal();
}

// --- Normalisation helpers -------------------------------------------------

/** Largest available thumbnail, preferring quality over guaranteed presence. */
function pickThumbnail(thumbnails: RawThumbnails | undefined): string | null {
  if (!thumbnails) return null;
  return (
    thumbnails.maxres?.url ??
    thumbnails.standard?.url ??
    thumbnails.high?.url ??
    thumbnails.medium?.url ??
    thumbnails.default?.url ??
    null
  );
}

/**
 * YouTube statistics arrive as strings, and are *omitted entirely* when hidden
 * (subscriber counts) or disabled (comments). `null` preserves that difference;
 * coercing to 0 would silently claim "zero subscribers".
 */
function parseCount(value: string | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Extracts width/height from `player.embedHtml`.
 *
 * Requested with `maxHeight`, YouTube sizes the embed iframe to the video's
 * real aspect ratio, which is the only aspect-ratio signal the Data API offers.
 * It is used as *corroborating* evidence by the Shorts classifier, never alone.
 */
function parsePlayerDimensions(
  player: RawVideoItem["player"],
): { width: number | null; height: number | null } {
  if (!player) return { width: null, height: null };

  const direct = {
    width: typeof player.embedWidth === "string" ? Number(player.embedWidth) : player.embedWidth,
    height: typeof player.embedHeight === "string" ? Number(player.embedHeight) : player.embedHeight,
  };
  if (Number.isFinite(direct.width) && Number.isFinite(direct.height)) {
    return { width: Number(direct.width), height: Number(direct.height) };
  }

  const html = player.embedHtml;
  if (!html) return { width: null, height: null };
  const width = /width="(\d+)"/.exec(html)?.[1];
  const height = /height="(\d+)"/.exec(html)?.[1];
  return {
    width: width ? Number(width) : null,
    height: height ? Number(height) : null,
  };
}

function normalizeChannel(item: RawChannelItem): YouTubeChannel | null {
  const channelId = item.id;
  if (!channelId) return null;

  const customUrl = item.snippet?.customUrl ?? null;
  // `customUrl` is the modern handle for essentially every channel, but legacy
  // vanity URLs live in the same field without the `@`.
  const handle = customUrl
    ? customUrl.startsWith("@")
      ? customUrl
      : `@${customUrl}`
    : null;

  return {
    channelId,
    title: item.snippet?.title?.trim() || "Untitled channel",
    description: item.snippet?.description ?? "",
    handle,
    customUrl,
    avatarUrl: pickThumbnail(item.snippet?.thumbnails),
    bannerUrl: item.brandingSettings?.image?.bannerExternalUrl ?? null,
    country: item.snippet?.country ?? null,
    subscriberCount: parseCount(item.statistics?.subscriberCount),
    hiddenSubscriberCount: item.statistics?.hiddenSubscriberCount === true,
    viewCount: parseCount(item.statistics?.viewCount),
    videoCount: parseCount(item.statistics?.videoCount),
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
    publishedAt: item.snippet?.publishedAt ? new Date(item.snippet.publishedAt) : null,
  };
}

function normalizeVideo(item: RawVideoItem): YouTubeVideo | null {
  const videoId = item.id;
  const publishedAtRaw = item.snippet?.publishedAt;
  if (!videoId || !publishedAtRaw) return null;

  const publishedAt = new Date(publishedAtRaw);
  if (Number.isNaN(publishedAt.getTime())) return null;

  const durationIso = item.contentDetails?.duration ?? "";
  const dims = parsePlayerDimensions(item.player);

  return {
    videoId,
    channelId: item.snippet?.channelId ?? "",
    title: item.snippet?.title ?? "Untitled",
    description: item.snippet?.description ?? "",
    publishedAt,
    durationIso,
    durationSeconds: parseIsoDuration(durationIso),
    thumbnailUrl: pickThumbnail(item.snippet?.thumbnails),
    viewCount: parseCount(item.statistics?.viewCount) ?? 0,
    likeCount: parseCount(item.statistics?.likeCount),
    commentCount: parseCount(item.statistics?.commentCount),
    playerWidth: dims.width,
    playerHeight: dims.height,
    liveBroadcastContent: item.snippet?.liveBroadcastContent ?? null,
  };
}

// --- Public client ---------------------------------------------------------

const CHANNEL_PARTS = "snippet,statistics,contentDetails,brandingSettings";
const VIDEO_PARTS = "snippet,contentDetails,statistics,player";

/** Data API allows at most 50 ids or results per call. */
export const MAX_BATCH = 50;

export const youtubeClient = {
  /**
   * Look up channels by canonical `UC…` id. Up to 50 per call, 1 quota unit.
   *
   * `credential` reads the channel with its owner's own grant instead of the
   * shared key — the same endpoint and the same normalisation, so an own channel
   * and a competitor produce identical rows and nothing downstream has to know
   * which door the data came through. Only the three methods the sync pipeline
   * uses take one; the resolver's handle and username lookups deliberately do
   * not, because those run BEFORE anybody knows whose channel it is.
   */
  async getChannelsByIds(
    ids: readonly string[],
    ledger?: QuotaLedger,
    credential?: YouTubeCredential,
  ): Promise<YouTubeChannel[]> {
    if (ids.length === 0) return [];
    const out: YouTubeChannel[] = [];
    for (let i = 0; i < ids.length; i += MAX_BATCH) {
      const batch = ids.slice(i, i + MAX_BATCH);
      const data = await apiRequest<RawListResponse<RawChannelItem>>(
        "channels",
        { part: CHANNEL_PARTS, id: batch.join(","), maxResults: MAX_BATCH },
        ledger,
        "channelsList",
        credential,
      );
      for (const item of data.items ?? []) {
        const channel = normalizeChannel(item);
        if (channel) out.push(channel);
      }
    }
    return out;
  },

  /**
   * Resolve an `@handle` directly. Costs 1 unit versus search.list's 100, so
   * this is always attempted before any fallback.
   */
  async getChannelByHandle(handle: string, ledger?: QuotaLedger): Promise<YouTubeChannel | null> {
    const normalized = handle.startsWith("@") ? handle : `@${handle}`;
    const data = await apiRequest<RawListResponse<RawChannelItem>>(
      "channels",
      { part: CHANNEL_PARTS, forHandle: normalized },
      ledger,
      "channelsList",
    );
    const item = data.items?.[0];
    return item ? normalizeChannel(item) : null;
  },

  /** Legacy `/user/NAME` URLs. Still resolvable for older channels. */
  async getChannelByUsername(username: string, ledger?: QuotaLedger): Promise<YouTubeChannel | null> {
    const data = await apiRequest<RawListResponse<RawChannelItem>>(
      "channels",
      { part: CHANNEL_PARTS, forUsername: username },
      ledger,
      "channelsList",
    );
    const item = data.items?.[0];
    return item ? normalizeChannel(item) : null;
  },

  /**
   * Last-resort channel lookup. 100 quota units — a hundred times the cost of
   * every other path here — so the resolver only reaches this when a handle
   * lookup has already failed.
   */
  async searchChannelId(query: string, ledger?: QuotaLedger): Promise<string | null> {
    const data = await apiRequest<RawListResponse<{ id?: { channelId?: string } }>>(
      "search",
      { part: "snippet", q: query, type: "channel", maxResults: 1 },
      ledger,
      "searchList",
    );
    return data.items?.[0]?.id?.channelId ?? null;
  },

  /**
   * Walk a channel's uploads playlist, newest first.
   *
   * `stopBefore` exploits the reverse-chronological ordering: once an entry is
   * older than the lookback window every later entry is too, so paging stops.
   * That is what keeps a refresh at a handful of quota units instead of walking
   * a channel's entire history.
   */
  async listUploads(
    playlistId: string,
    options: {
      stopBefore?: Date;
      maxPages?: number;
      ledger?: QuotaLedger;
      credential?: YouTubeCredential;
    } = {},
  ): Promise<{ entries: UploadsPlaylistEntry[]; reachedEnd: boolean; pagesFetched: number }> {
    const maxPages = options.maxPages ?? env.maxUploadPages;
    const entries: UploadsPlaylistEntry[] = [];
    let pageToken: string | undefined;
    let pagesFetched = 0;
    let reachedEnd = false;

    while (pagesFetched < maxPages) {
      const data = await apiRequest<RawListResponse<RawPlaylistItem>>(
        "playlistItems",
        {
          part: "contentDetails,snippet",
          playlistId,
          maxResults: MAX_BATCH,
          pageToken,
        },
        options.ledger,
        "playlistItemsList",
        options.credential,
      );
      pagesFetched += 1;

      const items = data.items ?? [];
      let hitCutoff = false;

      for (const item of items) {
        const videoId = item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId;
        if (!videoId) continue;

        const publishedRaw = item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt;
        const publishedAt = publishedRaw ? new Date(publishedRaw) : null;
        const validDate = publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null;

        if (options.stopBefore && validDate && validDate < options.stopBefore) {
          hitCutoff = true;
          continue;
        }
        entries.push({ videoId, publishedAt: validDate });
      }

      if (hitCutoff) {
        reachedEnd = true;
        break;
      }
      if (!data.nextPageToken) {
        reachedEnd = true;
        break;
      }
      pageToken = data.nextPageToken;
    }

    return { entries, reachedEnd, pagesFetched };
  },

  /**
   * Full metadata + statistics for up to 50 videos per call (1 unit).
   *
   * `maxHeight` is deliberate: with it set, `player.embedHtml` is sized to the
   * video's true aspect ratio, giving the Shorts classifier a vertical/
   * horizontal signal for free.
   */
  async getVideos(
    ids: readonly string[],
    ledger?: QuotaLedger,
    credential?: YouTubeCredential,
  ): Promise<YouTubeVideo[]> {
    if (ids.length === 0) return [];
    const out: YouTubeVideo[] = [];
    for (let i = 0; i < ids.length; i += MAX_BATCH) {
      const batch = ids.slice(i, i + MAX_BATCH);
      const data = await apiRequest<RawListResponse<RawVideoItem>>(
        "videos",
        {
          part: VIDEO_PARTS,
          id: batch.join(","),
          maxResults: MAX_BATCH,
          maxHeight: 8192,
        },
        ledger,
        "videosList",
        credential,
      );
      for (const item of data.items ?? []) {
        const video = normalizeVideo(item);
        if (video) out.push(video);
      }
    }
    return out;
  },
};

export type YouTubeClient = typeof youtubeClient;
