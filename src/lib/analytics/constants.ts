import type { PeriodPresetId, ViewBucket } from "./types";

/**
 * The product default: "how many of this channel's Shorts pass 1,000,000
 * views?" is the question the whole tool exists to answer.
 */
export const DEFAULT_THRESHOLD = 1_000_000;

export const DEFAULT_PERIOD_PRESET: PeriodPresetId = "30d";

/** Presets offered by the threshold control, in ascending order. */
export const THRESHOLD_PRESETS = [
  100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000,
] as const;

export const MIN_THRESHOLD = 1;
/** Above the most-viewed video ever, with room to spare. */
export const MAX_THRESHOLD = 100_000_000_000;

export interface PeriodPreset {
  readonly id: PeriodPresetId;
  readonly label: string;
  readonly shortLabel: string;
  /** `null` for the custom range, which carries its own bounds. */
  readonly days: number | null;
}

export const PERIOD_PRESETS: readonly PeriodPreset[] = [
  { id: "7d", label: "Last 7 days", shortLabel: "7D", days: 7 },
  { id: "30d", label: "Last 30 days", shortLabel: "30D", days: 30 },
  { id: "90d", label: "Last 90 days", shortLabel: "90D", days: 90 },
  { id: "180d", label: "Last 180 days", shortLabel: "180D", days: 180 },
  { id: "custom", label: "Custom range", shortLabel: "Custom", days: null },
];

export const PERIOD_PRESET_BY_ID: Readonly<Record<PeriodPresetId, PeriodPreset>> =
  Object.fromEntries(PERIOD_PRESETS.map((p) => [p.id, p])) as Readonly<
    Record<PeriodPresetId, PeriodPreset>
  >;

/**
 * Histogram buckets for the performance distribution.
 *
 * These exist because two channels can share a 20% hit rate while having
 * completely different shapes — one clustered just under the line, one carried
 * by a couple of outliers. The distribution is what exposes that.
 */
export const VIEW_BUCKETS: readonly ViewBucket[] = [
  { id: "lt10k", label: "<10K", min: 0, max: 10_000 },
  { id: "10k-50k", label: "10K–50K", min: 10_000, max: 50_000 },
  { id: "50k-100k", label: "50K–100K", min: 50_000, max: 100_000 },
  { id: "100k-250k", label: "100K–250K", min: 100_000, max: 250_000 },
  { id: "250k-500k", label: "250K–500K", min: 250_000, max: 500_000 },
  { id: "500k-1m", label: "500K–1M", min: 500_000, max: 1_000_000 },
  { id: "1m-2m", label: "1M–2M", min: 1_000_000, max: 2_000_000 },
  { id: "2m-5m", label: "2M–5M", min: 2_000_000, max: 5_000_000 },
  { id: "5m-10m", label: "5M–10M", min: 5_000_000, max: 10_000_000 },
  { id: "10m+", label: "10M+", min: 10_000_000, max: null },
];

/**
 * The single source of truth for what "hit rate" means, surfaced in the UI as
 * a tooltip. Worth stating explicitly because the natural-language reading of
 * "views in the last 30 days" is *not* what this measures.
 */
export const HIT_RATE_DEFINITION =
  "Hit rate is the share of Shorts uploaded during the selected period that currently have at least the selected number of views. The period decides which uploads are counted; the threshold decides which of them count as hits. It is not a measure of views accumulated during the period.";

export const HIT_RATE_FORMULA = "hits ÷ Shorts uploaded in period × 100";

/**
 * What "Total Shorts views" means here — stated because the natural assumption
 * (that it matches YouTube Studio) is wrong, and silently differing numbers
 * destroy trust in every other figure on the page.
 */
export const TOTAL_VIEWS_DEFINITION =
  "Total Shorts views is the sum of the current view counts of Shorts uploaded during the selected period. It is not views earned during the period: a Short uploaded three days ago contributes all of its lifetime views, and a Short uploaded before the period contributes none.";

/** Why this will not match the number in YouTube Studio. */
export const TOTAL_VIEWS_VS_STUDIO =
  "YouTube Studio measures something different — views earned in the last N days across a channel's entire back catalogue, including videos uploaded years ago. The two figures answer different questions and will not agree.";
