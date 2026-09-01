import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { frameFor } from "@/lib/shorts/player";
import { YOUTUBE_EMBED_ORIGIN, youtubeShortsEmbedUrl } from "@/lib/format";

const SHORT = {
  youtubeVideoId: "dQw4w9WgXcQ",
  title: "A Short",
  subtitle: "Some channel",
} as const;

/**
 * The in-app player, tested at the one place it can be tested honestly.
 *
 * `frameFor` is not a helper that happened to be extracted — it IS the rule
 * that a closed dialog has no iframe in it, stated as a value rather than as a
 * lifecycle. Everything below is written from the requirement rather than from
 * the implementation, so a regression names the behaviour that broke.
 */

describe("the player stops when the dialog closes", () => {
  /**
   * THE ONE THAT MATTERS.
   *
   * A cross-origin iframe goes on playing when it is hidden rather than
   * removed, so a dismissed overlay leaves a voice coming out of a page showing
   * no video and offering no way to stop it. "Closed" must therefore mean "no
   * element", and this asserts the absence rather than any property of a
   * surviving one.
   */
  it("produces no frame at all while the dialog is closed", () => {
    expect(frameFor(SHORT, false, true)).toBeNull();
    expect(frameFor(SHORT, false, false)).toBeNull();
  });

  /**
   * The second half of the same rule. The feed clears its `playingShort` state
   * when the dialog closes, so a null target and a closed dialog arrive
   * together — but they are independent inputs and either one alone has to be
   * enough. A frame built from a null target could only ever have `undefined`
   * in its URL.
   */
  it("produces no frame when there is no Short, open or not", () => {
    expect(frameFor(null, true, true)).toBeNull();
    expect(frameFor(null, false, true)).toBeNull();
  });

  it("produces exactly one frame while it is open", () => {
    const frame = frameFor(SHORT, true, false);
    expect(frame).not.toBeNull();
    expect(frame?.src).toContain(SHORT.youtubeVideoId);
  });
});

describe("what the player is pointed at", () => {
  /**
   * The embed host is the single value the CSP's `frame-src` allows, and a
   * player pointed anywhere else is silently blocked by the browser with
   * nothing in the UI to explain it. Asserted against the exported constant
   * rather than a literal, so this test and the header cannot drift apart on
   * their own — `security-headers.test.ts` pins the constant to the header.
   */
  it("plays from the allow-listed embed host and no other", () => {
    const frame = frameFor(SHORT, true, true);
    expect(frame?.src.startsWith(`${YOUTUBE_EMBED_ORIGIN}/embed/`)).toBe(true);
  });

  /**
   * `/shorts/<id>` is a watch page and refuses to be framed; only `/embed/<id>`
   * is embeddable. Getting this wrong produces a dialog containing YouTube's
   * refusal rather than the video, which is a failure mode that looks like a
   * broken app rather than a wrong URL.
   */
  it("uses the embed endpoint, not the watch page", () => {
    const src = frameFor(SHORT, true, false)?.src ?? "";
    expect(src).toContain("/embed/");
    expect(src).not.toContain("/shorts/");
    expect(src).not.toContain("/watch");
  });

  /**
   * The id is the only part of a Short this app will put into a frame source.
   * Anything reachable from a stored column — a note's `externalUrl`, say —
   * would make a hand-edited or restored row into a document this app tells the
   * browser to execute. Composing from the id makes a hostile value unreachable
   * rather than merely unlikely.
   */
  it("composes the source from the video id alone", () => {
    expect(frameFor(SHORT, true, false)?.src).toBe(
      youtubeShortsEmbedUrl(SHORT.youtubeVideoId, { autoplay: false }),
    );
  });
});

describe("motion preference", () => {
  /**
   * A video that starts by itself is the largest piece of motion this app can
   * produce, and it is the one thing here that has to ask. The dialog reads the
   * media query and passes the answer; this pins that the answer changes the
   * URL rather than being accepted and ignored.
   */
  it("only asks for autoplay when the caller says motion is welcome", () => {
    expect(frameFor(SHORT, true, true)?.src).toContain("autoplay=1");
    expect(frameFor(SHORT, true, false)?.src).not.toContain("autoplay");
  });

  /**
   * The subtractive parameters are not decoration. `playsinline` is what stops
   * iOS throwing the reader out of the app into a fullscreen player the moment
   * a Short starts, and `rel=0` is what stops an end screen turning a research
   * tool into a recommendation feed.
   */
  it("keeps the player inline and its suggestions off, either way", () => {
    for (const autoplay of [true, false]) {
      const src = frameFor(SHORT, true, autoplay)?.src ?? "";
      expect(src).toContain("playsinline=1");
      expect(src).toContain("rel=0");
    }
  });
});

/**
 * =========================================================================
 * THERE IS ALWAYS A WAY OUT OF THE PLAYER
 * =========================================================================
 *
 * The shared `DialogContent` is `fixed` and centred with `-translate-y-1/2`,
 * and it carries no `max-h` of its own. A dialog taller than the viewport
 * therefore hangs off BOTH edges with no document scroll able to reach the part
 * that is missing, and the close button — `absolute right-3.5 top-3.5` on that
 * same box — goes off the top with it. The player's first version sized its
 * frame at `min(70vh,560px)` and guarded only the width, so on a landscape
 * phone it lost its ×. The other exit, Escape, is documented in that file as
 * unreachable the moment the reader clicks into the cross-origin player, so
 * losing the button is losing the dialog.
 *
 * There is no DOM here to measure a layout in. What these hold is the set of
 * classes that make the overflow impossible, each of which a later edit could
 * remove without any test noticing.
 */
describe("the player dialog cannot outgrow the window", () => {
  /**
   * CODE ONLY, COMMENTS STRIPPED, and that is not tidiness. This repo argues
   * its decisions in prose directly above the classes they concern, so every
   * class named below also appears a few lines further up in English. Scanning
   * the whole file would let a mutation that DELETES the class pass on the
   * strength of the paragraph explaining why it is there — which is exactly
   * what happened the first time these were written.
   */
  const dialog = readFileSync(
    fileURLToPath(new URL("../../../components/shorts/short-player-dialog.tsx", import.meta.url)),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

  /**
   * `dvh`, not `vh`: on mobile `vh` is the tallest the viewport ever gets, so a
   * `100vh` box is still clipped by the browser's own chrome — which is exactly
   * the viewport this bug appears on.
   */
  it("bounds its height against the dynamic viewport", () => {
    expect(dialog).toContain("max-h-[calc(100dvh-2rem)]");
    expect(dialog).not.toContain("min(70vh,560px)");
    expect(dialog).toContain("min(70dvh,560px)");
  });

  /**
   * The bound alone would only clip the player. `flex flex-col` on the content
   * with `min-h-0` on the body and on the frame is what lets the player SHRINK
   * into what is left instead — `min-h-0` because a flex item otherwise refuses
   * to go below its content size, which is the whole failure.
   */
  it("shrinks the player rather than overflowing", () => {
    // The width cap moved into a per-format branch when the dialog learned
    // 16:9 (Long Form buys width; the Shorts dialog keeps its 420px), so the
    // three properties are asserted separately rather than as one class run.
    expect(dialog).toContain("flex max-h-[calc(100dvh-2rem)] flex-col");
    expect(dialog).toContain("max-w-[420px]");
    expect(dialog).toContain("min-h-0 flex-1");
    // The Shorts frame still derives width from its height, bounded both ways.
    expect(dialog).toContain('"aspect-[9/16] h-[min(70dvh,560px)] w-auto max-w-full"');
    expect(dialog).toContain("min-h-0 overflow-hidden");
  });

  /**
   * If the chrome alone ever exceeds the viewport, the BODY scrolls. The scroll
   * must not be on the content box: the close button is absolutely positioned
   * against it, so scrolling there would carry the × out of reach — the bug
   * rather than the fix.
   */
  it("scrolls the body, never the box the close button is pinned to", () => {
    expect(dialog).toContain("overflow-y-auto");
    expect(dialog).toMatch(/DialogBody className="[^"]*overflow-y-auto/);
    expect(dialog).not.toMatch(/DialogContent className="[^"]*overflow-y-auto/);
  });

  /** The frame keeps its ratio while it shrinks: a smaller Short, not a squat one. */
  it("keeps the player portrait at every size", () => {
    expect(dialog).toContain("aspect-[9/16]");
  });
});
