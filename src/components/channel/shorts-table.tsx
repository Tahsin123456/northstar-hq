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
  EM_DASH,
  formatCompactNumber,
  formatDate,
  formatDuration,
  formatNumber,
  formatThresholdRatio,
  youtubeShortsUrl,
  youtubeThumbnailUrl,
} from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type ShortsSortKey = "publishedAt" | "views" | "likes" | "comments" | "duration";
type Direction = "asc" | "desc";

/**
 * Every Short inside the selected period.
 *
 * Hits are marked with a badge and a left edge rule rather than a filled row.
 * On a channel with a strong hit rate, half the rows are hits — filling them
 * would tint the whole table and stop the marker meaning anything. A thin
 * accent on the leading edge stays scannable at any density.
 */
export function ShortsTable({
  shorts,
  threshold,
  className,
}: {
  shorts: readonly EvaluatedShort[];
  threshold: number;
  className?: string;
}) {
  const [sortKey, setSortKey] = React.useState<ShortsSortKey>("publishedAt");
  const [direction, setDirection] = React.useState<Direction>("desc");
  const [filter, setFilter] = React.useState<"all" | "hits" | "misses">("all");

  const sorted = React.useMemo(() => {
    const factor = direction === "asc" ? 1 : -1;
    const subset =
      filter === "all"
        ? [...shorts]
        : shorts.filter((s) => (filter === "hits" ? s.isHit : !s.isHit));

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

  const hitCount = shorts.filter((s) => s.isHit).length;

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
      {/* --- Filter chips --- */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface-sunken px-4 py-2">
        {(
          [
            { id: "all", label: "All", count: shorts.length },
            { id: "hits", label: "Hits", count: hitCount },
            { id: "misses", label: "Below threshold", count: shorts.length - hitCount },
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

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="w-[52px] px-4 py-2" />
              <th scope="col" className="px-2 py-2">
                <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                  Short
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
                label="vs threshold"
                active={false}
                direction={direction}
                onClick={() => toggleSort("views")}
                align="right"
                className="hidden w-[96px] md:table-cell"
                tip={`Views as a multiple of the ${formatCompactNumber(threshold)} threshold. 1.0× is exactly at the line.`}
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
              <ShortRow key={short.id} short={short} />
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

function ShortRow({ short }: { short: EvaluatedShort }) {
  return (
    <tr
      className={cn(
        "group border-b border-border transition-colors duration-100 last:border-b-0 hover:bg-surface-hover/50",
        // Leading rule marks a hit without tinting the whole row.
        short.isHit && "shadow-[inset_2px_0_0_0_var(--success)]",
      )}
    >
      <td className="py-2 pl-4 pr-0">
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
        <span className="tnum text-[12px] text-muted-foreground">
          {formatDate(short.publishedAt)}
        </span>
      </td>

      <td className="px-2 py-2 text-right">
        <span
          className={cn(
            "tnum text-[13px]",
            short.isHit ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {formatCompactNumber(short.views)}
        </span>
      </td>

      <td className="hidden px-2 py-2 text-right md:table-cell">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "tnum text-[12px]",
                short.thresholdRatio >= 1
                  ? "text-success"
                  : short.thresholdRatio >= 0.75
                    ? "text-warning"
                    : "text-subtle-foreground",
              )}
            >
              {formatThresholdRatio(short.thresholdRatio)}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {formatNumber(short.views)} views
            {short.thresholdRatio < 1
              ? ` — ${formatPercentShort(1 - short.thresholdRatio)} short of the threshold`
              : ""}
          </TooltipContent>
        </Tooltip>
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
        {short.isHit ? (
          <Badge variant="hit" size="sm">
            Hit
          </Badge>
        ) : (
          <span className="text-[12px] text-subtle-foreground">{EM_DASH}</span>
        )}
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
