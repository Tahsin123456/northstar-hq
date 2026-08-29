/**
 * Title and channel for a Short that is NOT in the tracker.
 *
 * ==========================================================================
 * WHY THIS DOES NOT USE `youtubeClient`
 * ==========================================================================
 * `client.ts` is built for the sync pipeline: it retries three times with
 * exponential backoff, allows fifteen seconds per attempt, charges a quota
 * ledger and throws a typed `AppError` describing what went wrong. Every one of
 * those is correct for a background refresh whose job is to eventually succeed,
 * and wrong here.
 *
 * This call sits inside a note write — somebody has typed an observation and
 * pressed save — and it is enrichment nobody asked for. Its worst case must be
 * measured in a couple of seconds, not in the forty-five the retry ladder can
 * reach, and its failure must be silence rather than an exception travelling up
 * into a request whose actual job (saving the note) has nothing to do with
 * YouTube. So: one attempt, a short hard timeout, and `null` for everything —
 * no key, quota gone, video private, deleted, or YouTube simply slow.
 *
 * The note is never worse off for this failing. The thumbnail is derived from
 * the video id with no request at all (`youtubeThumbnailUrl`), so an attached
 * Short always renders as a Short; `externalTitle` and `externalChannelTitle`
 * are nullable in the schema for exactly this reason, and the UI has a
 * no-title rendering that is a first-class case rather than a fallback.
 */

import { env } from "@/server/env";

/** How long the enrichment gets before the note saves without it. */
const LOOKUP_TIMEOUT_MS = 2_500;

const VIDEOS_ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";

export interface ExternalVideoMetadata {
  readonly title: string | null;
  readonly channelTitle: string | null;
}

interface RawExternalVideoResponse {
  items?: Array<{ snippet?: { title?: string; channelTitle?: string } }>;
}

/**
 * Whether looking one up is even worth attempting.
 *
 * Exported so a caller can skip the `await` entirely rather than awaiting a
 * function that was always going to return null — the common deployment has no
 * Data API key, and the note write should not grow an async hop for it.
 */
export function canFetchExternalVideoMetadata(): boolean {
  return env.youtubeApiKey !== null;
}

/**
 * Best effort, and only ever best effort.
 *
 * Returns `null` when there is nothing to say — which is a different statement
 * from `{ title: null, channelTitle: null }`, meaning "YouTube answered and had
 * no title", though both are stored identically. It never throws: every path
 * out of here is a value, because the caller is in the middle of a database
 * write it must be allowed to finish.
 */
export async function fetchExternalVideoMetadata(
  videoId: string,
): Promise<ExternalVideoMetadata | null> {
  const apiKey = env.youtubeApiKey;
  if (apiKey === null) return null;

  try {
    const url = new URL(VIDEOS_ENDPOINT);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("id", videoId);
    // Asks YouTube for the two strings we store and nothing else. A Shorts
    // snippet carries a full description and a thumbnail set we already derive
    // ourselves; not transferring them is free.
    url.searchParams.set("fields", "items(snippet(title,channelTitle))");
    url.searchParams.set("key", apiKey);

    const response = await fetch(url, {
      // The whole safety of doing this inline. `AbortSignal.timeout` covers the
      // connection and the body together, so there is no path where a hung
      // socket holds the note write open.
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    // Deliberately not mapped onto the app's error taxonomy. A 403 for spent
    // quota and a 404 for a deleted video lead to the same place — the note
    // saves with its URL and no title — so telling them apart would only
    // produce a distinction nothing acts on.
    if (!response.ok) return null;

    const data = (await response.json()) as RawExternalVideoResponse;
    const snippet = data.items?.[0]?.snippet;
    if (!snippet) return null;

    return {
      title: nonEmpty(snippet.title),
      channelTitle: nonEmpty(snippet.channelTitle),
    };
  } catch {
    // Timeout, DNS, TLS, malformed JSON — all the same answer. This is the
    // clause that guarantees enrichment can never fail a note.
    return null;
  }
}

/** "" and "   " mean "YouTube told us nothing", which is `null` in this app. */
function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
