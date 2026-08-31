import { youtubeShortsEmbedUrl } from "@/lib/format";

/**
 * Everything the in-app player needs, which is deliberately almost nothing.
 *
 * Only `youtubeVideoId` is required. A tracked Short passes its title and its
 * channel; a Short quoted by a note frequently has neither, because its
 * metadata is a best-effort lookup that a missing API key or a private video
 * legitimately defeats. The player has to read correctly in both cases rather
 * than in one case and awkwardly in the other, which is also why it takes this
 * shape rather than a `Video` row — a quoted Short has no row at all.
 */
export interface ShortPlayerTarget {
  readonly youtubeVideoId: string;
  /** Falls back to a plain description — never to the raw id, never to blank. */
  readonly title?: string | null;
  /** The channel that published it, where the app knows one. */
  readonly subtitle?: string | null;
}

/** What the player element should be, or `null` for "there must not be one". */
export interface ShortPlayerFrame {
  readonly src: string;
}

/**
 * Whether the player element should exist at all, and with what `src`.
 *
 * ==========================================================================
 * THIS FUNCTION IS THE UNMOUNT RULE, WRITTEN DOWN
 * ==========================================================================
 * A cross-origin iframe keeps playing when it is merely hidden. An overlay
 * dismissed over a talking Short would leave a voice coming out of a page that
 * shows no video, with no control to stop it and, for most people, no idea
 * where it is coming from. The fix is that the element must not exist when the
 * dialog is closed — not `display: none`, not `visibility: hidden`, not a
 * paused player. Gone.
 *
 * Two things enforce it in the component, and this is the first: a closed
 * dialog returns `null` here, so there is nothing to render. The second is that
 * Radix unmounts the portal's contents on close, which only holds while the
 * dialog defines no exit animation — see the note on `DialogContent`.
 *
 * It lives in `lib` and not beside the component so it can be tested for what
 * it actually promises, without a DOM: the interesting property is a statement
 * about the return value, and the failure mode it guards against is somebody
 * later "optimising" the dialog by keeping the frame mounted between opens.
 *
 * The src is composed from the ID, never from a stored URL string, for the same
 * reason `canonicalShortUrl` is: this becomes the source of a document the
 * browser will execute.
 */
export function frameFor(
  target: ShortPlayerTarget | null,
  open: boolean,
  autoplay: boolean,
): ShortPlayerFrame | null {
  if (!open || !target) return null;
  return { src: youtubeShortsEmbedUrl(target.youtubeVideoId, { autoplay }) };
}
