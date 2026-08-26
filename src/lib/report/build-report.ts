import {
  calculateChannelMetrics,
  calculateMarketShare,
  calculateMarketShareSeries,
  calculateOutliers,
  compareToMarket,
  median,
  pickShareGranularity,
  sortOutliers,
  sum,
  type ChannelMetrics,
  type DateRange,
  type MarketComparison,
  type MarketShare,
  type MarketSharePoint,
  type OutlierShort,
} from "@/lib/analytics";
import { calculateTrend, previousRange, type Trend } from "@/lib/analytics/trends";
import { baselineRangeFor } from "@/hooks/use-shorts-feed";
import type { ChannelDTO, DatasetDTO, NicheDTO } from "@/lib/dto";
import { BRAND } from "@/lib/brand";

/**
 * =========================================================================
 * REPORT ASSEMBLY
 * =========================================================================
 *
 * Builds every number the PDF prints, from the same dataset and the same
 * analytics functions the screens use.
 *
 * WHY THIS IS A PURE FUNCTION OVER THE CLIENT DATASET
 * The requirement is that the PDF and the dashboard can never disagree. The
 * strongest way to guarantee that is not "call the same helpers" — it is to
 * run in the same process on the same in-memory objects the UI just rendered
 * from. A server-side report generator would re-query, re-derive, and drift
 * the moment either side changed. Here, if Overview says 1.42B, the report is
 * reading that exact number.
 *
 * Nothing in this file computes a metric of its own; it only selects, scopes
 * and arranges.
 */

export interface ReportChannelRow {
  readonly channel: ChannelDTO;
  readonly metrics: ChannelMetrics;
  readonly viewsTrend: Trend;
  readonly hitRateTrend: Trend;
}

export interface ReportShort {
  readonly title: string;
  readonly youtubeVideoId: string;
  readonly channelName: string;
  readonly nicheNames: readonly string[];
  readonly views: number;
  readonly outlierMultiple: number | null;
  readonly publishedAt: number;
}

export interface ReportSummaryMetric {
  readonly key: string;
  readonly label: string;
  readonly value: number | null;
  readonly format: "views" | "percent" | "count" | "decimal";
  readonly trend: Trend;
}

export interface ReportData {
  readonly brand: typeof BRAND;
  readonly generatedAt: number;
  readonly range: DateRange;
  readonly comparisonRange: DateRange;
  readonly periodLabel: string;
  readonly nicheName: string | null;
  readonly threshold: number;
  /**
   * Whether this threshold is the niche configured default or an account-wide
   * one. Printed on the cover so a GTA report at 1M and an RDR report at 750K
   * are never mistaken for the same measurement.
   */
  readonly thresholdSource: "niche" | "account" | "override";

  readonly summary: readonly ReportSummaryMetric[];
  readonly marketShare: MarketShare;
  readonly marketShareTrend: Trend;
  readonly marketShareSeries: readonly MarketSharePoint[];
  readonly comparison: MarketComparison;

  readonly ourChannels: readonly ReportChannelRow[];
  readonly topWinners: readonly ReportShort[];
  readonly topOutliers: readonly ReportShort[];

  readonly insights: readonly string[];

  readonly trackedChannelCount: number;
  readonly ownChannelCount: number;
  readonly competitorChannelCount: number;
}

export interface BuildReportOptions {
  readonly dataset: DatasetDTO;
  readonly range: DateRange;
  readonly threshold: number;
  /** `null` / "all" reports across every tracked channel. */
  readonly nicheId: string | null;
  readonly periodLabel: string;
  readonly now: number;
  readonly thresholdSource?: "niche" | "account" | "override";
}

function scopeToNiche(
  dataset: DatasetDTO,
  nicheId: string | null,
): DatasetDTO["channels"] {
  if (!nicheId || nicheId === "all") return dataset.channels;
  if (nicheId === "unassigned") {
    return dataset.channels.filter((c) => c.channel.niches.length === 0);
  }
  return dataset.channels.filter((c) => c.channel.niches.some((n) => n.id === nicheId));
}

export function buildReport(options: BuildReportOptions): ReportData {
  const { dataset, range, threshold, nicheId, periodLabel, now } = options;

  const scoped = scopeToNiche(dataset, nicheId);
  const comparisonRange = previousRange(range);

  const ours = scoped.filter((c) => c.channel.ownershipType === "own");
  const competitors = scoped.filter((c) => c.channel.ownershipType !== "own");

  const allVideos = scoped.flatMap((c) => [...c.videos]);

  // --- Portfolio metrics, this period and the previous one ------------------
  const current = calculateChannelMetrics({ videos: allVideos, range, threshold });
  const previous = calculateChannelMetrics({
    videos: allVideos,
    range: comparisonRange,
    threshold,
  });

  const marketShare = calculateMarketShare(
    ours.map((c) => ({ videos: c.videos })),
    competitors.map((c) => ({ videos: c.videos })),
    range,
  );
  const previousShare = calculateMarketShare(
    ours.map((c) => ({ videos: c.videos })),
    competitors.map((c) => ({ videos: c.videos })),
    comparisonRange,
  );

  const comparison = compareToMarket(
    ours.map((c) => ({ videos: c.videos })),
    competitors.map((c) => ({ videos: c.videos })),
    range,
    threshold,
  );

  const summary: ReportSummaryMetric[] = [
    {
      key: "totalViews",
      label: "Views of period uploads",
      value: current.totalViews,
      format: "views",
      trend: calculateTrend(current.totalViews, previous.totalViews, {
        direction: "higherIsBetter",
        unit: "relativePercent",
      }),
    },
    {
      key: "hitRate",
      label: "Hit rate",
      value: current.hitRate,
      format: "percent",
      trend: calculateTrend(current.hitRate, previous.hitRate, {
        direction: "higherIsBetter",
        unit: "percentagePoints",
      }),
    },
    {
      key: "shortsUploaded",
      label: "Shorts uploaded",
      value: current.totalShorts,
      format: "count",
      // Volume is a strategy choice, not a result — shown without a verdict.
      trend: calculateTrend(current.totalShorts, previous.totalShorts, {
        direction: "neutral",
        unit: "relativePercent",
      }),
    },
    {
      key: "medianViews",
      label: "Median views",
      value: current.medianViews,
      format: "views",
      trend: calculateTrend(current.medianViews, previous.medianViews, {
        direction: "higherIsBetter",
        unit: "relativePercent",
      }),
    },
    {
      key: "marketShare",
      label: "Tracked market share",
      value: marketShare.sharePercent,
      format: "percent",
      trend: calculateTrend(marketShare.sharePercent, previousShare.sharePercent, {
        direction: "higherIsBetter",
        unit: "percentagePoints",
      }),
    },
    {
      key: "trackedChannels",
      label: "Tracked channels",
      value: scoped.length,
      format: "count",
      trend: calculateTrend(scoped.length, scoped.length, {
        direction: "neutral",
        unit: "relativePercent",
      }),
    },
  ];

  const marketShareTrend = calculateTrend(
    marketShare.sharePercent,
    previousShare.sharePercent,
    { direction: "higherIsBetter", unit: "percentagePoints" },
  );

  // --- Our channels, individually ------------------------------------------
  const ourChannels: ReportChannelRow[] = ours
    .map((entry) => {
      const metrics = calculateChannelMetrics({ videos: entry.videos, range, threshold });
      const prior = calculateChannelMetrics({
        videos: entry.videos,
        range: comparisonRange,
        threshold,
      });
      return {
        channel: entry.channel,
        metrics,
        viewsTrend: calculateTrend(metrics.totalViews, prior.totalViews, {
          direction: "higherIsBetter",
          unit: "relativePercent",
        }),
        hitRateTrend: calculateTrend(metrics.hitRate, prior.hitRate, {
          direction: "higherIsBetter",
          unit: "percentagePoints",
        }),
      };
    })
    .sort((a, b) => b.metrics.totalViews - a.metrics.totalViews);

  // --- Competitive intelligence --------------------------------------------
  const nicheNameById = new Map(dataset.niches.map((n: NicheDTO) => [n.id, n.name]));
  const channelById = new Map(scoped.map((c) => [c.channel.id, c.channel]));

  const scored = calculateOutliers(
    scoped.map((c) => ({ channelId: c.channel.id, videos: c.videos })),
    range,
    baselineRangeFor(range),
    now,
  );

  const toReportShort = (item: OutlierShort): ReportShort => {
    const channel = channelById.get(item.channelId);
    return {
      title: item.video.title,
      youtubeVideoId: item.video.youtubeVideoId,
      channelName: channel?.displayName ?? "Unknown",
      nicheNames: (channel?.niches ?? []).map((n) => nicheNameById.get(n.id) ?? n.name),
      views: item.video.views,
      outlierMultiple: item.outlierMultiple,
      publishedAt: item.video.publishedAt,
    };
  };

  const topWinners = sortOutliers(scored, "views").slice(0, 5).map(toReportShort);
  const topOutliers = sortOutliers(
    scored.filter((s) => s.outlierMultiple !== null),
    "outlierMultiple",
  )
    .slice(0, 5)
    .map(toReportShort);

  const nicheName =
    !nicheId || nicheId === "all"
      ? null
      : nicheId === "unassigned"
        ? "Uncategorised"
        : (nicheNameById.get(nicheId) ?? null);

  return {
    brand: BRAND,
    generatedAt: now,
    range,
    comparisonRange,
    periodLabel,
    nicheName,
    threshold,
    thresholdSource: options.thresholdSource ?? "account",
    summary,
    marketShare,
    marketShareTrend,
    marketShareSeries: calculateMarketShareSeries(
      ours.map((c) => ({ videos: c.videos })),
      competitors.map((c) => ({ videos: c.videos })),
      range,
      pickShareGranularity(range),
    ),
    comparison,
    ourChannels,
    topWinners,
    topOutliers,
    insights: buildInsights({
      current,
      previous,
      marketShare,
      previousShare,
      comparison,
      ourChannels,
      dataset,
      range,
      threshold,
      nicheId,
    }),
    trackedChannelCount: scoped.length,
    ownChannelCount: ours.length,
    competitorChannelCount: competitors.length,
  };
}

/**
 * Automatic insights.
 *
 * Every sentence is a direct restatement of a computed number. No causal
 * claims ("because GTA 6 speculation picked up"), no speculation about *why* —
 * the data cannot support that, and a report that invents explanations is
 * worse than one that states less. An insight is omitted entirely when its
 * inputs are missing rather than hedged into vagueness.
 */
function buildInsights(input: {
  current: ChannelMetrics;
  previous: ChannelMetrics;
  marketShare: MarketShare;
  previousShare: MarketShare;
  comparison: MarketComparison;
  ourChannels: readonly ReportChannelRow[];
  dataset: DatasetDTO;
  range: DateRange;
  threshold: number;
  nicheId: string | null;
}): string[] {
  const out: string[] = [];
  const fmtPct = (v: number | null) => (v === null ? null : `${v.toFixed(1)}%`);

  // Market share movement.
  if (
    input.marketShare.sharePercent !== null &&
    input.previousShare.sharePercent !== null
  ) {
    const from = input.previousShare.sharePercent;
    const to = input.marketShare.sharePercent;
    const delta = to - from;
    if (Math.abs(delta) >= 0.5) {
      out.push(
        `Tracked market share ${delta > 0 ? "increased" : "decreased"} from ${fmtPct(from)} to ${fmtPct(to)} (${delta > 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)} pp).`,
      );
    } else {
      out.push(`Tracked market share held steady at ${fmtPct(to)}.`);
    }
  }

  // Hit rate movement, and how it sits against the market.
  if (input.current.hitRate !== null && input.previous.hitRate !== null) {
    const delta = input.current.hitRate - input.previous.hitRate;
    if (Math.abs(delta) >= 0.5) {
      out.push(
        `Hit rate ${delta > 0 ? "increased" : "decreased"} by ${Math.abs(delta).toFixed(1)} percentage points, to ${fmtPct(input.current.hitRate)}.`,
      );
    }
  }

  const hitRateMetric = input.comparison.metrics.find((m) => m.key === "hitRate");
  if (
    hitRateMetric &&
    hitRateMetric.ours !== null &&
    hitRateMetric.market !== null &&
    input.comparison.ours.shorts.length > 0 &&
    input.comparison.market.shorts.length > 0
  ) {
    const gap = hitRateMetric.ours - hitRateMetric.market;
    out.push(
      `Our hit rate of ${fmtPct(hitRateMetric.ours)} is ${Math.abs(gap).toFixed(1)} pp ${gap >= 0 ? "above" : "below"} the tracked market at ${fmtPct(hitRateMetric.market)}.`,
    );
  }

  // Strongest own channel by views, only when there is more than one to rank.
  if (input.ourChannels.length > 1) {
    const best = input.ourChannels[0];
    if (best.metrics.totalShorts > 0) {
      out.push(
        `${best.channel.displayName} was our strongest channel this period with ${formatCompactForInsight(best.metrics.totalViews)} views across ${best.metrics.totalShorts} Shorts.`,
      );
    }
  }

  // Strongest niche, but only on an all-niches report where the comparison is
  // meaningful.
  if (!input.nicheId || input.nicheId === "all") {
    const byNiche = new Map<string, { name: string; views: number }>();
    for (const entry of input.dataset.channels) {
      if (entry.channel.ownershipType !== "own") continue;
      const metrics = calculateChannelMetrics({
        videos: entry.videos,
        range: input.range,
        threshold: input.threshold,
      });
      for (const niche of entry.channel.niches) {
        const acc = byNiche.get(niche.id) ?? { name: niche.name, views: 0 };
        acc.views += metrics.totalViews;
        byNiche.set(niche.id, acc);
      }
    }
    const ranked = [...byNiche.values()].sort((a, b) => b.views - a.views);
    if (ranked.length > 1 && ranked[0].views > 0) {
      out.push(
        `${ranked[0].name} was our strongest niche by Shorts views (${formatCompactForInsight(ranked[0].views)}).`,
      );
    }
  }

  return out;
}

/** Local compact formatter so this module has no UI dependency. */
function formatCompactForInsight(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  if (abs < 1_000_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  if (abs < 1_000_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return `${(value / 1_000_000_000).toFixed(2).replace(/\.?0+$/, "")}B`;
}

export { median, sum };
