import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SHORTS_CARD_GRID, SHORTS_POSTER_FRAME } from "@/lib/shorts/feed-layout";

/**
 * =========================================================================
 * THE FEEDS MUST NEVER SCROLL SIDEWAYS
 * =========================================================================
 *
 * Winners and Outliers used to draw each Short as a full-width row with three
 * fixed-width columns pinned to its right edge. The owner's words were
 * "horizontal long lines". Replacing that with a grid is only half the fix: a
 * card with a hard minimum width inside a `grid-cols-1` column on a phone gives
 * the whole PAGE a horizontal scrollbar, which is a worse bug than the one it
 * replaced and is invisible on the desktop it was built on.
 *
 * There is no DOM in this test runner, so this cannot measure a layout. What it
 * can do is hold the two structural properties that make the promise true —
 * one column at the bottom breakpoint, and no fixed widths inside the card —
 * and those are exactly the two that a later edit would break by accident.
 */

function source(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

/**
 * Tailwind classes as written, with any variant prefix (`sm:`, `hover:`)
 * stripped, so `sm:w-[320px]` is judged as the width it is rather than skipped
 * for the prefix in front of it.
 *
 * Comments come out first, and that is not a nicety: this repo argues its
 * decisions in prose, so the class that was REMOVED gets named in the comment
 * explaining why it went. Scanning the comments too would make a file fail for
 * describing its own fix.
 */
function utilityClasses(code: string): string[] {
  const withoutComments = code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

  return (withoutComments.match(/[A-Za-z0-9:_[\]().,%/\\#-]+/g) ?? []).map((token) => {
    const parts = token.split(":");
    return parts[parts.length - 1] ?? token;
  });
}

describe("the Shorts grid", () => {
  /**
   * `grid-cols-1` at the bottom end is the load-bearing part: on the narrowest
   * phone a card is one full-width column, so there is nothing for the body to
   * overflow with. Every wider breakpoint only adds columns to a container that
   * already fits.
   */
  it("is a single column before any breakpoint", () => {
    expect(SHORTS_CARD_GRID).toContain("grid-cols-1");
    expect(SHORTS_CARD_GRID.startsWith("grid ")).toBe(true);
  });

  it("adds columns only at Tailwind's own breakpoints", () => {
    for (const responsive of ["sm:grid-cols-2", "xl:grid-cols-3", "2xl:grid-cols-4"]) {
      expect(SHORTS_CARD_GRID).toContain(responsive);
    }
  });

  /**
   * =========================================================================
   * THE THREE COPIES ARE NOW ONE IMPORT, AND THIS TEST SAYS SO
   * =========================================================================
   *
   * This used to assert that the research log and the saved board each declared
   * a literal EQUAL to this constant, which is the best a test can do while
   * three files own three strings — it catches a drift after the fact rather
   * than preventing one. Both pages now import the constant instead, so the
   * property available is stronger and this asserts the stronger one: there is
   * no second copy to drift.
   *
   * Checking for the ABSENCE of a literal matters more than checking for the
   * import. Somebody adding a hand-rolled `grid-cols-2` beside a correct import
   * is exactly the regression that would otherwise pass.
   */
  it("is imported by the notes log and the saved board, not re-declared", () => {
    for (const page of ["app/(app)/notes/page.tsx", "app/(app)/saved/page.tsx"]) {
      const code = source(page);
      expect(code, `${page} should import SHORTS_CARD_GRID`).toContain("SHORTS_CARD_GRID");
      // No file outside `feed-layout` may spell the class list out. The one
      // legitimate mention of these tokens in a page is inside a comment, and
      // `utilityClasses` strips comments before this sees them.
      expect(
        utilityClasses(code).filter((klass) => /^grid-cols-\d/.test(klass)),
        `${page} should not hand-roll grid columns`,
      ).toEqual([]);
    }
  });
});

describe("the Shorts card", () => {
  const card = source("components/shorts/short-card.tsx");
  const feed = source("components/shorts/shorts-feed.tsx");

  it("is laid out on the shared grid rather than a hand-rolled one", () => {
    expect(feed).toContain("SHORTS_CARD_GRID");
    // The old container. A vertical stack of full-width rows is the shape the
    // owner asked to be rid of, so its reappearance in this file is a
    // regression rather than a style choice.
    expect(feed).not.toContain('<div className="flex flex-col">');
  });

  /**
   * A minimum width on a cell wider than the viewport is precisely how a page
   * starts scrolling sideways, and it is why the old row's `w-[112px]` outlier
   * column could not simply be moved into a grid. `max-w-` is fine and is used:
   * it caps a truncating label without ever forcing the track wider.
   */
  it("carries no fixed or minimum width that could outgrow its column", () => {
    const offenders = utilityClasses(card).filter(
      (klass) => /^min-w-\[/.test(klass) || /^w-\[\d+(px|rem)\]$/.test(klass),
    );
    expect(offenders).toEqual([]);
  });

  /** `min-w-0` is the opposite and is required: without it a flex child refuses
   *  to shrink below its content and truncation never happens. */
  it("lets its flex children shrink", () => {
    expect(card).toContain("min-w-0");
  });

  /**
   * The column headings went with the rows they described. A heading reading
   * "vs channel median" above a grid labels nothing, because there is no column
   * under it — every figure it used to head is now said in words on the card.
   */
  it("no longer ships table headings for a table that is gone", () => {
    expect(card).not.toContain("ShortCardHeader");
    expect(feed).not.toContain("ShortCardHeader");
  });

  /**
   * The point of the whole change. A card opens the player; it does not open a
   * tab. The one outward link that survives lives inside the player dialog,
   * where somebody looking at a single Short can ask for the real thing.
   */
  it("plays in the app instead of linking out", () => {
    expect(card).toContain("onPlayShort");
    expect(card).not.toContain('target="_blank"');
    expect(feed).toContain("ShortPlayerDialog");
  });
});

/**
 * =========================================================================
 * A SHORT IS PORTRAIT, AND THE TILE HAS TO BE
 * =========================================================================
 *
 * The first version of this grid fixed the LAYOUT half of "display the shorts
 * vertically, not in horizontal long lines" and missed the SHAPE half. It drew
 * every tile from `mqdefault.jpg`, which is 320x180 whatever the video is: for
 * a 9:16 Short that is the real frame pillarboxed into a 101px strip with
 * stretched blur either side, so what landed was a wall of wide boxes each
 * mostly filler. The code even argued for it, on the false premise that no
 * portrait thumbnail could be derived from a video id.
 *
 * `oardefault.jpg` is that portrait frame — measured 1080x1920, exactly 9:16 —
 * off the same id with no API call. WHICH SOURCE IS DRAWN AND HOW IT IS FITTED
 * is `posterSourceFor`'s decision and is tested directly in `poster.test.ts`,
 * as a rule rather than as a string in a file. What is left here is the part
 * that genuinely only exists as classes: the shape of the box those images go
 * into, and the fact that the card and its loading skeleton agree on it.
 */
describe("the Shorts poster box", () => {
  const card = source("components/shorts/short-card.tsx");
  const feed = source("components/shorts/shorts-feed.tsx");
  /**
   * The poster and the card shell live here now, shared by all three grids.
   *
   * The owner asked for Notes and Saved to look "almost identical" to Winners,
   * and three files agreeing about a class list is not a way to keep a promise
   * like that — `SHORTS_CARD_GRID`'s own history is the evidence. So the card
   * is one component and this file is where its shape is defined.
   */
  const frame = source("components/shorts/short-card-frame.tsx");
  const notes = source("app/(app)/notes/page.tsx");
  const saved = source("app/(app)/saved/page.tsx");

  /**
   * 9:16 IN BOTH BRANCHES. The box does not change shape when the portrait
   * source 404s and the wide fallback takes over — that image is letterboxed
   * into this same box instead. A box that changed shape as images resolved
   * would reflow the entire grid under the reader.
   *
   * THE SAVED BOARD IS IN THIS LIST NOW, and it is the reason the list grew.
   * It drew `mqdefault` at `aspect-video` — the exact mistake this card had
   * already made and fixed — for as long as the two cards were separate files
   * that merely agreed. A wide box two thirds filled with YouTube's stretched
   * pillarbox blur, in a grid the owner asked to be vertical.
   */
  it("is a portrait box and not a landscape one, on every grid", () => {
    expect(SHORTS_POSTER_FRAME).toContain("aspect-[9/16]");
    // The class the old tiles used. Its reappearance on any of these surfaces
    // is the regression itself, not a style choice.
    for (const [name, code] of [
      ["card", card],
      ["feed", feed],
      ["frame", frame],
      ["notes", notes],
      ["saved", saved],
    ] as const) {
      expect(utilityClasses(code), `${name} should not draw a 16:9 tile`).not.toContain(
        "aspect-video",
      );
    }
  });

  /**
   * The cap is what keeps a tile a readable height — a card is about 325px wide
   * at `xl`, and an uncapped 9:16 poster on it is 578px tall, three to a row.
   * It must be a `max-w-`: a `w-` would force the grid column wider than a
   * phone viewport and hand the page the horizontal scrollbar the grid above
   * exists to make impossible.
   */
  it("caps the poster's width without ever forcing one", () => {
    expect(SHORTS_POSTER_FRAME).toContain("max-w-[208px]");
    expect(SHORTS_POSTER_FRAME).toContain("w-full");
    expect(
      utilityClasses(SHORTS_POSTER_FRAME).filter(
        (klass) => /^min-w-\[/.test(klass) || /^w-\[\d+(px|rem)\]$/.test(klass),
      ),
    ).toEqual([]);
  });

  /**
   * The skeleton stands in for this box, so it has to BE this box — the shared
   * constant, not a copy that looks like it. A loading state predicting a
   * different shape than the answer makes the page settle by jumping, which is
   * the moment a reader loses their place.
   */
  it("is the same box the loading skeleton draws, on every grid", () => {
    for (const [name, code] of [
      ["frame", frame],
      ["feed", feed],
      // Both of these draw a Skeleton in the poster's place while their rows
      // load, and both used to predict a shape their own card did not draw —
      // the saved board a 16:9 strip, the notes log no poster at all. A
      // skeleton that mispredicts makes the page settle by jumping, which is
      // the moment a reader loses their place.
      ["notes", notes],
      ["saved", saved],
    ] as const) {
      // Used, not merely imported: the import line alone satisfied an earlier
      // version of this test and let a hand-rolled shape through beside it.
      const uses = code.split("SHORTS_POSTER_FRAME").length - 1;
      expect(uses, `${name} should import and use SHORTS_POSTER_FRAME`).toBeGreaterThan(1);
    }

    // The card itself no longer names the constant, and that is the point of
    // the refactor rather than a gap in this test: it renders `ShortPoster`,
    // which is where the box is now drawn for all three grids.
    expect(card).toContain("ShortPoster");
  });
});

/**
 * =========================================================================
 * THREE GRIDS, ONE CARD
 * =========================================================================
 *
 * The owner's first request: "Notes & Saved should have almost identical looks
 * to the Winners & Outliers tabs." The grid was already shared; the CARD was
 * three separate implementations that had each drifted in a different
 * direction. These hold the parts of "identical" that a class list can express,
 * and — more usefully — that the three surfaces reach them through one module
 * rather than by agreeing.
 */
describe("the Notes and Saved cards", () => {
  const notes = source("app/(app)/notes/page.tsx");
  const saved = source("app/(app)/saved/page.tsx");

  it("are built from the shared card rather than a copy of it", () => {
    for (const [name, code] of [
      ["notes", notes],
      ["saved", saved],
    ] as const) {
      expect(code, `${name} should use the shared shell`).toContain("SHORT_CARD_SHELL");
      expect(code, `${name} should use the shared poster`).toContain("ShortPoster");
      expect(code, `${name} should use the shared title control`).toContain(
        "ShortCardTitle",
      );
    }
  });

  /**
   * THE SAVED BOARD WAS THE LAST GRID IN THE APP WHERE A SHORT OPENED A TAB.
   *
   * Both the frame and the title were anchors to youtube.com. A director
   * working the save-and-revisit loop ended a session with thirty tabs and no
   * idea which of them they had already judged — the exact failure the player
   * dialog was introduced to end. The way out is not lost: it lives inside the
   * player, where it is honest about being a link.
   */
  it("play their Shorts in the app, as Winners does", () => {
    expect(saved).toContain("ShortPlayerDialog");
    expect(notes).toContain("ShortPlayerDialog");
    // No card on either surface may link a Short out directly any more.
    expect(saved).not.toContain('target="_blank"');
  });

  /**
   * A note about a channel, a niche, or nothing at all has no Short — roughly
   * half the log — and the card still has to fill the poster box. Omitting it
   * does not make the card shorter, because grid tracks stretch; it makes a
   * card with 208px of dead space where its neighbours have a frame. The rule
   * itself is tested properly in `note-poster.test.ts`; this holds that the
   * card actually goes through it rather than re-deciding inline.
   */
  it("give a note with no Short the same box as one with a Short", () => {
    expect(notes).toContain("notePosterFor");
    /*
     * THE PLATE'S CONTENTS, NAMED SPECIFICALLY.
     *
     * An earlier version of this line looked for `placeholder=` and was
     * satisfied by the search box's `placeholder="Search notes…"` — it passed
     * with the poster's placeholder deleted, which mutation testing caught. The
     * assertion now names the prop AND what goes in it: the note's own type
     * icon, which is the thing that makes a Short-less card read as a note
     * about a channel rather than as a card whose image failed to load.
     */
    expect(notes).toContain("placeholder={<Icon");
  });
});
