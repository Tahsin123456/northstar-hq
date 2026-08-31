import { GENERAL_NOTE_LABEL, type NoteKind } from "@/lib/dto";

/**
 * =========================================================================
 * WHAT SITS AT THE TOP OF A NOTE CARD
 * =========================================================================
 *
 * The owner asked for the research log to look like Winners, with the note text
 * "underneath the Short". That sentence is easy for the notes that have a
 * Short. This module is the other three cases, which are the majority:
 *
 *   1. A note ABOUT a tracked Short. Its `youtubeVideoId` drives the poster,
 *      and its `targetLabel` is the Short's title.
 *   2. A note QUOTING a Short from outside the tracker and about nothing else.
 *      There is no `Video` row, no channel and no view count — but a poster
 *      needs none of that, because `posterSourceFor` takes an id and nothing
 *      else. So an external Short gets the identical 9:16 frame for free.
 *   3. A note carrying BOTH. `NoteDTO` says this is real and says why: "a note
 *      filed against our channel, quoting theirs, is the comparison that
 *      prompted it". The TRACKED Short takes the poster, because it is what the
 *      note is filed against; the quoted one stays as the existing preview
 *      strip under the body, where it has always been. Collapsing the two would
 *      lose one of them.
 *   4. A note about a channel, a niche, or nothing at all. There is no Short
 *      anywhere. The card still draws the poster BOX — see `ShortPoster` for
 *      why omitting it makes the card worse rather than shorter — and fills it
 *      with the note's own type icon.
 *
 * =========================================================================
 * WHY THIS IS A PURE FUNCTION IN `lib` RATHER THAN A TERNARY IN THE CARD
 * =========================================================================
 * The same reason `posterSourceFor` and `frameFor` are pure functions: it is a
 * RULE, and the test runner is Node with no DOM, so a rule expressed as JSX is
 * a rule no test can hold. Case 4 in particular — a note with no Short still
 * producing a complete, renderable answer rather than a null — is exactly the
 * kind of thing a later "simplification" removes, and it is the case the owner
 * will hit most often.
 *
 * The FALLBACK CHAIN FOR THE TITLE is part of the rule and not decoration. A
 * card whose title slot can be empty is a card that renders a blank line, and
 * every one of these four cases has something true to say: a Short's title, an
 * external Short's title or the honest "YouTube Short", a channel or niche
 * name, or the general-note label. There is no branch that returns nothing.
 */

/** Just the fields this rule reads, so it can be called with a stub in a test. */
export interface NotePosterSource {
  readonly targetType: NoteKind;
  readonly targetLabel: string;
  readonly channelName: string | null;
  readonly youtubeVideoId: string | null;
  readonly externalVideoId: string | null;
  readonly externalTitle: string | null;
  readonly externalChannelTitle: string | null;
}

/** Which of the four cases above a note is in. */
export type NotePosterKind =
  /** A Short this app tracks. Case 1, and case 3's poster. */
  | "tracked"
  /** A Short quoted from outside the tracker, and the only one on the note. */
  | "external"
  /** No Short anywhere. The type icon goes on the plate. Case 4. */
  | "none";

export interface NotePoster {
  readonly kind: NotePosterKind;
  /**
   * The YouTube id to draw and to play, or `null` when there is no Short.
   *
   * NULL IS AN ANSWER, not a failure. It is what tells the card to draw the
   * placeholder plate rather than a broken image, and it is what tells it not
   * to offer a play control that would open an empty player.
   */
  readonly youtubeVideoId: string | null;
  /** Never empty. See the note on the fallback chain above. */
  readonly title: string;
  /** The second line in the player dialog. Null where there is nothing to say. */
  readonly subtitle: string | null;
  /**
   * True when the note ALSO quotes an outside Short that the poster is not
   * showing — case 3. The card keeps the preview strip under the body for it.
   */
  readonly hasSeparateExternalShort: boolean;
}

/**
 * The title a titleless external Short gets.
 *
 * Metadata is best effort — no API key, spent quota, a private video — so a
 * titleless attachment is ordinary rather than broken. The fallback is a plain
 * description of the thing rather than the raw id, an em dash, or the URL
 * string. Matches `ExternalShortPreview` exactly, so a note whose quoted Short
 * moves onto the poster does not change its name on the way.
 */
export const UNTITLED_EXTERNAL_SHORT = "YouTube Short";

export function notePosterFor(note: NotePosterSource): NotePoster {
  const external = note.externalVideoId;

  /*
   * THE TRACKED SHORT WINS WHEN THERE ARE TWO.
   *
   * `targetType === "video"` is the test rather than the mere presence of
   * `youtubeVideoId`, matching the rule `NoteDTO.targetId` states for itself:
   * the KIND is the fact and the id is its consequence. A channel note carries
   * no video id, so the two agree today — but reading the kind is what keeps
   * them agreeing if the context resolver ever starts attaching a video id to
   * something that is not a note about that video.
   */
  if (note.targetType === "video" && note.youtubeVideoId) {
    return {
      kind: "tracked",
      youtubeVideoId: note.youtubeVideoId,
      title: note.targetLabel,
      subtitle: note.channelName,
      // The quoted Short survives below the body rather than being dropped.
      hasSeparateExternalShort: external !== null,
    };
  }

  if (external) {
    return {
      kind: "external",
      youtubeVideoId: external,
      title: note.externalTitle ?? UNTITLED_EXTERNAL_SHORT,
      // The id, where there is no channel name — it identifies the Short
      // without pretending to be its name. Same sentence the preview strip uses.
      subtitle: note.externalChannelTitle ?? `youtube.com/shorts/${external}`,
      // It IS the poster, so drawing the strip as well would show it twice.
      hasSeparateExternalShort: false,
    };
  }

  return {
    kind: "none",
    youtubeVideoId: null,
    /*
     * A channel or niche name, and the general label where there is neither.
     *
     * `targetLabel` is resolved by the server for every kind — it is the
     * channel's name, the niche's name, or `GENERAL_NOTE_LABEL` — so this is
     * normally just the label. The `||` guard is for the empty string a
     * resolver could hand back for a target that has been deleted: a card whose
     * title is "" is a blank line where the reader expects the subject.
     */
    title: note.targetLabel || GENERAL_NOTE_LABEL,
    subtitle: null,
    hasSeparateExternalShort: false,
  };
}
