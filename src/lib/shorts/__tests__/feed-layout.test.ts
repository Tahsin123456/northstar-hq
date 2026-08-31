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
   * The research log and the saved board declare the same string. They are
   * meant to be one grid — three card surfaces that read as one system rather
   * than as three people's ideas of a card — and they drifted apart once
   * already. Comparing against the literal in those files is what makes
   * "we intended these to match" something that fails a build.
   */
  it("matches the grid the notes log and the saved board already use", () => {
    for (const page of ["app/(app)/notes/page.tsx", "app/(app)/saved/page.tsx"]) {
      const declared = source(page).match(/const CARD_GRID =\s*([\s\S]*?);/)?.[1] ?? "";
      // Whitespace differs because prettier wraps one of them and not the
      // other; the class list must not.
      expect(declared.replace(/\s+/g, " ")).toContain(SHORTS_CARD_GRID);
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
   * 9:16 IN BOTH BRANCHES. The box does not change shape when the portrait
   * source 404s and the wide fallback takes over — that image is letterboxed
   * into this same box instead. A box that changed shape as images resolved
   * would reflow the entire grid under the reader.
   */
  it("is a portrait box and not a landscape one", () => {
    expect(SHORTS_POSTER_FRAME).toContain("aspect-[9/16]");
    // The class the old tile used. Its reappearance in the card or the feed is
    // the regression itself, not a style choice.
    expect(utilityClasses(card)).not.toContain("aspect-video");
    expect(utilityClasses(feed)).not.toContain("aspect-video");
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
  it("is the same box the loading skeleton draws", () => {
    for (const [name, code] of [
      ["card", card],
      ["feed", feed],
    ] as const) {
      // Used, not merely imported: the import line alone satisfied an earlier
      // version of this test and let a hand-rolled shape through beside it.
      const uses = code.split("SHORTS_POSTER_FRAME").length - 1;
      expect(uses, `${name} should import and use SHORTS_POSTER_FRAME`).toBeGreaterThan(1);
    }
  });
});
