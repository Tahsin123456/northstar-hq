"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  STALE_DATA_THRESHOLD_MS,
  STALE_DATA_TITLE,
  staleDataExplanation,
} from "@/lib/analytics/constants";
import { formatRelativeTime } from "@/lib/format";
import { useRefreshAll } from "@/hooks/use-dataset";
import { useNow } from "@/hooks/use-now";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Data-freshness indicator with a refresh action.
 *
 * Shows the *oldest* fetch time across tracked channels, not the newest. When
 * you are comparing channels against each other, the honest claim about the
 * comparison is only as strong as its stalest input — reporting the freshest
 * would overstate how current the ranking is.
 */
/**
 * The refresh action both surfaces below share.
 *
 * ONE CODE PATH ON PURPOSE. The pill and the banner are two statements about
 * the same fact, and a second copy of this mutation would eventually report a
 * different outcome for the same click — a partial refresh reported as a
 * success in one place and a warning in the other is the kind of small
 * inconsistency that costs a tool its credibility on the numbers.
 */
function useRefreshAllWithToasts() {
  const refreshAll = useRefreshAll();

  const refresh = React.useCallback(() => {
    refreshAll.mutate(true, {
      onSuccess: (result) => {
        if (result.refreshed === 0) {
          toast.info("Everything is already up to date");
          return;
        }
        if (result.failed > 0) {
          toast.warning(
            `Refreshed ${result.refreshed - result.failed} of ${result.refreshed} channels`,
            { description: `${result.failed} failed. Open a channel to see why.` },
          );
          return;
        }
        toast.success(`Refreshed ${result.refreshed} channels`, {
          description: `${result.quotaUnitsUsed} YouTube API units used.`,
        });
      },
      onError: (error) =>
        toast.error("Refresh failed", {
          description: error instanceof Error ? error.message : undefined,
        }),
    });
  }, [refreshAll]);

  return { refresh, isPending: refreshAll.isPending };
}

export function DataFreshness({
  oldestFetchedAt,
  className,
}: {
  oldestFetchedAt: number | null;
  className?: string;
}) {
  const { refresh: handleRefresh, isPending } = useRefreshAllWithToasts();

  // Ticks every 30s so "12 minutes ago" keeps counting, and gives a pure value
  // to compare against instead of calling Date.now() during render.
  const now = useNow();

  // `now === 0` before the clock store subscribes; nothing is stale then.
  const isStale =
    now > 0 && oldestFetchedAt !== null && now - oldestFetchedAt > 24 * 60 * 60_000;

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 text-[12px]",
              isStale ? "text-warning" : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                isStale ? "bg-warning" : "bg-success",
              )}
              aria-hidden
            />
            Data updated{" "}
            {formatRelativeTime(oldestFetchedAt, now === 0 ? undefined : now)}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          View counts change constantly. This is the oldest fetch time across all
          tracked channels, so it reflects how current the weakest link in any
          comparison is.
        </TooltipContent>
      </Tooltip>

      <Button
        variant="ghost"
        size="icon-sm"
        onClick={handleRefresh}
        loading={isPending}
        aria-label="Refresh all channels"
        title="Refresh all channels"
      >
        {isPending ? null : <RefreshCw />}
      </Button>
    </div>
  );
}

/**
 * The same fact as the pill, said where it cannot be missed.
 *
 * WHY BOTH. The pill above is 12px of muted text in a row of buttons, attached
 * to no particular number. On the day the "views are wrong" report came in it
 * read "Data updated 5 days ago" and it did not register — while the channel in
 * question publishes one Short a day, so the 30-day window on screen was
 * missing roughly six of its thirty days of uploads. That understatement lands
 * at the NEW end of the window, which is exactly where a reader is least likely
 * to suspect it and most likely to read it as a channel going quiet.
 *
 * Two days rather than the pill's one, deliberately: a full-width banner that
 * appeared every morning would be trained away inside a week, and one day of
 * staleness genuinely does not change a 30-day comparison much. Two days does.
 *
 * Renders nothing at all when the data is fresh, and nothing when no channel
 * has ever been fetched (`oldestFetchedAt === null`) — that is a first-run
 * tracker with nothing to be stale, and the empty states already say so.
 */
export function StaleDataNotice({
  oldestFetchedAt,
  className,
}: {
  oldestFetchedAt: number | null;
  className?: string;
}) {
  const { refresh, isPending } = useRefreshAllWithToasts();
  const now = useNow();

  if (now === 0 || oldestFetchedAt === null) return null;
  if (now - oldestFetchedAt <= STALE_DATA_THRESHOLD_MS) return null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-3 rounded-lg border border-warning/40 bg-warning-subtle/40 px-4 py-3",
        className,
      )}
      role="status"
    >
      <RefreshCw className="mt-px size-4 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">{STALE_DATA_TITLE}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
          {staleDataExplanation(formatRelativeTime(oldestFetchedAt, now))}
        </p>
      </div>
      <div className="shrink-0">
        <Button variant="secondary" size="sm" onClick={refresh} loading={isPending}>
          Refresh now
        </Button>
      </div>
    </div>
  );
}
