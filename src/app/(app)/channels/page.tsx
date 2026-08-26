"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, MoreHorizontal, RotateCcw, SearchX, Tv2 } from "lucide-react";
import { toast } from "sonner";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { AddChannelDialog } from "@/components/channels/add-channel-dialog";
import { ChannelRowMenu } from "@/components/channels/channel-row-menu";
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
  useChannelRows,
  useScopedRows,
} from "@/hooks/use-channel-analytics";
import {
  NicheFilterControl,
  OwnershipFilterControl,
} from "@/components/dashboard/scope-filters";
import { useFilters } from "@/components/providers/filters-provider";
import { NicheChips } from "@/components/niches/niche-chip";
import { useDataset, useRestoreChannel } from "@/hooks/use-dataset";
import { api } from "@/lib/api-client";
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
 */
export default function ChannelsPage() {
  const { data, isLoading, error, refetch } = useDataset();
  const { niche, ownership } = useFilters();
  const [query, setQuery] = React.useState("");

  const allRows = useChannelRows(data);
  const rows = useScopedRows(allRows, niche, ownership);
  const visible = React.useMemo(() => filterRows(rows, query), [rows, query]);

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
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <NicheFilterControl
                niches={data?.niches ?? []}
                unassignedCount={
                  allRows.filter((r) => r.channel.niches.length === 0).length
                }
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
                description="Add a YouTube channel to start measuring how consistently it produces high-performing Shorts."
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

  return (
    <Card className="group relative flex flex-col p-4 transition-colors duration-150 hover:border-border-strong">
      <div className="flex items-start gap-3">
        <Avatar src={channel.avatarUrl} name={channel.displayName} size={40} />

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <Link
              href={`/channels/${channel.id}`}
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
            hitRate={metrics.hitRate}
            hitCount={metrics.hitCount}
            totalShorts={metrics.totalShorts}
            size="sm"
            showBar
          />
        </div>

        <MiniStat label="Views" value={formatCompactNumber(metrics.totalViews)} />
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
    </Card>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
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
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          Hidden from your dashboard. Their Shorts history is still stored and
          comes back intact.
        </p>
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
