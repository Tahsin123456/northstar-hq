/**
 * Display formatting.
 *
 * House rule: `null` means "no data" and always renders as an em dash. Nothing
 * here ever turns an absent value into a zero — on a dashboard whose entire
 * purpose is comparison, a fabricated 0 is worse than a visible gap.
 */

export const EM_DASH = "—";

/** 1234 -> "1.2K", 1_234_567 -> "1.2M", 1.27e9 -> "1.27B". */
export function formatCompactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  if (abs < 1_000_000) return `${trim(value / 1000)}K`;
  if (abs < 1_000_000_000) return `${trim(value / 1_000_000)}M`;
  return `${trim(value / 1_000_000_000, 2)}B`;
}

function trim(value: number, decimals = 1): string {
  const rounded = value.toFixed(decimals);
  return rounded.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

/** Full number with locale grouping: 1234567 -> "1,234,567". */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return new Intl.NumberFormat().format(Math.round(value));
}

/**
 * Hit rate. `null` renders as an em dash — never "0%" — because a channel that
 * uploaded nothing has no hit rate, which is a different statement from a
 * channel that uploaded and missed every time.
 */
export function formatPercent(
  value: number | null | undefined,
  decimals = 1,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return `${value.toFixed(decimals)}%`;
}

/** Signed percentage-point delta: "+6.2 pts" / "−3.0 pts". */
export function formatDelta(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(decimals)} pts`;
}

/** Threshold labels for the selector and table chips: "≥ 1M". */
export function formatThreshold(threshold: number): string {
  return `≥ ${formatCompactNumber(threshold)}`;
}

export function formatThresholdLong(threshold: number): string {
  return `${formatNumber(threshold)} views`;
}

/** "12 minutes ago", "3 days ago", "just now". */
export function formatRelativeTime(
  input: Date | string | number | null | undefined,
  now: number = Date.now(),
): string {
  if (input === null || input === undefined) return "never";
  const ms = typeof input === "number" ? input : new Date(input).getTime();
  if (!Number.isFinite(ms)) return "never";

  const diffSeconds = Math.round((now - ms) / 1000);

  if (diffSeconds < 0) return "just now";
  if (diffSeconds < 45) return "just now";

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.34524],
    ["month", 12],
    ["year", Number.POSITIVE_INFINITY],
  ];

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  let value = diffSeconds;
  for (const [unit, size] of units) {
    if (Math.abs(value) < size) {
      return formatter.format(-Math.round(value), unit);
    }
    value /= size;
  }
  return formatter.format(-Math.round(value), "year");
}

/** "26 Aug 2026". */
export function formatDate(input: Date | string | number | null | undefined): string {
  if (input === null || input === undefined) return EM_DASH;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** "26 Aug 2026, 14:32". */
export function formatDateTime(input: Date | string | number | null | undefined): string {
  if (input === null || input === undefined) return EM_DASH;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "12 / 38" — the raw fraction behind a hit rate. */
export function formatFraction(numerator: number, denominator: number): string {
  return `${formatNumber(numerator)} / ${formatNumber(denominator)}`;
}

/** Multiples of the threshold: 2_400_000 at 1M -> "2.4×". */
export function formatThresholdRatio(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return EM_DASH;
  if (ratio >= 10) return `${Math.round(ratio)}×`;
  if (ratio >= 1) return `${ratio.toFixed(1)}×`;
  return `${ratio.toFixed(2)}×`;
}

/** Seconds -> "0:42" / "1:02:03". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return EM_DASH;
  }
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}

/** YouTube's CDN derives thumbnails from the video id — no need to store them. */
export function youtubeThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

/**
 * THE PORTRAIT FRAME OF A SHORT, from the id alone.
 *
 * `mqdefault.jpg` above is 320x180 WHATEVER SHAPE THE VIDEO IS. For a 9:16
 * Short that means the real frame is pillarboxed into a 101px strip in the
 * middle and the remaining two thirds is stretched blur — fine as a 64px chip
 * beside a note, ruinous as the lead element of a browsing tile, which is what
 * a Shorts grid makes it.
 *
 * `oardefault.jpg` is the same frame at its original aspect ratio — measured
 * 1080x1920, exactly 9:16, no matting — and it exists for the same video id
 * with no API call, no key and nothing to store. ("oar" is YouTube's own
 * shorthand for the original aspect ratio.)
 *
 * IT IS NOT GUARANTEED, AND THE 404 IS THE POINT. YouTube generates it only for
 * a video that actually is portrait. A landscape video returns 404 with the
 * grey 120x90 placeholder body — verified against a known landscape upload,
 * where `mqdefault` is 200 and this is 404 — so the miss is a real error event
 * the `onError` handler can see, not a 200 carrying a picture of nothing. Every
 * caller must therefore pair this with a fallback to `youtubeThumbnailUrl`:
 * this app calls a video a Short from its duration and its metadata, and a
 * sub-minute landscape upload is a perfectly ordinary thing for a competitor to
 * publish.
 */
export function youtubeShortsPosterUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/oardefault.jpg`;
}

export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function youtubeShortsUrl(videoId: string): string {
  return `https://www.youtube.com/shorts/${videoId}`;
}

/**
 * The one host this app is allowed to put in an iframe.
 *
 * Exported as a constant rather than inlined into the URL below because it has
 * to appear in exactly one other place — the `frame-src` directive in
 * `next.config.ts` — and the two must agree character for character or every
 * embed fails silently with nothing in the UI to say why. A test asserts the
 * header contains this value, so a well-meaning tidy-up of either one breaks a
 * build rather than the player.
 *
 * `youtube-nocookie.com` rather than `youtube.com`: it serves the identical
 * player, but defers cookies until somebody actually presses play and keeps the
 * view out of ad personalisation. It is not "cookieless" — it still writes a
 * device id to browser storage on load — so the honest claim is "less", not
 * "none", which is how the privacy policy words it.
 */
export const YOUTUBE_EMBED_ORIGIN = "https://www.youtube-nocookie.com";

/**
 * The embeddable form of a Short, for the in-app player.
 *
 * A Short is an ordinary video that happens to be shot 9:16, so the standard
 * `/embed/` endpoint is the right one — `/shorts/<id>` is a watch page and
 * refuses to be framed at all.
 *
 * COMPOSED FROM THE ID, never from a stored URL string, for the same reason
 * `canonicalShortUrl` is: this string becomes the `src` of a document the
 * browser will execute, and "safe because of what some other file writes into
 * that column" is a property that holds until somebody restores a backup.
 *
 * The parameters are all subtractive except one. `rel=0` keeps the end screen's
 * suggestions inside the same channel instead of turning a research tool into a
 * recommendation feed; `modestbranding=1` drops the watermark; `playsinline=1`
 * stops iOS taking the video fullscreen the moment it starts, which on a phone
 * would throw the reader out of the app they were reading. `autoplay` is the
 * caller's decision because it is the only one that depends on the person: see
 * `usePrefersReducedMotion` at the player.
 */
export function youtubeShortsEmbedUrl(
  videoId: string,
  options: { autoplay?: boolean } = {},
): string {
  const params = new URLSearchParams({
    rel: "0",
    modestbranding: "1",
    playsinline: "1",
  });
  if (options.autoplay) params.set("autoplay", "1");
  return `${YOUTUBE_EMBED_ORIGIN}/embed/${videoId}?${params.toString()}`;
}

export function youtubeChannelUrl(handle: string | null, channelId: string): string {
  return handle
    ? `https://www.youtube.com/${handle}`
    : `https://www.youtube.com/channel/${channelId}`;
}

/**
 * Compact number for a chart axis, where horizontal space is scarce.
 *
 * Tighter than `formatCompactNumber`: axis ticks are read as a scale, not as
 * exact values, so one decimal at most and no trailing noise. The precise
 * figure always remains available in the tooltip.
 *
 * 1_250_000 -> "1.3M", 850_000 -> "850K", 12_500_000 -> "12.5M"
 */
export function formatAxisNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  if (abs < 1_000_000) {
    const k = value / 1000;
    return `${abs < 10_000 ? k.toFixed(1).replace(/\.0$/, "") : Math.round(k)}K`;
  }
  if (abs < 1_000_000_000) {
    const m = value / 1_000_000;
    return `${abs < 10_000_000 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)}M`;
  }
  const b = value / 1_000_000_000;
  return `${b.toFixed(b < 10 ? 2 : 1).replace(/\.?0+$/, "")}B`;
}

/**
 * Width in pixels a numeric Y axis needs so its longest tick is never clipped.
 *
 * Recharts does not measure tick text, so a fixed `width` either wastes space
 * or truncates. Deriving it from the formatted maximum keeps large values
 * ("12.5M", "1.27B") fully visible without stealing plot area from small ones.
 */
export function axisWidthFor(maxValue: number, suffix = ""): number {
  const longest = `${formatAxisNumber(maxValue)}${suffix}`;
  // ~7px per character at 11px type, plus the tick margin.
  return Math.max(34, Math.min(72, longest.length * 7 + 14));
}
