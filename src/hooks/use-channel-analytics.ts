"use client";

import * as React from "react";
import { calculateChannelMetrics, calculatePortfolioSummary } from "@/lib/analytics/channel-metrics";
import {
  calculateContentTypePerformance,
  type ContentTypePerformance,
} from "@/lib/analytics/content-type-performance";
import type { ChannelMetrics, DateRange, PortfolioSummary } from "@/lib/analytics";
import type { ChannelDTO, ContentTypeDTO, DatasetDTO, VideoDTO } from "@/lib/dto";
import { useFilters } from "@/components/providers/filters-provider";
import { sortRows, type SortState } from "@/lib/sorting";
import type {
  ContentTypeFilter,
  NicheFilter,
  OwnershipFilter,
} from "@/lib/filters-store";

export interface ChannelRow {
  readonly channel: ChannelDTO;
  readonly metrics: ChannelMetrics;
  readonly videos: readonly VideoDTO[];
  readonly excludedCount: number;
  readonly unclassifiedCount: number;
}

/**
 * Derives every channel's metrics for the current period and threshold.
 *
 * This is where the "changing a filter recalculates instead of refetching"
 * promise is actually kept. The dataset is an immutable object from the query
 * cache; the filters are plain state. When either changes this memo re-runs the
 * analytics engine over in-memory arrays — a few milliseconds for thousands of
 * videos — and no request is made.
 */
export function useChannelRows(dataset: DatasetDTO | undefined): ChannelRow[] {
  const { range, threshold } = useFilters();

  return React.useMemo(() => {
    if (!dataset) return [];
    return dataset.channels.map((entry) => ({
      channel: entry.channel,
      videos: entry.videos,
      excludedCount: entry.excludedCount,
      unclassifiedCount: entry.unclassifiedCount,
      metrics: calculateChannelMetrics({
        videos: entry.videos,
        range,
        threshold,
      }),
    }));
  }, [dataset, range, threshold]);
}

/** Case-insensitive search across the display name, YouTube title and handle. */
export function filterRows(rows: readonly ChannelRow[], query: string): ChannelRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...rows];

  return rows.filter((row) => {
    const { displayName, title, handle } = row.channel;
    return (
      displayName.toLocaleLowerCase().includes(needle) ||
      title.toLocaleLowerCase().includes(needle) ||
      (handle ?? "").toLocaleLowerCase().includes(needle)
    );
  });
}

/**
 * The minimal row shape the scope predicate reads.
 *
 * Generic over this rather than the full `ChannelRow` so the rule stays
 * testable without fabricating metrics that play no part in it. The videos are
 * NO LONGER part of it — see the predicate below.
 */
export type ScopeableRow = {
  channel: Pick<ChannelDTO, "niches" | "ownershipType" | "contentTypeIds">;
};

/**
 * Applies the niche, content-type and ownership scope.
 *
 * Runs *before* metrics are read, so every downstream number — the summary
 * cards, the ranking, the comparison — describes only the scoped set. That is
 * what makes "GTA + Our Channels + 30D + ≥1M" a single coherent question
 * rather than a filtered view of a global average.
 *
 * THE CONTENT-TYPE PREDICATE READS THE CHANNEL'S OWN TAGS AGAIN.
 *
 * `ChannelContentType` is back, so "channels that make Rankings" is answered by
 * the tag on the channel rather than by scanning every Short it ever published
 * for one. That is the simplification the flat catalogue makes available, and
 * it is a better answer as well as a cheaper one: a channel tagged "Rankings"
 * is the team saying what they watch it for, whereas "has at least one Short
 * filed as a Ranking" made a channel that posted one ranking in 2024 a
 * permanent member of the set.
 *
 * It also drops the niche narrowing entirely. A content type belongs to no
 * niche now, so there is no "type within the niche" to compose — niche and type
 * are two independent narrowings again, and picking "Rankings" with no niche
 * selected is a perfectly ordinary org-wide question.
 *
 * The row is still the CHANNEL, and its metrics still describe everything the
 * channel published — this narrows which channels appear, never which of their
 * Shorts count. A row labelled "Ranking" whose hit rate silently described only
 * its rankings would be a different, unasked question. Per-Short filtering
 * happens where Shorts are the unit: `useShortsFeed` and the Shorts table.
 */
export function filterRowsByScope<T extends ScopeableRow>(
  rows: readonly T[],
  niche: NicheFilter,
  ownership: OwnershipFilter,
  // Defaulted so the existing three-argument callers — and the tests that pin
  // niche scoping down — keep meaning exactly what they meant before.
  contentType: ContentTypeFilter = "all",
): T[] {
  return rows.filter((row) => {
    if (ownership !== "all" && row.channel.ownershipType !== ownership) return false;

    if (contentType !== "all") {
      const tags = row.channel.contentTypeIds;
      // "Untagged" is a channel nobody has described — the backlog this filter
      // exists to find.
      if (contentType === "unassigned") {
        if (tags.length > 0) return false;
      } else if (!tags.includes(contentType)) {
        return false;
      }
    }

    if (niche === "all") return true;
    if (niche === "unassigned") return row.channel.niches.length === 0;
    return row.channel.niches.some((n) => n.id === niche);
  });
}

/**
 * How many channels carry no content-type tag at all.
 *
 * Lives beside the predicate rather than being re-derived at each call site,
 * because it has to agree with the "unassigned" branch above exactly: a count
 * that disagreed with the filter it labels would offer "Untagged · 12" and then
 * show eleven rows.
 */
export function untaggedChannelCount(rows: readonly ScopeableRow[]): number {
  return rows.filter((row) => row.channel.contentTypeIds.length === 0).length;
}

/**
 * The full client-side pipeline: scope, then search, then sort.
 *
 * All three are pure transforms over data already in memory. Adding niche and
 * ownership changed nothing about the network behaviour — selecting a niche is
 * exactly as free as changing the threshold.
 *
 * The scope arrives as three primitives rather than an options object so the
 * memo keys on stable values. An object literal from the caller would be a new
 * reference every render, quietly defeating the memo.
 */
export function useVisibleRows(
  rows: readonly ChannelRow[],
  query: string,
  sort: SortState,
  niche: NicheFilter = "all",
  ownership: OwnershipFilter = "all",
  ownFirst = false,
  contentType: ContentTypeFilter = "all",
): ChannelRow[] {
  return React.useMemo(
    () =>
      sortRows(
        filterRows(filterRowsByScope(rows, niche, ownership, contentType), query),
        sort,
        { ownFirst },
      ),
    [rows, query, sort, niche, ownership, ownFirst, contentType],
  );
}

/** Rows after scope but before search — what the summary cards describe. */
export function useScopedRows<T extends ScopeableRow>(
  rows: readonly T[],
  niche: NicheFilter,
  ownership: OwnershipFilter,
  contentType: ContentTypeFilter = "all",
): T[] {
  return React.useMemo(
    () => filterRowsByScope(rows, niche, ownership, contentType),
    [rows, niche, ownership, contentType],
  );
}

/**
 * Portfolio metrics for the active period, or for an explicit window.
 *
 * The override exists so a caller can request the *previous* equivalent period
 * with the identical calculation path — a trend is only trustworthy when both
 * of its numbers were produced the same way.
 */
export function usePortfolioSummary(
  rows: readonly ChannelRow[],
  overrideRange?: DateRange,
): PortfolioSummary {
  const { range, threshold } = useFilters();
  const effective = overrideRange ?? range;

  return React.useMemo(
    () =>
      calculatePortfolioSummary(
        rows.map((row) => ({
          id: row.channel.id,
          name: row.channel.displayName,
          // Recompute against the requested window rather than reusing
          // row.metrics, which is always scoped to the active period.
          metrics: overrideRange
            ? calculateChannelMetrics({ videos: row.videos, range: effective, threshold })
            : row.metrics,
        })),
      ),
    [rows, overrideRange, effective, threshold],
  );
}

/**
 * "What kind of content is actually working?" over a set of channel rows.
 *
 * The rows are flattened into one pool of Shorts and handed to the pure
 * aggregate — the SAME derivation the tests pin, with nothing recomputed here.
 * It runs over the active period and threshold from `useFilters`, so the table
 * moves with every other number on the screen.
 *
 * A HOOK RATHER THAN A CALL AT EACH SITE, for the reason every other memo in
 * this file exists: the pool is a few thousand videos and this re-runs whenever
 * a filter moves. Nothing here touches the network — it is the same in-memory
 * transform as the channel rows above.
 */
export function useContentTypePerformance(
  rows: readonly ChannelRow[],
  contentTypes: readonly ContentTypeDTO[],
): ContentTypePerformance {
  const { range, threshold } = useFilters();

  return React.useMemo(
    () =>
      calculateContentTypePerformance({
        videos: rows.flatMap((row) => row.videos),
        range,
        threshold,
        contentTypes,
      }),
    [rows, contentTypes, range, threshold],
  );
}

/** Finds one channel's row by id. */
export function useChannelRow(
  dataset: DatasetDTO | undefined,
  channelId: string,
): ChannelRow | null {
  const rows = useChannelRows(dataset);
  return React.useMemo(
    () => rows.find((row) => row.channel.id === channelId) ?? null,
    [rows, channelId],
  );
}
