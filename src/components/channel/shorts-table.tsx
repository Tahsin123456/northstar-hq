"use client";

import * as React from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  ExternalLink,
  Heart,
  MessageSquare,
} from "lucide-react";
import type { EvaluatedShort } from "@/lib/analytics/types";
import {
  UNCONFIGURED_RULE_EXPLANATION,
  UNCONFIGURED_RULE_SHORT,
} from "@/lib/analytics/constants";
import {
  EM_DASH,
  formatCompactNumber,
  formatDate,
  formatDuration,
  formatNumber,
  formatThresholdRatio,
  youtubeShortsUrl,
  youtubeThumbnailUrl,
} from "@/lib/format";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  BulkContentTypeButton,
  ContentTypeControl,
} from "@/components/content-types/content-type-control";
import { useOptionalSession } from "@/components/providers/session-provider";
import { useVideoContentTypeResolutions } from "@/hooks/use-content-types";
import { EMPTY_RESOLUTION, type ContentTypeResolution } from "@/lib/content-types/resolve";
import {
  hitContributionOf,
  tallyShorts,
} from "@/lib/analytics/hit-rate";
import { HitOutcomeBadge } from "@/components/metrics/hit-outcome-badge";
import { cn } from "@/lib/utils";

/**
 * The tabs above the table.
 *
 * Three of the four are verdicts and the fourth is everything that has not
 * reached one. "Not decided" deliberately pools pending, unrecorded and
 * unscoreable rather than offering three more tabs: they are three reasons for
 * the same fact — this Short is in nobody's hit rate — and the badge on each
 * row says which reason applies.
 */
type ShortsFilter = "all" | "hit" | "miss" | "undecided";

type ShortsSortKey = "publishedAt" | "views" | "likes" | "comments" | "duration";
type Direction = "asc" | "desc";

/**
 * Every Short inside the selected period.
 *
 * Hits are marked with a badge and a left edge rule rather than a filled row.
 * On a channel with a strong hit rate, half the rows are hits — filling them
 * would tint the whole table and stop the marker meaning anything. A thin
 * accent on the leading edge stays scannable at any density.
 *
 * CLASSIFICATION LIVES HERE TOO. This is the densest list of a channel's Shorts
 * in the product, which makes it the natural place to work down a back
 * catalogue filing each one under a content type — one click per row, or a
 * selection and one click for all of them.
 *
 * The selection is deliberately scoped to what is on screen: the header
 * checkbox ticks the rows the active filter is showing, and the bulk action
 * receives exactly the number the bar names. A row selected and then filtered
 * away is remembered but neither counted nor written, so switching to "Hits"
 * cannot quietly widen or narrow what is about to be relabelled.
 */
export function ShortsTable({
  shorts,
  threshold,
  className,
}: {
  shorts: readonly EvaluatedShort[];
  /**
   * The view bar the screen is exploring with, or `null` when the niche in view
   * has none configured.
   *
   * A LENS, NOT A DEFINITION. It shades the views column and scales the "vs
   * bar" ratio; the Outcome column beside it reads each Short's stored verdict
   * and moving this control changes none of them. `null` leaves the ratio
   * column with nothing to be a ratio of — see the cell renderer below.
   */
  threshold: number | null;
  className?: string;
}) {
  const [sortKey, setSortKey] = React.useState<ShortsSortKey>("publishedAt");
  const [direction, setDirection] = React.useState<Direction>("desc");
  const [filter, setFilter] = React.useState<ShortsFilter>("all");
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set());

  const session = useOptionalSession();
  // Assigning, not managing — see the note in content-type-control.tsx.
  const canManage = session?.can("research.write") ?? false;
  // Built once for the whole table rather than per row: it is one Map lookup
  // each, but the query subscription behind it is not free a hundred times.
  const contentTypeIndex = useVideoContentTypeResolutions();

  const sorted = React.useMemo(() => {
    const factor = direction === "asc" ? 1 : -1;
    /*
     * FILTERED ON THE VERDICT, not on the bar.
     *
     * These tabs used to read "Hits" and "Below threshold" and split the table
     * by a lifetime comparison — so a Short that crossed the line two years
     * late sat under "Hits", and one still four days into its window sat under
     * "Below threshold" as though it had already failed. The undecided Shorts
     * now get a tab of their own instead of being filed under the answer they
     * have not reached.
     */
    const subset =
      filter === "all"
        ? [...shorts]
        : shorts.filter((s) => {
            const contribution = hitContributionOf(s.hit);
            if (filter === "undecided") return contribution !== "hit" && contribution !== "miss";
            return contribution === filter;
          });

    return subset.sort((a, b) => {
      const value = (short: EvaluatedShort): number => {
        switch (sortKey) {
          case "views":
            return short.views;
          case "likes":
            return short.likes ?? -1;
          case "comments":
            return short.comments ?? -1;
          case "duration":
            return short.durationSeconds;
          case "publishedAt":
          default:
            return short.publishedAt;
        }
      };
      return (value(a) - value(b)) * factor;
    });
  }, [shorts, sortKey, direction, filter]);

  const toggleSort = (key: ShortsSortKey) => {
    if (sortKey === key) {
      setDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setDirection("desc");
    }
  };

  // One pass over the verdicts for every tab count, so the tabs and the rows
  // can never disagree about what a Short is.
  const tally = tallyShorts(shorts);
  const undecidedCount = tally.pending + tally.unknown + tally.unscoreable;

  const selectedIds = React.useMemo(
    () => sorted.filter((short) => selected.has(short.id)).map((short) => short.id),
    [sorted, selected],
  );

  const allVisibleSelected = sorted.length > 0 && selectedIds.length === sorted.length;

  const toggleRow = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      // Only the rows in view move, so ticking the header inside a filter does
      // not silently drop a selection made under a different one.
      for (const short of sorted) {
        if (allVisibleSelected) next.delete(short.id);
        else next.add(short.id);
      }
      return next;
    });
  };

  if (shorts.length === 0) {
    return (
      <div className={cn("rounded-lg border border-border bg-surface", className)}>
        <EmptyState
          title="No Shorts in this period"
          description="Try a longer period, or refresh the channel to pull in newer uploads."
        />
      </div>
    );
  }

  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-surface", className)}>
      {/* --- Selection bar, or the filter chips when nothing is ticked --- */}
      {selectedIds.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-accent-subtle px-4 py-2">
          <span className="tnum text-[12px] font-medium text-foreground">
            {selectedIds.length} {selectedIds.length === 1 ? "Short" : "Shorts"} selected
          </span>
          <BulkContentTypeButton
            videoIds={selectedIds}
            onAssigned={() => setSelected(new Set())}
          />
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Clear selection
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface-sunken px-4 py-2">
          {(
            [
              { id: "all", label: "All", count: shorts.length },
              { id: "hit", label: "Hits", count: tally.hits },
              { id: "miss", label: "Misses", count: tally.misses },
              { id: "undecided", label: "Not decided", count: undecidedCount },
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setFilter(option.id)}
              className={cn(
                "rounded px-2 py-1 text-[12px] font-medium transition-colors duration-150",
                filter === option.id
                  ? "bg-surface-raised text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
              <span className="tnum ml-1.5 text-subtle-foreground">{option.count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-left">
          <thead>
            <tr className="border-b border-border">
              {canManage ? (
                <th scope="col" className="w-[36px] py-2 pl-4 pr-0">
                  <Checkbox
                    checked={
                      allVisibleSelected
                        ? true
                        : selectedIds.length > 0
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={toggleAllVisible}
                    aria-label={
                      allVisibleSelected
                        ? "Deselect every Short in view"
                        : "Select every Short in view"
                    }
                  />
                </th>
              ) : null}
              <th
                scope="col"
                className={cn("py-2 pr-0", canManage ? "w-[46px] pl-2" : "w-[52px] pl-4")}
              />
              <th scope="col" className="px-2 py-2">
                <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                  Short
                </span>
              </th>
              <th scope="col" className="w-[150px] px-2 py-2">
                <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                  Content type
                </span>
              </th>
              <SortHeader
                label="Published"
                active={sortKey === "publishedAt"}
                direction={direction}
                onClick={() => toggleSort("publishedAt")}
                className="w-[110px]"
              />
              <SortHeader
                label="Views"
                active={sortKey === "views"}
                direction={direction}
                onClick={() => toggleSort("views")}
                align="right"
                className="w-[92px]"
              />
              <SortHeader
                label="vs bar"
                active={false}
                direction={direction}
                onClick={() => toggleSort("views")}
                align="right"
                className="hidden w-[96px] md:table-cell"
                tip={
                  threshold === null
                    ? UNCONFIGURED_RULE_EXPLANATION
                    : `LIFETIME views as a multiple of the ${formatCompactNumber(threshold)} bar above. 1.0× is exactly at the line. This is not how close the Short came to being a hit — that is measured at the window's close, and it is in the Outcome tooltip where a reading exists.`
                }
              />
              <SortHeader
                label="Likes"
                active={sortKey === "likes"}
                direction={direction}
                onClick={() => toggleSort("likes")}
                align="right"
                className="hidden w-[80px] lg:table-cell"
              />
              <SortHeader
                label="Comments"
                active={sortKey === "comments"}
                direction={direction}
                onClick={() => toggleSort("comments")}
                align="right"
                className="hidden w-[92px] lg:table-cell"
              />
              <SortHeader
                label="Length"
                active={sortKey === "duration"}
                direction={direction}
                onClick={() => toggleSort("duration")}
                align="right"
                className="hidden w-[72px] sm:table-cell"
              />
              <th scope="col" className="w-[64px] px-4 py-2 text-right">
                <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                  Status
                </span>
              </th>
            </tr>
          </thead>

          <tbody>
            {sorted.map((short) => (
              <ShortRow
                key={short.id}
                short={short}
                resolution={contentTypeIndex.get(short.id) ?? EMPTY_RESOLUTION}
                selectable={canManage}
                isSelected={selected.has(short.id)}
                onToggleSelected={() => toggleRow(short.id)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {sorted.length === 0 ? (
        <div className="px-4 py-8 text-center text-[13px] text-subtle-foreground">
          No Shorts match this filter.
        </div>
      ) : null}
    </div>
  );
}

function ShortRow({
  short,
  resolution,
  selectable,
  isSelected,
  onToggleSelected,
}: {
  short: EvaluatedShort;
  resolution: ContentTypeResolution;
  selectable: boolean;
  isSelected: boolean;
  onToggleSelected: () => void;
}) {
  return (
    <tr
      className={cn(
        "group border-b border-border transition-colors duration-100 last:border-b-0 hover:bg-surface-hover/50",
        // Leading rule marks a HIT — the stored verdict, not the bar. It used
        // to key on lifetime views, which put the green edge on every Short
        // that eventually crawled over the line.
        hitContributionOf(short.hit) === "hit" &&
          "shadow-[inset_2px_0_0_0_var(--success)]",
        isSelected && "bg-accent-subtle",
      )}
    >
      {selectable ? (
        <td className="py-2 pl-4 pr-0">
          <Checkbox
            checked={isSelected}
            onCheckedChange={onToggleSelected}
            aria-label={"Select " + short.title}
          />
        </td>
      ) : null}

      <td className={cn("py-2 pr-0", selectable ? "pl-2" : "pl-4")}>
        <a
          href={youtubeShortsUrl(short.youtubeVideoId)}
          target="_blank"
          rel="noopener noreferrer"
          className="block"
          tabIndex={-1}
          aria-hidden
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={youtubeThumbnailUrl(short.youtubeVideoId)}
            alt=""
            width={36}
            height={48}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="h-12 w-9 rounded object-cover ring-1 ring-border"
          />
        </a>
      </td>

      <td className="min-w-0 px-2 py-2">
        <a
          href={youtubeShortsUrl(short.youtubeVideoId)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex max-w-full items-center gap-1.5 text-[13px] text-foreground transition-colors hover:text-accent"
          title={short.title}
        >
          <span className="truncate">{short.title}</span>
          <ExternalLink className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-50" />
        </a>
      </td>

      <td className="px-2 py-2">
        <ContentTypeControl videoId={short.id} resolution={resolution} />
      </td>

      <td className="px-2 py-2">
        <span className="tnum text-[12px] text-muted-foreground">
          {formatDate(short.publishedAt)}
        </span>
      </td>

      <td className="px-2 py-2 text-right">
        <span
          className={cn(
            "tnum text-[13px]",
            short.clearsThreshold ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {formatCompactNumber(short.views)}
        </span>
      </td>

      <td className="hidden px-2 py-2 text-right md:table-cell">
        {/* No threshold, no ratio. `formatThresholdRatio(null)` would render an
            em dash, which in this column reads as "we could not work it out"
            rather than "there is nothing to work out". */}
        {short.lifetimeRatio === null ? (
          <span className="text-[11px] text-subtle-foreground">
            {UNCONFIGURED_RULE_SHORT}
          </span>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "tnum text-[12px]",
                  short.lifetimeRatio >= 1
                    ? "text-success"
                    : short.lifetimeRatio >= 0.75
                      ? "text-warning"
                      : "text-subtle-foreground",
                )}
              >
                {formatThresholdRatio(short.lifetimeRatio)}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px]">
              {formatNumber(short.views)} lifetime views
              {short.lifetimeRatio < 1
                ? ` — ${formatPercentShort(1 - short.lifetimeRatio)} short of the bar`
                : ""}
              {/* The number the RULE reads, where there is one. Most Shorts on
                  this account have no reading from inside their window, and the
                  honest thing is to say nothing rather than let the lifetime
                  figure above be mistaken for it. */}
              {short.windowRatio !== null ? (
                <>
                  {" "}
                  At its window&rsquo;s close it was{" "}
                  {formatThresholdRatio(short.windowRatio)} of the bar that
                  judged it.
                </>
              ) : null}
            </TooltipContent>
          </Tooltip>
        )}
      </td>

      <td className="hidden px-2 py-2 text-right lg:table-cell">
        <span className="tnum inline-flex items-center justify-end gap-1 text-[12px] text-muted-foreground">
          {short.likes !== null ? (
            <>
              <Heart className="size-3 text-subtle-foreground" />
              {formatCompactNumber(short.likes)}
            </>
          ) : (
            EM_DASH
          )}
        </span>
      </td>

      <td className="hidden px-2 py-2 text-right lg:table-cell">
        <span className="tnum inline-flex items-center justify-end gap-1 text-[12px] text-muted-foreground">
          {short.comments !== null ? (
            <>
              <MessageSquare className="size-3 text-subtle-foreground" />
              {formatCompactNumber(short.comments)}
            </>
          ) : (
            EM_DASH
          )}
        </span>
      </td>

      <td className="hidden px-2 py-2 text-right sm:table-cell">
        <span className="tnum text-[12px] text-muted-foreground">
          {formatDuration(short.durationSeconds)}
        </span>
      </td>

      <td className="px-4 py-2 text-right">
        {/* THE STORED VERDICT. This cell used to read "Hit" whenever lifetime
            views cleared the bar, which is the central bug of the old rule
            rendered one row at a time. */}
        <HitOutcomeBadge
          verdict={short.hit}
          publishedAt={short.publishedAt}
          lifetimeViews={short.views}
        />
      </td>
    </tr>
  );
}

function formatPercentShort(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

function SortHeader({
  label,
  active,
  direction,
  onClick,
  align = "left",
  className,
  tip,
}: {
  label: string;
  active: boolean;
  direction: Direction;
  onClick: () => void;
  align?: "left" | "right";
  className?: string;
  tip?: string;
}) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group/sort inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider transition-colors",
        active ? "text-foreground" : "text-subtle-foreground hover:text-muted-foreground",
      )}
    >
      {label}
      {active ? (
        direction === "asc" ? (
          <ArrowUp className="size-3 text-accent" />
        ) : (
          <ArrowDown className="size-3 text-accent" />
        )
      ) : (
        <ChevronsUpDown className="size-3 opacity-0 transition-opacity group-hover/sort:opacity-60" />
      )}
    </button>
  );

  return (
    <th
      scope="col"
      className={cn("px-2 py-2", align === "right" ? "text-right" : "text-left", className)}
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
    >
      {tip ? (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>{tip}</TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
    </th>
  );
}
