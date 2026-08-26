"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ChevronsUpDown, ExternalLink, MoreHorizontal } from "lucide-react";
import type { ChannelRow } from "@/hooks/use-channel-analytics";
import { useFilters } from "@/components/providers/filters-provider";
import {
  EM_DASH,
  formatCompactNumber,
  formatNumber,
  formatRelativeTime,
  youtubeWatchUrl,
} from "@/lib/format";
import { nextSortState, type SortKey, type SortState } from "@/lib/sorting";
import { PERIOD_PRESET_BY_ID } from "@/lib/analytics/constants";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HitRateValue, HitRateInfo } from "@/components/metrics/hit-rate-value";
import { ChannelRowMenu } from "@/components/channels/channel-row-menu";
import { NicheChips } from "@/components/niches/niche-chip";
import type { OwnershipType } from "@/lib/dto";
import { cn } from "@/lib/utils";

interface Column {
  key: SortKey;
  label: string;
  align: "left" | "right";
  /** Hidden below this breakpoint to keep the table usable on narrow screens. */
  hideBelow?: "sm" | "md" | "lg" | "xl";
  width?: string;
  tip?: string;
}

/**
 * Column order encodes priority: identity, then the headline metric, then the
 * volume and shape metrics that qualify it. Hit rate sits immediately after the
 * channel because it is the answer the table exists to give — everything to its
 * right is supporting evidence.
 */
const COLUMNS: Column[] = [
  { key: "name", label: "Channel", align: "left", width: "minmax(200px,2.2fr)" },
  { key: "hitRate", label: "Hit rate", align: "left", width: "minmax(118px,1.1fr)" },
  { key: "shortsUploaded", label: "Shorts", align: "right", width: "minmax(72px,0.6fr)", tip: "Shorts uploaded during the selected period. Long-form videos are excluded." },
  { key: "totalViews", label: "Total views", align: "right", width: "minmax(92px,0.75fr)" },
  { key: "averageViews", label: "Avg views", align: "right", width: "minmax(88px,0.7fr)", hideBelow: "md" },
  { key: "medianViews", label: "Median", align: "right", width: "minmax(84px,0.7fr)", hideBelow: "lg", tip: "The typical Short. More resistant to a single viral outlier than the average." },
  { key: "bestShort", label: "Best Short", align: "right", width: "minmax(92px,0.7fr)", hideBelow: "lg" },
  { key: "consistency", label: "Consistency", align: "right", width: "minmax(94px,0.7fr)", hideBelow: "xl", tip: "0–100. How tightly this channel's Shorts cluster around their median. High means dependable output rather than a few outliers carrying the total." },
  { key: "subscribers", label: "Subs", align: "right", width: "minmax(72px,0.6fr)", hideBelow: "sm" },
];

const GRID_TEMPLATE = `${COLUMNS.map((c) => c.width ?? "1fr").join(" ")} 40px`;

const HIDE_CLASS: Record<NonNullable<Column["hideBelow"]>, string> = {
  sm: "hidden sm:flex",
  md: "hidden md:flex",
  lg: "hidden lg:flex",
  xl: "hidden xl:flex",
};

export function ChannelTable({
  rows,
  sort,
  onSortChange,
  loading,
}: {
  rows: readonly ChannelRow[];
  sort: SortState;
  onSortChange: (sort: SortState) => void;
  loading?: boolean;
}) {
  const { threshold, period } = useFilters();
  const periodLabel = PERIOD_PRESET_BY_ID[period.preset]?.shortLabel ?? "Custom";

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      {/* A horizontal scroll container rather than a squeeze: on a narrow
          screen the numbers stay readable and the user scrolls, instead of
          every column collapsing to an unreadable width. */}
      <div className="overflow-x-auto">
        {/*
          A CSS-grid layout rather than a <table>, because the columns need to
          share a single track definition across the header and every row.
          The ARIA roles restore the table semantics that markup would have
          given for free — role="row" is only meaningful inside a rowgroup
          inside a table, and its children must be cells.
        */}
        <div
          className="min-w-[720px]"
          role="table"
          aria-label="Tracked channels ranked by Shorts hit rate"
          aria-rowcount={loading ? undefined : rows.length}
        >
          {/* --- Header --- */}
          <div role="rowgroup">
            <div
              className="grid items-center gap-3 border-b border-border bg-surface-sunken px-4 py-2"
              style={{ gridTemplateColumns: GRID_TEMPLATE }}
              role="row"
            >
              {COLUMNS.map((column) => (
                <SortableHeader
                  key={column.key}
                  column={column}
                  sort={sort}
                  onSortChange={onSortChange}
                  extra={
                    column.key === "hitRate" ? (
                      <span className="ml-1 inline-flex items-center gap-1">
                        <Badge
                          variant="outline"
                          size="sm"
                          className="tnum normal-case tracking-normal"
                        >
                          ≥ {formatCompactNumber(threshold)}
                        </Badge>
                        <Badge variant="outline" size="sm" className="normal-case tracking-normal">
                          {periodLabel}
                        </Badge>
                        <HitRateInfo />
                      </span>
                    ) : null
                  }
                />
              ))}
              <div role="columnheader" className="flex items-center justify-end">
                <span className="sr-only">Actions</span>
              </div>
            </div>
          </div>

          {/* --- Body --- */}
          <div role="rowgroup">
            {loading
              ? Array.from({ length: 6 }, (_, i) => <ChannelRowSkeleton key={i} />)
              : rows.map((row, index) => (
                  <ChannelTableRow key={row.channel.id} row={row} rank={index + 1} />
                ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function SortableHeader({
  column,
  sort,
  onSortChange,
  extra,
}: {
  column: Column;
  sort: SortState;
  onSortChange: (sort: SortState) => void;
  extra?: React.ReactNode;
}) {
  const isActive = sort.key === column.key;

  const header = (
    <button
      type="button"
      onClick={() => onSortChange(nextSortState(sort, column.key))}
      className={cn(
        "group inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider transition-colors",
        isActive ? "text-foreground" : "text-subtle-foreground hover:text-muted-foreground",
      )}
    >
      {column.label}
      {isActive ? (
        sort.direction === "asc" ? (
          <ArrowUp className="size-3 text-accent" />
        ) : (
          <ArrowDown className="size-3 text-accent" />
        )
      ) : (
        <ChevronsUpDown className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />
      )}
    </button>
  );

  // `aria-sort` belongs on the column header itself, not on the button inside
  // it — the implicit `button` role does not support the property.
  return (
    <div
      role="columnheader"
      aria-sort={isActive ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}
      className={cn(
        "flex min-w-0 items-center",
        column.align === "right" ? "justify-end" : "justify-start",
        column.hideBelow ? HIDE_CLASS[column.hideBelow] : "flex",
      )}
    >
      {column.tip ? (
        <Tooltip>
          <TooltipTrigger asChild>{header}</TooltipTrigger>
          <TooltipContent>{column.tip}</TooltipContent>
        </Tooltip>
      ) : (
        header
      )}
      {extra}
    </div>
  );
}

function ChannelTableRow({ row, rank }: { row: ChannelRow; rank: number }) {
  const { channel, metrics } = row;
  const { threshold } = useFilters();

  return (
    <div
      className="group relative grid items-center gap-3 border-b border-border px-4 py-3 transition-colors duration-100 last:border-b-0 hover:bg-surface-hover/50"
      style={{ gridTemplateColumns: GRID_TEMPLATE }}
      role="row"
    >
      {/* --- Channel identity --- */}
      <div role="cell" className="flex min-w-0 items-center gap-2.5">
        <span className="tnum w-4 shrink-0 text-right text-[11px] text-subtle-foreground">
          {rank}
        </span>
        <Avatar src={channel.avatarUrl} name={channel.displayName} size={30} />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <Link
              href={`/channels/${channel.id}`}
              className="truncate text-[13px] font-medium text-foreground transition-colors hover:text-accent"
              title={channel.displayName}
            >
              {channel.displayName}
              {/* An absolutely-positioned overlay makes the whole row clickable
                  without nesting interactive elements inside an anchor. */}
              <span className="absolute inset-0 z-0" aria-hidden />
            </Link>
            <OwnBadge ownershipType={channel.ownershipType} />
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-subtle-foreground">
            <span className="shrink-0 truncate">
              {channel.handle ?? channel.youtubeChannelId}
            </span>
            {channel.niches.length > 0 ? (
              <>
                <span className="shrink-0 text-border-strong" aria-hidden>
                  ·
                </span>
                <NicheChips niches={channel.niches} limit={1} size="sm" />
              </>
            ) : null}
            {channel.lastFetchStatus === "error" ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="relative z-10 size-1.5 shrink-0 rounded-full bg-danger" />
                </TooltipTrigger>
                <TooltipContent>
                  Last refresh failed: {channel.lastFetchError}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>
      </div>

      {/* --- Hit rate: the headline --- */}
      <div role="cell" className="relative z-10 min-w-0 pointer-events-none">
        <HitRateValue
          hitRate={metrics.hitRate}
          hitCount={metrics.hitCount}
          totalShorts={metrics.totalShorts}
          threshold={threshold}
          size="md"
        />
      </div>

      <NumericCell value={formatNumber(metrics.totalShorts)} />
      <NumericCell value={formatCompactNumber(metrics.totalViews)} />
      <NumericCell value={formatCompactNumber(metrics.averageViews)} hideBelow="md" />
      <NumericCell value={formatCompactNumber(metrics.medianViews)} hideBelow="lg" />

      {/* --- Best Short: links straight to the video --- */}
      <div role="cell" className="hidden min-w-0 items-center justify-end lg:flex">
        {metrics.bestShort ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={youtubeWatchUrl(metrics.bestShort.youtubeVideoId)}
                target="_blank"
                rel="noopener noreferrer"
                className="tnum relative z-10 inline-flex items-center gap-1 text-[13px] text-foreground transition-colors hover:text-accent"
              >
                {formatCompactNumber(metrics.bestShort.views)}
                <ExternalLink className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />
              </a>
            </TooltipTrigger>
            <TooltipContent>{metrics.bestShort.title}</TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-[13px] text-subtle-foreground">{EM_DASH}</span>
        )}
      </div>

      {/* --- Consistency --- */}
      <div role="cell" className="hidden min-w-0 items-center justify-end xl:flex">
        {metrics.consistencyScore !== null ? (
          <span className="tnum text-[13px] text-foreground">
            {metrics.consistencyScore.toFixed(0)}
          </span>
        ) : (
          <span className="text-[13px] text-subtle-foreground">{EM_DASH}</span>
        )}
      </div>

      <div role="cell" className="hidden min-w-0 items-center justify-end sm:flex">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="tnum text-[13px] text-muted-foreground">
              {channel.hiddenSubscriberCount
                ? EM_DASH
                : formatCompactNumber(channel.subscriberCount)}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {channel.hiddenSubscriberCount
              ? "This channel hides its subscriber count."
              : `Updated ${formatRelativeTime(channel.lastFetchedAt)}`}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* --- Row actions --- */}
      <div role="cell" className="relative z-10 flex items-center justify-end">
        <ChannelRowMenu
          channel={channel}
          trigger={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${channel.displayName}`}
              className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal />
            </Button>
          }
        />
      </div>
    </div>
  );
}

/**
 * The "this is ours" marker.
 *
 * One indicator, not four. The brief explicitly warned against making own
 * channels look dramatically different, so this is a small accent-tinted
 * wordmark beside the name — recognisable in a scan of thirty rows, but adding
 * no background tint, no border and no extra row height. Competitors get
 * nothing at all, which keeps the table quiet by default since most rows are
 * competitors.
 */
function OwnBadge({ ownershipType }: { ownershipType: OwnershipType }) {
  if (ownershipType !== "own") return null;
  return (
    <Badge
      variant="accent"
      size="sm"
      className="relative z-10 shrink-0 tracking-wider"
      title="One of your channels"
    >
      Own
    </Badge>
  );
}

function NumericCell({
  value,
  hideBelow,
}: {
  value: string;
  hideBelow?: "sm" | "md" | "lg" | "xl";
}) {
  return (
    <div
      role="cell"
      className={cn(
        "min-w-0 items-center justify-end",
        hideBelow ? HIDE_CLASS[hideBelow] : "flex",
      )}
    >
      <span
        className={cn(
          "tnum truncate text-[13px]",
          value === EM_DASH ? "text-subtle-foreground" : "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** Mirrors a real row's grid exactly, so nothing shifts when data lands. */
function ChannelRowSkeleton() {
  return (
    <div
      role="row"
      aria-hidden
      className="grid items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
      style={{ gridTemplateColumns: GRID_TEMPLATE }}
    >
      <div className="flex items-center gap-2.5">
        <Skeleton className="size-4" />
        <Skeleton className="size-[30px] rounded-full" />
        <div className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-2.5 w-20" />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-3.5 w-12" />
        <Skeleton className="h-[3px] w-full" />
        <Skeleton className="h-2.5 w-16" />
      </div>
      <Skeleton className="ml-auto h-3 w-8" />
      <Skeleton className="ml-auto h-3 w-12" />
      <Skeleton className="ml-auto hidden h-3 w-12 md:block" />
      <Skeleton className="ml-auto hidden h-3 w-12 lg:block" />
      <Skeleton className="ml-auto hidden h-3 w-12 lg:block" />
      <Skeleton className="ml-auto hidden h-3 w-10 xl:block" />
      <Skeleton className="ml-auto hidden h-3 w-10 sm:block" />
      <div />
    </div>
  );
}
