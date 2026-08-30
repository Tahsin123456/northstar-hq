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
import { ContentTypeChips } from "@/components/content-types/content-type-chip";
import { useContentTypesByIds } from "@/hooks/use-content-types";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChannelRowMenu } from "@/components/channels/channel-row-menu";
import { ChannelSourceLine, channelSourceCopy } from "@/components/youtube/channel-source";

export function ChannelHeader({ channel }: { channel: ChannelDTO }) {
  const refresh = useRefreshChannel();

  // Asked once here so the separator dot and the line itself agree about
  // whether there is anything to show — a lone "·" is the classic way this
  // kind of conditional inline list goes wrong.
  const sourceCopy = channelSourceCopy(channel.dataSource, channel.ownershipType);

  // Keeps "views checked 3 minutes ago" honest, from the shared clock store.
  const now = useNow();

  /*
   * The tags this channel is CURRENTLY claiming — open rules only.
   *
   * A header states what a thing is now. A retired rule is part of the channel's
   * history rather than its present, and showing it up here would tell somebody
   * this channel makes rankings when the whole point of the retirement was that
   * it has stopped. The full history, retirements included, is in the Content
   * types block further down the page, where there is room to say when.
   *
   * Joined from the catalogue that already travelled with the dataset, so a
   * rename shows up here without this component knowing anything about it.
   */
  const currentTypeIds = React.useMemo(
    () =>
      channel.contentTypeRules
        .filter((rule) => rule.effectiveUntil === null)
        .map((rule) => rule.contentTypeId),
    [channel.contentTypeRules],
  );
  const contentTypes = useContentTypesByIds(currentTypeIds);

  const handleRefresh = () => {
    refresh.mutate(channel.id, {
      onSuccess: ({ result }) => {
        /*
         * A refusal is not a failure, and calling it one would be the screen's
         * own small lie. Nothing broke: this channel reads through its Google
         * account's authorisation, that authorisation has stopped working, and
         * the sync declined to substitute the public API behind the reader's
         * back. "Refresh failed" invites somebody to press it again; naming the
         * reconnection is the only thing that will actually change the outcome.
         */
        if (result.dataSource === "connection_unavailable") {
          toast.warning("Not refreshed — this channel's connection needs reconnecting", {
            description: result.error ?? undefined,
            duration: 12_000,
          });
          return;
        }
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
                  at, not a detail to hunt for.

                  Content types sit beside them, and the two are different
                  claims: the niche is which slice of the operation owns this
                  channel, the content types are what the team says it makes.
                  They are told apart by the chip itself — a content type's dot
                  is squared where a niche's is round — which is why both can
                  share a line without reading as one list.

                  Read-only here. Editing lives in the block further down the
                  page, where a whole set is committed at once; a header is for
                  knowing what you are looking at. */}
              <NicheChips niches={channel.niches} limit={3} size="md" />
              <ContentTypeChips contentTypes={contentTypes} limit={3} size="md" />
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

              {/*
                Which door these numbers came through, beside the freshness that
                depends on it. Silent for a competitor on the public API — that
                is the only source a competitor can ever have — and loud for an
                own channel whose connection has failed, where "checked 2 hours
                ago" is true and dangerously incomplete on its own: nothing was
                read, and nothing will be until the account is reconnected.
              */}
              {sourceCopy ? (
                <>
                  <span className="text-border-strong" aria-hidden>
                    ·
                  </span>
                  <ChannelSourceLine
                    dataSource={channel.dataSource}
                    ownershipType={channel.ownershipType}
                  />
                </>
              ) : null}
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
