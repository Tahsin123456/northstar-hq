"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
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
export function DataFreshness({
  oldestFetchedAt,
  className,
}: {
  oldestFetchedAt: number | null;
  className?: string;
}) {
  const refreshAll = useRefreshAll();

  // Ticks every 30s so "12 minutes ago" keeps counting, and gives a pure value
  // to compare against instead of calling Date.now() during render.
  const now = useNow();

  const handleRefresh = () => {
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
  };

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
        loading={refreshAll.isPending}
        aria-label="Refresh all channels"
        title="Refresh all channels"
      >
        {refreshAll.isPending ? null : <RefreshCw />}
      </Button>
    </div>
  );
}
