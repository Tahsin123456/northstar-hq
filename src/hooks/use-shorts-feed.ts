"use client";

import * as React from "react";
import {
  calculateOutliers,
  sortOutliers,
  type OutlierShort,
  type OutlierSortKey,
} from "@/lib/analytics/outliers";
import type { DateRange } from "@/lib/analytics/types";
import type { ChannelDTO, DatasetDTO, NicheRefDTO, OwnershipType } from "@/lib/dto";
import type { NicheFilter, OwnershipFilter } from "@/lib/filters-store";
import { useNow } from "./use-now";

/**
 * The shared Shorts feed.
 *
 * Winners, Outliers and every Shorts table read from this one derivation, so a
 * Short's outlier multiple is identical wherever it appears. Building a second
 * scoring path per page is exactly how two screens end up disagreeing about the
 * same number.
 *
 * Like every other filter in this app, it is a pure transform over the dataset
 * already in memory — no page here issues a request of its own.
 */

/** A scored Short with the channel context the UI needs to render it. */
export interface FeedShort extends OutlierShort {
  readonly channel: ChannelDTO;
  readonly niches: readonly NicheRefDTO[];
  readonly ownershipType: OwnershipType;
  readonly isSaved: boolean;
}

export interface FeedOptions {
  /** Window the Shorts themselves must fall inside. */
  readonly range: DateRange;
  /**
   * Window used to compute each channel's median baseline.
   *
   * Deliberately separate from `range`: judging a 2-day-old Short against a
   * 2-day median would compare it to one or two siblings. A wider baseline is
   * what makes "typical for this channel" mean anything.
   */
  readonly baselineRange: DateRange;
  readonly niche: NicheFilter;
  readonly ownership: OwnershipFilter;
  readonly minViews?: number;
  readonly channelId?: string | null;
  readonly sort?: OutlierSortKey;
  /** Drop Shorts whose channel has too small a sample to benchmark. */
  readonly requireReliableBaseline?: boolean;
}

function matchesNiche(niches: readonly NicheRefDTO[], niche: NicheFilter): boolean {
  if (niche === "all") return true;
  if (niche === "unassigned") return niches.length === 0;
  return niches.some((n) => n.id === niche);
}

export function useShortsFeed(
  dataset: DatasetDTO | undefined,
  options: FeedOptions,
): FeedShort[] {
  const now = useNow();

  const {
    range,
    baselineRange,
    niche,
    ownership,
    minViews = 0,
    channelId = null,
    sort = "outlierMultiple",
    requireReliableBaseline = false,
  } = options;

  return React.useMemo(() => {
    if (!dataset) return [];

    const savedVideoIds = new Set(dataset.savedShorts.map((s) => s.videoId));

    // Scope channels first so a filtered feed never pays to score channels it
    // will discard — and, more importantly, so the baseline of an excluded
    // channel can never leak into the ranking.
    const scoped = dataset.channels.filter((entry) => {
      if (channelId && entry.channel.id !== channelId) return false;
      if (ownership !== "all" && entry.channel.ownershipType !== ownership) return false;
      return matchesNiche(entry.channel.niches, niche);
    });

    const channelById = new Map(scoped.map((entry) => [entry.channel.id, entry.channel]));

    const scored = calculateOutliers(
      scoped.map((entry) => ({ channelId: entry.channel.id, videos: entry.videos })),
      range,
      baselineRange,
      // `now` is 0 until the clock store subscribes; fall back to the range end
      // so views-per-day is never computed against the epoch.
      now === 0 ? range.endMs : now,
    );

    const enriched: FeedShort[] = [];
    for (const item of scored) {
      const channel = channelById.get(item.channelId);
      if (!channel) continue;
      if (item.video.views < minViews) continue;
      if (requireReliableBaseline && item.outlierMultiple === null) continue;

      enriched.push({
        ...item,
        channel,
        niches: channel.niches,
        ownershipType: channel.ownershipType,
        isSaved: savedVideoIds.has(item.video.id),
      });
    }

    return sortOutliers(enriched, sort) as FeedShort[];
  }, [
    dataset,
    range,
    baselineRange,
    niche,
    ownership,
    minViews,
    channelId,
    sort,
    requireReliableBaseline,
    now,
  ]);
}

/**
 * Builds the baseline window for a given analysis range.
 *
 * At least 90 days, and always at least as wide as the range itself. A short
 * feed window (24h, 3d) still gets a meaningful denominator, while a 180-day
 * analysis keeps its own span rather than being benchmarked against a narrower
 * slice of itself.
 */
export function baselineRangeFor(range: DateRange): DateRange {
  const MIN_BASELINE_MS = 90 * 86_400_000;
  const span = range.endMs - range.startMs;
  const width = Math.max(MIN_BASELINE_MS, span);
  return { startMs: range.endMs - width, endMs: range.endMs };
}
