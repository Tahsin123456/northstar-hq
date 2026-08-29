/**
 * Public surface of the YouTube integration.
 *
 * Everything that talks to YouTube lives behind this barrel. No route handler,
 * server action or React component imports `client.ts` directly, and none of
 * them ever sees a raw API response — the boundary is enforced by only
 * exporting normalised types and intention-revealing functions.
 */

export { youtubeClient, QuotaLedger, QUOTA_COST, MAX_BATCH } from "./client";
export type { YouTubeClient } from "./client";

export { resolveChannel, parseChannelInput } from "./channel-resolver";
export type { ResolveResult } from "./channel-resolver";

export {
  classifyVideo,
  classifyVideos,
  classifyFromSignals,
  probeShortsUrl,
  SHORTS_MAX_DURATION_SECONDS,
  SHORTS_HARD_MAX_SECONDS,
  VERTICAL_ASPECT_MAX,
  MIN_SHORT_CONFIDENCE,
} from "./shorts-detector";
export type {
  ShortsClassification,
  ClassificationMethod,
  ClassificationResult,
  ClassificationSignals,
  VideoClassification,
  ProbeOutcome,
  DetectionOptions,
} from "./shorts-detector";

export { parseIsoDuration, formatDurationSeconds } from "./parse-duration";

export {
  fetchExternalVideoMetadata,
  canFetchExternalVideoMetadata,
} from "./external-video";
export type { ExternalVideoMetadata } from "./external-video";

export type {
  YouTubeChannel,
  YouTubeVideo,
  UploadsPlaylistEntry,
  ParsedChannelInput,
  ChannelInputKind,
} from "./types";
