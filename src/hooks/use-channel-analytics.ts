"use client";

import * as React from "react";
import { calculateChannelMetrics, calculatePortfolioSummary } from "@/lib/analytics/channel-metrics";
import type { ChannelMetrics, DateRange, PortfolioSummary } from "@/lib/analytics";
import type { ChannelDTO, DatasetDTO, VideoDTO } from "@/lib/dto";
import { useFilters } from "@/components/providers/filters-provider";
import { sortRows, type SortState } from "@/lib/sorting";
import type { NicheFilter, OwnershipFilter } from "@/lib/filters-store";

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
 * Applies the niche and ownership scope.
 *
 * Runs *before* metrics are read, so every downstream number — the summary
 * cards, the ranking, the comparison — describes only the scoped set. That is
 * what makes "GTA + Our Channels + 30D + ≥1M" a single coherent question
 * rather than a filtered view of a global average.
 */
export function filterRowsByScope<
  // Generic over the minimal shape it actually reads, rather than the full
  // ChannelRow. The predicate needs two fields; demanding the whole row would
  // make it untestable without fabricating video arrays that play no part in
  // the logic.
  T extends { channel: Pick<ChannelDTO, "niches" | "ownershipType"> },
>(rows: readonly T[], niche: NicheFilter, ownership: OwnershipFilter): T[] {
  return rows.filter((row) => {
    if (ownership !== "all" && row.channel.ownershipType !== ownership) return false;

    if (niche === "all") return true;
    if (niche === "unassigned") return row.channel.niches.length === 0;
    return row.channel.niches.some((n) => n.id === niche);
  });
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
): ChannelRow[] {
  return React.useMemo(
    () =>
      sortRows(filterRows(filterRowsByScope(rows, niche, ownership), query), sort, {
        ownFirst,
      }),
    [rows, query, sort, niche, ownership, ownFirst],
  );
}

/** Rows after scope but before search — what the summary cards describe. */
export function useScopedRows<
  T extends { channel: Pick<ChannelDTO, "niches" | "ownershipType"> },
>(
  rows: readonly T[],
  niche: NicheFilter,
  ownership: OwnershipFilter,
): T[] {
  return React.useMemo(
    () => filterRowsByScope(rows, niche, ownership),
    [rows, niche, ownership],
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
