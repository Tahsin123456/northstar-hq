"use client";

import * as React from "react";
import { calculateChannelMetrics, calculatePortfolioSummary } from "@/lib/analytics/channel-metrics";
import {
  calculateContentTypePerformance,
  type ContentTypePerformance,
} from "@/lib/analytics/content-type-performance";
import type { ChannelMetrics, DateRange, PortfolioSummary } from "@/lib/analytics";
import type { ChannelDTO, ContentTypeDTO, DatasetDTO, VideoDTO } from "@/lib/dto";
import { EMPTY_RESOLUTION } from "@/lib/content-types/resolve";
import { useFilters } from "@/components/providers/filters-provider";
import { useVideoContentTypeResolutions } from "./use-content-types";
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
 * Derives every channel's metrics for the current period.
 *
 * This is where the "changing a filter recalculates instead of refetching"
 * promise is actually kept. The dataset is an immutable object from the query
 * cache; the filters are plain state. When either changes this memo re-runs the
 * analytics engine over in-memory arrays — a few milliseconds for thousands of
 * videos — and no request is made.
 *
 * THE PROMISE SURVIVED THE RULE CHANGE, and it is worth saying how. A hit is
 * now views-within-a-window, decided from a snapshot series the browser does
 * not have — so on the face of it the client can no longer compute the headline
 * number at all. It does not have to: the VERDICT ships with each video on the
 * dataset payload, already decided, and everything here is still arithmetic
 * over in-memory arrays. Changing the period re-tallies verdicts; changing the
 * niche re-scopes them; changing the view bar re-shades the table and moves no
 * rate at all, because it decides nothing.
 *
 * What genuinely does require the server now is a CHANGE TO A RULE — a new
 * threshold or window on a niche — because that re-decides stored verdicts.
 * That is a mutation with an invalidation behind it, not a filter.
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
 * THE CONTENT-TYPE PREDICATE READS THE CHANNEL'S OWN TAGS, AND UNDER
 * INHERITANCE THAT IS *ALREADY* THE EFFECTIVE ANSWER.
 *
 * This is worth stating plainly, because "match on effective tags" sounds like
 * it must mean resolving something here, and here is the one surface where it
 * does not. A channel's tags are not a copy of anything — they are the SOURCE
 * every one of its Shorts resolves against. So `contentTypeIds.includes("memes")`
 * on a channel row is exactly the set of channels whose Shorts inherit Memes;
 * there is no second thing to consult, and calling `resolveContentTypes` on a
 * channel would be resolving a value against itself.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO is admit a channel because one of its
 * Shorts was manually tagged Memes while the channel is not. That is a genuine
 * hole and it is the old "has at least one Short filed as a Ranking" rule
 * wearing a new hat — the one that made a channel which posted a single ranking
 * in 2024 a permanent member of the set. The row here is a CHANNEL and its
 * metrics describe everything it published; admitting it on the strength of one
 * deviating Short would put a "Memes" label above a hit rate computed from four
 * hundred Shorts that are not memes. Per-Short filtering, where that question is
 * the right one, happens where Shorts are the unit: `useShortsFeed` and the
 * channel page's own table, both of which DO resolve.
 *
 * "Unassigned" moves with it and gets stronger: a channel with no tags is now
 * one whose Shorts inherit nothing either, so the option finds exactly the
 * backlog it claims to — channels nobody has characterised, and therefore whole
 * libraries no tag reaches.
 *
 * It also drops the niche narrowing entirely. A content type belongs to no
 * niche now, so there is no "type within the niche" to compose — niche and type
 * are two independent narrowings again, and picking "Rankings" with no niche
 * selected is a perfectly ordinary org-wide question.
 *
 * NOTHING HERE TOUCHES THE NETWORK, and that is load-bearing rather than
 * incidental. This is a plain predicate over arrays already in memory, called
 * from the `useMemo`s below; the scope never reaches a React Query key, so
 * picking a content type re-runs this filter and nothing else.
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
  /*
   * The dataset-wide resolution index, NOT a resolve pass of this hook's own.
   *
   * It is already built — the Shorts table and both feeds read the same map —
   * and it is memoised on the payload object, so reusing it here costs a Map
   * lookup per video instead of a second full resolve over the library. It is
   * also the only way this table and the chips below it are guaranteed to be
   * describing the same tags: one derivation, several readers.
   */
  const resolutions = useVideoContentTypeResolutions();

  return React.useMemo(
    () =>
      calculateContentTypePerformance({
        /*
         * Resolved on the way in, because this is the altitude where the channel
         * is still in scope. `calculateContentTypePerformance` is handed one flat
         * pool of Shorts from every channel at once, so by the time it runs there
         * is no way back to "which channel provided this tag" — the join has to
         * happen here or not at all.
         *
         * One object allocated per video per recompute, which is the price of
         * keeping the aggregate a pure function of what it is given rather than
         * teaching it to look up channels. The pool is a few thousand rows and
         * this memo only re-runs when a filter moves.
         */
        videos: rows.flatMap((row) =>
          row.videos.map((video) => ({
            ...video,
            effectiveContentTypeIds: (resolutions.get(video.id) ?? EMPTY_RESOLUTION)
              .effectiveIds,
          })),
        ),
        range,
        threshold,
        contentTypes,
      }),
    [rows, contentTypes, range, threshold, resolutions],
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
