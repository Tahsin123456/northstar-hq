"use client";

import * as React from "react";
import { Flame, SearchX } from "lucide-react";
import type { FeedShort } from "@/hooks/use-shorts-feed";
import type { DatasetDTO } from "@/lib/dto";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ShortCard } from "./short-card";
import { ShortDetailDialog, type ShortDetailTarget } from "./short-detail-dialog";
import { ShortPlayerDialog, type ShortPlayerTarget } from "./short-player-dialog";
import { useVideoContentTypeResolutions } from "@/hooks/use-content-types";
import { EMPTY_RESOLUTION } from "@/lib/content-types/resolve";
import { SHORTS_CARD_GRID, SHORTS_POSTER_FRAME } from "@/lib/shorts/feed-layout";
import { cn } from "@/lib/utils";

/**
 * The shared feed body used by Winners, Outliers and any other ranked list.
 *
 * Keeping one component means the outlier multiple, the save control and the
 * notes affordance behave identically everywhere — the workflow is the same
 * whichever page a director happens to be on.
 *
 * A GRID, NOT A TABLE, since the owner's note that the feeds render as
 * "horizontal long lines". It used to be a `flex flex-col` of full-width rows
 * under a row of column headings hand-matched to their widths — a table in
 * everything but the element name. The headings went with the rows: a heading
 * that says "vs channel median" above a grid describes nothing, because there
 * is no column under it. Every figure they labelled is still on the card, said
 * in words instead of implied by position.
 *
 * TWO DIALOGS, and they are not redundant. The player answers "let me watch
 * this"; the detail dialog answers "let me file this" — notes, niche, content
 * type. They were one gesture only in the sense that both used to be reached
 * from the same row, and merging them would mean opening a note started a
 * video. Both are mounted once for the whole list rather than per card, so a
 * hundred Shorts cost one of each.
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
  const [playingShort, setPlayingShort] = React.useState<FeedShort | null>(null);
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

  /*
   * The player needs the id and two strings, and nothing else — see the note on
   * `ShortPlayerTarget`. Flattened here, like `detailTarget` above, so the
   * dialog stays usable from the notes log, where a quoted Short has no `Video`
   * row to project from at all.
   */
  const playerTarget = React.useMemo<ShortPlayerTarget | null>(
    () =>
      playingShort
        ? {
            youtubeVideoId: playingShort.video.youtubeVideoId,
            title: playingShort.video.title,
            subtitle: playingShort.channel.displayName,
          }
        : null,
    [playingShort],
  );

  if (loading) {
    return (
      // The same grid as the answer, so the loading state cannot settle into a
      // different shape than the one it was predicting. Eight rather than six:
      // at `2xl` the grid is four across, and six would leave a half-empty
      // second row that looks like the end of a short list.
      <div className={SHORTS_CARD_GRID}>
        {Array.from({ length: 8 }, (_, i) => (
          <Card key={i} className="flex flex-col overflow-hidden">
            {/* 9:16 and width-capped, matching `PosterFrame` exactly. A
                skeleton that predicts a different shape than the thing it
                stands in for is worse than none: the page settles by jumping,
                which is the moment a reader loses their place. */}
            <div className="bg-surface-sunken">
              <Skeleton className={cn(SHORTS_POSTER_FRAME, "rounded-none")} />
            </div>
            <div className="flex flex-col gap-2 p-3">
              <Skeleton className="h-3 w-11/12" />
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-2.5 w-1/2" />
              <div className="mt-1 flex items-center justify-between border-t border-border pt-2">
                <Skeleton className="h-4 w-14" />
                <Skeleton className="h-4 w-16" />
              </div>
            </div>
          </Card>
        ))}
      </div>
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
      <div className={SHORTS_CARD_GRID}>
        {visible.map((short, index) => (
          <ShortCard
            key={short.video.id}
            short={short}
            rank={showRank ? index + 1 : undefined}
            noteCount={noteCounts[short.video.id] ?? 0}
            resolution={contentTypeIndex.get(short.video.id) ?? EMPTY_RESOLUTION}
            onPlayShort={setPlayingShort}
            onOpenShort={setOpenShort}
          />
        ))}
      </div>

      {shorts.length > visible.length ? (
        // Out of the card it used to sit inside, because there is no longer one
        // card holding the list. A plain line under the grid, in the same voice.
        <p className="px-1 text-center text-[11px] text-subtle-foreground">
          Showing the top {visible.length} of {shorts.length}. Narrow the filters to see
          further down the list.
        </p>
      ) : null}

      {/* Watching it. Mounted once for the whole feed; the iframe inside exists
          only while this is open, which is what stops a dismissed overlay
          leaving a Short talking to an empty page. */}
      <ShortPlayerDialog
        short={playerTarget}
        open={playingShort !== null}
        onOpenChange={(open) => {
          if (!open) setPlayingShort(null);
        }}
      />

      {/* Filing it: notes, plus its niche and content type, changeable without
          leaving the feed. */}
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
