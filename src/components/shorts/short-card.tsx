"use client";

import * as React from "react";
import Link from "next/link";
import { Bookmark, ExternalLink, StickyNote } from "lucide-react";
import type { FeedShort } from "@/hooks/use-shorts-feed";
import {
  EM_DASH,
  formatCompactNumber,
  formatRelativeTime,
  youtubeShortsUrl,
  youtubeThumbnailUrl,
} from "@/lib/format";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NicheChips } from "@/components/niches/niche-chip";
import { SaveShortButton } from "./save-short-button";
import { cn } from "@/lib/utils";

/**
 * The outlier multiple, rendered as the headline number.
 *
 * This is deliberately the most prominent thing on the card. Absolute views
 * tell you a channel is big; the multiple tells you a Short *broke out*, which
 * is the only one of the two that suggests something worth studying.
 *
 * `null` renders as "Insufficient data", never as a number. A channel with
 * three Shorts has no trustworthy median, and inventing a 40x from that would
 * send a director chasing noise.
 */
export function OutlierMultiple({
  multiple,
  sampleSize,
  size = "md",
  className,
}: {
  multiple: number | null;
  sampleSize: number;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const textClass = { sm: "text-[13px]", md: "text-[17px]", lg: "text-[24px]" }[size];

  if (multiple === null) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex cursor-default items-center text-[11px] text-subtle-foreground",
              className,
            )}
          >
            Insufficient data
          </span>
        </TooltipTrigger>
        <TooltipContent>
          This channel has only {sampleSize}{" "}
          {sampleSize === 1 ? "Short" : "Shorts"} in the baseline window. A median
          needs at least 5 to be a trustworthy benchmark, so no multiple is shown
          rather than a misleading one.
        </TooltipContent>
      </Tooltip>
    );
  }

  // Emphasis tiers, not a gradient: 10x+ is genuinely exceptional, 3x+ is worth
  // a look, below that is ordinary variance.
  const tone =
    multiple >= 10
      ? "text-success"
      : multiple >= 3
        ? "text-foreground"
        : "text-muted-foreground";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("tnum inline-flex cursor-default items-baseline gap-1", className)}>
          <span className={cn("font-semibold leading-none tracking-tight", textClass, tone)}>
            {multiple >= 10 ? Math.round(multiple) : multiple.toFixed(1)}×
          </span>
          <span className="text-[10px] uppercase tracking-wider text-subtle-foreground">
            median
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        This Short did {multiple >= 10 ? Math.round(multiple) : multiple.toFixed(1)}× the
        views of this channel&rsquo;s median Short over the baseline window
        ({sampleSize} Shorts). Median, not average — one viral Short would drag an
        average up and hide the next breakout.
      </TooltipContent>
    </Tooltip>
  );
}

export function ShortCard({
  short,
  rank,
  onAddNote,
  noteCount = 0,
  className,
}: {
  short: FeedShort;
  rank?: number;
  onAddNote?: (short: FeedShort) => void;
  noteCount?: number;
  className?: string;
}) {
  const { video, channel } = short;

  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 border-b border-border px-4 py-3 transition-colors last:border-b-0 hover:bg-surface-hover/40",
        className,
      )}
    >
      {rank !== undefined ? (
        <span className="tnum w-5 shrink-0 text-right text-[11px] text-subtle-foreground">
          {rank}
        </span>
      ) : null}

      <a
        href={youtubeShortsUrl(video.youtubeVideoId)}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0"
        tabIndex={-1}
        aria-hidden
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={youtubeThumbnailUrl(video.youtubeVideoId)}
          alt=""
          width={40}
          height={54}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="h-[54px] w-10 rounded object-cover ring-1 ring-border"
        />
      </a>

      <div className="min-w-0 flex-1">
        <a
          href={youtubeShortsUrl(video.youtubeVideoId)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex max-w-full items-center gap-1.5 text-[13px] font-medium text-foreground transition-colors hover:text-accent"
          title={video.title}
        >
          <span className="truncate">{video.title}</span>
          <ExternalLink className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-50" />
        </a>

        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-subtle-foreground">
          <Link
            href={`/channels/${channel.id}`}
            className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-accent"
          >
            <Avatar src={channel.avatarUrl} name={channel.displayName} size={14} />
            <span className="max-w-[160px] truncate">{channel.displayName}</span>
          </Link>

          {short.ownershipType === "own" ? (
            <Badge variant="accent" size="sm" className="tracking-wider">
              Own
            </Badge>
          ) : null}

          <NicheChips niches={short.niches} limit={1} size="sm" />

          <span aria-hidden className="text-border-strong">
            ·
          </span>
          <span>{formatRelativeTime(video.publishedAt)}</span>

          {short.viewsPerDay !== null ? (
            <>
              <span aria-hidden className="text-border-strong">
                ·
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="tnum cursor-default">
                    {formatCompactNumber(short.viewsPerDay)}/day
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Average since upload, over {short.ageDays.toFixed(1)} days. Not shown
                  for Shorts under a day old, where the figure would be an
                  extrapolation rather than a rate.
                </TooltipContent>
              </Tooltip>
            </>
          ) : null}
        </div>
      </div>

      <div className="hidden shrink-0 flex-col items-end gap-0.5 sm:flex">
        <span className="tnum text-[14px] font-medium text-foreground">
          {formatCompactNumber(video.views)}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-subtle-foreground">
          views
        </span>
      </div>

      <div className="w-[112px] shrink-0 text-right">
        <OutlierMultiple
          multiple={short.outlierMultiple}
          sampleSize={short.baselineSampleSize}
        />
        <div className="tnum mt-0.5 text-[10px] text-subtle-foreground">
          median {short.channelMedianViews === null
            ? EM_DASH
            : formatCompactNumber(short.channelMedianViews)}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {onAddNote ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onAddNote(short)}
                aria-label="Add a note about this Short"
                className={cn(
                  "transition-opacity",
                  noteCount > 0
                    ? "text-accent opacity-100"
                    : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
                )}
              >
                <StickyNote />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {noteCount > 0
                ? `${noteCount} ${noteCount === 1 ? "note" : "notes"}`
                : "Add a note"}
            </TooltipContent>
          </Tooltip>
        ) : null}

        <SaveShortButton short={short} />
      </div>
    </div>
  );
}

/** Column headings that line up with ShortCard, for feed tables. */
export function ShortCardHeader({ showRank = false }: { showRank?: boolean }) {
  return (
    <div className="flex items-center gap-3 border-b border-border bg-surface-sunken px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
      {showRank ? <span className="w-5 shrink-0" /> : null}
      <span className="w-10 shrink-0" />
      <span className="min-w-0 flex-1">Short</span>
      <span className="hidden w-[64px] shrink-0 text-right sm:block">Views</span>
      <span className="w-[112px] shrink-0 text-right">vs channel median</span>
      <span className="w-[64px] shrink-0" />
    </div>
  );
}

export { Bookmark };
