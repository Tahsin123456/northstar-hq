"use client";

import * as React from "react";
import { Play } from "lucide-react";
import { SHORTS_POSTER_FRAME } from "@/lib/shorts/feed-layout";
import { posterSourceFor } from "@/lib/shorts/poster";
import { cn } from "@/lib/utils";

/**
 * =========================================================================
 * THE SHAPE OF A SHORT, WHEREVER ONE IS DRAWN
 * =========================================================================
 *
 * WHY THIS FILE EXISTS. The owner asked for Notes and Saved to look "almost
 * identical" to Winners and Outliers. There were three cards claiming to be the
 * same card and none of them shared a line of code: the feed's card led with a
 * 9:16 poster, the saved board drew a 16:9 thumbnail that linked out to YouTube,
 * and the research log had no poster at all and led with a badge. `feed-layout`
 * already records what happens next — the grid class list was copied into three
 * files and "they drifted apart once already". This is the same lesson applied
 * one level up: the GRID was shared and the CARD was not, so the three cards
 * drifted inside a grid that did not.
 *
 * WHAT IS SHARED AND WHAT IS NOT. The shell, the poster box, the title control
 * and the footer rule — the things that make three grids read as one product.
 * NOT the contents of the footer: Winners shows an outlier multiple, Saved
 * shows the views journey it exists for, Notes shows a byline. Making those
 * identical would not be consistency, it would be deleting three screens and
 * keeping one.
 *
 * A CLASS CONSTANT RATHER THAN A WRAPPER COMPONENT, for the shell and the
 * footer. Both are a single `<div>` whose children differ completely in every
 * consumer, so a component would be a prop-forwarding shim that adds a stack
 * frame and hides a class list. The poster IS a component, because it has
 * state (which image source has failed), a fallback, and a rule about what to
 * draw when there is no Short at all.
 *
 * NOTHING IN HERE MAY CARRY A MINIMUM WIDTH — inherited verbatim from
 * `short-card`, and it now binds three screens instead of one. These cards sit
 * in a `grid-cols-1` column on a phone, and a single `min-w-` on any child is
 * all it takes to give the whole page a horizontal scrollbar.
 */

/**
 * The card itself: a column that clips its poster to the rounded corner and
 * lifts its border on approach.
 *
 * `overflow-hidden` is what lets the poster bleed to the card's edges, which is
 * why a consumer using this must NOT also put padding on the Card — the padding
 * moves inward to `SHORT_CARD_BODY`. That was the one structural change the
 * notes log needed: it carried `p-4` on the Card itself.
 *
 * `group` is relied on by the action plate below and by the play badge, so it
 * has to be on the Card rather than on an inner wrapper.
 */
export const SHORT_CARD_SHELL =
  "group flex min-w-0 flex-col overflow-hidden transition-colors duration-150 hover:border-border-strong";

/**
 * Everything below the poster.
 *
 * `flex-1` is what makes `mt-auto` on the footer work, and `gap-2` is what lets
 * a consumer stack rows without hand-placing `mt-*` on each one — which is what
 * the saved board was doing, and why its spacing did not match the feed's.
 */
export const SHORT_CARD_BODY = "flex min-w-0 flex-1 flex-col gap-2 p-3";

/**
 * The floor of the card.
 *
 * `mt-auto` is the whole point: grid tracks stretch, so pinning the last row to
 * the bottom means every card in a row ends on the same line and the figures
 * there can be compared by eye. Wrapping rather than fixed columns, because at
 * `grid-cols-1` on a narrow phone these have to be allowed to stack.
 */
export const SHORT_CARD_FOOTER =
  "mt-auto flex min-w-0 flex-wrap items-end justify-between gap-x-3 gap-y-1 border-t border-border pt-2";

/** The row of small facts under the title — channel, badges, chips. */
export const SHORT_CARD_META_ROW =
  "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-subtle-foreground";

/**
 * The plate the on-poster actions sit on.
 *
 * A token-coloured plate rather than bare icons on the image: a ghost icon over
 * an arbitrary video frame is legible on some Shorts and invisible on others,
 * and it has to work in both themes. Visibility is the caller's decision — the
 * feed and the saved board reveal it on hover unless the Short carries notes,
 * because a note count is information rather than an affordance.
 */
export const SHORT_CARD_ACTION_PLATE =
  "absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-md border border-border bg-surface/90 p-0.5 backdrop-blur-sm transition-opacity";

/**
 * The Short's own frame, in the Short's own shape.
 *
 * EVERY DECISION IN HERE IS `posterSourceFor`'s — which of the two sources to
 * draw, at what intrinsic size, and how to fit it — and that is deliberate:
 * this component holds only the one piece that genuinely is React, the record
 * of which URL has already failed. The rule itself is a pure function so it can
 * be tested, for exactly the same reason `frameFor` is one. See that file for
 * why the portrait source is tried first and why the fallback is letterboxed
 * into an unchanged 9:16 box rather than cropped to fill it.
 */
export function PosterFrame({ videoId }: { videoId: string }) {
  // WHICH source failed, not a boolean — see `posterSourceFor`. Keyed to the
  // URL, so a card recycled onto a different Short considers it untried again.
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const poster = posterSourceFor(videoId, failedSrc);

  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={poster.src}
      alt=""
      // The intrinsic size of whichever source is showing, so the browser gets
      // the ratio right before a byte arrives rather than from the class alone.
      width={poster.width}
      height={poster.height}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      // Only the portrait source has somewhere to fall back TO. Once the wide
      // fallback fails as well there is nothing left to try, and the play badge
      // drawn over this is what still says "video" on a blank frame.
      onError={poster.isPortrait ? () => setFailedSrc(poster.src) : undefined}
      className={cn("size-full bg-surface-sunken", poster.fit)}
    />
  );
}

/**
 * The poster box at the top of a card — including the case where there is no
 * Short to put in it.
 *
 * =========================================================================
 * WHY A NOTE WITH NO SHORT STILL GETS A 208px BOX
 * =========================================================================
 * This is the part of the shared card that only the research log needs, and it
 * is the reason the poster is a component rather than a class list. A note can
 * be about a channel, about a niche, or about nothing at all, and roughly half
 * of them have no Short anywhere on them.
 *
 * OMITTING THE POSTER FOR THOSE IS THE OBVIOUS MOVE AND IT IS WRONG. Grid items
 * stretch, so a card with no poster does not become shorter — it becomes a card
 * with 208px of dead space where its neighbours have a frame. The notes log's
 * own equal-height argument depends on the waste being BOUNDED by a clamped
 * five-line body; a bound of "one whole poster" is not the same bound.
 *
 * Splitting Short-less notes into a second grid is worse still: it fragments
 * the log on a property nobody asked to filter by, and the log is scanned down
 * its byline column.
 *
 * So the box is always there and always the same size, and when there is no
 * Short it carries the note's own type icon on the sunken plate — where the
 * play badge would be. The card keeps its shape; what changes is what the shape
 * contains, which is honest, because "this note is not about a Short" is a real
 * fact about the note rather than a missing image.
 *
 * `placeholder` rather than a boolean: the icon differs per note kind — a
 * screen for a channel, layers for a niche, a sticky note for a general
 * thought — and the caller already owns that mapping.
 */
export function ShortPoster({
  videoId,
  onPlay,
  placeholder,
  children,
  className,
}: {
  /** `null` draws the placeholder plate instead. See the note above. */
  videoId: string | null;
  /**
   * Plays the Short in the app. Absent means "there is nothing to play", which
   * is a different state from "there is a Short and you may not play it" —
   * the frame stops being a button rather than becoming a disabled one.
   */
  onPlay?: () => void;
  /** Drawn centred on the plate when there is no Short. */
  placeholder?: React.ReactNode;
  /** Absolutely-positioned overlays: a rank chip, an action plate. */
  children?: React.ReactNode;
  className?: string;
}) {
  const playable = videoId !== null && onPlay !== undefined;

  return (
    <div className={cn("relative bg-surface-sunken", className)}>
      {/*
        A BUTTON, not a link, and that is a deliberate downgrade in semantics.
        It does not navigate anywhere — it opens a dialog in this document — and
        dressing that up as an anchor would promise a middle-click and a "copy
        link address" that do nothing. The outward link still exists, inside the
        player, where it is honest about being one.

        The whole frame is the target because a play affordance the size of an
        icon is a poor thing to hit on a phone. Kept out of the tab order, with
        the title below as the accessible control: two tab stops onto one action
        is noise for anybody on a keyboard.
      */}
      <button
        type="button"
        onClick={playable ? onPlay : undefined}
        disabled={!playable}
        tabIndex={-1}
        aria-hidden
        // The button IS the 9:16 box, so the badge below centres on the poster
        // rather than on the card's full width. `SHORTS_POSTER_FRAME` is shared
        // with every loading skeleton — see the note on it.
        className={cn(
          "relative block cursor-pointer disabled:cursor-default",
          SHORTS_POSTER_FRAME,
        )}
      >
        {videoId !== null ? (
          <>
            <PosterFrame videoId={videoId} />

            {/* Drawn rather than left to the image, which is the one part of
                this that can fail: YouTube serves a placeholder or a 404 for a
                Short that has been deleted or made private, and the badge is
                what still says "this is a video" when the frame behind it is
                blank. Only when there is something to play — a badge over a
                dead button would be an affordance that lies. */}
            {playable ? (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 flex items-center justify-center"
              >
                <span className="flex size-10 items-center justify-center rounded-full bg-black/45 opacity-80 backdrop-blur-sm transition-opacity group-hover:opacity-100">
                  <Play className="size-4 fill-white text-white" />
                </span>
              </span>
            ) : null}
          </>
        ) : (
          // The Short-less plate. Muted and centred, in the play badge's
          // position, so a row of mixed cards still scans as one grid rather
          // than as a grid with holes in it.
          <span
            aria-hidden
            className="absolute inset-0 flex items-center justify-center text-subtle-foreground [&>svg]:size-8"
          >
            {placeholder}
          </span>
        )}
      </button>

      {children}
    </div>
  );
}

/**
 * The card's title, and its accessible play control.
 *
 * THE FRAME ABOVE IS HIDDEN FROM ASSISTIVE TECHNOLOGY precisely so this one
 * carries the whole action, with the Short's own name in it rather than "play".
 * Where there is nothing to play it renders as text rather than as a dead
 * button, so a keyboard user is not handed a tab stop that does nothing.
 */
export function ShortCardTitle({
  title,
  onPlay,
  className,
}: {
  title: string;
  onPlay?: () => void;
  className?: string;
}) {
  const shared = cn(
    "min-w-0 text-left text-[13px] font-medium leading-snug text-foreground",
    className,
  );

  if (!onPlay) {
    return (
      <span title={title} className={shared}>
        <span className="line-clamp-2 break-words">{title}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onPlay}
      title={title}
      className={cn(
        shared,
        "transition-colors hover:text-accent focus:outline-none focus-visible:text-accent",
      )}
    >
      <span className="line-clamp-2 break-words">{title}</span>
    </button>
  );
}
