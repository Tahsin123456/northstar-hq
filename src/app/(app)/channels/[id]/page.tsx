"use client";

import * as React from "react";
import { use } from "react";
import Link from "next/link";
import { Tv2 } from "lucide-react";
import { PageContainer } from "@/components/layout/app-shell";
import { ChannelHeader, ChannelHeaderSkeleton } from "@/components/channel/channel-header";
import { ExcludedPanel } from "@/components/channel/excluded-panel";
import { NotesPanel } from "@/components/notes/notes-panel";
import { KpiCards } from "@/components/channel/kpi-cards";
import { ShortsTable } from "@/components/channel/shorts-table";
import { DistributionPanel } from "@/components/charts/distribution-panel";
import { HitRateChart } from "@/components/charts/hit-rate-chart";
import { PeriodSelector } from "@/components/dashboard/period-selector";
import { ThresholdSelector } from "@/components/dashboard/threshold-selector";
import { ErrorState } from "@/components/common/error-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useChannelRow } from "@/hooks/use-channel-analytics";
import { useDataset } from "@/hooks/use-dataset";
import { useChannelThreshold, useFilters } from "@/components/providers/filters-provider";
import {
  calculateChannelMetrics,
  calculateHitRateSeries,
  calculateHitRateTrend,
  calculateViewDistribution,
  evaluateShorts,
  getShortsInDateRange,
  pickGranularity,
} from "@/lib/analytics";
import { HIT_RATE_DEFINITION } from "@/lib/analytics/constants";
import { formatCompactNumber, formatPercent } from "@/lib/format";

/**
 * Channel detail.
 *
 * Every figure, chart and row here is derived in the browser from the same
 * cached dataset the dashboard uses. The period and threshold controls are
 * repeated at the top on purpose: this is where a user most wants to sweep
 * across windows, and sending them back to the dashboard to change one would
 * break that loop.
 */
/** Stable identity so the threshold memo does not rerun on every render. */
const EMPTY_NICHES: readonly { id: string }[] = [];

export default function ChannelDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data, isLoading, error, refetch } = useDataset();
  const { range } = useFilters();

  const row = useChannelRow(data, id);

  // Judged by this channel's own niche, so an RDR channel is measured against
  // RDR's definition of a hit even when no niche filter is selected.
  const { threshold, source: thresholdSource, nicheName: thresholdNicheName } =
    useChannelThreshold(row?.channel.niches ?? EMPTY_NICHES);

  // All derived analysis for this channel, recomputed only when the data or
  // the filters change.
  const analysis = React.useMemo(() => {
    if (!row) return null;

    const shortsInRange = getShortsInDateRange(row.videos, range);
    const granularity = pickGranularity(range);

    return {
      shortsInRange,
      // Recomputed here rather than reusing row.metrics, which was calculated
      // at the globally selected threshold. Mixing the two would show '29 hit'
      // beside a table listing 38.
      metrics: calculateChannelMetrics({ videos: row.videos, range, threshold }),
      evaluated: evaluateShorts(shortsInRange, threshold),
      series: calculateHitRateSeries(row.videos, range, threshold, granularity),
      granularity,
      distribution: calculateViewDistribution(shortsInRange, threshold),
      trend: calculateHitRateTrend(row.videos, range, threshold),
    };
  }, [row, range, threshold]);

  if (error) {
    return (
      <PageContainer>
        <div className="rounded-lg border border-border bg-surface">
          <ErrorState error={error} onRetry={() => refetch()} />
        </div>
      </PageContainer>
    );
  }

  if (isLoading) {
    return (
      <PageContainer className="flex flex-col gap-6">
        <ChannelHeaderSkeleton />
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </PageContainer>
    );
  }

  if (!row || !analysis) {
    return (
      <PageContainer>
        <div className="rounded-lg border border-border bg-surface">
          <EmptyState
            icon={<Tv2 />}
            title="Channel not found"
            description="This channel isn't in your tracker. It may have been removed."
            action={
              <Button variant="primary" asChild>
                <Link href="/">Back to overview</Link>
              </Button>
            }
          />
        </div>
      </PageContainer>
    );
  }

  const { channel } = row;
  const metrics = analysis.metrics;

  return (
    <PageContainer className="flex flex-col gap-6">
      <ChannelHeader channel={channel} />

      <div className="flex flex-wrap items-center gap-2">
        <PeriodSelector />
        <ThresholdSelector
          effective={{
            threshold,
            source: thresholdSource,
            nicheName: thresholdNicheName,
          }}
        />
      </div>

      <KpiCards
        metrics={metrics}
        trendDelta={analysis.trend?.delta ?? null}
        threshold={threshold}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        {/* --- Hit rate over time --- */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>Hit rate over time</CardTitle>
                <CardDescription>
                  {analysis.trend
                    ? `${formatPercent(analysis.trend.firstHalf)} in the first half of this period, ${formatPercent(analysis.trend.secondHalf)} in the second.`
                    : "Whether this channel is improving, declining, steady or volatile."}
                </CardDescription>
              </div>
              <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-subtle-foreground">
                by {analysis.granularity}
              </span>
            </div>
          </CardHeader>
          <CardContent>
            <HitRateChart
              points={analysis.series}
              granularity={analysis.granularity}
              averageHitRate={metrics.hitRate}
            />
            <p className="mt-2 text-[11px] leading-relaxed text-subtle-foreground">
              Gaps mean no Shorts were published in that {analysis.granularity} — not a
              0% hit rate.
            </p>
          </CardContent>
        </Card>

        {/* --- Distribution --- */}
        <Card>
          <CardHeader>
            <CardTitle>Shorts performance distribution</CardTitle>
            <CardDescription>
              Where this channel&rsquo;s Shorts actually land, and how that shape has
              shifted over time.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DistributionPanel
              shorts={analysis.shortsInRange}
              range={range}
              threshold={threshold}
              channelId={channel.id}
            />
          </CardContent>
        </Card>
      </div>

      {/* --- Every Short in the window --- */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-medium tracking-tight text-foreground">
            Shorts in this period
          </h2>
          <p className="text-[12px] text-muted-foreground">
            {metrics.totalShorts} Shorts ·{" "}
            <span className="text-success">{metrics.hitCount} hit</span> at{" "}
            {formatCompactNumber(threshold)}+ views
            {/* Say where the bar came from, so a channel judged at its niche's
                750K is never mistaken for the 1M account default. */}
            {thresholdSource === "niche" && thresholdNicheName ? (
              <span className="text-subtle-foreground"> · {thresholdNicheName} default</span>
            ) : thresholdSource === "override" ? (
              <span className="text-subtle-foreground"> · temporary override</span>
            ) : (
              <span className="text-subtle-foreground"> · account default</span>
            )}
          </p>
        </div>

        <ShortsTable shorts={analysis.evaluated} threshold={threshold} />
      </div>

      <NotesPanel
        targetType="channel"
        targetId={channel.id}
        title="Channel notes"
        description="What you have noticed about this channel — format shifts, posting cadence, anything worth remembering next time."
      />

      <ExcludedPanel
        channelId={channel.id}
        range={range}
        excludedCount={metrics.excludedLongform + row.unclassifiedCount}
      />

      <p className="px-1 text-[11px] leading-relaxed text-subtle-foreground">
        {HIT_RATE_DEFINITION}
      </p>
    </PageContainer>
  );
}
