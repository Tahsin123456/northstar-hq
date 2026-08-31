"use client";

import * as React from "react";
import { ExternalLink, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { ShortPlayerDialog } from "@/components/shorts/short-player-dialog";
import type { NoteDTO } from "@/lib/dto";
import { youtubeThumbnailUrl } from "@/lib/format";
import {
  canonicalShortUrl,
  EXTERNAL_SHORT_URL_HINT,
  readExternalShortInput,
  type ExternalShortInput,
} from "@/lib/youtube-url";
import { cn } from "@/lib/utils";

/**
 * The Short a note quotes from outside the tracker — the field for attaching
 * one, and the card that renders it afterwards.
 *
 * One file for both, for the same reason `note-visibility.tsx` holds a badge
 * and a toggle together: the composer, the panel on a channel page and the
 * research log all show this, and a preview that says "YouTube Short" in one
 * place and "External video" in another is the kind of drift that makes people
 * unsure whether they are looking at the same thing.
 *
 * THIS IS NOT A TRACKED SHORT. Everything here describes a competitor's video
 * that is deliberately absent from the database — no `Video` row, no channel,
 * no view count, no niche. All it has is an id, a URL composed from that id, a
 * thumbnail derived from the id, and two strings YouTube may or may not have
 * given us. The rendering below is honest about that: there is nothing to link
 * internally to, so the only link is out.
 */

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** Just the parts of a note this module reads, so the card is reusable. */
export type ExternalShortFields = Pick<
  NoteDTO,
  "externalVideoId" | "externalUrl" | "externalTitle" | "externalChannelTitle"
>;

/**
 * The attached Short, under the note that quotes it.
 *
 * Renders nothing when there is no Short — the common case by a wide margin, so
 * this must add no empty box, no divider and no gap to a note that has none.
 *
 * Both `externalVideoId` and `externalUrl` are required before anything is
 * drawn. They are written and cleared as one group by the server, so one
 * without the other should be impossible; refusing to render on the impossible
 * combination is cheaper than an `href={undefined}` that renders as a link
 * going nowhere.
 */
export function ExternalShortPreview({
  note,
  className,
}: {
  note: ExternalShortFields;
  className?: string;
}) {
  /*
   * THE ATTACHMENT PLAYS HERE NOW, and this component is why request "same for
   * notes as well" reaches three screens at once: the research log, the notes
   * panel on a channel page, and the composer's own preview all draw this. That
   * is the point of it being one component — an attachment that played in the
   * log and opened a tab in the panel would be the exact drift the file header
   * argues against.
   *
   * It became a card with two controls rather than one link, because a play
   * button inside an anchor is invalid markup and a keyboard user gets whichever
   * of the two the browser happens to pick. So: the frame and the title are a
   * button that opens the player, and the way out to YouTube is its own small
   * link beside them.
   */
  const [playing, setPlaying] = React.useState(false);

  const { externalVideoId, externalUrl } = note;
  if (!externalVideoId || !externalUrl) return null;

  // WHAT THE LINK SAYS WHEN THERE IS NO TITLE.
  //
  // Metadata is best effort — no API key, spent quota, a private video — so a
  // titleless attachment is ordinary, not broken. It must still be obviously a
  // link and obviously say what it is, which is why the fallback is a plain
  // description of the thing rather than the raw id, an em dash, or the URL
  // string. The id goes on the second line, where it identifies the Short
  // without pretending to be its name.
  const title = note.externalTitle ?? "YouTube Short";
  const subtitle = note.externalChannelTitle ?? `youtube.com/shorts/${externalVideoId}`;

  return (
    <div
      className={cn(
        "group/short flex items-center gap-2.5 rounded-lg border border-border bg-surface-sunken/60 p-2",
        "transition-colors duration-150 hover:border-border-strong hover:bg-surface-hover",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setPlaying(true)}
        title={note.externalTitle ?? `Play this Short — ${externalVideoId}`}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
      >
        <ExternalShortThumbnail videoId={externalVideoId} />

        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[12px] font-medium text-foreground transition-colors group-hover/short:text-accent">
            {title}
          </span>
          <span className="truncate text-[11px] text-subtle-foreground">{subtitle}</span>
        </span>
      </button>

      {/*
       * COMPOSED HERE, not read from the column.
       *
       * `externalUrl` is safe today — `externalShortColumns` is its only writer
       * and always builds it from an eleven-character id — but this is the one
       * place a stored string becomes an `href`, and "safe because of what some
       * other file does" is a property that holds until somebody restores a
       * backup, hand-edits a row, or adds a second writer. Rebuilding from
       * `externalVideoId`, which this component already requires to be present,
       * costs nothing and makes a hostile value unreachable rather than absent.
       * The player's `src` is built from the same id for the same reason.
       *
       * KEPT, now that the card plays in place. Some Shorts refuse to be
       * embedded at all — the creator disabled it, or the music on it is
       * licensed that way — and this is then the only route to the video. It is
       * also simply a smaller thing than YouTube: no comments, no channel, no
       * subscribe. Replacing the link with the player would have been a
       * capability removed, not a capability added.
       */}
      <a
        href={canonicalShortUrl(externalVideoId)}
        target="_blank"
        // Opening in a new tab hands the new document a handle on this one
        // through `window.opener` unless it is cut. `noreferrer` covers the
        // browsers where `noopener` alone is not enough, and neither is optional
        // on a link whose destination somebody else chose.
        rel="noopener noreferrer"
        title={`Open this Short on YouTube — ${externalVideoId}`}
        aria-label="Open this Short on YouTube"
        className="shrink-0 rounded p-1 text-subtle-foreground transition-colors hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
      >
        <ExternalLink className="size-3" />
      </a>

      <ShortPlayerDialog
        short={{ youtubeVideoId: externalVideoId, title, subtitle }}
        open={playing}
        onOpenChange={setPlaying}
      />
    </div>
  );
}

/**
 * The thumbnail, which costs NO request to know about.
 *
 * `youtubeThumbnailUrl` composes an `i.ytimg.com` address from the video id
 * alone, so every attached Short is recognisable the instant it is saved, even
 * on a deployment with no Data API key at all. That is what makes the metadata
 * lookup genuinely optional rather than nominally optional.
 *
 * The play badge is drawn rather than relying on the image, because the image
 * is the one part of this that can fail: YouTube serves a placeholder (or a
 * 404) for a video that has been deleted or made private, and the fallback
 * below keeps the shape of the card and still reads as a video.
 */
function ExternalShortThumbnail({ videoId }: { videoId: string }) {
  // Which source failed, not a boolean — the same pattern as `Avatar`, so a
  // changed id is considered untried again without an effect.
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const src = youtubeThumbnailUrl(videoId);

  return (
    <span className="relative flex h-9 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-hover">
      {failedSrc === src ? (
        <Play className="size-3.5 text-subtle-foreground" aria-hidden />
      ) : (
        <>
          {/* Deliberately a plain <img>, matching `Avatar`: remote, small, and
              not worth allow-listing a YouTube CDN host for the optimiser. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setFailedSrc(src)}
            className="size-full object-cover"
          />
          <span
            aria-hidden
            className="absolute inset-0 flex items-center justify-center bg-black/25"
          >
            <Play className="size-3 fill-white text-white" />
          </span>
        </>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

/**
 * What the form currently holds, and whether it may be submitted.
 *
 * A hook rather than internal state, because the FORM owns submission: the
 * composer has to disable its button while the link is wrong, and the edit
 * forms have to know whether the link changed at all before deciding what to
 * PATCH. Hiding that inside the field would leave every caller re-deriving it.
 */
export function useExternalShortField(initialUrl: string | null) {
  const [value, setValue] = React.useState(initialUrl ?? "");
  // Errors appear on blur, not on the first keystroke. A field that turns red
  // at "h" is telling somebody they are wrong while they are still typing the
  // thing that would make them right.
  const [touched, setTouched] = React.useState(false);

  const parsed = React.useMemo<ExternalShortInput>(
    () => readExternalShortInput(value),
    [value],
  );

  return {
    value,
    parsed,
    touched,
    setValue: (next: string) => setValue(next),
    /**
     * Puts the field back to a known link and forgets that it was ever touched.
     *
     * For editors that TOGGLE rather than unmount — the research log's row
     * opens its form in place — where an abandoned edit would otherwise still
     * be sitting in the field the next time it is opened, complete with the
     * error message from whatever was typed and given up on.
     */
    reset: (url: string | null) => {
      setValue(url ?? "");
      setTouched(false);
    },
    /** Called by the field on blur; also called by a form on a failed submit. */
    markTouched: () => setTouched(true),
    /** Blocks submit. Empty is fine — the link is optional. */
    isInvalid: parsed.status === "invalid",
    /**
     * What to send. `null` for an empty field, which is what REMOVES a link on
     * an update and means "no link" on a create — the two are the same request
     * from the form's point of view, and the service tells them apart by
     * whether the key is present at all.
     */
    payloadValue: (): string | null => (parsed.status === "valid" ? parsed.url : null),
    /** The video id currently in the field, for comparing against a stored one. */
    videoId: parsed.status === "valid" ? parsed.videoId : null,
  };
}

export type ExternalShortFieldState = ReturnType<typeof useExternalShortField>;

/** What an edit may change — the body, and possibly the Short it quotes. */
export interface NoteEditPatch {
  body: string;
  /** Absent leaves the Short alone; `null` removes it; a URL replaces it. */
  externalShortUrl?: string | null;
}

/**
 * The patch for an edit, given the note as stored and the link as edited.
 *
 * Lives here rather than beside either editor because BOTH use it — the panel
 * on a channel page and the research log — and the three-state link value is
 * the easiest thing in this feature to get subtly wrong in one of them.
 *
 * ==========================================================================
 * WHY THE COMPARISON IS ON THE ID, NOT ON THE TEXT IN THE FIELD
 * ==========================================================================
 * The field is seeded with the note's CANONICAL url, but somebody re-pasting
 * the same Short from their phone gets `youtu.be/<id>?si=…`, which is a
 * different string naming the identical video. Comparing strings would call
 * that a change, send a PATCH, and — worse — spend a Data API lookup
 * re-fetching a title we already have. Comparing the parsed ids asks the
 * question that actually matters: is this a different Short?
 *
 * The key is omitted entirely when it is the same one, so a body-only edit
 * cannot disturb an attachment.
 */
export function buildNotePatch(
  note: ExternalShortFields,
  body: string,
  linkVideoId: string | null,
): NoteEditPatch {
  if (linkVideoId === note.externalVideoId) return { body };
  // Emptied field -> `null`, which is the only spelling of "remove it".
  return { body, externalShortUrl: linkVideoId ? canonicalShortUrl(linkVideoId) : null };
}

/**
 * The "YouTube Short URL" input.
 *
 * Validated with the SAME parser the server uses (`lib/youtube-url.ts` imports
 * nothing server-side for exactly this reason), so the field's verdict and the
 * request's verdict cannot disagree. The brief's requirement that an invalid
 * link never "silently save as nothing" is met twice over: the message appears
 * under the field, and the form's submit is disabled while it stands.
 */
export function ExternalShortField({
  state,
  id,
  label = "YouTube Short URL",
  compact = false,
}: {
  state: ExternalShortFieldState;
  /** Ties the label and the hint to the input; required when more than one is on a page. */
  id: string;
  label?: string;
  /** Drops the label for the tight inline forms in the notes panel. */
  compact?: boolean;
}) {
  const showError = state.touched && state.parsed.status === "invalid";
  const hintId = `${id}-hint`;

  return (
    <div className="flex flex-col gap-1.5">
      {compact ? null : (
        <Label htmlFor={id}>
          {label}
          <span className="ml-1.5 font-normal text-subtle-foreground">optional</span>
        </Label>
      )}

      <div className="relative">
        <Input
          id={id}
          type="url"
          inputMode="url"
          value={state.value}
          onChange={(event) => state.setValue(event.target.value)}
          onBlur={state.markTouched}
          invalid={showError}
          aria-describedby={hintId}
          placeholder={compact ? "Quote a Short — paste a YouTube link" : "youtube.com/shorts/…"}
          className={cn("h-8 text-[13px]", state.value ? "pr-8" : undefined)}
        />
        {state.value ? (
          // Clearing is one click, because "remove the link" is half of what
          // the brief asks an edit to be able to do, and selecting the text of
          // a URL to delete it is a worse way to say it.
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove the attached Short"
            onClick={() => {
              state.setValue("");
              state.markTouched();
            }}
            className="absolute right-1 top-1/2 size-6 -translate-y-1/2"
          >
            <X />
          </Button>
        ) : null}
      </div>

      {/* One element whichever it says, so the layout does not jump between
          the hint and the error. */}
      <FieldHint id={hintId} tone={showError ? "danger" : "muted"}>
        {showError && state.parsed.status === "invalid"
          ? state.parsed.message
          : state.parsed.status === "valid"
            ? `Attaching ${state.parsed.url}`
            : EXTERNAL_SHORT_URL_HINT}
      </FieldHint>
    </div>
  );
}
