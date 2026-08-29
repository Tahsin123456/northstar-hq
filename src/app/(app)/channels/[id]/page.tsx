"use client";

import * as React from "react";
import { use } from "react";
import Link from "next/link";
import { Tv2 } from "lucide-react";
import { PageContainer } from "@/components/layout/app-shell";
import { ChannelHeader, ChannelHeaderSkeleton } from "@/components/channel/channel-header";
import { ChannelContentTypes } from "@/components/channel/channel-content-types";
import { ExcludedPanel } from "@/components/channel/excluded-panel";
import { NotesPanel } from "@/components/notes/notes-panel";
import { KpiCards } from "@/components/channel/kpi-cards";
import { ShortsTable } from "@/components/channel/shorts-table";
import { DistributionPanel } from "@/components/charts/distribution-panel";
import { HitRateChart } from "@/components/charts/hit-rate-chart";
import { PeriodSelector } from "@/components/dashboard/period-selector";
import { ThresholdSelector } from "@/components/dashboard/threshold-selector";
import { ContentTypeFilterControl } from "@/components/dashboard/scope-filters";
import { ErrorState } from "@/components/common/error-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useChannelRow } from "@/hooks/use-channel-analytics";
import { useDataset } from "@/hooks/use-dataset";
import { useChannelThreshold, useFilters } from "@/components/providers/filters-provider";
import { ThresholdNotConfiguredNotice } from "@/components/metrics/threshold-not-configured";
import { SetNicheThresholdButton } from "@/components/niches/niche-threshold-dialog";
import {
  calculateChannelMetrics,
  calculateHitRateSeries,
  calculateHitRateTrend,
  calculateViewDistribution,
  evaluateShorts,
  getShortsInDateRange,
  pickGranularity,
} from "@/lib/analytics";
import {
  HIT_RATE_DEFINITION,
  UNCONFIGURED_THRESHOLD_LABEL,
} from "@/lib/analytics/constants";
import { formatCompactNumber, formatPercent } from "@/lib/format";
import type { ContentTypeDTO, VideoDTO } from "@/lib/dto";

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
// Stable identities for the fallbacks below. A fresh array literal on every
// render would be a new dependency on every render, defeating the memos.
const EMPTY_VIDEOS: readonly VideoDTO[] = [];
const EMPTY_CONTENT_TYPES: readonly ContentTypeDTO[] = [];

export default function ChannelDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data, isLoading, error, refetch } = useDataset();
  const { range, nicheId, contentType } = useFilters();

  const row = useChannelRow(data, id);

  // Judged by this channel's own niche, so an RDR channel is measured against
  // RDR's definition of a hit even when no niche filter is selected.
  const { threshold, source: thresholdSource, nicheName: thresholdNicheName } =
    useChannelThreshold(row?.channel.niches ?? EMPTY_NICHES);

  /*
   * The niche an admin would fix, when there is one to fix.
   *
   * Only the *selected* niche can be unconfigured — that is the rule the
   * provider implements — so this looks it up rather than guessing from the
   * channel's several niches, which may disagree and are not what the user is
   * currently filtered to.
   */
  const unconfiguredNiche = React.useMemo(() => {
    if (threshold !== null || !nicheId) return null;
    return data?.niches.find((n) => n.id === nicheId && n.hitThreshold === null) ?? null;
  }, [data, nicheId, threshold]);

  /*
   * The channel's videos, narrowed to the selected content type.
   *
   * A PER-SHORT predicate, because on this page every number describes Shorts:
   * feeding the narrowed list into the memo below means the KPI cards, the
   * distribution, the series and the table all describe the same set. Filtering
   * only the table would leave a hit rate above it counting Shorts the table
   * does not list.
   *
   * Applied before the date window rather than after, so `calculateChannelMetrics`
   * — which does its own windowing — sees the same set as everything else.
   */
  const scopedVideos = React.useMemo(() => {
    const videos = row?.videos ?? EMPTY_VIDEOS;
    if (contentType === "all") return videos;
    return videos.filter((video) =>
      contentType === "unassigned"
        ? video.contentTypeIds.length === 0
        : video.contentTypeIds.includes(contentType),
    );
  }, [row, contentType]);

  // This channel's unclassified Shorts, for the "Untagged" option's badge.
  // Counted over the channel's whole stored history rather than the current
  // window, so the number does not move every time the period does.
  const untaggedShorts = React.useMemo(
    () =>
      (row?.videos ?? EMPTY_VIDEOS).filter(
        (video) => video.isShort && video.contentTypeIds.length === 0,
      ).length,
    [row],
  );

  // All derived analysis for this channel, recomputed only when the data or
  // the filters change.
  const analysis = React.useMemo(() => {
    if (!row) return null;

    const shortsInRange = getShortsInDateRange(scopedVideos, range);
    const granularity = pickGranularity(range);

    return {
      shortsInRange,
      // Recomputed here rather than reusing row.metrics, which was calculated
      // at the globally selected threshold. Mixing the two would show '29 hit'
      // beside a table listing 38.
      metrics: calculateChannelMetrics({ videos: scopedVideos, range, threshold }),
      evaluated: evaluateShorts(shortsInRange, threshold),
      granularity,
      distribution: calculateViewDistribution(shortsInRange, threshold),
      /*
       * The two hit-rate-only derivations are skipped entirely rather than
       * computed against a substituted number.
       *
       * A hit rate series and a first-half/second-half trend are nothing but
       * hit rate over time; with no threshold there is no series to draw, and
       * the panels below render an honest empty state instead. Everything else
       * on this page — uploads, views, the distribution shape — is independent
       * of the threshold and is still computed in full.
       */
      series: threshold === null
        ? []
        : calculateHitRateSeries(scopedVideos, range, threshold, granularity),
      trend: threshold === null
        ? null
        : calculateHitRateTrend(scopedVideos, range, threshold),
    };
  }, [row, scopedVideos, range, threshold]);

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
        {/* Shown, not merely honoured: a global filter that narrows this whole
            page without appearing on it is indistinguishable from a channel
            that suddenly published less. `unit="short"` because every figure
            below counts Shorts. */}
        <ContentTypeFilterControl
          contentTypes={data?.contentTypes ?? EMPTY_CONTENT_TYPES}
          unassignedCount={untaggedShorts}
          unit="short"
        />
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
                  {threshold === null
                    ? UNCONFIGURED_THRESHOLD_LABEL
                    : analysis.trend
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
            {/* An empty chart, not a flat line at zero. The series is genuinely
                empty — there is no threshold to measure any bucket against. */}
            {threshold === null ? (
              <ThresholdNotConfiguredNotice
                nicheName={thresholdNicheName}
                action={
                  unconfiguredNiche ? (
                    <SetNicheThresholdButton niche={unconfiguredNiche} />
                  ) : null
                }
              />
            ) : (
              <>
                <HitRateChart
                  points={analysis.series}
                  granularity={analysis.granularity}
                  averageHitRate={metrics.hitRate}
                />
                <p className="mt-2 text-[11px] leading-relaxed text-subtle-foreground">
                  Gaps mean no Shorts were published in that {analysis.granularity} —
                  not a 0% hit rate.
                </p>
              </>
            )}
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

      {/*
        Directly above the Shorts table on purpose.

        This is the channel's own claim about what it makes; every row below is
        the record of what each Short actually turned out to be. Adjacent, the
        two can be read against each other in one glance — which is the entire
        reason the channel carries tags of its own rather than inheriting the
        union of its Shorts'. Note it deliberately ignores the content-type
        FILTER above: this states what the channel is, not what you are
        currently looking at.
      */}
      <ChannelContentTypes channel={channel} />

      {/* --- Every Short in the window --- */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-medium tracking-tight text-foreground">
            Shorts in this period
          </h2>
          <p className="text-[12px] text-muted-foreground">
            {threshold === null ? (
              <>
                {metrics.totalShorts} Shorts ·{" "}
                <span className="text-warning">{UNCONFIGURED_THRESHOLD_LABEL}</span>
              </>
            ) : (
              <>
                {metrics.totalShorts} Shorts ·{" "}
                <span className="text-success">{metrics.hitCount} hit</span> at{" "}
                {formatCompactNumber(threshold)}+ views
                {/* Say where the bar came from, so a channel judged at its
                    niche's 750K is never mistaken for the 1M account default. */}
                {thresholdSource === "niche" && thresholdNicheName ? (
                  <span className="text-subtle-foreground">
                    {" "}
                    · {thresholdNicheName} default
                  </span>
                ) : thresholdSource === "override" ? (
                  <span className="text-subtle-foreground"> · temporary override</span>
                ) : (
                  <span className="text-subtle-foreground"> · account default</span>
                )}
              </>
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
