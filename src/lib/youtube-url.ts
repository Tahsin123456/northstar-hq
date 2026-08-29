/**
 * Parsing a pasted YouTube link down to its video id.
 *
 * ==========================================================================
 * WHY THIS FILE EXISTS AT ALL, AND WHY IT RETURNS AN ID RATHER THAN A URL
 * ==========================================================================
 * A note can quote a competitor's Short, and the way somebody quotes one is by
 * pasting a link. That link ends up rendered as an `href`, which makes the
 * pasted string an attacker-controlled value in a position where the browser
 * will *execute* some schemes — `javascript:`, `data:`, `vbscript:`. Sanitising
 * a URL after the fact is a game of finding every scheme and every encoding of
 * every scheme, and it is a game people lose.
 *
 * So this never sanitises. It EXTRACTS — an 11-character video id and nothing
 * else — and the caller composes the URL itself from that id. Whatever was
 * pasted is discarded at this boundary and never reaches the database, which
 * makes a hostile href impossible by construction rather than by vigilance:
 * `https://www.youtube.com/shorts/` + eleven characters of `[A-Za-z0-9_-]` has
 * no room in it for a scheme.
 *
 * That is also the reason `Note.externalUrl` is a separate column from
 * `Note.externalVideoId` and is documented in the schema as "rebuilt from the
 * id". The id is the fact; the URL is a rendering of it.
 *
 * ==========================================================================
 * BROWSER AND SERVER
 * ==========================================================================
 * Deliberately dependency-free apart from `format.ts`, so the composer can tell
 * somebody their link is wrong *while they type it* using the same code the
 * server will use to reject it. Two parsers would eventually disagree, and the
 * disagreement people notice is the one where the field says "looks good" and
 * the save fails.
 */

import { youtubeShortsUrl } from "@/lib/format";

/**
 * A YouTube video id: exactly 11 characters of base64url.
 *
 * Anchored at both ends, and the length is exact rather than a minimum —
 * "eleven or more" would accept `AAAAAAAAAAA/../../evil` as an id and put the
 * slashes straight into the path we compose.
 */
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/**
 * Hosts a Short can legitimately be pasted from.
 *
 * An allow-list of exact hostnames, never a `.includes("youtube.com")` test:
 * the string "youtube.com" appears in `youtube.com.evil.test` and in
 * `evil.test/youtube.com/shorts/x`, and both of those are somebody else's
 * server. Matching `URL.hostname` exactly is what makes those two miss.
 */
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

/** Any leading `scheme:`, per RFC 3986. Used to spot one, not to trust it. */
const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;

/**
 * What a good link looks like, in the words the user sees.
 *
 * One constant because the composer, the edit form and the server's rejection
 * all have to say the same thing — a field that accepts what the error message
 * describes is the whole of "a clear message".
 */
export const EXTERNAL_SHORT_URL_HINT =
  "Paste a YouTube link — youtube.com/shorts/…, youtu.be/… or youtube.com/watch?v=…";

const NOT_YOUTUBE_MESSAGE = `That is not a YouTube link. ${EXTERNAL_SHORT_URL_HINT}`;
const NO_VIDEO_ID_MESSAGE = `That YouTube link has no video in it. ${EXTERNAL_SHORT_URL_HINT}`;

/**
 * Pulls the video id out of anything a person is likely to paste.
 *
 * Accepts, with or without a scheme, with any extra query parameters:
 *   youtube.com/shorts/<id>          ?feature=share
 *   www.youtube.com/watch?v=<id>     &t=17s
 *   youtu.be/<id>                    ?si=…
 *   m.youtube.com/… and music.youtube.com/…
 *
 * Returns `null` for everything else — a different site, a channel page, a
 * malformed id, a `javascript:` payload. There is no partial success: a caller
 * either has eleven safe characters or it has nothing to store.
 */
export function parseYouTubeVideoId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  const url = parseHttpUrl(raw);
  if (!url) return null;
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;

  const segments = url.pathname.split("/").filter(Boolean);

  // youtu.be/<id> — the id is the whole path, and `?si=` tracking rides along
  // in the query where it is ignored.
  if (url.hostname.toLowerCase().endsWith("youtu.be")) {
    return validId(segments[0]);
  }

  // /shorts/<id>. Note this is checked before anything else on youtube.com:
  // `/@handle/shorts` is a channel tab, not a video, and it fails the id test
  // rather than being mistaken for one.
  if (segments[0] === "shorts") return validId(segments[1]);

  // /watch?v=<id> — the id is in the query, so `&t=` and friends are free.
  if (segments[0] === "watch") return validId(url.searchParams.get("v"));

  /*
   * The other three shapes that carry a video id in the first path segment.
   *
   * None are what somebody sets out to copy, and all three are what they end up
   * with: `/live/` from a premiere or a stream that has since become a normal
   * video, `/embed/` from a page's view-source or an iframe, `/v/` from a link
   * old enough to predate the current player. Each identifies a real video, so
   * refusing them would be the parser being fussy about provenance rather than
   * about validity — and the person would have no idea why a YouTube link had
   * been called not-a-YouTube-link.
   *
   * Safe to widen because the safety here is not in the path list: whatever
   * matches, the id is still checked against an anchored eleven-character
   * pattern and the URL is still composed rather than echoed.
   */
  if (segments[0] === "live" || segments[0] === "embed" || segments[0] === "v") {
    return validId(segments[1]);
  }

  return null;
}

/**
 * The canonical URL for a Short, and the ONLY value ever persisted or rendered.
 *
 * Composed from the id rather than echoing the input — see the header. Always
 * the `/shorts/` form even when the link was pasted as `/watch?v=`: these are
 * Shorts by the feature's own definition, and YouTube redirects between the two
 * anyway.
 */
export function canonicalShortUrl(videoId: string): string {
  return youtubeShortsUrl(videoId);
}

/**
 * The state of the field as somebody types in it.
 *
 * Three cases rather than a boolean, because "empty" is not an error: the link
 * is optional, and a field that turns red the moment it is focused and cleared
 * is telling somebody off for declining to use a feature.
 */
export type ExternalShortInput =
  | { readonly status: "empty" }
  | { readonly status: "valid"; readonly videoId: string; readonly url: string }
  | { readonly status: "invalid"; readonly message: string };

/**
 * Reads what is currently in the field, for the UI.
 *
 * The message distinguishes "that is not YouTube" from "that is YouTube but
 * points at no video", because those prompt different corrections: one person
 * pasted the wrong thing entirely, the other pasted a channel page and needs to
 * open the Short first.
 */
export function readExternalShortInput(input: string): ExternalShortInput {
  const raw = input.trim();
  if (!raw) return { status: "empty" };

  const videoId = parseYouTubeVideoId(raw);
  if (videoId) return { status: "valid", videoId, url: canonicalShortUrl(videoId) };

  const url = parseHttpUrl(raw);
  const isYouTube = url !== null && YOUTUBE_HOSTS.has(url.hostname.toLowerCase());
  return { status: "invalid", message: isYouTube ? NO_VIDEO_ID_MESSAGE : NOT_YOUTUBE_MESSAGE };
}

/**
 * Parses a string as an http(s) URL, tolerating a missing scheme.
 *
 * THE SCHEME CHECK IS THE POINT. `new URL("javascript:alert(1)")` succeeds —
 * `URL` parses any scheme, it does not judge them — so a parser that only asked
 * "did this parse?" would hand `javascript:` straight through. Anything
 * carrying a scheme that is not http or https is refused here and never gets as
 * far as the host test.
 *
 * A bare `youtube.com/shorts/…` has no scheme, so `https://` is prepended
 * before parsing; that is the common paste from a mobile share sheet. A string
 * with no scheme and no dot is not a URL attempt at all and is refused rather
 * than being reinterpreted as a hostname.
 */
function parseHttpUrl(value: string): URL | null {
  const scheme = SCHEME_PATTERN.exec(value);
  if (scheme && !/^https?$/i.test(scheme[1])) return null;
  // No scheme and no dot: "hello world" or a bare id. Prepending `https://`
  // would turn those into hostnames and invite a guess; there is nothing to
  // guess from.
  if (!scheme && !value.includes(".")) return null;

  const candidate = scheme ? value : `https://${value}`;

  try {
    const url = new URL(candidate);
    // Re-checked after parsing rather than trusted from the regex above:
    // `URL` resolves oddities the pattern does not model, and the protocol on
    // the parsed object is the one the browser would actually act on.
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** An id, or nothing. Never a truncated or "cleaned up" id. */
function validId(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  return VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
}
