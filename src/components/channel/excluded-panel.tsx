"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, FilterX } from "lucide-react";
import { api } from "@/lib/api-client";
import type { DateRange } from "@/lib/analytics/types";
import { formatCompactNumber, formatDate, formatDuration } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Classification transparency.
 *
 * Answers "why isn't this video in my hit rate?" with the classifier's actual
 * recorded reason, per video. Without this the Shorts filter is a black box the
 * user has to take on faith, and any hit rate they disagree with becomes
 * unfalsifiable. With it, the denominator is auditable.
 *
 * Collapsed by default — it is a diagnostic, not a headline.
 */
export function ExcludedPanel({
  channelId,
  range,
  excludedCount,
  className,
}: {
  channelId: string;
  range: DateRange;
  excludedCount: number;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["excluded", channelId, range.startMs, range.endMs],
    queryFn: () => api.getExcludedVideos(channelId, range),
    // Only fetch when the user actually opens the panel.
    enabled: open,
    staleTime: 5 * 60_000,
  });

  if (excludedCount === 0) return null;

  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-surface", className)}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-hover/50"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <FilterX className="size-4 shrink-0 text-subtle-foreground" />
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-foreground">
              {excludedCount} stored {excludedCount === 1 ? "video" : "videos"} excluded
              from Shorts metrics
            </div>
            <div className="text-[12px] text-muted-foreground">
              Long-form uploads and videos the classifier could not confirm. See
              why each one was excluded.
            </div>
          </div>
        </div>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-subtle-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <div className="border-t border-border">
          {isLoading ? (
            <div className="flex flex-col gap-2 p-4">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : error ? (
            <p className="p-4 text-[12px] text-danger">
              {error instanceof Error ? error.message : "Could not load the exclusion list."}
            </p>
          ) : !data || data.videos.length === 0 ? (
            <p className="p-4 text-[12px] text-muted-foreground">
              Nothing was excluded in this date range.
            </p>
          ) : (
            <ul className="max-h-80 divide-y divide-border overflow-y-auto">
              {data.videos.map((video) => (
                <li key={video.youtubeVideoId} className="flex flex-col gap-1.5 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <a
                      href={`https://www.youtube.com/watch?v=${video.youtubeVideoId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="min-w-0 truncate text-[13px] text-foreground transition-colors hover:text-accent"
                      title={video.title}
                    >
                      {video.title}
                    </a>
                    <Badge
                      variant={video.classification === "uncertain" ? "near" : "neutral"}
                      size="sm"
                      className="shrink-0"
                    >
                      {video.classification === "uncertain" ? "Unresolved" : "Not a Short"}
                    </Badge>
                  </div>

                  <div className="tnum flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-subtle-foreground">
                    <span>{formatDate(video.publishedAt)}</span>
                    <span>{formatDuration(video.durationSeconds)}</span>
                    <span>{formatCompactNumber(video.views)} views</span>
                    <span className="uppercase tracking-wide">
                      {video.classificationMethod.replace(/_/g, " ")}
                    </span>
                    <span>{Math.round(video.classificationConfidence * 100)}% confidence</span>
                  </div>

                  <p className="text-[12px] leading-relaxed text-muted-foreground">
                    {video.classificationReason}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
