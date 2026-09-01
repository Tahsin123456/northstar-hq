import { videosInDateRange } from "./filters";
import { roundTo, sum } from "./stats";
import type { NicheFormat } from "@/lib/niches/niche-format";
import type { AnalyticsVideo, DateRange } from "./types";

/**
 * =========================================================================
 * TRACKED MARKET SHARE
 * =========================================================================
 *
 * What proportion of Shorts views inside the tracked set belong to our
 * channels?
 *
 *     share = our Shorts views / (our + competitor Shorts views)
 *
 * NAMING IS LOAD-BEARING
 * This is *tracked* market share, never "market share". The app only knows
 * about channels the user has chosen to track — a handful of competitors out
 * of a niche that may contain thousands. Calling it market share would imply
 * a denominator the system has no access to, and would turn a useful internal
 * benchmark into a number someone repeats in a board meeting as if it were an
 * industry statistic. Every label, tooltip and PDF heading says "tracked".
 *
 * The denominator also moves when you add or remove a competitor, which is
 * another reason the qualifier matters: the metric describes a set the user
 * curates, not a fixed market.
 */

export const TRACKED_MARKET_SHARE_DEFINITION =
  "Tracked market share is our share of total Shorts views among the channels currently tracked for this niche and period. It is not total YouTube market share — the denominator only contains channels you have added to the tracker, so it moves when you add or remove competitors.";

export interface MarketShare {
  readonly ourViews: number;
  readonly competitorViews: number;
  readonly totalViews: number;
  /** Percentage 0..100, or `null` when the tracked set produced no views. */
  readonly sharePercent: number | null;
  readonly ourShorts: number;
  readonly competitorShorts: number;
}

export function calculateMarketShare(
  ourChannels: readonly { videos: readonly AnalyticsVideo[] }[],
  competitorChannels: readonly { videos: readonly AnalyticsVideo[] }[],
  range: DateRange,
  // Which format's views make up the tracked market. Defaulted to shorts so
  // every existing surface — the niche cards, Our vs Market, the earnings
  // panel — keeps computing exactly what it always did.
  format: NicheFormat = "shorts",
): MarketShare {
  const ourShorts = ourChannels.flatMap((c) => videosInDateRange(c.videos, range, format));
  const competitorShorts = competitorChannels.flatMap((c) =>
    videosInDateRange(c.videos, range, format),
  );

  const ourViews = sum(ourShorts.map((s) => s.views));
  const competitorViews = sum(competitorShorts.map((s) => s.views));
  const totalViews = ourViews + competitorViews;

  return {
    ourViews,
    competitorViews,
    totalViews,
    // `null` rather than 0 when nothing was published: a share of nothing is
    // undefined, not zero.
    sharePercent: totalViews === 0 ? null : roundTo((ourViews / totalViews) * 100, 1),
    ourShorts: ourShorts.length,
    competitorShorts: competitorShorts.length,
  };
}

export interface MarketSharePoint {
  readonly bucketStartMs: number;
  readonly bucketEndMs: number;
  readonly label: string;
  readonly sharePercent: number | null;
  readonly ourViews: number;
  readonly competitorViews: number;
}

export type ShareGranularity = "week" | "month";

function bucketStart(ms: number, granularity: ShareGranularity): number {
  const date = new Date(ms);
  if (granularity === "week") {
    const daysSinceMonday = (date.getDay() + 6) % 7;
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate() - daysSinceMonday,
    ).getTime();
  }
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

function nextBucket(ms: number, granularity: ShareGranularity): number {
  const date = new Date(ms);
  if (granularity === "week") {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 7).getTime();
  }
  return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
}

function label(ms: number, granularity: ShareGranularity): string {
  const date = new Date(ms);
  return granularity === "month"
    ? date.toLocaleDateString(undefined, { month: "short", year: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function pickShareGranularity(range: DateRange): ShareGranularity {
  const days = (range.endMs - range.startMs) / 86_400_000;
  return days <= 120 ? "week" : "month";
}

/**
 * Tracked market share bucketed over time.
 *
 * A bucket with no tracked views anywhere yields `null`, not 0 — the same rule
 * the hit-rate series uses. A week when nobody in the niche published is a gap
 * in the line, not a collapse to zero share.
 */
export function calculateMarketShareSeries(
  ourChannels: readonly { videos: readonly AnalyticsVideo[] }[],
  competitorChannels: readonly { videos: readonly AnalyticsVideo[] }[],
  range: DateRange,
  granularity: ShareGranularity = pickShareGranularity(range),
  // Same default and same reasoning as `calculateMarketShare` above. No Long
  // Form surface draws this series yet; the parameter exists so the two
  // functions cannot drift apart on which views they count.
  format: NicheFormat = "shorts",
): MarketSharePoint[] {
  const ourShorts = ourChannels.flatMap((c) => videosInDateRange(c.videos, range, format));
  const competitorShorts = competitorChannels.flatMap((c) =>
    videosInDateRange(c.videos, range, format),
  );

  const ourByBucket = new Map<number, number>();
  const theirsByBucket = new Map<number, number>();

  for (const short of ourShorts) {
    const key = bucketStart(short.publishedAt, granularity);
    ourByBucket.set(key, (ourByBucket.get(key) ?? 0) + short.views);
  }
  for (const short of competitorShorts) {
    const key = bucketStart(short.publishedAt, granularity);
    theirsByBucket.set(key, (theirsByBucket.get(key) ?? 0) + short.views);
  }

  const points: MarketSharePoint[] = [];
  let cursor = bucketStart(range.startMs, granularity);
  let guard = 0;

  while (cursor < range.endMs && guard < 500) {
    guard += 1;
    const end = nextBucket(cursor, granularity);
    const ourViews = ourByBucket.get(cursor) ?? 0;
    const competitorViews = theirsByBucket.get(cursor) ?? 0;
    const total = ourViews + competitorViews;

    points.push({
      bucketStartMs: cursor,
      bucketEndMs: end,
      label: label(cursor, granularity),
      sharePercent: total === 0 ? null : roundTo((ourViews / total) * 100, 1),
      ourViews,
      competitorViews,
    });

    cursor = end;
  }

  return points;
}
