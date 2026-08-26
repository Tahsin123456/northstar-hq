/**
 * Channel input resolution.
 *
 * Accepts anything a user is likely to paste and normalises it to a canonical
 * `UC…` channel id:
 *
 *   https://www.youtube.com/@mrbeast          -> handle
 *   youtube.com/@mrbeast/shorts               -> handle (trailing tab stripped)
 *   @mrbeast                                  -> handle
 *   mrbeast                                   -> bare handle
 *   https://www.youtube.com/channel/UCX6O…    -> channel id
 *   UCX6OQ3DkcsbYNE6H8uQQuVA                  -> channel id
 *   https://www.youtube.com/c/PewDiePie       -> legacy custom URL
 *   https://www.youtube.com/user/PewDiePie    -> legacy username
 *   https://youtu.be/dQw4w9WgXcQ              -> video URL, resolved via its channel
 *   https://www.youtube.com/shorts/abc123     -> Shorts URL, resolved via its channel
 *
 * Ordering is quota-driven. `channels.list` costs 1 unit whether keyed by id,
 * handle or username; `search.list` costs 100. So every cheap avenue is
 * exhausted before search is even considered.
 */

import { errors } from "@/server/errors";
import { QuotaLedger, youtubeClient } from "./client";
import type { ParsedChannelInput, YouTubeChannel } from "./types";

/** Canonical channel ids are `UC` + 22 base64url characters. */
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
/** YouTube handles: 3–30 chars, letters/digits/underscore/hyphen/period. */
const HANDLE_PATTERN = /^@?[A-Za-z0-9_.-]{3,30}$/;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

/** Channel sub-tabs that may trail a handle in a pasted URL. */
const CHANNEL_TABS = new Set([
  "shorts",
  "videos",
  "streams",
  "live",
  "playlists",
  "community",
  "about",
  "featured",
  "posts",
  "store",
  "podcasts",
  "releases",
  "search",
]);

/**
 * Pure, synchronous, network-free parse of user input.
 * Exported separately so it can be tested exhaustively without an API key.
 */
export function parseChannelInput(rawInput: string): ParsedChannelInput | null {
  const raw = rawInput.trim();
  if (!raw) return null;

  // --- Bare identifiers (no URL structure) ---
  if (CHANNEL_ID_PATTERN.test(raw)) {
    return { kind: "channelId", value: raw, raw };
  }

  if (raw.startsWith("@") && HANDLE_PATTERN.test(raw)) {
    return { kind: "handle", value: raw, raw };
  }

  // --- URL forms ---
  const url = tryParseUrl(raw);
  if (url) {
    if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;

    // youtu.be/<videoId>
    if (url.hostname.toLowerCase().endsWith("youtu.be")) {
      const videoId = url.pathname.replace(/^\//, "").split("/")[0];
      if (VIDEO_ID_PATTERN.test(videoId)) {
        return { kind: "videoUrl", value: videoId, raw };
      }
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);

    // /watch?v=<videoId>
    if (segments[0] === "watch") {
      const videoId = url.searchParams.get("v");
      if (videoId && VIDEO_ID_PATTERN.test(videoId)) {
        return { kind: "videoUrl", value: videoId, raw };
      }
      return null;
    }

    // /shorts/<videoId>  — but only when it really is a video id. A pasted
    // "/@handle/shorts" is handled by the handle branch below.
    if (segments[0] === "shorts" && segments[1] && VIDEO_ID_PATTERN.test(segments[1])) {
      return { kind: "videoUrl", value: segments[1], raw };
    }

    // /channel/<UC…>
    if (segments[0] === "channel" && segments[1]) {
      const id = segments[1];
      if (CHANNEL_ID_PATTERN.test(id)) return { kind: "channelId", value: id, raw };
      return null;
    }

    // /@handle[/tab]
    const handleSegment = segments.find((s) => s.startsWith("@"));
    if (handleSegment && HANDLE_PATTERN.test(handleSegment)) {
      return { kind: "handle", value: handleSegment, raw };
    }

    // /c/<customUrl> and /user/<username>
    if ((segments[0] === "c" || segments[0] === "user") && segments[1]) {
      return {
        kind: segments[0] === "user" ? "customUrl" : "url",
        value: decodeURIComponent(segments[1]),
        raw,
      };
    }

    // A single trailing segment that is not a known tab: treat as a handle.
    if (segments.length >= 1 && !CHANNEL_TABS.has(segments[0].toLowerCase())) {
      const candidate = segments[0];
      if (HANDLE_PATTERN.test(candidate)) {
        return { kind: "handle", value: `@${candidate.replace(/^@/, "")}`, raw };
      }
    }

    return null;
  }

  // --- Bare handle without the leading @ ---
  if (HANDLE_PATTERN.test(raw) && !raw.includes(" ")) {
    return { kind: "handle", value: `@${raw}`, raw };
  }

  return null;
}

function tryParseUrl(value: string): URL | null {
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  // Only treat it as a URL if it plausibly *is* one; otherwise "@handle" would
  // parse as a hostname.
  if (!/[./]/.test(value)) return null;
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

export interface ResolveResult {
  readonly channel: YouTubeChannel;
  readonly parsedAs: ParsedChannelInput;
  readonly quotaUnitsUsed: number;
}

/**
 * Resolve user input to a full channel record.
 *
 * @param allowSearchFallback  When false, the expensive (100-unit) search path
 *   is skipped entirely. Callers that resolve in bulk should pass false.
 */
export async function resolveChannel(
  rawInput: string,
  options: { allowSearchFallback?: boolean; ledger?: QuotaLedger } = {},
): Promise<ResolveResult> {
  const allowSearchFallback = options.allowSearchFallback ?? true;
  const ledger = options.ledger ?? new QuotaLedger();

  const parsed = parseChannelInput(rawInput);
  if (!parsed) {
    throw errors.invalidInput(
      "That does not look like a YouTube channel. Paste a channel URL (youtube.com/@name), an @handle, or a channel ID starting with UC.",
      { input: rawInput },
    );
  }

  const channel = await resolveParsed(parsed, allowSearchFallback, ledger);
  if (!channel) throw errors.channelNotFound(parsed.raw);

  return { channel, parsedAs: parsed, quotaUnitsUsed: ledger.total };
}

async function resolveParsed(
  parsed: ParsedChannelInput,
  allowSearchFallback: boolean,
  ledger: QuotaLedger,
): Promise<YouTubeChannel | null> {
  switch (parsed.kind) {
    case "channelId": {
      const [channel] = await youtubeClient.getChannelsByIds([parsed.value], ledger);
      return channel ?? null;
    }

    case "handle": {
      const byHandle = await youtubeClient.getChannelByHandle(parsed.value, ledger);
      if (byHandle) return byHandle;

      // Older channels sometimes answer to forUsername but not forHandle.
      const bare = parsed.value.replace(/^@/, "");
      const byUsername = await youtubeClient.getChannelByUsername(bare, ledger);
      if (byUsername) return byUsername;

      return allowSearchFallback ? searchThenFetch(parsed.value, ledger) : null;
    }

    case "customUrl":
    case "url": {
      const byUsername = await youtubeClient.getChannelByUsername(parsed.value, ledger);
      if (byUsername) return byUsername;

      const byHandle = await youtubeClient.getChannelByHandle(parsed.value, ledger);
      if (byHandle) return byHandle;

      return allowSearchFallback ? searchThenFetch(parsed.value, ledger) : null;
    }

    case "videoUrl": {
      // Cheapest route from a video to its channel: one videos.list (1 unit)
      // for the channelId, then one channels.list (1 unit).
      const [video] = await youtubeClient.getVideos([parsed.value], ledger);
      if (!video || !video.channelId) return null;
      const [channel] = await youtubeClient.getChannelsByIds([video.channelId], ledger);
      return channel ?? null;
    }

    default:
      return null;
  }
}

/** 100-unit last resort. Only reached when every 1-unit path has failed. */
async function searchThenFetch(
  query: string,
  ledger: QuotaLedger,
): Promise<YouTubeChannel | null> {
  const channelId = await youtubeClient.searchChannelId(query.replace(/^@/, ""), ledger);
  if (!channelId) return null;
  const [channel] = await youtubeClient.getChannelsByIds([channelId], ledger);
  return channel ?? null;
}
