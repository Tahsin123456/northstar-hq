"use client";

import * as React from "react";
import {
  calculateOutliers,
  sortOutliers,
  type OutlierShort,
  type OutlierSortKey,
} from "@/lib/analytics/outliers";
import { effectiveContentTypeIds } from "@/lib/content-types/resolve";
import type { DateRange } from "@/lib/analytics/types";
import type { ChannelDTO, DatasetDTO, NicheRefDTO, OwnershipType } from "@/lib/dto";
import type {
  ContentTypeFilter,
  NicheFilter,
  OwnershipFilter,
} from "@/lib/filters-store";
import { useSession } from "@/components/providers/session-provider";
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
  /** Whether *this* viewer has saved it. Saves are personal, so a colleague's does not count. */
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
  /**
   * Which content type the Shorts themselves must carry, EFFECTIVELY.
   *
   * A PER-SHORT predicate here, unlike the channel-list filter in
   * `filterRowsByScope` which reads the channel's own tags. That is not an
   * inconsistency — it is the two surfaces having different units. A row on the
   * dashboard is a channel and its numbers describe everything that channel
   * published, so filtering it by a per-Short label would put a figure next to a
   * label that did not describe it. Here the row IS a Short, so what that Short
   * actually carries — inherited from its channel or filed against it directly —
   * is exactly the right question.
   */
  readonly contentType?: ContentTypeFilter;
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
  // Saves are personal, and an admin's payload deliberately carries the whole
  // team's. Without narrowing to the viewer, every Short a colleague had saved
  // would render with a filled bookmark on an admin's feed, and clicking it
  // would do nothing — the server un-saves the caller's row, and there is none.
  const viewerId = useSession().user.id;

  const {
    range,
    baselineRange,
    niche,
    ownership,
    contentType = "all",
    minViews = 0,
    channelId = null,
    sort = "outlierMultiple",
    requireReliableBaseline = false,
  } = options;

  return React.useMemo(() => {
    if (!dataset) return [];

    const savedVideoIds = new Set(
      dataset.savedShorts.filter((s) => s.savedById === viewerId).map((s) => s.videoId),
    );

    // Scope channels first so a filtered feed never pays to score channels it
    // will discard — and, more importantly, so the baseline of an excluded
    // channel can never leak into the ranking.
    const scoped = dataset.channels.filter((entry) => {
      if (channelId && entry.channel.id !== channelId) return false;
      if (ownership !== "all" && entry.channel.ownershipType !== ownership) return false;
      return matchesNiche(entry.channel.niches, niche);
    });

    const channelById = new Map(scoped.map((entry) => [entry.channel.id, entry.channel]));

    /*
     * The content-type predicate, as a set of video ids to keep.
     *
     * Built here and applied AFTER scoring, never before. `calculateOutliers`
     * derives each channel's median from its whole baseline window, and a
     * channel's typical Short is a fact about the channel — narrowing the input
     * to one content type would silently re-baseline every multiple against
     * "typical for this channel's rankings", so a ranking could never be an
     * outlier among rankings. Filtering the output keeps the multiples the same
     * numbers they are on every other screen.
     *
     * MATCHED ON EFFECTIVE TAGS, WHICH IS THE ONLY WAY IT FINDS ANYTHING.
     *
     * A Short inheriting "Memes" from its channel stores no row for it, so the
     * old `video.contentTypeIds.includes(...)` would have matched only the
     * handful of Shorts somebody had singled out — and would have returned an
     * almost empty feed for a tag applied to thousands of Shorts. Resolving each
     * candidate against its channel is what makes "Memes" mean the Memes.
     *
     * "Unassigned" comes along for free and gets stricter: a Short with nothing
     * effective is one whose channel is untagged AND which nobody classified,
     * rather than merely one with no row of its own.
     *
     * `null` means no filter at all, which is the overwhelmingly common case and
     * skips the resolve pass entirely.
     */
    const allowedVideoIds =
      contentType === "all"
        ? null
        : new Set(
            scoped.flatMap((entry) => {
              const channelTypeIds = entry.channel.contentTypeIds;
              return entry.videos
                .filter((video) => {
                  const effective = effectiveContentTypeIds({
                    channelTypeIds,
                    manualIds: video.manualContentTypeIds,
                    excludedIds: video.excludedContentTypeIds,
                  });
                  return contentType === "unassigned"
                    ? effective.length === 0
                    : effective.includes(contentType);
                })
                .map((video) => video.id);
            }),
          );

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
      if (allowedVideoIds && !allowedVideoIds.has(item.video.id)) continue;
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
    contentType,
    minViews,
    channelId,
    sort,
    requireReliableBaseline,
    now,
    viewerId,
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
