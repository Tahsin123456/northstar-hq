"use client";

import * as React from "react";
import Link from "next/link";
import { Tv2 } from "lucide-react";
import { PageContainer } from "@/components/layout/app-shell";
import { ChannelHeader, ChannelHeaderSkeleton } from "@/components/channel/channel-header";
import { ChannelContentTypeRules } from "@/components/channel/channel-content-types";
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
import { useDatasetFormat } from "@/hooks/dataset-format-context";
import { useChannelThreshold, useFilters } from "@/components/providers/filters-provider";
import { HitRuleNotConfiguredNotice } from "@/components/metrics/hit-rule-not-configured";
import { SetNicheThresholdButton } from "@/components/niches/niche-threshold-dialog";
import {
  calculateChannelMetrics,
  calculateHitRateSeries,
  calculateHitRateTrend,
  calculateViewDistribution,
  annotateAgainstThreshold,
  videosInDateRange,
  pickGranularity,
} from "@/lib/analytics";
import {
  HIT_RATE_DEFINITION,
  HIT_RATE_DEFINITION_LONGFORM,
  UNCONFIGURED_RULE_LABEL,
} from "@/lib/analytics/constants";
import { measuredRate, resolveHitDisplayState } from "@/lib/analytics/hit-display";
import {
  buildInheritanceTimeline,
  effectiveContentTypeIds,
} from "@/lib/content-types/resolve";
import { tallyEffectiveShorts } from "@/lib/content-types/tally";
import { formatCompactNumber, formatPercent } from "@/lib/format";
import type {
  ChannelContentTypeRuleDTO,
  ContentTypeDTO,
  VideoDTO,
} from "@/lib/dto";

/**
 * Channel detail — the shared body behind BOTH channel pages.
 *
 * Extracted verbatim from the Shorts route (`/channels/[id]`), which now
 * renders this and nothing else, so the Shorts page cannot have drifted. The
 * format comes from `useDatasetFormat()` rather than a prop: the /channels
 * route sits under the app shell's Shorts provider and reads "shorts" — the
 * value the context defaults to everywhere — and /longform/channels sits
 * under the Long Form provider and reads "longform", along with the matching
 * dataset, filter store and threshold resolution. One subtree, one format,
 * with no way to pass this component a format its providers disagree with.
 *
 * Everything here was already client-derived from the cached dataset, which
 * is what made the extraction mechanical: the format threads into the four
 * analytics calls and the child panels' words, and nothing else moves.
 *
 * TWO BLOCKS ARE SHORTS-ONLY, deliberately:
 *   • the content-type filter and the channel's content-type rules block —
 *     their counts come from `tallyEffectiveShorts`, which counts Shorts
 *     (`tally.ts:118`), so on a Long Form page their badges would be facts
 *     about the other product. Content types stay a Shorts surface until the
 *     tally learns formats; hiding the control is honest, showing wrong
 *     counts is not.
 *   • the historical distribution comparison, hidden inside
 *     `DistributionPanel` for the same reason: the history endpoint
 *     reconstructs Shorts only.
 */

/** Stable identity so the threshold memo does not rerun on every render. */
const EMPTY_NICHES: readonly { id: string }[] = [];
// Stable identities for the fallbacks below. A fresh array literal on every
// render would be a new dependency on every render, defeating the memos.
const EMPTY_VIDEOS: readonly VideoDTO[] = [];
/** A channel that has not loaded yet has no rules, so its videos inherit nothing. */
const EMPTY_RULES: readonly ChannelContentTypeRuleDTO[] = [];
const EMPTY_CONTENT_TYPES: readonly ContentTypeDTO[] = [];

export function ChannelDetailBody({ channelId }: { channelId: string }) {
  const format = useDatasetFormat();
  const { data, isLoading, error, refetch } = useDataset();
  const { range, nicheId, contentType } = useFilters();

  // The unit noun, once — same convention as the panels this page mounts.
  const many = format === "shorts" ? "Shorts" : "videos";

  const row = useChannelRow(data, channelId);

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
   * A PER-VIDEO predicate, because on this page every number describes one
   * format's videos: feeding the narrowed list into the memo below means the
   * KPI cards, the distribution, the series and the table all describe the
   * same set. Filtering only the table would leave a hit rate above it
   * counting videos the table does not list.
   *
   * Applied before the date window rather than after, so `calculateChannelMetrics`
   * — which does its own windowing — sees the same set as everything else.
   */
  const scopedVideos = React.useMemo(() => {
    const videos = row?.videos ?? EMPTY_VIDEOS;
    if (contentType === "all") return videos;

    /*
     * Resolved against THIS channel's rules, which is the whole reason the
     * filter finds anything: the videos that carry a type here overwhelmingly
     * inherit it and store nothing, so reading their own rows would narrow a
     * four hundred video library down to the two somebody had singled out.
     *
     * And resolved PER VIDEO, against its publish date. On a channel that
     * switched format the table is exactly where that has to be visible — the
     * filter finds the uploads a rule actually covered, and stops at the switch.
     */
    const timeline = buildInheritanceTimeline(row?.channel.contentTypeRules ?? EMPTY_RULES);
    return videos.filter((video) => {
      const effective = effectiveContentTypeIds({
        inheritedIds: timeline.at(video.publishedAt),
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
   * SHORTS-ONLY BY CONSTRUCTION (`tallyEffectiveShorts` counts Shorts), which
   * is why the two surfaces it feeds render only on the Shorts page — see the
   * header note.
   */
  const shortsTally = React.useMemo(
    () =>
      tallyEffectiveShorts([
        {
          rules: row?.channel.contentTypeRules ?? EMPTY_RULES,
          videos: row?.videos ?? EMPTY_VIDEOS,
        },
      ]),
    [row],
  );

  // All derived analysis for this channel, recomputed only when the data or
  // the filters change. The format threads into every call that narrows by
  // format, so a Long Form page never counts a Short anywhere on it.
  const analysis = React.useMemo(() => {
    if (!row) return null;

    const shortsInRange = videosInDateRange(scopedVideos, range, format);
    const granularity = pickGranularity(range);

    return {
      shortsInRange,
      // Recomputed here rather than reusing row.metrics, which is annotated
      // against the globally selected bar. The hit rate itself is identical
      // either way — it is counted from stored verdicts — but the shading and
      // the ratio column follow this page's own bar, and mixing the two would
      // highlight a different set of rows than the header describes.
      metrics: calculateChannelMetrics({ videos: scopedVideos, range, threshold, format }),
      evaluated: annotateAgainstThreshold(shortsInRange, threshold),
      granularity,
      distribution: calculateViewDistribution(shortsInRange, threshold),
      /*
       * The series and the trend no longer take a threshold, and no longer have
       * to be skipped when there isn't one.
       *
       * They count the STORED VERDICTS on the videos, so a channel in an
       * unconfigured niche produces buckets of `unscoreable` videos with a null
       * rate in each — which draws as a gap and reads as "nothing decided here",
       * which is the truth. Guarding on `threshold` would now be guarding on
       * the display control, which decides nothing.
       */
      series: calculateHitRateSeries(scopedVideos, range, granularity, format),
      trend: calculateHitRateTrend(scopedVideos, range, format),
    };
  }, [row, scopedVideos, range, threshold, format]);

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
            description={
              format === "shorts"
                ? "This channel isn't in your tracker. It may have been removed."
                : "This channel isn't on the Long Form side of your tracker. It may have been removed, or it is filed only under Shorts niches."
            }
            action={
              <Button variant="primary" asChild>
                <Link href={format === "shorts" ? "/" : "/longform"}>
                  Back to overview
                </Link>
              </Button>
            }
          />
        </div>
      </PageContainer>
    );
  }

  const { channel } = row;
  const metrics = analysis.metrics;
  /*
   * Resolved ONCE for the whole page, and read by everything on it that speaks
   * about the hit rate — the KPI strip resolves the same value internally from
   * the same object. Two guards over one object is how this page came to print
   * an em dash and a "0 hit" for the same number.
   */
  const hitState = resolveHitDisplayState(metrics.hits, metrics.totalShorts);

  return (
    <PageContainer className="flex flex-col gap-6">
      <ChannelHeader channel={channel} />

      <div className="flex flex-wrap items-center gap-2">
        <PeriodSelector />
        {/* Shown, not merely honoured: a global filter that narrows this whole
            page without appearing on it is indistinguishable from a channel
            that suddenly published less. `unit="short"` because every figure
            below counts Shorts — and Shorts-only, because the tally behind
            its badges is; see the header note. */}
        {format === "shorts" ? (
          <ContentTypeFilterControl
            contentTypes={data?.contentTypes ?? EMPTY_CONTENT_TYPES}
            unassignedCount={shortsTally.untagged}
            shortCounts={shortsTally.byType}
            unit="short"
          />
        ) : null}
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
        viewsDefinition={data?.viewsDefinition ?? null}
        format={format}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        {/* --- Hit rate over time --- */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>Hit rate over time</CardTitle>
                <CardDescription>
                  {/* The halves carry their denominators now. "18% then 24%"
                      over four decided videos and over two hundred are the same
                      sentence and completely different evidence, and the second
                      half of any recent window is the one most likely to be
                      thin because its videos are still in flight. */}
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
                videos — read off the verdicts rather than off the display bar,
                which decides nothing. A channel whose niche has a rule but
                whose videos are all still in flight gets the chart with gaps in
                it, because that is a wait rather than a misconfiguration. */}
            {hitState === "notConfigured" ? (
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
                  averageHitRate={measuredRate(metrics.hits)}
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
            <CardTitle>
              {format === "shorts"
                ? "Shorts performance distribution"
                : "Video performance distribution"}
            </CardTitle>
            <CardDescription>
              Where this channel&rsquo;s {many} actually land, and how that shape has
              shifted over time.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DistributionPanel
              shorts={analysis.shortsInRange}
              range={range}
              threshold={threshold}
              channelId={channel.id}
              format={format}
            />
          </CardContent>
        </Card>
      </div>

      {/*
        Directly above the videos table on purpose, and now for a stronger
        reason than adjacency.

        This block is where the tags on every row below come FROM. A reader who
        sees the same two chips on two hundred Shorts and wonders who filed them
        all has the answer immediately above the table, rather than having to
        infer inheritance from the fact that it is unlikely anybody did that by
        hand. The rows that differ from it are the deviations, and they are
        drawn to look like deviations.

        Note it deliberately ignores the content-type FILTER above: this states
        what the channel is, not what you are currently looking at.

        SHORTS PAGE ONLY — its "reaches N Shorts" figure is the Shorts tally.
      */}
      {format === "shorts" ? (
        <ChannelContentTypeRules channel={channel} shortsCount={shortsTally.total} />
      ) : null}

      {/* --- Every video in the window --- */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-medium tracking-tight text-foreground">
            {format === "shorts" ? "Shorts in this period" : "Videos in this period"}
          </h2>
          <p className="text-[12px] text-muted-foreground">
            {/*
              THE SAME STATE THE KPI STRIP AT THE TOP OF THIS PAGE RESOLVES,
              from the same object, rather than a fourth guard of its own.

              This sentence used to gate on `judged === 0` alone, which is false
              in the evidence-limited state — so a channel whose KPI card four
              inches above correctly read "Shorts that hit: —" over a 0%–45%
              range read "0 hit of 6 decided" down here, in success green. One
              page, one object, two answers. The count is printed in exactly the
              state where a count means something; the others say what is
              actually missing.
            */}
            {hitState !== "measured" ? (
              <>
                {metrics.totalShorts} {many} ·{" "}
                <span className="text-warning">
                  {hitState === "evidenceLimited"
                    ? `${metrics.hits.tally.unknown} passed the bar with the timing unrecorded · ${metrics.hits.judged} decided`
                    : metrics.hits.excluded > 0
                      ? `none decided yet · ${metrics.hits.excluded} excluded`
                      : UNCONFIGURED_RULE_LABEL}
                </span>
              </>
            ) : (
              <>
                {metrics.totalShorts} {many} ·{" "}
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

        <ShortsTable shorts={analysis.evaluated} threshold={threshold} format={format} />
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
        format={format}
        /*
         * The format-relative complement plus the unresolved backlog — the
         * SAME expression on both pages, because `metrics.excludedLongform`
         * is computed as in-range-minus-this-format's-count and is therefore
         * already "everything on this page's blind side" whichever page this
         * is. For shorts that is byte-for-byte the number this page always
         * showed.
         */
        excludedCount={metrics.excludedLongform + row.unclassifiedCount}
      />

      <p className="px-1 text-[11px] leading-relaxed text-subtle-foreground">
        {format === "shorts" ? HIT_RATE_DEFINITION : HIT_RATE_DEFINITION_LONGFORM}
      </p>
    </PageContainer>
  );
}
