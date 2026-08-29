"use client";

import * as React from "react";
import { TrendingUp } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/error-state";
import { Card } from "@/components/ui/card";
import { ShortsFeed } from "@/components/shorts/shorts-feed";
import { FeedControls, useFeedControls } from "@/components/shorts/feed-controls";
import { baselineRangeFor, useShortsFeed } from "@/hooks/use-shorts-feed";
import { useDataset } from "@/hooks/use-dataset";
import { useFilters } from "@/components/providers/filters-provider";
import { MIN_SHORTS_FOR_BASELINE } from "@/lib/analytics/outliers";

/**
 * Biggest Outliers — the same scoring as Winners, but ranked purely and always
 * by multiple, over the longer analysis windows.
 *
 * Where Winners answers "what is hot this week?", this answers "what are the
 * most remarkable Shorts in this period, full stop?" — the list a director
 * works through when deciding what to study.
 *
 * Unbenchmarkable channels are excluded here rather than shown as "insufficient
 * data": this is an explicitly *ranked* list, and an unranked entry in a
 * numbered list is noise.
 */
export default function OutliersPage() {
  const { data, isLoading, error, refetch } = useDataset();
  const { niche, contentType } = useFilters();

  const controls = useFeedControls({
    defaultWindowDays: 30,
    defaultOwnership: "all",
    defaultSort: "outlierMultiple",
  });

  const range = controls.range;
  const baselineRange = React.useMemo(() => baselineRangeFor(range), [range]);

  const shorts = useShortsFeed(data, {
    range,
    baselineRange,
    niche,
    contentType,
    ownership: controls.ownership,
    minViews: controls.minViews,
    channelId: controls.channelId,
    sort: controls.sort,
    requireReliableBaseline: true,
  });

  const excludedForSample = useShortsFeed(data, {
    range,
    baselineRange,
    niche,
    contentType,
    ownership: controls.ownership,
    minViews: controls.minViews,
    channelId: controls.channelId,
    sort: controls.sort,
  }).filter((s) => s.outlierMultiple === null).length;

  if (error) {
    return (
      <PageContainer>
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader
        title="Biggest outliers"
        description="Shorts ranked by how far they beat their own channel's median. The single best signal for what is worth studying."
      />

      <FeedControls controls={controls} dataset={data} showNiche showOwnership />

      <ShortsFeed
        shorts={shorts}
        dataset={data}
        loading={isLoading}
        showRank
        emptyTitle="No rankable outliers in this window"
        emptyDescription={
          <>
            A channel needs at least {MIN_SHORTS_FOR_BASELINE} Shorts in the baseline
            window before its median is a trustworthy benchmark. Try a longer window
            or a different niche.
          </>
        }
      />

      <p className="flex items-start gap-2 px-1 text-[11px] leading-relaxed text-subtle-foreground">
        <TrendingUp className="mt-px size-3 shrink-0" />
        Outlier multiple is views ÷ that channel&rsquo;s median Short over the baseline
        window. Median rather than average, because one viral Short would inflate an
        average and hide the next breakout.
        {excludedForSample > 0 ? (
          <>
            {" "}
            {excludedForSample}{" "}
            {excludedForSample === 1 ? "Short is" : "Shorts are"} hidden here because
            their channel has fewer than {MIN_SHORTS_FOR_BASELINE} Shorts in the
            baseline window — they appear in Winners marked as insufficient data.
          </>
        ) : null}
      </p>
    </PageContainer>
  );
}
