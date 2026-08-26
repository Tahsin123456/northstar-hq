/**
 * =========================================================================
 * SHORTS DETECTION
 * =========================================================================
 *
 * THE PROBLEM
 * The YouTube Data API v3 has no field that says "this video is a Short".
 * There is no `isShort`, no `shortsMetadata`, nothing in snippet,
 * contentDetails or status. That is a hard limitation of the official API, not
 * an oversight in this code.
 *
 * WHY "duration < 60s" IS WRONG
 * The naive heuristic fails in both directions:
 *   • Since October 2024 a Short may be up to 3 minutes long, so a 90-second
 *     Short is missed entirely.
 *   • A 45-second landscape trailer, teaser or clip uploaded normally is *not*
 *     a Short, but a duration-only rule counts it — inflating the denominator
 *     and quietly deflating every hit rate on the dashboard.
 * Because hit rate is a ratio, an error in the denominator corrupts the single
 * number this whole product exists to report. Detection has to be better than
 * a duration check.
 *
 * THE STRATEGY — layered signals, explicit confidence
 *
 *  1. DURATION GATE (free, definitive for exclusion)
 *     A video longer than the Shorts maximum cannot be a Short, full stop.
 *     Settles most long-form uploads with zero network traffic.
 *
 *  2. URL PROBE (authoritative, zero API quota)
 *     Request youtube.com/shorts/{id} without following redirects. YouTube
 *     serves 200 for a genuine Short and 3xx-redirects to /watch?v={id} for
 *     anything that is not one. This is YouTube's own classification, read
 *     back from YouTube — the closest thing to ground truth available, and it
 *     costs nothing against the Data API quota.
 *
 *  3. ASPECT RATIO (corroborating, from the API)
 *     Requesting `part=player&maxHeight=…` makes YouTube size the embed to the
 *     video's real aspect ratio. Vertical-or-square plus a short duration is
 *     precisely YouTube's own eligibility rule, so this reconstructs the
 *     decision when the probe is unavailable.
 *
 *  4. LIVE CONTENT (exclusion)
 *     Live broadcasts and premieres are never Shorts.
 *
 * CONSERVATIVE BY CONSTRUCTION
 * When the signals do not clear `MIN_SHORT_CONFIDENCE` the video is classified
 * `uncertain`, `isShort` stays false, and the reason is recorded on the row.
 * An uncertain video therefore cannot enter the numerator *or* the denominator
 * of a hit rate. Guessing "probably a Short" would silently corrupt the metric;
 * abstaining merely narrows the sample, and the UI reports how many were
 * excluded and why.
 *
 * DESIGNED TO BE REPLACED
 * The decision logic is a pure function of a `ClassificationSignals` record
 * (`classifyFromSignals`), separate from the I/O that gathers those signals.
 * Adding a new signal means adding a field and a rule — no caller changes.
 */

import { env } from "@/server/env";
import type { YouTubeVideo } from "./types";

/** Maximum duration YouTube allows for a Short (3 minutes, since Oct 2024). */
export const SHORTS_MAX_DURATION_SECONDS = 180;

/**
 * Slack on the duration gate. Reported durations are rounded and occasionally
 * land a second or two over a true 3:00 Short, so the hard exclusion is applied
 * at 185s. Being slightly generous here is safe: anything in the grey zone is
 * still subject to the probe and aspect-ratio rules below.
 */
export const SHORTS_DURATION_TOLERANCE_SECONDS = 5;

export const SHORTS_HARD_MAX_SECONDS =
  SHORTS_MAX_DURATION_SECONDS + SHORTS_DURATION_TOLERANCE_SECONDS;

/**
 * Aspect ratio (width / height) at or below which a video counts as
 * vertical-or-square. Exactly 1.0 (square) is Shorts-eligible; the 1.05 cushion
 * absorbs rounding in the embed dimensions.
 */
export const VERTICAL_ASPECT_MAX = 1.05;

/** Confidence a `short` verdict must reach before `isShort` is allowed true. */
export const MIN_SHORT_CONFIDENCE = 0.6;

export type ShortsClassification = "short" | "not_short" | "uncertain";

export type ClassificationMethod =
  | "duration_gate"
  | "url_probe"
  | "duration_aspect"
  | "live_broadcast"
  | "duration_only"
  | "insufficient_signal"
  | "none";

export type ProbeOutcome =
  | "short"
  | "not_short"
  | "unavailable"
  | "blocked"
  | "error";

export interface ClassificationSignals {
  /** `null` when absent or unparseable (live streams report `P0D`). */
  readonly durationSeconds: number | null;
  /** width / height, or `null` when the player gave no dimensions. */
  readonly aspectRatio: number | null;
  /** Result of the shorts-URL probe, or `null` when it was not run. */
  readonly probe: ProbeOutcome | null;
  /** `"live"` / `"upcoming"` / `"none"` from the snippet. */
  readonly liveBroadcastContent: string | null;
}

export interface ClassificationResult {
  readonly classification: ShortsClassification;
  /** `true` only for `classification === "short"` above the confidence floor. */
  readonly isShort: boolean;
  /** 0..1. */
  readonly confidence: number;
  readonly method: ClassificationMethod;
  /** Human-readable justification, persisted for auditability. */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Pure decision logic — no I/O, exhaustively unit tested.
// ---------------------------------------------------------------------------

export function classifyFromSignals(
  signals: ClassificationSignals,
): ClassificationResult {
  const { durationSeconds, aspectRatio, probe, liveBroadcastContent } = signals;

  // (1) Hard duration exclusion. Cheapest and most certain rule available:
  // no Short can exceed the platform maximum, regardless of any other signal.
  if (durationSeconds !== null && durationSeconds > SHORTS_HARD_MAX_SECONDS) {
    return {
      classification: "not_short",
      isShort: false,
      confidence: 1,
      method: "duration_gate",
      reason: `Duration ${durationSeconds}s exceeds the ${SHORTS_MAX_DURATION_SECONDS}s Shorts maximum.`,
    };
  }

  // (2) Live broadcasts and premieres are never Shorts.
  if (liveBroadcastContent === "live" || liveBroadcastContent === "upcoming") {
    return {
      classification: "not_short",
      isShort: false,
      confidence: 0.95,
      method: "live_broadcast",
      reason: `Live broadcast content ("${liveBroadcastContent}") is never a Short.`,
    };
  }

  // (3) The probe is YouTube's own verdict — trust it over any heuristic.
  if (probe === "short") {
    return {
      classification: "short",
      isShort: true,
      confidence: 0.99,
      method: "url_probe",
      reason: "youtube.com/shorts/{id} served the Shorts player directly.",
    };
  }

  if (probe === "not_short") {
    return {
      classification: "not_short",
      isShort: false,
      confidence: 0.97,
      method: "url_probe",
      reason: "youtube.com/shorts/{id} redirected to the standard watch page.",
    };
  }

  if (probe === "unavailable") {
    return {
      classification: "uncertain",
      isShort: false,
      confidence: 0,
      method: "insufficient_signal",
      reason: "Video is private, deleted or region-blocked; it cannot be classified.",
    };
  }

  // (4) Probe skipped, blocked or errored — reconstruct YouTube's own rule
  // from duration plus aspect ratio.
  const withinDuration =
    durationSeconds !== null && durationSeconds <= SHORTS_HARD_MAX_SECONDS;

  if (withinDuration && aspectRatio !== null) {
    const isVertical = aspectRatio <= VERTICAL_ASPECT_MAX;
    if (isVertical) {
      return {
        classification: "short",
        isShort: true,
        confidence: 0.75,
        method: "duration_aspect",
        reason: `Vertical/square player (${aspectRatio.toFixed(2)}:1) and ${durationSeconds}s duration match YouTube's Shorts eligibility rules.`,
      };
    }
    return {
      classification: "not_short",
      isShort: false,
      confidence: 0.8,
      method: "duration_aspect",
      reason: `Landscape player (${aspectRatio.toFixed(2)}:1) — Shorts must be vertical or square.`,
    };
  }

  // (5) Duration alone. Not enough to assert a Short: plenty of sub-minute
  // landscape clips are ordinary uploads. Deliberately below the confidence
  // floor, so the video is excluded rather than guessed at.
  if (withinDuration) {
    return {
      classification: "uncertain",
      isShort: false,
      confidence: 0.45,
      method: "duration_only",
      reason: `Duration ${durationSeconds}s is Shorts-eligible, but no aspect-ratio or probe signal was available to confirm it. Excluded from Shorts metrics.`,
    };
  }

  // (6) Nothing usable at all.
  return {
    classification: "uncertain",
    isShort: false,
    confidence: 0,
    method: "insufficient_signal",
    reason:
      durationSeconds === null
        ? "No parseable duration (live stream or still-processing upload)."
        : "No signal was sufficient to classify this video.",
  };
}

// ---------------------------------------------------------------------------
// I/O — the redirect probe.
// ---------------------------------------------------------------------------

const SHORTS_URL = (videoId: string) => `https://www.youtube.com/shorts/${videoId}`;

/**
 * A real browser UA. YouTube serves markedly different responses to unknown
 * clients, and the redirect behaviour this probe depends on is part of the
 * normal page-serving path.
 */
const PROBE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * Ask YouTube whether a video is a Short by observing how it serves the Shorts
 * URL. Costs no Data API quota.
 *
 * 200            -> it is a Short
 * 3xx -> /watch  -> it is not a Short
 * 404 / 410      -> unavailable (private, deleted, blocked)
 * 429            -> we are being throttled; treated as `blocked`, never as a
 *                   verdict, so throttling can never mass-misclassify a channel
 */
export async function probeShortsUrl(
  videoId: string,
  timeoutMs: number = env.shortsProbeTimeoutMs,
): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response = await fetch(SHORTS_URL(videoId), {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": PROBE_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
      },
      cache: "no-store",
    });

    // Some edges reject HEAD outright; retry once with GET. The body is never
    // read, so this stays cheap.
    if (response.status === 405 || response.status === 501) {
      response = await fetch(SHORTS_URL(videoId), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": PROBE_USER_AGENT,
          "Accept-Language": "en-US,en;q=0.9",
        },
        cache: "no-store",
      });
    }

    const status = response.status;

    if (status === 200) return "short";

    if (status >= 300 && status < 400) {
      const location = response.headers.get("location") ?? "";
      // A redirect to /watch is the definitive "not a Short" answer. A redirect
      // anywhere else (consent interstitial, regional gateway, login wall) says
      // nothing about the video, so it must not be read as a verdict.
      if (location.includes("/watch")) return "not_short";
      if (location.includes("/shorts/")) return "short";
      return "blocked";
    }

    if (status === 404 || status === 410) return "unavailable";
    if (status === 429) return "blocked";

    return "error";
  } catch {
    // Network failure, timeout, DNS — never a verdict.
    return "error";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bounded-concurrency map. Keeps the probe a polite client rather than firing
 * hundreds of simultaneous requests at youtube.com during a large refresh.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

export interface DetectionOptions {
  /** Overrides SHORTS_PROBE_ENABLED for a single run. */
  readonly probeEnabled?: boolean;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
}

export interface VideoClassification extends ClassificationResult {
  readonly videoId: string;
  readonly aspectRatio: number | null;
}

function computeAspectRatio(video: YouTubeVideo): number | null {
  if (
    video.playerWidth === null ||
    video.playerHeight === null ||
    !Number.isFinite(video.playerWidth) ||
    !Number.isFinite(video.playerHeight) ||
    video.playerHeight <= 0
  ) {
    return null;
  }
  return video.playerWidth / video.playerHeight;
}

/**
 * Classify a batch of videos.
 *
 * The duration gate runs first and locally, so videos that are obviously
 * long-form are settled without any network traffic at all. Only the remaining
 * candidates are probed — on a typical mixed channel that is a large saving,
 * and on a pure-Shorts channel it costs one lightweight request per *new*
 * video, since classifications are cached permanently by the caller.
 */
export async function classifyVideos(
  videos: readonly YouTubeVideo[],
  options: DetectionOptions = {},
): Promise<Map<string, VideoClassification>> {
  const probeEnabled = options.probeEnabled ?? env.shortsProbeEnabled;
  const concurrency = options.concurrency ?? env.shortsProbeConcurrency;

  const results = new Map<string, VideoClassification>();
  const needsProbe: YouTubeVideo[] = [];

  for (const video of videos) {
    const aspectRatio = computeAspectRatio(video);
    const baseSignals: ClassificationSignals = {
      durationSeconds: video.durationSeconds,
      aspectRatio,
      probe: null,
      liveBroadcastContent: video.liveBroadcastContent,
    };

    // Settle the free, definitive cases before spending any network I/O.
    const preliminary = classifyFromSignals(baseSignals);
    const settledWithoutProbe =
      preliminary.method === "duration_gate" || preliminary.method === "live_broadcast";

    if (settledWithoutProbe || !probeEnabled) {
      results.set(video.videoId, {
        ...preliminary,
        videoId: video.videoId,
        aspectRatio,
      });
      continue;
    }

    needsProbe.push(video);
  }

  if (needsProbe.length > 0) {
    const outcomes = await mapWithConcurrency(needsProbe, concurrency, (video) =>
      probeShortsUrl(video.videoId, options.timeoutMs),
    );

    needsProbe.forEach((video, index) => {
      const aspectRatio = computeAspectRatio(video);
      const classification = classifyFromSignals({
        durationSeconds: video.durationSeconds,
        aspectRatio,
        probe: outcomes[index],
        liveBroadcastContent: video.liveBroadcastContent,
      });
      results.set(video.videoId, {
        ...classification,
        videoId: video.videoId,
        aspectRatio,
      });
    });
  }

  return results;
}

/** Single-video convenience wrapper. */
export async function classifyVideo(
  video: YouTubeVideo,
  options: DetectionOptions = {},
): Promise<VideoClassification> {
  const map = await classifyVideos([video], options);
  const result = map.get(video.videoId);
  if (result) return result;
  return {
    videoId: video.videoId,
    aspectRatio: null,
    classification: "uncertain",
    isShort: false,
    confidence: 0,
    method: "none",
    reason: "Classification did not run.",
  };
}
