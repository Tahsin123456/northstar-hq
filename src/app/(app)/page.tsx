"use client";

import * as React from "react";
import { FilterX, SearchX, Sparkles } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { AddChannelDialog } from "@/components/channels/add-channel-dialog";
import { ChannelTable } from "@/components/dashboard/channel-table";
import { DataFreshness } from "@/components/dashboard/data-freshness";
import { PeriodSelector } from "@/components/dashboard/period-selector";
import { SearchInput } from "@/components/dashboard/search-input";
import { SummaryCards } from "@/components/dashboard/summary-cards";
import { ThresholdSelector } from "@/components/dashboard/threshold-selector";
import { ApiKeyNotice, ErrorState } from "@/components/common/error-state";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  usePortfolioSummary,
  useChannelRows,
  useScopedRows,
  useVisibleRows,
} from "@/hooks/use-channel-analytics";
import {
  NicheFilterControl,
  OwnershipFilterControl,
  ScopeSummary,
} from "@/components/dashboard/scope-filters";
import { useDataset } from "@/hooks/use-dataset";
import { useFilters } from "@/components/providers/filters-provider";
import { DEFAULT_SORT, type SortState } from "@/lib/sorting";
import { previousRange } from "@/lib/analytics/trends";
import { GenerateReportDialog } from "@/components/report/generate-report-dialog";
import { HIT_RATE_DEFINITION } from "@/lib/analytics/constants";
import { formatCompactNumber } from "@/lib/format";
import { BRAND } from "@/lib/brand";

/**
 * Overview — the primary screen.
 *
 * The whole page is derived from one cached dataset. Period, threshold, search
 * and sort are all client-side transforms over that same array, which is why
 * every control on this page responds instantly and none of them touch YouTube.
 */
export default function OverviewPage() {
  const { data, isLoading, error, refetch, isFetching } = useDataset();
  const { threshold, niche, ownership, ownFirst, clearScopeFilters, range } = useFilters();

  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<SortState>(DEFAULT_SORT);

  const rows = useChannelRows(data);

  // Scope first, then search and sort. The summary cards read the *scoped* set,
  // not the global one, so "GTA + Our Channels" reports the average hit rate of
  // those channels rather than of everything being tracked.
  const scopedRows = useScopedRows(rows, niche, ownership);
  const visibleRows = useVisibleRows(rows, query, sort, niche, ownership, ownFirst);
  const summary = usePortfolioSummary(scopedRows);
  // The same portfolio metrics over the immediately preceding window, so every
  // KPI can show movement rather than a bare number.
  const previousSummary = usePortfolioSummary(scopedRows, previousRange(range));

  const niches = data?.niches ?? [];
  const unassignedCount = React.useMemo(
    () => rows.filter((row) => row.channel.niches.length === 0).length,
    [rows],
  );
  const ownCount = React.useMemo(
    () => rows.filter((row) => row.channel.ownershipType === "own").length,
    [rows],
  );

  const hasChannels = rows.length > 0;
  const showEmptyTracker = !isLoading && !error && !hasChannels;
  const scopeIsEmpty = hasChannels && scopedRows.length === 0;

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader
        title="Overview"
        description={
          hasChannels
            ? `Out of every 100 Shorts these channels publish, how many pass ${formatCompactNumber(threshold)} views?`
            : "Track the Shorts channels you care about."
        }
        actions={
          <>
            {data ? <DataFreshness oldestFetchedAt={data.oldestFetchedAt} /> : null}
            {rows.length > 0 ? <GenerateReportDialog /> : null}
            <AddChannelDialog
              trigger={
                <Button variant="primary" size="sm">
                  <span className="text-base leading-none">+</span>
                  Add Channel
                </Button>
              }
            />
          </>
        }
      />

      {data && !data.hasApiKey ? <ApiKeyNotice /> : null}

      {error ? (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorState error={error} onRetry={() => refetch()} />
        </div>
      ) : showEmptyTracker ? (
        <EmptyTracker />
      ) : (
        <>
          {/*
            The product's mental model, left to right:
              niche → channels → period → threshold → answer.
            All four are the same weight and the same interaction, so adding
            two of them did not add a second layer of UI.
          */}
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <NicheFilterControl niches={niches} unassignedCount={unassignedCount} />
              <OwnershipFilterControl
                ownCount={ownCount}
                competitorCount={rows.length - ownCount}
              />
              <PeriodSelector />
              <ThresholdSelector />
            </div>

            <div className="flex items-center gap-3">
              <ScopeSummary shown={scopedRows.length} total={rows.length} />
              <SearchInput
                value={query}
                onChange={setQuery}
                resultCount={query ? visibleRows.length : undefined}
                className="w-full lg:w-64"
              />
            </div>
          </div>

          <SummaryCards
            summary={summary}
            previousSummary={previousSummary}
            loading={isLoading}
          />

          {!isLoading && scopeIsEmpty ? (
            <div className="rounded-lg border border-border bg-surface">
              <EmptyState
                icon={<FilterX />}
                title="No channels match these filters"
                description="Nothing in your tracker fits this niche and channel-type combination."
                action={
                  <Button variant="secondary" onClick={clearScopeFilters}>
                    Clear filters
                  </Button>
                }
              />
            </div>
          ) : !isLoading && visibleRows.length === 0 && query ? (
            <div className="rounded-lg border border-border bg-surface">
              <EmptyState
                icon={<SearchX />}
                title={`No channels match “${query}”`}
                description="Search looks at the channel name, its YouTube title and its @handle."
                action={
                  <Button variant="secondary" onClick={() => setQuery("")}>
                    Clear search
                  </Button>
                }
              />
            </div>
          ) : (
            <ChannelTable
              rows={visibleRows}
              sort={sort}
              onSortChange={setSort}
              loading={isLoading}
            />
          )}

          <p className="px-1 text-[11px] leading-relaxed text-subtle-foreground">
            {HIT_RATE_DEFINITION}
            {isFetching && !isLoading ? (
              <span className="ml-2 text-accent">Refreshing…</span>
            ) : null}
          </p>
        </>
      )}
    </PageContainer>
  );
}

/**
 * First-run state.
 *
 * Explains what the tool measures before asking for anything, so the single
 * input field has context. An empty dashboard is a starting point, not a
 * failure, and should not look like one.
 */
function EmptyTracker() {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <EmptyState
        icon={<Sparkles />}
        title={`Track the Shorts channels that matter to ${BRAND.company}.`}
        description={
          <>
            Monitor Shorts views, upload frequency, and hit rate across 7D, 30D,
            90D, 180D, or a custom period. Long-form videos are detected and
            excluded automatically, so every number describes Shorts only.
          </>
        }
        action={
          <AddChannelDialog
            trigger={
              <Button variant="primary" size="lg">
                <span className="text-base leading-none">+</span>
                Add Your First Channel
              </Button>
            }
          />
        }
      />

      <div className="grid gap-px border-t border-border bg-border sm:grid-cols-3">
        {[
          {
            title: "Hit rate, not vanity metrics",
            body: "The share of a channel's Shorts that clear your view threshold — the number that separates a repeatable system from one lucky video.",
          },
          {
            title: "Consistency beats one viral hit",
            body: "A channel at 10M / 8M / 200K / 150K looks impressive on totals. One at a steady 1.2M every time is usually the more valuable model.",
          },
          {
            title: "Shorts only, verified",
            body: "Duration, aspect ratio and YouTube's own Shorts URL are checked before a video counts. Anything ambiguous is excluded, never guessed.",
          },
        ].map((item) => (
          <div key={item.title} className="bg-surface p-5">
            <h4 className="text-[13px] font-medium text-foreground">{item.title}</h4>
            <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
              {item.body}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
