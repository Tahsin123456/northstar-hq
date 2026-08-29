"use client";

import * as React from "react";
import { Flame } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/error-state";
import { Card } from "@/components/ui/card";
import { ShortsFeed } from "@/components/shorts/shorts-feed";
import {
  FeedControls,
  useFeedControls,
} from "@/components/shorts/feed-controls";
import { baselineRangeFor, useShortsFeed } from "@/hooks/use-shorts-feed";
import { useDataset } from "@/hooks/use-dataset";
import { useFilters } from "@/components/providers/filters-provider";
import { formatCompactNumber } from "@/lib/format";

/**
 * Winners — "what is blowing up right now?"
 *
 * Recency-scoped and ranked by breakout, not by size. Defaults to the last 7
 * days and to competitors, because the job this page does is market discovery:
 * a director opens it to find out what is working *out there* that they should
 * be studying.
 *
 * Uses the same period control as everything else, but with its own tighter
 * window options — "what is hot" is a 24h-to-30d question, not a 180-day one.
 */
export default function WinnersPage() {
  const { data, isLoading, error, refetch } = useDataset();
  // Niche and content type come from the global filter; ownership is a
  // page-local control, because a market-discovery feed defaults to
  // competitors regardless of what the dashboard is scoped to.
  //
  // The content-type filter is a PER-SHORT predicate here, unlike on the
  // dashboard where it narrows the channel list — the row on this page is a
  // Short, so its own classification is the right question. See `useShortsFeed`.
  const { niche, contentType } = useFilters();

  const controls = useFeedControls({
    defaultWindowDays: 7,
    defaultOwnership: "competitor",
    defaultSort: "outlierMultiple",
  });

  const range = controls.range;
  const baselineRange = React.useMemo(() => baselineRangeFor(range), [range]);

  const shorts = useShortsFeed(data, {
    range,
    baselineRange,
    niche,
    contentType,
    // The page-level ownership control overrides the global filter here: the
    // global default is "all", and a market-discovery feed that silently
    // included your own channels would be answering a different question.
    ownership: controls.ownership,
    minViews: controls.minViews,
    channelId: controls.channelId,
    sort: controls.sort,
  });

  const totalViews = shorts.reduce((sum, s) => sum + s.video.views, 0);
  const breakouts = shorts.filter((s) => (s.outlierMultiple ?? 0) >= 3).length;

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
        title="Winners"
        description="Recently uploaded Shorts that are performing well right now, ranked against each channel's own baseline."
        actions={
          !isLoading && shorts.length > 0 ? (
            <div className="flex items-center gap-4 text-[12px] text-muted-foreground">
              <span className="tnum">
                <span className="text-foreground">{shorts.length}</span> Shorts
              </span>
              <span className="tnum">
                <span className="text-foreground">{formatCompactNumber(totalViews)}</span>{" "}
                views
              </span>
              <span className="tnum">
                <span className="text-success">{breakouts}</span> at 3×+
              </span>
            </div>
          ) : undefined
        }
      />

      <FeedControls controls={controls} dataset={data} showNiche showOwnership />

      <ShortsFeed
        shorts={shorts}
        dataset={data}
        loading={isLoading}
        emptyTitle="Nothing is breaking out in this window"
        emptyDescription={
          <>
            No Shorts match these filters. Try a longer window, a lower minimum
            view count, or switch the channel type — the default here is
            competitors only.
          </>
        }
      />

      <p className="flex items-start gap-2 px-1 text-[11px] leading-relaxed text-subtle-foreground">
        <Flame className="mt-px size-3 shrink-0" />
        Ranked by how far each Short beat its own channel&rsquo;s median, not by raw
        views. A 4M-view Short from a channel that usually does 100K is far more
        interesting than a 5M-view Short from a channel that always does 4M.
      </p>
    </PageContainer>
  );
}
