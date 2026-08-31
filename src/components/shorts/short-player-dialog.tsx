"use client";

import * as React from "react";
import { ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { youtubeShortsUrl } from "@/lib/format";
import { frameFor, type ShortPlayerTarget } from "@/lib/shorts/player";

export type { ShortPlayerTarget };

/**
 * =========================================================================
 * WATCHING A SHORT WITHOUT LEAVING THE APP
 * =========================================================================
 *
 * Every Short in this product used to be a link out. That is a defensible
 * default for a research tool — YouTube's player is the real thing — but in
 * practice it meant a director scanning Winners ended the session with thirty
 * tabs open and no idea which of them they had already judged. The work is
 * "watch this, decide, move to the next one", and a new tab per Short breaks it
 * in the middle every single time.
 *
 * WHY A SEPARATE DIALOG FROM `ShortDetailDialog`
 * They answer different questions and one of them applies to things the other
 * cannot describe. `ShortDetailDialog` is about a Short THIS APP TRACKS — it
 * needs an internal `Video` row to hang notes, a niche and a content type off.
 * A Short quoted by a note is deliberately not tracked: no `Video` row, no
 * channel, no views, nothing but an eleven-character id. This dialog needs only
 * the id, which is exactly why the notes log can use it. Folding the player
 * into the detail dialog would have made playback available on precisely the
 * surfaces that already had the most context and unavailable on the one that
 * has none.
 *
 * PLAYBACK STOPS WHEN THE DIALOG CLOSES, and that is not incidental.
 * A cross-origin iframe keeps playing when it is merely hidden, so an overlay
 * dismissed over a talking Short leaves a voice coming out of a page that shows
 * no video — the reader has no control to stop and often no idea where it is
 * coming from. Two things prevent it, deliberately belt and braces: Radix
 * unmounts the portal's contents on close (no `forceMount` anywhere, and the
 * dialog defines an enter animation only, so there is no exit transition
 * holding the node alive), and `frameFor` below returns `null` for a closed
 * dialog so the element is never in the tree to begin with. `frameFor` is
 * exported and directly tested, because "the iframe is gone" is the kind of
 * property that quietly stops being true when somebody adds an exit animation.
 *
 * WHAT GOOGLE LEARNS, AND WHEN
 * Nothing at all until somebody opens this dialog. The feeds render thumbnails
 * from i.ytimg.com as they always have; the player is mounted only by an
 * explicit click on a specific Short, so no page in this app contacts the
 * player host on load. Once open, the reader's own browser talks to Google
 * directly, carrying whatever Google account it is signed into. That is a
 * genuinely new data flow and is written into /privacy rather than left to be
 * inferred.
 */

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToMotionPreference(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * True when the reader has asked their system for less movement.
 *
 * A video that starts by itself is the largest piece of motion this app can
 * produce, so it is the one thing here that has to ask. The stylesheet's global
 * reduced-motion rule cannot help: it collapses CSS animation durations, and a
 * playing video is not one.
 *
 * `useSyncExternalStore` rather than an effect that sets state, because the
 * preference is somebody else's state and React has a way of saying so. The
 * server snapshot is `false` and so is the fallback for a browser that cannot
 * answer, which is the right way round — it means a missing `matchMedia` gets
 * the ordinary behaviour rather than a player that silently never starts.
 */
export function usePrefersReducedMotion(): boolean {
  return React.useSyncExternalStore(
    subscribeToMotionPreference,
    () =>
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia(REDUCED_MOTION_QUERY).matches
        : false,
    () => false,
  );
}

export function ShortPlayerDialog({
  short,
  open,
  onOpenChange,
}: {
  /** `null` keeps the dialog closed and the player unmounted. */
  short: ShortPlayerTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const frame = frameFor(short, open, !prefersReducedMotion);

  const title = short?.title?.trim() ? short.title : "YouTube Short";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        Narrow on purpose. A Short is 9:16, and a dialog the width of the
        detail view would put a portrait video in the middle of two columns of
        empty surface. `max-w-lg` is the app's default and is wrong here.

        =====================================================================
        AND BOUNDED IN HEIGHT, WHICH IS NOT OPTIONAL HERE
        =====================================================================
        The shared `DialogContent` is `fixed` and centred with
        `-translate-y-1/2`, and it carries no `max-h`. A dialog taller than the
        viewport therefore hangs off BOTH edges, and because it is `fixed` there
        is no scroll in the document that can reach the part that is missing.
        The close button is `absolute right-3.5 top-3.5` on that same box, so
        the overflowing top edge takes the × with it — and the other exit,
        Escape, is the one this file documents below as unreachable the moment
        the reader clicks into the player. The combination is a dialog with no
        way out, on a landscape phone or any short window.

        Three parts, and each does a different job:
        - `max-h-[calc(100dvh-2rem)]` bounds the box. `dvh` rather than `vh`
          because on mobile `vh` is the tallest the viewport ever gets, so the
          browser's own chrome would still clip a `100vh` box.
        - `flex flex-col` + `min-h-0` on the body lets the player SHRINK into
          whatever is left instead of overflowing. The frame keeps its ratio
          while it shrinks, so a short window gets a smaller Short, not a
          cropped one.
        - `overflow-hidden` here with `overflow-y-auto` on the body: if the
          chrome alone ever exceeds the viewport, the body scrolls while the
          header and the × stay put. Putting the scroll on this box instead
          would scroll the × out of reach, which is the bug rather than the fix.
      */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-[420px] flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          {/* `pr-6` clears the close button, which is the only exit that keeps
              working once focus is inside the player — see the note below. */}
          <DialogTitle className="pr-6 text-[14px] leading-snug">
            <span className="line-clamp-2">{title}</span>
          </DialogTitle>
          <DialogDescription className="truncate">
            {short?.subtitle ?? "Playing here rather than in a new tab"}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pt-0">
          {/*
            THE FRAME BOX SIZES ITSELF FROM ITS HEIGHT, not its width.

            A 9:16 box that takes the dialog's width would be 420 wide and 746
            tall, which is off the bottom of most laptops. Fixing the height
            first and letting `aspect-[9/16]` derive the width means the player
            is always fully visible: capped at 560px so it cannot outgrow a
            short window, and 70dvh so it shrinks with one.

            `h-[…]` IS A PREFERENCE HERE, NOT A COMMITMENT, and that is the
            whole point of `min-h-0` beside it. This is a flex item in a column
            whose container is bounded by the dialog's `max-h`, so `h-` is the
            size it asks for and flex shrinks it when the window cannot pay.
            Without `min-h-0` a flex item refuses to shrink below its content
            and the box would overflow the dialog instead — which is the bug
            this replaced. `aspect-[9/16]` with `w-auto` re-derives the width
            from whatever height it ends up with, so it shrinks in proportion
            rather than getting squat.

            Worked through at 812x375, a phone held sideways: the dialog is
            capped at 343 tall, the header takes about 86 and the link row and
            padding about 32, so the player asks for 70dvh (262) and is given
            225 — a real 127x225 player, entirely on screen, with the × where
            the reader left it. `max-w-full` still guards the other axis, where
            a tall narrow window could otherwise derive a width past the dialog.
          */}
          <div className="mx-auto aspect-[9/16] h-[min(70dvh,560px)] min-h-0 w-auto max-w-full overflow-hidden rounded-lg bg-black ring-1 ring-border">
            {frame ? (
              <iframe
                // Keyed by src so switching Shorts without closing the dialog
                // replaces the document rather than navigating the existing
                // frame, which would otherwise leave the previous Short's audio
                // running through the swap on some browsers.
                key={frame.src}
                src={frame.src}
                title={`YouTube player — ${title}`}
                // Delegated on the element because the site's
                // Permissions-Policy header defaults these to `self`, and a
                // cross-origin frame is not `self`. Nothing here is granted
                // that the header denies outright — camera, microphone,
                // geolocation, payment and USB stay denied everywhere.
                allow="autoplay; encrypted-media; picture-in-picture; web-share"
                allowFullScreen
                // Matches the site-wide Referrer-Policy: Google learns the
                // origin, not that the reader was on /winners or /notes.
                referrerPolicy="strict-origin-when-cross-origin"
                className="size-full border-0"
              />
            ) : null}
          </div>

          {/* `shrink-0`: the player above absorbs a short window, this row does
              not. Squeezing the only always-working exit hint to nothing to buy
              the video twenty more pixels is the wrong trade. */}
          <div className="flex shrink-0 items-center justify-between gap-3">
            {/*
              THE WAY OUT IS KEPT, and it is not a courtesy.

              Two reasons, one of them structural. The app has no way to know in
              advance whether a Short may be embedded at all: the pipeline does
              not store YouTube's `embeddable` flag, and creator-disabled
              embedding and music licensing are both common on Shorts. When one
              refuses, YouTube renders its own error inside the frame and this
              link is the reader's only route to the video. The other reason is
              simply that the player here is not the real thing — no comments,
              no channel, no way to subscribe — and replacing an outward link
              with a lesser copy of the destination takes a capability away.
            */}
            <a
              href={short ? youtubeShortsUrl(short.youtubeVideoId) : "#"}
              target="_blank"
              // A new tab is handed a live handle on this document through
              // `window.opener` unless it is cut, and this destination is
              // chosen by data rather than by us.
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] rounded"
            >
              <ExternalLink className="size-3" />
              Open on YouTube
            </a>

            {/*
              An honest caption rather than a keyboard hint that would sometimes
              be a lie. Escape closes this dialog — until the reader clicks into
              the player, after which the key press happens inside YouTube's own
              document and never reaches us. That is a property of cross-origin
              framing and cannot be worked around from this side, so the close
              button above stays visible instead of being tidied away, and this
              says which one always works.
            */}
            <span className="text-[11px] text-subtle-foreground">
              Close with the × above
            </span>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
