"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft, ExternalLink, MoreHorizontal, RefreshCw, Users } from "lucide-react";
import { toast } from "sonner";
import type { ChannelDTO } from "@/lib/dto";
import { formatCompactNumber, formatRelativeTime } from "@/lib/format";
import { useRefreshChannel } from "@/hooks/use-dataset";
import { useNow } from "@/hooks/use-now";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NicheChips } from "@/components/niches/niche-chip";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChannelRowMenu } from "@/components/channels/channel-row-menu";

export function ChannelHeader({ channel }: { channel: ChannelDTO }) {
  const refresh = useRefreshChannel();

  // Keeps "views checked 3 minutes ago" honest, from the shared clock store.
  const now = useNow();

  const handleRefresh = () => {
    refresh.mutate(channel.id, {
      onSuccess: ({ result }) => {
        if (result.status === "error") {
          toast.error("Refresh failed", { description: result.error ?? undefined });
          return;
        }
        toast.success("Channel refreshed", {
          description: `${result.videosUpdated} videos updated · ${result.shortsClassified} newly classified · ${result.quotaUnitsUsed} API units`,
        });
      },
      onError: (error) =>
        toast.error("Refresh failed", {
          description: error instanceof Error ? error.message : undefined,
        }),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/"
        className="inline-flex w-fit items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to overview
      </Link>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <Avatar
            src={channel.avatarUrl}
            name={channel.displayName}
            size={56}
            className="ring-1 ring-border"
          />

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-[19px] font-semibold tracking-tight text-foreground">
                {channel.displayName}
              </h1>
              <Badge
                variant={channel.ownershipType === "own" ? "accent" : "outline"}
                size="md"
              >
                {channel.ownershipType === "own" ? "Our channel" : "Competitor"}
              </Badge>
              {/* Niches sit next to the identity rather than in a metadata row:
                  "which niche is this?" is part of knowing what you're looking
                  at, not a detail to hunt for. */}
              <NicheChips niches={channel.niches} limit={3} size="md" />
            </div>

            {channel.label ? (
              <p className="truncate text-[12px] text-subtle-foreground">
                YouTube name: {channel.title}
              </p>
            ) : null}

            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
              <a
                href={channel.channelUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-accent"
              >
                {channel.handle ?? channel.youtubeChannelId}
                <ExternalLink className="size-3" />
              </a>

              <span className="text-border-strong" aria-hidden>
                ·
              </span>

              <span className="tnum inline-flex items-center gap-1.5 text-muted-foreground">
                <Users className="size-3 text-subtle-foreground" />
                {channel.hiddenSubscriberCount
                  ? "Subscribers hidden"
                  : `${formatCompactNumber(channel.subscriberCount)} subscribers`}
              </span>

              <span className="text-border-strong" aria-hidden>
                ·
              </span>

              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cnStatus(channel.lastFetchStatus)}
                  >
                    <span
                      className={
                        channel.lastFetchStatus === "error"
                          ? "size-1.5 rounded-full bg-danger"
                          : "size-1.5 rounded-full bg-success"
                      }
                      aria-hidden
                    />
                    Views checked {formatRelativeTime(channel.lastFetchedAt, now === 0 ? undefined : now)}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {channel.lastFetchStatus === "error"
                    ? `Last refresh failed: ${channel.lastFetchError}`
                    : "Every metric on this page reflects view counts as of this time."}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleRefresh}
            loading={refresh.isPending}
          >
            {refresh.isPending ? null : <RefreshCw />}
            {refresh.isPending ? "Refreshing…" : "Refresh"}
          </Button>

          <Button variant="secondary" size="sm" asChild>
            <a href={channel.channelUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink />
              YouTube
            </a>
          </Button>

          <ChannelRowMenu
            channel={channel}
            trigger={
              <Button variant="ghost" size="icon-sm" aria-label="More actions">
                <MoreHorizontal />
              </Button>
            }
          />
        </div>
      </div>

      {channel.lastFetchStatus === "error" && channel.lastFetchError ? (
        <div className="rounded-lg border border-danger/25 bg-danger-subtle px-3.5 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-danger">Last refresh failed.</span>{" "}
          {channel.lastFetchError} The figures below are from the last successful
          fetch{channel.lastFetchedAt ? ` ${formatRelativeTime(channel.lastFetchedAt, now === 0 ? undefined : now)}` : ""}.
        </div>
      ) : null}
    </div>
  );
}

function cnStatus(status: string): string {
  return status === "error"
    ? "inline-flex items-center gap-1.5 text-danger"
    : "inline-flex items-center gap-1.5 text-muted-foreground";
}

export function ChannelHeaderSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-3 w-28" />
      <div className="flex items-start gap-4">
        <Skeleton className="size-14 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-3 w-72" />
        </div>
        <Skeleton className="h-8 w-24" />
      </div>
    </div>
  );
}
