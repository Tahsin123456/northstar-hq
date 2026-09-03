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
 * Long Form Winners — the Winners feed for the other side of the operation,
 * still at /longform/videos. It was titled "Videos", which named the unit
 * where the Shorts side names the question; the two sections now use the
 * same row names for the same kinds of screen.
 *
 * The same engine as /winners with `format: "longform"` threaded through:
 * `calculateOutliers` then selects long-form candidates AND builds each
 * channel's baseline from its long-form videos only, so a video is measured
 * against its channel's typical video, never against its Shorts. Uncertain
 * videos are in neither feed — the pinned `isVideoOfFormat` rule.
 *
 * The cards, the player and the detail dialog are the shared components in
 * their 16:9 configuration: `maxresdefault`/`hqdefault` posters in an
 * `aspect-video` frame, /watch links, and the Long Form channel page behind
 * every channel name.
 *
 * The default window is 30 days where Winners uses 7: a long-form video's arc
 * is slower, and a week-old upload is often still climbing. Note the age
 * floor for channels with no configured rule is the shared 7 days — short for
 * this format, but a floor rather than a claim of maturity, and any channel
 * under a configured Long Form niche uses its own window instead.
 */
export default function LongformVideosPage() {
  const { data, isLoading, error, refetch } = useDataset();
  const { niche, contentType } = useFilters();

  const controls = useFeedControls({
    defaultWindowDays: 30,
    defaultOwnership: "competitor",
    defaultSort: "outlierMultiple",
  });

  const range = controls.range;
  const baselineRange = React.useMemo(() => baselineRangeFor(range), [range]);

  const videos = useShortsFeed(data, {
    format: "longform",
    range,
    baselineRange,
    niche,
    contentType,
    ownership: controls.ownership,
    minViews: controls.minViews,
    channelId: controls.channelId,
    sort: controls.sort,
  });

  const totalViews = videos.reduce((sum, s) => sum + s.video.views, 0);
  const breakouts = videos.filter((s) => (s.outlierMultiple ?? 0) >= 3).length;

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
        description="Recently uploaded long-form videos that are performing well right now, ranked against each channel's own baseline."
        actions={
          !isLoading && videos.length > 0 ? (
            <div className="flex items-center gap-4 text-[12px] text-muted-foreground">
              <span className="tnum">
                <span className="text-foreground">{videos.length}</span> videos
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
        shorts={videos}
        dataset={data}
        loading={isLoading}
        format="longform"
        emptyTitle="No videos match these filters"
        emptyDescription={
          <>
            Nothing long-form matches these filters. Try a longer window, a
            lower minimum view count, or switch the channel type — the default
            here is competitors only.
          </>
        }
      />

      <p className="flex items-start gap-2 px-1 text-[11px] leading-relaxed text-subtle-foreground">
        <Flame className="mt-px size-3 shrink-0" />
        Ranked by how far each video beat its own channel&rsquo;s long-form
        median, not by raw views. A 4M-view video from a channel that usually
        does 100K is far more interesting than a 5M-view video from a channel
        that always does 4M.
      </p>
    </PageContainer>
  );
}
