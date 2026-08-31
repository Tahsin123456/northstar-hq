import { describe, expect, it } from "vitest";
import { GENERAL_NOTE_LABEL } from "@/lib/dto";
import {
  UNTITLED_EXTERNAL_SHORT,
  notePosterFor,
  type NotePosterSource,
} from "../note-poster";

/**
 * =========================================================================
 * A NOTE CARD ALWAYS HAS SOMETHING TO PUT AT THE TOP OF IT
 * =========================================================================
 *
 * The owner asked for the research log to look like Winners, with the note text
 * "underneath the Short". Most notes have no Short. This rule is what makes
 * that request answerable, and it is the piece most likely to be broken by a
 * later edit — because the tempting simplification (return null when there is
 * no Short, and let the card skip the poster) is wrong in a way that only shows
 * up on a rendered grid, where the card does not become shorter, it becomes a
 * card with a hole in it.
 *
 * TESTED AS A PURE FUNCTION because the runner is Node with no DOM. That is not
 * a workaround: the rendering is three JSX branches, and every decision worth
 * protecting — which Short leads, whether the other survives below, and that
 * the title is never blank — is arithmetic over a DTO. The card calls this
 * unconditionally and has no second opinion.
 */

function note(overrides: Partial<NotePosterSource> = {}): NotePosterSource {
  return {
    targetType: "general",
    targetLabel: GENERAL_NOTE_LABEL,
    channelName: null,
    youtubeVideoId: null,
    externalVideoId: null,
    externalTitle: null,
    externalChannelTitle: null,
    ...overrides,
  };
}

describe("a note with no Short at all", () => {
  /**
   * THE CASE THE WHOLE MODULE EXISTS FOR, and the majority of the log.
   *
   * A general note is attached to nothing. It still gets a complete answer: no
   * video id, so the card draws the placeholder plate in the same 208px box its
   * neighbours use, and a title that says what the note is about rather than
   * leaving a blank line where the reader expects the subject.
   */
  it("still renders — a plate in the poster's place, and a real title", () => {
    const poster = notePosterFor(note());

    expect(poster.kind).toBe("none");
    // Null is the ANSWER, not a failure: it is what tells the card to draw the
    // plate instead of a broken image, and not to offer a play control that
    // would open an empty player.
    expect(poster.youtubeVideoId).toBeNull();
    expect(poster.title).toBe(GENERAL_NOTE_LABEL);
    expect(poster.title).not.toBe("");
    expect(poster.hasSeparateExternalShort).toBe(false);
  });

  it("names the channel or the niche where the note is about one", () => {
    expect(
      notePosterFor(
        note({ targetType: "channel", targetLabel: "Northstar GTA", channelName: "Northstar GTA" }),
      ).title,
    ).toBe("Northstar GTA");

    expect(
      notePosterFor(note({ targetType: "niche", targetLabel: "Finance" })).title,
    ).toBe("Finance");
  });

  /**
   * A target that has since been deleted can leave the resolver with nothing to
   * put in `targetLabel`. A card whose title is the empty string is a blank
   * line where the subject goes, so the label falls back rather than passing an
   * empty string through.
   */
  it("falls back rather than rendering an empty title", () => {
    expect(notePosterFor(note({ targetLabel: "" })).title).toBe(GENERAL_NOTE_LABEL);
  });
});

describe("a note about a tracked Short", () => {
  it("leads with the Short, its own title and its channel", () => {
    const poster = notePosterFor(
      note({
        targetType: "video",
        targetLabel: "How I made $10k with GTA edits",
        youtubeVideoId: "abc12345678",
        channelName: "Northstar GTA",
      }),
    );

    expect(poster.kind).toBe("tracked");
    expect(poster.youtubeVideoId).toBe("abc12345678");
    expect(poster.title).toBe("How I made $10k with GTA edits");
    expect(poster.subtitle).toBe("Northstar GTA");
  });
});

describe("a note quoting a Short from outside the tracker", () => {
  /**
   * EXTERNAL SHORTS ARE FREE, and that is what makes this case work at all.
   * There is no `Video` row, no channel and no view count — but `posterSourceFor`
   * takes an id and nothing else, so a quoted Short gets the identical 9:16
   * frame and the identical in-app player.
   */
  it("puts the quoted Short on the poster when it is the only one", () => {
    const poster = notePosterFor(
      note({
        externalVideoId: "xyz98765432",
        externalTitle: "Their hook, 4M views",
        externalChannelTitle: "RivalClips",
      }),
    );

    expect(poster.kind).toBe("external");
    expect(poster.youtubeVideoId).toBe("xyz98765432");
    expect(poster.title).toBe("Their hook, 4M views");
    expect(poster.subtitle).toBe("RivalClips");
    // It IS the poster, so drawing the preview strip as well would show the
    // same Short twice on one card.
    expect(poster.hasSeparateExternalShort).toBe(false);
  });

  /**
   * Metadata is best effort — no API key, spent quota, a private video — so a
   * titleless attachment is ordinary rather than broken. The fallback is a
   * plain description of the thing rather than the raw id, an em dash, or the
   * URL string, and it matches `ExternalShortPreview` word for word so a Short
   * does not change its name when it moves onto the poster.
   */
  it("names a titleless quoted Short honestly rather than showing its id", () => {
    const poster = notePosterFor(note({ externalVideoId: "xyz98765432" }));

    expect(poster.title).toBe(UNTITLED_EXTERNAL_SHORT);
    expect(poster.title).not.toContain("xyz98765432");
    // The id belongs on the second line, where it identifies the Short without
    // pretending to be its name.
    expect(poster.subtitle).toBe("youtube.com/shorts/xyz98765432");
  });
});

describe("a note carrying both a tracked Short and a quoted one", () => {
  /**
   * `NoteDTO` says this is real and says why: "a note filed against our
   * channel, quoting theirs, is the comparison that prompted it." Both halves
   * of that comparison have to survive — the tracked Short leads because it is
   * what the note is filed against, and the quoted one keeps the preview strip
   * under the body where it has always been.
   */
  it("leads with the tracked Short and keeps the quoted one below the note", () => {
    const poster = notePosterFor(
      note({
        targetType: "video",
        targetLabel: "Our version",
        youtubeVideoId: "ours1234567",
        channelName: "Northstar GTA",
        externalVideoId: "theirs76543",
        externalTitle: "Their version",
      }),
    );

    expect(poster.youtubeVideoId).toBe("ours1234567");
    // The half that would otherwise be silently dropped.
    expect(poster.hasSeparateExternalShort).toBe(true);
  });

  /**
   * THE KIND IS THE FACT, THE ID IS ITS CONSEQUENCE — the rule `NoteDTO.targetId`
   * states for itself. A channel note that somehow arrives carrying a video id
   * must not be drawn as a note about that video, because its title and its
   * subtitle describe the channel.
   */
  it("reads the note's kind rather than the mere presence of a video id", () => {
    const poster = notePosterFor(
      note({
        targetType: "channel",
        targetLabel: "Northstar GTA",
        youtubeVideoId: "abc12345678",
        externalVideoId: "theirs76543",
      }),
    );

    expect(poster.kind).toBe("external");
    expect(poster.youtubeVideoId).toBe("theirs76543");
  });
});
