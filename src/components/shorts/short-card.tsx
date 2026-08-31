"use client";

import * as React from "react";
import Link from "next/link";
import { StickyNote } from "lucide-react";
import type { FeedShort } from "@/hooks/use-shorts-feed";
import {
  EM_DASH,
  formatCompactNumber,
  formatRelativeTime,
} from "@/lib/format";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EMPTY_RESOLUTION, type ContentTypeResolution } from "@/lib/content-types/resolve";
import { NicheChips } from "@/components/niches/niche-chip";
import { ContentTypeControl } from "@/components/content-types/content-type-control";
import { SaveShortButton } from "./save-short-button";
import type { UnbenchmarkableReason } from "@/lib/analytics/outliers";
import {
  SHORT_CARD_ACTION_PLATE,
  SHORT_CARD_BODY,
  SHORT_CARD_FOOTER,
  SHORT_CARD_META_ROW,
  SHORT_CARD_SHELL,
  ShortCardTitle,
  ShortPoster,
} from "./short-card-frame";
import { cn } from "@/lib/utils";

/**
 * The outlier multiple, rendered as the headline number.
 *
 * This is deliberately the most prominent thing on the card. Absolute views
 * tell you a channel is big; the multiple tells you a Short *broke out*, which
 * is the only one of the two that suggests something worth studying.
 *
 * `null` renders as words, never as a number, and THE WORDS DIFFER BY REASON.
 * A channel with three Shorts has no trustworthy median, and inventing a 40x
 * from that would send a director chasing noise. A Short still inside its hit
 * window is a different situation entirely: the channel is fine, the Short is
 * simply not finished, and comparing its two-day view count against a median of
 * mature Shorts would understate it by exactly the time it has left. One says
 * "this channel cannot be benchmarked"; the other says "come back Thursday".
 */
export function OutlierMultiple({
  multiple,
  sampleSize,
  reason,
  size = "md",
  className,
}: {
  multiple: number | null;
  sampleSize: number;
  /** Why there is no multiple. `null` when there is one. */
  reason?: UnbenchmarkableReason | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const textClass = { sm: "text-[13px]", md: "text-[17px]", lg: "text-[24px]" }[size];

  if (multiple === null) {
    const inFlight = reason === "in-flight";
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex cursor-default items-center text-[11px] text-subtle-foreground",
              className,
            )}
          >
            {inFlight ? "Still in window" : "Insufficient data"}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[280px]">
          {inFlight ? (
            <>
              This Short is still inside its niche&rsquo;s hit window. Its views
              are compared against the channel&rsquo;s typical Short, and its
              typical Short has had months — so a multiple now would understate
              it by however long it has left. Views per day is the age-neutral
              figure until the window shuts.
            </>
          ) : (
            <>
              This channel has only {sampleSize}{" "}
              {sampleSize === 1 ? "settled Short" : "settled Shorts"} in the
              baseline window. A median needs at least 5 to be a trustworthy
              benchmark, so no multiple is shown rather than a misleading one.
            </>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  // Emphasis tiers, not a gradient: 10x+ is genuinely exceptional, 3x+ is worth
  // a look, below that is ordinary variance.
  const tone =
    multiple >= 10
      ? "text-success"
      : multiple >= 3
        ? "text-foreground"
        : "text-muted-foreground";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("tnum inline-flex cursor-default items-baseline gap-1", className)}>
          <span className={cn("font-semibold leading-none tracking-tight", textClass, tone)}>
            {multiple >= 10 ? Math.round(multiple) : multiple.toFixed(1)}×
          </span>
          <span className="text-[10px] uppercase tracking-wider text-subtle-foreground">
            median
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        This Short did {multiple >= 10 ? Math.round(multiple) : multiple.toFixed(1)}× the
        views of this channel&rsquo;s median Short over the baseline window
        ({sampleSize} Shorts). Median, not average — one viral Short would drag an
        average up and hide the next breakout.
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * =========================================================================
 * ONE SHORT, AS A CARD
 * =========================================================================
 *
 * This was a table row until the owner said the feeds were "horizontal long
 * lines". It was: a 40x54 thumbnail, a title, and three fixed-width columns on
 * the right, stacked full-width under hand-matched column headings. That shape
 * fits a spreadsheet and fights everything else — at 1400px it spent two thirds
 * of the row on whitespace between the title and the numbers, and the
 * thumbnail, which is the fastest way a human recognises a Short, was smaller
 * than the text beside it.
 *
 * THE THUMBNAIL LEADS NOW, for the same reason it leads on the saved board: you
 * remember the frame — the face, the caption, the colour of the hook — long
 * before you remember the sentence. A grid of frames is scannable in a way a
 * stack of sentences is not.
 *
 * THE FRAME IS 9:16, WHICH IS THE SHAPE OF THE THING. An earlier draft of this
 * card used `aspect-video` and defended it on the grounds that `mqdefault.jpg`
 * is 320x180 whatever the video is and no portrait thumbnail can be derived
 * from an id. The second half was simply wrong: `oardefault.jpg` is the same
 * frame at its original aspect ratio, 1080x1920, off the same id with no API
 * call — see `youtubeShortsPosterUrl`. Rendering `mqdefault` here meant every
 * tile in a grid the owner asked to be VERTICAL was a wide box two thirds
 * filled with the stretched blur YouTube pillarboxes a portrait frame into.
 *
 * THE BOX IS ALWAYS 9:16, INCLUDING ON THE FALLBACK, and that is what stops the
 * grid reflowing. `oardefault` 404s for a video that is not actually portrait,
 * so the card falls back to `mqdefault` — but into the same portrait box,
 * letterboxed rather than cropped. Cropping the sides off a 16:9 frame to force
 * it portrait is the exact mistake the old 40x54 row made in the other axis,
 * and it threw away the sides of every hook. A box whose shape never changes
 * also means the space is reserved before either image loads. The choice of
 * source and fit is `posterSourceFor`, a pure function, for the same reason
 * `frameFor` is one: it is a rule, and there is no DOM here to test it in.
 *
 * THE POSTER IS WIDTH-CAPPED AND CENTRED rather than bled to the card's edges.
 * The shared grid gives a card about 325px at `xl`, and 9:16 of that is 578px
 * of thumbnail above a 100px body — a tile taller than most laptop viewports,
 * three of them to a row. Capping the poster and letting the card mat it keeps
 * the tile a readable height without cropping the frame or forking the grid
 * away from the notes log and the saved board, which declare the same one.
 *
 * CLICKING THE CARD PLAYS IT, IN THE APP. The thumbnail and the title used to
 * be two links to a new tab. They are now one gesture that opens the player
 * dialog. The way out to YouTube is not lost: it is inside that dialog, which
 * is the point at which somebody is looking at one Short and might want the
 * real thing.
 *
 * NOTHING IN HERE MAY CARRY A MINIMUM WIDTH. The card sits in a `grid-cols-1`
 * column on a phone, and one `min-w-` on any child is all it takes to give the
 * whole page a horizontal scrollbar. That is why the old row's `w-[112px]`
 * right-hand columns were rebuilt as a wrapping footer rather than moved.
 */
export function ShortCard({
  short,
  rank,
  onPlayShort,
  onOpenShort,
  noteCount = 0,
  resolution = EMPTY_RESOLUTION,
  className,
}: {
  short: FeedShort;
  rank?: number;
  /**
   * Plays the Short in the app. Separate from `onOpenShort` because they are
   * two different intentions with two different dialogs: this one is "let me
   * watch it", that one is "let me file it". Collapsing them would mean every
   * attempt to read a note started a video.
   */
  onPlayShort?: (short: FeedShort) => void;
  /**
   * Opens the single-Short view — notes, and the Short's niche and content
   * type. It used to be `onAddNote`, and the rename is the point: the dialog it
   * opens is no longer only about notes, and a prop still called `onAddNote`
   * would be the last thing in the codebase asserting that it was.
   */
  onOpenShort?: (short: FeedShort) => void;
  noteCount?: number;
  /** Supplied by the feed, which resolves the whole list in one pass. */
  resolution?: ContentTypeResolution;
  className?: string;
}) {
  const { video, channel } = short;

  return (
    <Card className={cn(SHORT_CARD_SHELL, className)}>
      <ShortPoster
        videoId={video.youtubeVideoId}
        onPlay={onPlayShort ? () => onPlayShort(short) : undefined}
      >
        {rank !== undefined ? (
          // On the frame rather than in the body: the rank is the reason the
          // card is in this position, and in a grid the reading order is no
          // longer obvious from the layout the way it was down a single column.
          <span className="tnum pointer-events-none absolute left-1.5 top-1.5 rounded border border-border bg-surface/90 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground backdrop-blur-sm">
            #{rank}
          </span>
        ) : null}

        {/* The plate reveals on hover EXCEPT when the Short carries notes —
            that is information about the Short rather than an affordance, and
            it has always been visible without hovering. Same rule as the saved
            board, so the two grids behave identically. */}
        <div
          className={cn(
            SHORT_CARD_ACTION_PLATE,
            noteCount > 0
              ? "opacity-100"
              : "opacity-0 focus-within:opacity-100 group-hover:opacity-100",
          )}
        >
          {onOpenShort ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onOpenShort(short)}
                  // The dialog behind this button is the app's single-Short
                  // filing view — notes, plus the niche and the content type —
                  // so the label names the Short rather than only the note.
                  aria-label="Open this Short: notes, niche and content type"
                  className={cn(noteCount > 0 && "text-accent")}
                >
                  <StickyNote />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {noteCount > 0
                  ? `${noteCount} ${noteCount === 1 ? "note" : "notes"} — open the Short`
                  : "Open this Short — notes, niche and content type"}
              </TooltipContent>
            </Tooltip>
          ) : null}

          <SaveShortButton short={short} />
        </div>
      </ShortPoster>

      <div className={SHORT_CARD_BODY}>
        <ShortCardTitle
          title={video.title}
          onPlay={onPlayShort ? () => onPlayShort(short) : undefined}
        />

        <div className={SHORT_CARD_META_ROW}>
          <Link
            href={`/channels/${channel.id}`}
            className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground transition-colors hover:text-accent"
          >
            <Avatar src={channel.avatarUrl} name={channel.displayName} size={14} />
            <span className="max-w-[140px] truncate">{channel.displayName}</span>
          </Link>

          {short.ownershipType === "own" ? (
            <Badge variant="accent" size="sm" className="tracking-wider">
              Own
            </Badge>
          ) : null}

          <NicheChips niches={short.niches} limit={1} size="sm" />

          {/* The same control as the Shorts table and Saved. A Short is worth
              classifying at the moment somebody notices it, which is here.
              `revealOnHover` is dropped in the grid: the control used to hide
              in a dense row of other people's columns, and on a card it has
              room to simply be there. */}
          <ContentTypeControl
            videoId={video.id}
            resolution={resolution}
            className="-ml-1"
          />
        </div>

        {/*
          THE NUMBERS, on the floor of the card.

          `mt-auto` pins them there however long the title ran, so the multiple
          — the one figure the whole feed is ranked by — sits on the same line
          across every card in a row and can be compared by eye. Wrapping
          rather than fixed columns: at `grid-cols-1` on a narrow phone these
          have to be allowed to stack, and the old `w-[112px]` block is exactly
          the kind of thing that would have pushed the page sideways instead.
        */}
        <div className={SHORT_CARD_FOOTER}>
          <div className="flex min-w-0 flex-col gap-0.5">
            <OutlierMultiple
              multiple={short.outlierMultiple}
              sampleSize={short.baselineSampleSize}
              reason={short.unbenchmarkable}
            />
            <span className="tnum text-[10px] text-subtle-foreground">
              median{" "}
              {short.channelMedianViews === null
                ? EM_DASH
                : formatCompactNumber(short.channelMedianViews)}
            </span>
          </div>

          <div className="flex min-w-0 flex-col items-end gap-0.5">
            <span className="tnum text-[13px] font-medium text-foreground">
              {formatCompactNumber(video.views)} views
            </span>
            <span className="tnum flex min-w-0 items-center gap-1.5 text-[10px] text-subtle-foreground">
              <span className="truncate">{formatRelativeTime(video.publishedAt)}</span>
              {short.viewsPerDay !== null ? (
                <>
                  <span aria-hidden className="text-border-strong">
                    ·
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-default">
                        {formatCompactNumber(short.viewsPerDay)}/day
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      Average since upload, over {short.ageDays.toFixed(1)} days. Not
                      shown for Shorts under a day old, where the figure would be an
                      extrapolation rather than a rate.
                    </TooltipContent>
                  </Tooltip>
                </>
              ) : null}
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}
