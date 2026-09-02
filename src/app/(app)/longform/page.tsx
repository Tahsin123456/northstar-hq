"use client";

import * as React from "react";
import { FilterX, SearchX } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import {
  ChannelTable,
  type ChannelTableLabels,
} from "@/components/dashboard/channel-table";
import { DataFreshness, StaleDataNotice } from "@/components/dashboard/data-freshness";
import { PeriodSelector } from "@/components/dashboard/period-selector";
import { SearchInput } from "@/components/dashboard/search-input";
import {
  SummaryCards,
  type SummaryCardsLabels,
} from "@/components/dashboard/summary-cards";
import { ThresholdSelector } from "@/components/dashboard/threshold-selector";
import { ErrorState } from "@/components/common/error-state";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import {
  usePortfolioSummary,
  useChannelRows,
  useScopedRows,
  useVisibleRows,
} from "@/hooks/use-channel-analytics";
import { NicheEarningsPanel } from "@/components/dashboard/niche-earnings-panel";
import {
  NicheFilterControl,
  OwnershipFilterControl,
  ScopeSummary,
} from "@/components/dashboard/scope-filters";
import { useDataset } from "@/hooks/use-dataset";
import { useFilters } from "@/components/providers/filters-provider";
import { DEFAULT_SORT, type SortState } from "@/lib/sorting";
import { previousRange } from "@/lib/analytics/trends";
import { HitRuleNotConfiguredNotice } from "@/components/metrics/hit-rule-not-configured";
import { SetNicheThresholdButton } from "@/components/niches/niche-threshold-dialog";
import {
  HIT_RATE_DEFINITION_LONGFORM,
  UNCONFIGURED_RULE_LABEL,
  uploadViewsTipLongform,
} from "@/lib/analytics/constants";
import { resolveHitDisplayState } from "@/lib/analytics/hit-display";
import { asksAboutOneNiche } from "@/lib/niches/niche-kind";

/**
 * Long Form overview — the other side of the operation's primary screen.
 *
 * THE SAME MACHINERY AS THE SHORTS OVERVIEW, OVER THE OTHER DATASET. This
 * page mounts under the /longform layout's `LongformFiltersProvider`, so the
 * bare `useDataset()` below reads `/api/dataset?format=longform` and every
 * derived hook — rows, summaries, thresholds — counts long-form videos via
 * the format the provider publishes. Nothing here re-implements a metric: the
 * components are the Shorts ones with the format's own words handed in, which
 * is what keeps the two products incapable of defining a hit differently.
 *
 * WHAT IS DELIBERATELY NOT HERE (vs the Shorts overview): the content-type
 * performance table and the content-type filter. Content types are shared,
 * but every configuration surface for them lives on the Shorts side today;
 * this page ships the owner's approved scope — the summary, the ranking and
 * the niche economics — rather than a speculative copy of everything.
 *
 * A SHORTS-ROLE USER WHO TYPES THIS URL gets the ErrorState below, because
 * the dataset request itself is refused with a 403 — the API is the boundary,
 * exactly as it is for a longs-role user on a Shorts page.
 */

const LONGFORM_TABLE_LABELS: ChannelTableLabels = {
  countColumn: "Videos",
  countTip:
    "Long-form videos uploaded during the selected period. Shorts and anything the classifier could not confirm are excluded.",
  uploadViewsLabel: "Upload views",
  // The Long Form wording of the same disclosure; the snapshot-days suffix is
  // resolved by the summary card, which has the dataset in hand — a column
  // head only has room for the definition.
  uploadViewsTip: uploadViewsTipLongform(null),
  medianTip: "The typical video. More resistant to a single viral outlier than the average.",
  bestColumn: "Best video",
  consistencyTip:
    "0–100. How tightly this channel's long-form videos cluster around their median. High means dependable output rather than a few outliers carrying the total.",
  tableAriaLabel: "Tracked channels ranked by long-form hit rate",
  hrefBase: "/longform/channels",
};

const LONGFORM_SUMMARY_LABELS: SummaryCardsLabels = {
  uploadedLabel: "Videos uploaded",
  perUnit: "per video",
  noneInPeriod: "No videos in period",
  noChannelHasUploads: "No channel has videos this period",
  uploadViewsTip: uploadViewsTipLongform,
  hrefBase: "/longform/channels",
};

export default function LongformOverviewPage() {
  const { data, isLoading, error, refetch, isFetching } = useDataset();
  const {
    nicheId,
    nicheName,
    niche,
    ownership,
    ownFirst,
    contentType,
    clearScopeFilters,
    range,
  } = useFilters();

  const [query, setQuery] = React.useState("");
  const [sort, setSort] = React.useState<SortState>(DEFAULT_SORT);

  const rows = useChannelRows(data);

  // Scope first, then search and sort — the same order and the same reasons
  // as the Shorts overview: the summary cards must describe the scoped set.
  const scopedRows = useScopedRows(rows, niche, ownership, contentType);
  const visibleRows = useVisibleRows(
    rows,
    query,
    sort,
    niche,
    ownership,
    ownFirst,
    contentType,
  );

  const oneNicheSelected = asksAboutOneNiche(niche);
  const summary = usePortfolioSummary(scopedRows, {
    includeWatchlist: oneNicheSelected,
  });
  const previousSummary = usePortfolioSummary(scopedRows, {
    overrideRange: previousRange(range),
    includeWatchlist: oneNicheSelected,
  });

  const niches = data?.niches ?? [];

  const unconfiguredNiche = React.useMemo(
    () =>
      nicheId
        ? (data?.niches.find(
            (n) =>
              n.id === nicheId &&
              (n.hitThreshold === null || n.hitWindowHours === null),
          ) ?? null)
        : null,
    [data, nicheId],
  );

  const unassignedCount = React.useMemo(
    () => rows.filter((row) => row.channel.niches.length === 0).length,
    [rows],
  );
  const ownCount = React.useMemo(
    () => rows.filter((row) => row.channel.ownershipType === "own").length,
    [rows],
  );

  const hasChannels = rows.length > 0;
  const scopeIsEmpty = hasChannels && scopedRows.length === 0;

  const nothingScoreableInScope =
    resolveHitDisplayState(summary.pooled, summary.scorecardTotalShorts) ===
    "notConfigured";

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader
        title="Long Form"
        description={
          !hasChannels
            ? "Track the long-form channels the studio cares about. Channels filed under a Long Form niche — and any not filed anywhere yet — appear here."
            : nothingScoreableInScope
              ? `${UNCONFIGURED_RULE_LABEL} for ${nicheName ?? "these niches"}, so no hit rate is shown below.`
              : "Out of every 100 long-form videos these channels publish, how many reach their niche's view threshold inside its hit window?"
        }
        actions={
          data ? <DataFreshness oldestFetchedAt={data.oldestFetchedAt} /> : undefined
        }
      />

      {error ? (
        <div className="rounded-lg border border-border bg-surface">
          <ErrorState error={error} onRetry={() => refetch()} />
        </div>
      ) : !isLoading && !hasChannels ? (
        <div className="rounded-lg border border-border bg-surface">
          <EmptyState
            icon={<FilterX />}
            title="No channels on the Long Form side yet"
            description="File a tracked channel under a Long Form niche — or add one — and it appears here. Unfiled channels show on both sides until somebody files them."
          />
        </div>
      ) : (
        <>
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

          {data ? <StaleDataNotice oldestFetchedAt={data.oldestFetchedAt} /> : null}

          {nothingScoreableInScope ? (
            <HitRuleNotConfiguredNotice
              nicheName={nicheName}
              action={
                unconfiguredNiche ? (
                  <SetNicheThresholdButton niche={unconfiguredNiche} />
                ) : null
              }
            />
          ) : null}

          <SummaryCards
            summary={summary}
            previousSummary={previousSummary}
            viewsDefinition={data?.viewsDefinition ?? null}
            loading={isLoading}
            labels={LONGFORM_SUMMARY_LABELS}
          />

          {!isLoading && scopeIsEmpty ? (
            <div className="rounded-lg border border-border bg-surface">
              <EmptyState
                icon={<FilterX />}
                title="No channels match these filters"
                description="Nothing on the Long Form side fits this niche and channel-type combination."
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
              labels={LONGFORM_TABLE_LABELS}
            />
          )}

          {/* The economics, priced on the Long Form basis: every niche in this
              payload is a longform niche, so `NicheEarningsPanel` reads each
              row's own format and quotes a hand-entered rate per 1,000 plain
              views with no engaged-view share — see `manualRpmBasis`. The
              panel fetches its own long-form view GAINS for the period; the
              table rows above stay on the upload basis by design. */}
          <NicheEarningsPanel niches={niches} range={range} />

          <p className="px-1 text-[11px] leading-relaxed text-subtle-foreground">
            {HIT_RATE_DEFINITION_LONGFORM}
            {isFetching && !isLoading ? (
              <span className="ml-2 text-accent">Refreshing…</span>
            ) : null}
          </p>
        </>
      )}
    </PageContainer>
  );
}
