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
import { HitRuleNotConfiguredNotice } from "@/components/metrics/hit-rule-not-configured";
import { SetNicheThresholdButton } from "@/components/niches/niche-threshold-dialog";
import {
  calculateChannelMetrics,
  calculateHitRateSeries,
  calculateHitRateTrend,
  calculateViewDistribution,
  annotateAgainstThreshold,
  getShortsInDateRange,
  pickGranularity,
} from "@/lib/analytics";
import {
  HIT_RATE_DEFINITION,
  UNCONFIGURED_RULE_LABEL,
} from "@/lib/analytics/constants";
import { effectiveContentTypeIds } from "@/lib/content-types/resolve";
import { tallyEffectiveShorts } from "@/lib/content-types/tally";
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
/** A channel that has not loaded yet gives its Shorts nothing to inherit. */
const EMPTY_TYPE_IDS: readonly string[] = [];
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

    // Resolved against THIS channel's tags, which is the whole reason the filter
    // finds anything: the Shorts that carry a type here overwhelmingly inherit
    // it and store nothing, so reading their own rows would narrow a four
    // hundred Short library down to the two somebody had singled out.
    const channelTypeIds = row?.channel.contentTypeIds ?? EMPTY_TYPE_IDS;
    return videos.filter((video) => {
      const effective = effectiveContentTypeIds({
        channelTypeIds,
        manualIds: video.manualContentTypeIds,
        excludedIds: video.excludedContentTypeIds,
      });
      return contentType === "unassigned"
        ? effective.length === 0
        : effective.includes(contentType);
    });
  }, [row, contentType]);

  /*
   * This channel's Shorts, resolved: the per-type counts and the untagged count
   * behind the filter menu's badges, and the reach of a channel-level tag for
   * the Content Types block below.
   *
   * ONE PASS FOR ALL THREE, because all three have to agree with each other and
   * with `scopedVideos` above. A menu that offered "Rankings · 40" over a table
   * of twelve, or a Content Types block promising to reach a different number of
   * Shorts than the filter can find, would each be the same bug: two counts of
   * one library derived two ways.
   *
   * Counted over the channel's whole stored history rather than the current
   * window, so none of these numbers moves every time the period does.
   *
   * ON A TAGGED CHANNEL `untagged` IS NOW ZERO, and that is the correct answer
   * rather than a broken one: every Short inherits the channel's tags, so none of
   * them is unclassified. The badge collapsing to nothing the moment somebody
   * tags the channel is the feature working.
   */
  const shortsTally = React.useMemo(
    () =>
      tallyEffectiveShorts([
        {
          channelTypeIds: row?.channel.contentTypeIds ?? EMPTY_TYPE_IDS,
          videos: row?.videos ?? EMPTY_VIDEOS,
        },
      ]),
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
      // Recomputed here rather than reusing row.metrics, which is annotated
      // against the globally selected bar. The hit rate itself is identical
      // either way — it is counted from stored verdicts — but the shading and
      // the ratio column follow this page's own bar, and mixing the two would
      // highlight a different set of rows than the header describes.
      metrics: calculateChannelMetrics({ videos: scopedVideos, range, threshold }),
      evaluated: annotateAgainstThreshold(shortsInRange, threshold),
      granularity,
      distribution: calculateViewDistribution(shortsInRange, threshold),
      /*
       * The series and the trend no longer take a threshold, and no longer have
       * to be skipped when there isn't one.
       *
       * They count the STORED VERDICTS on the Shorts, so a channel in an
       * unconfigured niche produces buckets of `unscoreable` Shorts with a null
       * rate in each — which draws as a gap and reads as "nothing decided here",
       * which is the truth. Guarding on `threshold` would now be guarding on
       * the display control, which decides nothing.
       */
      series: calculateHitRateSeries(scopedVideos, range, granularity),
      trend: calculateHitRateTrend(scopedVideos, range),
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
          unassignedCount={shortsTally.untagged}
          shortCounts={shortsTally.byType}
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

      <KpiCards metrics={metrics} trendDelta={analysis.trend?.delta ?? null} />

      <div className="grid gap-4 xl:grid-cols-2">
        {/* --- Hit rate over time --- */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>Hit rate over time</CardTitle>
                <CardDescription>
                  {/* The halves carry their denominators now. "18% then 24%"
                      over four decided Shorts and over two hundred are the same
                      sentence and completely different evidence, and the second
                      half of any recent window is the one most likely to be
                      thin because its Shorts are still in flight. */}
                  {analysis.trend
                    ? `${formatPercent(analysis.trend.firstHalf)} over ${analysis.trend.firstJudged} decided in the first half of this period, ${formatPercent(analysis.trend.secondHalf)} over ${analysis.trend.secondJudged} in the second.`
                    : "Whether this channel is improving, declining, steady or volatile."}
                </CardDescription>
              </div>
              <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-subtle-foreground">
                by {analysis.granularity}
              </span>
            </div>
          </CardHeader>
          <CardContent>
            {/* The notice, not an empty chart, when NO RULE reached these
                Shorts — read off the verdicts rather than off the display bar,
                which decides nothing. A channel whose niche has a rule but
                whose Shorts are all still in flight gets the chart with gaps in
                it, because that is a wait rather than a misconfiguration. */}
            {metrics.totalShorts > 0 &&
            metrics.hits.judged === 0 &&
            metrics.hits.tally.pending === 0 &&
            metrics.hits.tally.unknown === 0 ? (
              <HitRuleNotConfiguredNotice
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
                  averageHitRate={metrics.hits.rate}
                />
                <p className="mt-2 text-[11px] leading-relaxed text-subtle-foreground">
                  A gap means nothing was decided in that {analysis.granularity} —
                  either nothing was published, or everything published is still
                  inside its hit window. Neither is a 0% hit rate. Hover a point
                  for the split.
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
        Directly above the Shorts table on purpose, and now for a stronger
        reason than adjacency.

        This block is where the tags on every row below come FROM. A reader who
        sees the same two chips on two hundred Shorts and wonders who filed them
        all has the answer immediately above the table, rather than having to
        infer inheritance from the fact that it is unlikely anybody did that by
        hand. The rows that differ from it are the deviations, and they are
        drawn to look like deviations.

        Note it deliberately ignores the content-type FILTER above: this states
        what the channel is, not what you are currently looking at.
      */}
      <ChannelContentTypes channel={channel} shortsCount={shortsTally.total} />

      {/* --- Every Short in the window --- */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-medium tracking-tight text-foreground">
            Shorts in this period
          </h2>
          <p className="text-[12px] text-muted-foreground">
            {metrics.hits.judged === 0 ? (
              <>
                {metrics.totalShorts} Shorts ·{" "}
                <span className="text-warning">
                  {metrics.hits.excluded > 0
                    ? `none decided yet · ${metrics.hits.excluded} excluded`
                    : UNCONFIGURED_RULE_LABEL}
                </span>
              </>
            ) : (
              <>
                {metrics.totalShorts} Shorts ·{" "}
                <span className="text-success">{metrics.hits.hits} hit</span> of{" "}
                {metrics.hits.judged} decided
                {metrics.hits.excluded > 0
                  ? ` · ${metrics.hits.excluded} excluded`
                  : ""}
                {/* Where the DISPLAY BAR came from. It shades the views column
                    and scales the ratio; it is no longer what "hit" above
                    means, so the sentence no longer claims it is. */}
                {" · bar "}
                {threshold === null ? "not set" : `${formatCompactNumber(threshold)}+`}
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
