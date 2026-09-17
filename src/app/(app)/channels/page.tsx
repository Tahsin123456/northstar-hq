"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, MoreHorizontal, RotateCcw, SearchX, Tv2 } from "lucide-react";
import { toast } from "sonner";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { AddChannelDialog } from "@/components/channels/add-channel-dialog";
import { ChannelRowMenu } from "@/components/channels/channel-row-menu";
import { ConnectYouTubePanel } from "@/components/youtube/connect-youtube-panel";
import { ChannelSourceLine } from "@/components/youtube/channel-source";
import { SearchInput } from "@/components/dashboard/search-input";
import { PeriodSelector } from "@/components/dashboard/period-selector";
import { ThresholdSelector } from "@/components/dashboard/threshold-selector";
import { ErrorState } from "@/components/common/error-state";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { HitRateValue } from "@/components/metrics/hit-rate-value";
import {
  filterRows,
  channelCountsByContentType,
  untaggedChannelCount,
  useChannelRows,
  useScopedRows,
} from "@/hooks/use-channel-analytics";
import {
  ContentTypeFilterControl,
  NicheFilterControl,
  OwnershipFilterControl,
} from "@/components/dashboard/scope-filters";
import { useFilters } from "@/components/providers/filters-provider";
import { NicheChips } from "@/components/niches/niche-chip";
import { useDataset, useRestoreChannel } from "@/hooks/use-dataset";
import { useDatasetFormat } from "@/hooks/dataset-format-context";
import { api } from "@/lib/api-client";
import { UPLOAD_VIEWS_LABEL } from "@/lib/analytics/constants";
import { channelHref } from "@/lib/channel-href";
import { channelsPageCopy } from "@/lib/channels-page-copy";
import {
  EM_DASH,
  formatCompactNumber,
  formatRelativeTime,
} from "@/lib/format";

/**
 * Channels — the roster view.
 *
 * A card grid rather than a second table. The dashboard already ranks channels
 * against each other; this page answers a different question — "what am I
 * tracking, and is it healthy?" — so it emphasises identity, freshness and
 * management actions instead of comparison.
 *
 * MOUNTED AT TWO URLS. /longform/channels re-exports this module under the
 * Long Form provider, so `useDataset()` reads that format's roster and the
 * three strings that name the unit come from `channelsPageCopy(format)`.
 * Under the app shell's Shorts provider the format is "shorts" and the page
 * is, word for word, what it always was — a test pins that.
 */
export default function ChannelsPage() {
  const format = useDatasetFormat();
  const copy = channelsPageCopy(format);
  const { data, isLoading, error, refetch } = useDataset();
  const { niche, contentType, ownership } = useFilters();
  const [query, setQuery] = React.useState("");

  const allRows = useChannelRows(data);
  const rows = useScopedRows(allRows, niche, ownership, contentType);
  // Niche and ownership only — the set the Type menu describes. See the note on
  // `unassignedCount` in `ContentTypeFilterControl`.
  const nicheScopedRows = useScopedRows(allRows, niche, ownership);
  const visible = React.useMemo(() => filterRows(rows, query), [rows, query]);

  // Taken over EVERY tracked channel, not the filtered view: whether the studio
  // has connected its own channels is a fact about the workspace, and a niche
  // filter that happened to exclude the one own channel must not make the
  // connect panel swell back to its first-run size.
  const hasOwnChannel = React.useMemo(
    () => allRows.some((row) => row.channel.ownershipType === "own"),
    [allRows],
  );

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader
        title="Channels"
        description="Every channel in your tracker, with its current status and data freshness."
        actions={
          <AddChannelDialog
            trigger={
              <Button variant="primary" size="sm">
                <span className="text-base leading-none">+</span>
                Add Channel
              </Button>
            }
          />
        }
      />

      {error ? (
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      ) : (
        <>
          {/*
            Connecting lives HERE, not only three clicks away under Admin.
            This is the screen where somebody first wonders why their own
            channel's numbers look like the public ones, and the answer belongs
            beside the question. It takes the full treatment until an own channel
            is actually tracked, then shrinks to a strip — the panel should stop
            competing with the roster once it has done its job.
          */}
          {/* Held back until the tracker has loaded. The variant depends on
              whether an own channel exists, and rendering before the answer is
              known would show the full panel and then visibly collapse it on
              every first load. */}
          {isLoading ? null : (
            <ConnectYouTubePanel variant={hasOwnChannel ? "compact" : "full"} />
          )}

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <NicheFilterControl
                niches={data?.niches ?? []}
                unassignedCount={
                  allRows.filter((r) => r.channel.niches.length === 0).length
                }
              />
              <ContentTypeFilterControl
                contentTypes={data?.contentTypes ?? []}
                unassignedCount={untaggedChannelCount(nicheScopedRows)}
                channelCounts={channelCountsByContentType(nicheScopedRows)}
              />
              <OwnershipFilterControl
                ownCount={allRows.filter((r) => r.channel.ownershipType === "own").length}
                competitorCount={
                  allRows.filter((r) => r.channel.ownershipType !== "own").length
                }
              />
              <PeriodSelector />
              <ThresholdSelector />
            </div>
            <SearchInput
              value={query}
              onChange={setQuery}
              resultCount={query ? visible.length : undefined}
              className="w-full lg:w-72"
            />
          </div>

          {isLoading ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Card key={i} className="p-4">
                  <div className="flex items-start gap-3">
                    <Skeleton className="size-10 rounded-full" />
                    <div className="flex flex-1 flex-col gap-2">
                      <Skeleton className="h-3.5 w-32" />
                      <Skeleton className="h-3 w-20" />
                    </div>
                  </div>
                  <Skeleton className="mt-4 h-12 w-full" />
                </Card>
              ))}
            </div>
          ) : rows.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Tv2 />}
                title="No channels tracked yet"
                description={copy.emptyDescription}
                action={
                  <AddChannelDialog
                    trigger={
                      <Button variant="primary">
                        <span className="text-base leading-none">+</span>
                        Add Your First Channel
                      </Button>
                    }
                  />
                }
              />
            </Card>
          ) : visible.length === 0 ? (
            <Card>
              <EmptyState
                icon={<SearchX />}
                title={`No channels match “${query}”`}
                action={
                  <Button variant="secondary" onClick={() => setQuery("")}>
                    Clear search
                  </Button>
                }
              />
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {visible.map((row) => (
                <ChannelCard key={row.channel.id} row={row} />
              ))}
            </div>
          )}

          <RemovedChannels />
        </>
      )}
    </PageContainer>
  );
}

function ChannelCard({ row }: { row: ReturnType<typeof useChannelRows>[number] }) {
  const { channel, metrics } = row;
  // The link stays inside the format the reader is in — see `channelHref`.
  const format = useDatasetFormat();
  const copy = channelsPageCopy(format);
  return (
    <Card className="group relative flex flex-col p-4 transition-colors duration-150 hover:border-border-strong">
      <div className="flex items-start gap-3">
        <Avatar src={channel.avatarUrl} name={channel.displayName} size={40} />

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <Link
              href={channelHref(format, channel.id)}
              className="truncate text-[13px] font-medium text-foreground transition-colors hover:text-accent"
              title={channel.displayName}
            >
              {channel.displayName}
              <span className="absolute inset-0" aria-hidden />
            </Link>
            {channel.ownershipType === "own" ? (
              <Badge variant="accent" size="sm" className="relative z-10 shrink-0 tracking-wider">
                Own
              </Badge>
            ) : null}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-subtle-foreground">
            <span className="truncate">{channel.handle ?? channel.youtubeChannelId}</span>
            {channel.niches.length > 0 ? (
              <>
                <span className="shrink-0 text-border-strong" aria-hidden>
                  ·
                </span>
                <NicheChips niches={channel.niches} limit={2} size="sm" />
              </>
            ) : null}
          </div>
        </div>

        <div className="relative z-10">
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

      <div className="mt-4 grid grid-cols-[1.2fr_1fr_1fr] gap-3 border-t border-border pt-3">
        <div className="pointer-events-none">
          <HitRateValue
            summary={metrics.hits}
            totalShorts={metrics.totalShorts}
            size="sm"
            showBar
            // A card in a grid. The exclusions are the channel page's job;
            // three extra counts here would crowd out the one number the card
            // exists to show, and the bounds still appear beside the figure
            // wherever the unrecorded population makes it ambiguous.
            showExclusions={false}
          />
        </div>

        {/* The disclosure rides in a `title` rather than an InfoTip. This card
            sits under a stretched link, where a nested button is unreachable —
            the same constraint documented on `HitRateBounds`'s compact form. */}
        <MiniStat
          label={UPLOAD_VIEWS_LABEL}
          value={formatCompactNumber(metrics.totalViews)}
          title={copy.uploadViewsTip}
        />
        <MiniStat
          label="Median"
          value={formatCompactNumber(metrics.medianViews)}
        />
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 text-[11px]">
        <span
          className={
            channel.lastFetchStatus === "error"
              ? "inline-flex items-center gap-1.5 text-danger"
              : "inline-flex items-center gap-1.5 text-subtle-foreground"
          }
        >
          <span
            className={
              channel.lastFetchStatus === "error"
                ? "size-1.5 rounded-full bg-danger"
                : "size-1.5 rounded-full bg-success"
            }
            aria-hidden
          />
          Updated {formatRelativeTime(channel.lastFetchedAt)}
        </span>

        <span className="tnum text-subtle-foreground">
          {channel.hiddenSubscriberCount
            ? EM_DASH
            : `${formatCompactNumber(channel.subscriberCount)} subs`}
        </span>
      </div>

      {/*
        Where these numbers came from — and, when a connection has failed, that
        they have stopped moving. Renders nothing for a competitor on the public
        API, which is every competitor forever and not worth a caption. Above
        the card's own link overlay so its tooltip is reachable.
      */}
      <ChannelSourceLine
        dataSource={channel.dataSource}
        ownershipType={channel.ownershipType}
        className="relative z-10 mt-2"
      />
    </Card>
  );
}

function MiniStat({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  /** The definition, where a tooltip button cannot go. */
  title?: string;
}) {
  return (
    <div className="flex flex-col gap-1" title={title}>
      <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
        {label}
      </span>
      <span className="tnum truncate text-[13px] font-medium text-foreground">{value}</span>
    </div>
  );
}

/**
 * Soft-deleted channels, with a one-click restore.
 *
 * Removal keeps every video and snapshot, so surfacing what was removed makes
 * that recoverability real rather than a claim in a dialog. Hidden entirely
 * when nothing has been removed.
 */
function RemovedChannels() {
  const restore = useRestoreChannel();
  const copy = channelsPageCopy(useDatasetFormat());

  const { data } = useQuery({
    queryKey: ["channels", "with-removed"],
    queryFn: () => api.listChannels(true),
    staleTime: 60_000,
  });

  const removed = React.useMemo(
    () => (data?.channels ?? []).filter((channel) => !channel.isActive),
    [data],
  );

  if (removed.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-[13px] font-medium text-foreground">Removed channels</h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">{copy.removedHistory}</p>
      </div>

      <Card className="divide-y divide-border">
        {removed.map((channel) => (
          <div key={channel.id} className="flex items-center gap-3 px-4 py-3">
            <Avatar
              src={channel.avatarUrl}
              name={channel.displayName}
              size={30}
              className="opacity-60"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-muted-foreground">
                {channel.displayName}
              </div>
              <div className="truncate text-[11px] text-subtle-foreground">
                {channel.handle ?? channel.youtubeChannelId}
              </div>
            </div>

            <Badge variant="outline" size="sm">
              Removed
            </Badge>

            <Button
              variant="secondary"
              size="sm"
              loading={restore.isPending && restore.variables === channel.id}
              onClick={() =>
                restore.mutate(channel.id, {
                  onSuccess: () => toast.success(`${channel.displayName} restored`),
                  onError: (error) =>
                    toast.error("Could not restore", {
                      description: error instanceof Error ? error.message : undefined,
                    }),
                })
              }
            >
              <RotateCcw />
              Restore
            </Button>

            <Button variant="ghost" size="icon-sm" asChild aria-label="Open on YouTube">
              <a href={channel.channelUrl} target="_blank" rel="noopener noreferrer">
                <ArrowUpRight />
              </a>
            </Button>
          </div>
        ))}
      </Card>
    </div>
  );
}
