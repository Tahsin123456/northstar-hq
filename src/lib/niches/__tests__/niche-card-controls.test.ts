import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * =========================================================================
 * THE "…" MENU ON A NICHE CARD
 * =========================================================================
 *
 * One of the owner's requests was satisfied by DELETING code, which is the
 * hardest kind of change to keep:
 *
 *   • "'...' only becomes visible when you hover over it, so make it persistent
 *     and always visible." — an `opacity-0` and the three rules whose only job
 *     was to undo it came off the menu trigger.
 *
 * A deletion has no code to test. What it has is a shape that must not come
 * back, and "somebody re-adds a hover gate while tidying a class list" is a
 * completely ordinary thing to happen — it would look like a style tweak in a
 * diff. There is no DOM in this runner, so these read the source, which is the
 * same technique `feed-layout.test.ts` uses for the layout promises it cannot
 * measure.
 *
 * The menu matters because it is the ONLY route to the hit-rule dialog, the
 * rename and the delete. A menu that appears only under a pointer would make
 * all three unreachable on a touch screen.
 */

function source(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

/** Comments stripped, so a file describing its own fix does not fail for it. */
function code(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const nichesPage = code("app/(app)/niches/page.tsx");
const savedPage = code("app/(app)/saved/page.tsx");

describe("the '…' menu on a niche card", () => {
  /**
   * The whole fix was deleting the opacity group. Once there is no hidden
   * state, no focus or open handling is needed to reveal it — which is why the
   * absence of `focus-visible:opacity-100` beside it is a sign of health rather
   * than a missing case.
   */
  it("is always visible, not revealed on hover", () => {
    expect(nichesPage).not.toContain("opacity-0");
    expect(nichesPage).not.toContain("group-hover:opacity-100");
    expect(nichesPage).not.toContain("data-[state=open]:opacity-100");
  });

  /**
   * The same control, the same complaint, on the saved board's collection chip.
   * It holds the only rename and the only delete a collection has, so a
   * pointer-only trigger makes both unreachable on a touch screen.
   */
  it("is always visible on the saved board's collection chip too", () => {
    expect(savedPage).not.toContain("group-hover/chip:opacity-100");
    expect(savedPage).not.toContain("data-[state=open]:opacity-100");
  });

  /**
   * The trigger still has to sit above the card's stretched link. The whole
   * card is one `<Link>` with an `absolute inset-0` span inside it, so without
   * a stacking context the menu would never receive a click — a different way
   * to make it unreachable, and one that looks fine in a screenshot.
   */
  it("stays above the card's stretched link", () => {
    expect(nichesPage).toContain("relative z-10");
  });

  /** The hit rule is still reachable from the menu; nothing else prices a niche. */
  it("offers the hit rule and nothing about a rate per view", () => {
    expect(nichesPage).toContain("Hit rule");
    expect(nichesPage).not.toContain("RPM");
    expect(nichesPage).not.toContain("DollarSign");
  });
});
