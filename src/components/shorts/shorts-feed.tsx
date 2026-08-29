"use client";

import * as React from "react";
import { Flame, SearchX } from "lucide-react";
import type { FeedShort } from "@/hooks/use-shorts-feed";
import type { DatasetDTO } from "@/lib/dto";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ShortCard, ShortCardHeader } from "./short-card";
import { ShortDetailDialog, type ShortDetailTarget } from "./short-detail-dialog";
import { useVideoContentTypeResolutions } from "@/hooks/use-content-types";
import { EMPTY_RESOLUTION } from "@/lib/content-types/resolve";

/**
 * The shared feed body used by Winners, Outliers and any other ranked list.
 *
 * Keeping one component means the outlier multiple, the save control and the
 * notes affordance behave identically everywhere — the workflow is the same
 * whichever page a director happens to be on.
 */
export function ShortsFeed({
  shorts,
  dataset,
  loading,
  showRank = false,
  emptyTitle = "No Shorts match these filters",
  emptyDescription,
  limit = 100,
}: {
  shorts: readonly FeedShort[];
  dataset: DatasetDTO | undefined;
  loading?: boolean;
  showRank?: boolean;
  emptyTitle?: string;
  emptyDescription?: React.ReactNode;
  limit?: number;
}) {
  const [openShort, setOpenShort] = React.useState<FeedShort | null>(null);
  const noteCounts = dataset?.noteCounts.videos ?? {};
  // Resolved here, once, and handed down exactly like `noteCount` already is —
  // a scored feed row carries the analytics engine's projection of a video,
  // which deliberately knows nothing about this organization's labels.
  const contentTypeIndex = useVideoContentTypeResolutions();

  const visible = React.useMemo(() => shorts.slice(0, limit), [shorts, limit]);

  // The feed's own row shape flattened into what a single-Short view needs.
  // Built here rather than inside the dialog so the dialog stays usable from
  // Saved, whose rows are a different type describing the same Short.
  const detailTarget = React.useMemo<ShortDetailTarget | null>(
    () =>
      openShort
        ? {
            videoId: openShort.video.id,
            youtubeVideoId: openShort.video.youtubeVideoId,
            title: openShort.video.title,
            channelId: openShort.channel.id,
            channelName: openShort.channel.displayName,
            channelAvatarUrl: openShort.channel.avatarUrl,
            niches: openShort.niches,
          }
        : null,
    [openShort],
  );

  if (loading) {
    return (
      <Card className="overflow-hidden">
        <ShortCardHeader showRank={showRank} />
        <div className="flex flex-col">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 border-b border-border px-4 py-3">
              <Skeleton className="h-[54px] w-10 rounded" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-2.5 w-1/3" />
              </div>
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      </Card>
    );
  }

  if (visible.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<SearchX />}
          title={emptyTitle}
          description={
            emptyDescription ??
            "Try a longer date range, a lower minimum view count, or a different niche."
          }
        />
      </Card>
    );
  }

  return (
    <>
      <Card className="overflow-hidden">
        <ShortCardHeader showRank={showRank} />
        <div className="flex flex-col">
          {visible.map((short, index) => (
            <ShortCard
              key={short.video.id}
              short={short}
              rank={showRank ? index + 1 : undefined}
              noteCount={noteCounts[short.video.id] ?? 0}
              resolution={contentTypeIndex.get(short.video.id) ?? EMPTY_RESOLUTION}
              onOpenShort={setOpenShort}
            />
          ))}
        </div>

        {shorts.length > visible.length ? (
          <div className="border-t border-border px-4 py-2.5 text-center text-[11px] text-subtle-foreground">
            Showing the top {visible.length} of {shorts.length}. Narrow the filters to see
            further down the list.
          </div>
        ) : null}
      </Card>

      {/* The one place a Short is looked at on its own: notes, plus its niche
          and content type, changeable without leaving the feed. */}
      <ShortDetailDialog
        short={detailTarget}
        open={openShort !== null}
        onOpenChange={(open) => {
          if (!open) setOpenShort(null);
        }}
      />
    </>
  );
}

export { Flame };
