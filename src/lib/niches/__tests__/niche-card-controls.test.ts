import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * =========================================================================
 * THE CONTROLS ON A NICHE CARD
 * =========================================================================
 *
 * Two of the owner's requests were satisfied by DELETING code, which is the
 * hardest kind of change to keep:
 *
 *   • "The 'Set RPM range' buttons look really ugly inside Niches > Each Niche
 *     window. Just put them under [the menu]." — two inline accent links came
 *     out of the money strip. The menu item they moved to already existed.
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
 * THE TWO CHANGES ARE CONNECTED, which is why they share a file. Removing the
 * inline buttons made the "…" menu the ONLY route to the RPM dialog. A menu
 * that appears only under a pointer would then have made pricing a niche
 * unreachable on a touch screen — so the second change is not cosmetic, it is
 * what keeps the first one from removing a capability.
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
const valueStrip = code("components/niches/niche-value-strip.tsx");
const rpmDialog = code("components/niches/niche-rpm-dialog.tsx");
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
});

describe("where a niche's RPM is set", () => {
  /**
   * The inline buttons are gone, and the component behind them with them. A
   * component left exported with no callers reads as "something else must use
   * this" to the next person, which is how dead code survives a decade.
   */
  it("no longer offers an inline button in the money strip", () => {
    expect(valueStrip).not.toContain("SetNicheRpmButton");
    expect(rpmDialog).not.toContain("function SetNicheRpmButton");
  });

  /**
   * The menu item is the replacement, and the strip POINTS at it. Removing the
   * button without the pointer would leave an unpriced niche explaining a gap
   * and offering nothing to close it — which is worse than the ugly button.
   * The label is imported rather than typed in two places, so the sentence
   * cannot end up naming a menu item that has been renamed.
   */
  it("offers it in the '…' menu, and says so where the figure is missing", () => {
    expect(nichesPage).toContain("RPM_MENU_ITEM_LABEL");
    expect(valueStrip).toContain("RPM_MENU_ITEM_LABEL");
    expect(rpmDialog).toContain("export const RPM_MENU_ITEM_LABEL");
  });
});

describe("the RPM dialog's low and high boxes", () => {
  /**
   * =========================================================================
   * THE ALIGNMENT BUG HAD TWO CAUSES AND BOTH FIXES HAVE TO SURVIVE
   * =========================================================================
   * The owner reported the two boxes sitting at different heights.
   *
   * (1) The left label read "Low (USD per 1,000 views)" against a bare "High",
   *     and at 162px of column it wrapped to two lines while "High" did not —
   *     so the right input sat exactly one label line-height higher. The unit
   *     is stated once above the pair now, and both labels are single words.
   *
   * (2) Nothing pinned the inputs to a shared line: the cells were top-packed
   *     flex columns with no `items-end`, no `self-end`, no `mt-auto` and no
   *     minimum height on the label. They aligned only for as long as the two
   *     labels happened to occupy the same number of lines, which is alignment
   *     by coincidence.
   *
   * Fixing only (1) leaves the cause in place for the next label that wraps —
   * a longer currency code, a translation. So both are asserted.
   */
  it("states the unit once above the pair rather than inside one label", () => {
    // The asymmetric label that wrapped. Its return is the bug returning.
    expect(rpmDialog).not.toMatch(/Low \(\{currency\}/);
    expect(rpmDialog).toContain('id="niche-rpm-unit"');
    // Both fields reach the unit, which also closes the accessibility gap: a
    // screen-reader user used to hear the unit on "Low" and nothing on "High".
    expect(
      rpmDialog.split('aria-describedby="niche-rpm-unit"').length - 1,
    ).toBe(2);
  });

  it("pins both inputs to the bottom of the row whatever the labels do", () => {
    // `h-full` on each cell plus `mt-auto` on each input: the grid stretches
    // its items, so both inputs sit on the floor of the taller cell.
    expect(rpmDialog.split("flex h-full flex-col").length - 1).toBe(2);
    expect(rpmDialog.split('className="mt-auto"').length - 1).toBe(2);
  });
});

/**
 * =========================================================================
 * THE ENGAGED-VIEW CLAUSE HAS TO SIT BESIDE THE FIGURE IT IS THE DENOMINATOR OF
 * =========================================================================
 * `NicheValue.pricedViews` is `ourPayable + competitorPayable` — the engaged
 * subset of the WHOLE tracked niche, and therefore the denominator behind
 * `trackedRevenue`, the headline figure. It was rendered as a trailing clause on
 * the sentence whose money is Northstar's ALONE:
 *
 *   "Northstar's 8M of 40M tracked views, worth $180.00. Priced on 20M engaged
 *    views (50%)."
 *
 * Both numbers are correct and the sentence is still false, which is the
 * dangerous kind: $180 came from 4M engaged views, not 20M, so a reader who
 * divides the stated money by the stated views gets a rate five times off. The
 * more carefully somebody reads it, the more wrong they end up.
 *
 * This is the one line on the card that discloses the engaged-view step at all,
 * so it cannot simply be dropped — it had to move to the figure it explains.
 * There is no DOM here, so position is asserted through the source in the same
 * way as the deletions above.
 */
describe("where the niche card says what it priced", () => {
  const engagedAt = valueStrip.indexOf("value.pricedViews");
  const oursAt = valueStrip.indexOf("formatProjected(value.ourRevenue");

  it("renders the engaged-view clause before Northstar's own figure", () => {
    expect(engagedAt).toBeGreaterThan(-1);
    expect(oursAt).toBeGreaterThan(-1);
    expect(engagedAt).toBeLessThan(oursAt);
  });

  /**
   * The specific regression: the clause must not be inside the paragraph whose
   * money is `ourRevenue`. Bounded at that paragraph's own closing tag so this
   * keeps meaning what it says if the surrounding block is rearranged.
   */
  it("keeps it out of the sentence about Northstar's own revenue", () => {
    const paragraph = valueStrip.slice(oursAt, valueStrip.indexOf("</p>", oursAt));

    expect(paragraph).not.toContain("pricedViews");
    expect(paragraph).not.toContain("engaged");
  });

  /**
   * Scoped to the clause itself, and that is the whole point of the slice.
   * Asserting `valueStrip` merely CONTAINS "tracked views" passes on the old
   * broken layout too — the sentence about Northstar's own figure says
   * "tracked views" as well — so a whole-file assertion here would be green for
   * a reason unrelated to what it claims to check.
   */
  it("qualifies the tracked total, naming the number it belongs to", () => {
    const clause = valueStrip.slice(
      valueStrip.indexOf('value.basis === "engaged"'),
      valueStrip.indexOf("</p>", engagedAt),
    );

    expect(clause).toContain("value.trackedNicheViews");
    expect(clause).toContain("value.pricedViews");
    expect(clause).toContain("are priced as engaged");
    // The old phrasing hung off "worth $X" and read as a claim about it.
    expect(valueStrip).not.toContain("Priced on {formatCompactNumber");
  });

  /**
   * The clause is still gated on the basis. A MEASURED rate prices raw views —
   * it is derived from channel-wide revenue that YouTube did not pay on engaged
   * views at all — so announcing an engaged subset under one would invent a step
   * that never ran.
   */
  it("only claims an engaged subset where the rate is quoted in one", () => {
    expect(valueStrip).toContain('value.basis === "engaged"');
  });
});

/**
 * =========================================================================
 * A STORED RANGE MEANS SOMETHING DIFFERENT THAN IT DID LAST RELEASE
 * =========================================================================
 * The previous dialog collected "what 1,000 views in {niche} are worth" and
 * priced the full view count with it. This one collects the same column as
 * 1,000 ENGAGED views and prices roughly half. The migration is additive and
 * rewrites no niche row — correct, since a backfill would be code guessing
 * which unit a human meant — so any range entered before the deploy now yields
 * about half the money it did, with nothing on screen to explain the drop.
 *
 * Nobody can read the production table from a test, and "we assume no niche is
 * priced yet" is an assumption rather than a fact. So the dialog says it once,
 * to the only reader who can be affected: the one with a range in the boxes.
 */
describe("the RPM dialog's note about the unit change", () => {
  it("exports the notice, so the wording is not buried in JSX", () => {
    expect(rpmDialog).toContain("export const RPM_UNIT_CHANGED_NOTICE");
  });

  it("names both units, so the reader can tell which one they used", () => {
    expect(rpmDialog).toContain("ENGAGED views");
    expect(rpmDialog).toContain("per 1,000 total views");
  });

  /**
   * Shown only when a range was actually seeded into the fields. A niche nobody
   * has priced has nothing to re-check, and a warning on an empty form is the
   * kind of notice people learn to dismiss without reading.
   */
  it("shows it only to a reader who has a stored range in front of them", () => {
    expect(rpmDialog).toContain("seeded.low || seeded.high");
    const at = rpmDialog.indexOf("RPM_UNIT_CHANGED_NOTICE}");
    const gate = rpmDialog.lastIndexOf("seeded.low || seeded.high", at);
    expect(gate).toBeGreaterThan(-1);
    expect(at - gate).toBeLessThan(400);
  });
});
