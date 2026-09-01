import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { calculateChannelMetrics } from "../channel-metrics";
import {
  EVIDENCE_LIMITED_EXPLANATION,
  STALE_DATA_THRESHOLD_MS,
  STALE_DATA_TITLE,
  TOTAL_VIEWS_DEFINITION,
  TOTAL_VIEWS_VS_STUDIO,
  UPLOAD_VIEWS_LABEL,
  UPLOAD_VIEWS_LABEL_LONG,
  UPLOAD_VIEWS_TIP,
  VIEWS_EARNED_NOT_AVAILABLE,
  staleDataExplanation,
  uploadViewsTip,
  viewHistoryNote,
} from "../constants";
import type { DateRange } from "../types";
import { DAY_MS, daysAgo, makeShort } from "./factories";

/**
 * =========================================================================
 * "TOTAL VIEWS AREN'T CORRECT"
 * =========================================================================
 *
 * They were correct. The name was not. The figure is the sum of the CURRENT
 * lifetime view counts of Shorts UPLOADED in the selected period — two
 * different clocks in one number, and a perfectly useful measure of how recent
 * output performed. Called "Total views" with no qualifier, in a table
 * comparing channels, it reads as "views this channel earned", which is what
 * YouTube Studio and VidIQ report over a whole back catalogue. Those two
 * quantities have never agreed and never will.
 *
 * The first block pins the arithmetic so nobody "fixes" the metric into
 * something this deployment cannot compute. The rest pin the words, because the
 * words are the actual bug.
 */

const NOW = Date.UTC(2026, 5, 1);
const range = (days: number): DateRange => ({
  startMs: NOW - days * DAY_MS,
  endMs: NOW,
});

const readSource = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), "utf8");

describe("Upload views — what the number counts", () => {
  it("sums lifetime views of Shorts uploaded inside the window, and nothing else", () => {
    const videos = [
      // Uploaded three days ago. Contributes ALL of its lifetime views.
      makeShort({ views: 5_000_000, publishedAt: daysAgo(3, NOW) }),
      makeShort({ views: 1_500_000, publishedAt: daysAgo(20, NOW) }),
      // Uploaded before the window. Contributes NONE of its views, even though
      // plenty of them were certainly earned during the window.
      makeShort({ views: 90_000_000, publishedAt: daysAgo(45, NOW) }),
    ];

    const metrics = calculateChannelMetrics({
      videos,
      range: range(30),
      threshold: 1_000_000,
    });

    expect(metrics.totalShorts).toBe(2);
    expect(metrics.totalViews).toBe(6_500_000);
  });

  it("is a lifetime total with no window — the same Short counts the same in a wider period", () => {
    // The property that makes "views earned in the period" the wrong reading:
    // widening the window can only ADD uploads, never re-cut anybody's views.
    const videos = [makeShort({ views: 4_000_000, publishedAt: daysAgo(5, NOW) })];
    const week = calculateChannelMetrics({ videos, range: range(7), threshold: 1 });
    const quarter = calculateChannelMetrics({ videos, range: range(90), threshold: 1 });
    expect(week.totalViews).toBe(4_000_000);
    expect(quarter.totalViews).toBe(4_000_000);
  });
});

describe("Upload views — the name and the disclosure", () => {
  it("has one name", () => {
    expect(UPLOAD_VIEWS_LABEL).toBe("Upload views");
  });

  it("opens the definition with the name the surfaces use", () => {
    // A tooltip that starts "Total Shorts views is..." under a column headed
    // "Upload views" makes a reader wonder whether they are the same figure.
    expect(TOTAL_VIEWS_DEFINITION.startsWith(`${UPLOAD_VIEWS_LABEL} is`)).toBe(true);
  });

  it("says plainly that it is not views earned during the period", () => {
    expect(TOTAL_VIEWS_DEFINITION).toContain("not views earned during the period");
  });

  it("names VidIQ, not only YouTube Studio", () => {
    // The owner's comparison was VidIQ. A caveat that names only Studio lets a
    // reader conclude it does not apply to them.
    expect(TOTAL_VIEWS_VS_STUDIO).toContain("VidIQ");
    expect(TOTAL_VIEWS_VS_STUDIO).toContain("YouTube Studio");
    expect(TOTAL_VIEWS_VS_STUDIO).toContain("will not agree");
  });

  it("ships one tip made of both halves", () => {
    expect(UPLOAD_VIEWS_TIP).toContain(TOTAL_VIEWS_DEFINITION);
    expect(UPLOAD_VIEWS_TIP).toContain(TOTAL_VIEWS_VS_STUDIO);
  });

  /*
   * THE SHORT NAME IS AN ABBREVIATION, NOT THE WHOLE DISCLOSURE.
   *
   * "Upload views" names the cohort and never says the views themselves are
   * lifetime, so "views our uploads got in the last 30 days" survives it — and
   * that reading is VidIQ's quantity, which is the false comparison the rename
   * exists to break. It fits a 10px column head and that is the only reason it
   * exists; every surface with a stat label carries the long form.
   */
  it("gets the missing qualifier onto a visible surface, not only into a tooltip", () => {
    expect(UPLOAD_VIEWS_LABEL_LONG.toLowerCase()).toContain("lifetime");
    expect(UPLOAD_VIEWS_LABEL_LONG.toLowerCase()).toContain("period uploads");
  });

  it("does not let a consistency pass make the roomy surfaces say less", () => {
    // The Overview card in the bug report used to read "Views of period
    // uploads". Whatever it says now has to be at least as specific.
    for (const relative of [
      "components/dashboard/summary-cards.tsx",
      "components/channel/kpi-cards.tsx",
      "app/(app)/admin/page.tsx",
      "lib/report/build-report.ts",
    ]) {
      expect(readSource(relative)).toContain("UPLOAD_VIEWS_LABEL_LONG");
    }
  });

  it("keeps the short name on the two surfaces that cannot fit the long one", () => {
    // A ~100px column head and a bare <th> in a scrollable table.
    for (const relative of [
      "components/dashboard/channel-table.tsx",
      "components/dashboard/content-type-performance-table.tsx",
    ]) {
      const source = readSource(relative);
      expect(source).toContain("UPLOAD_VIEWS_LABEL");
      expect(source).not.toContain("UPLOAD_VIEWS_LABEL_LONG");
    }
  });
});

describe("the evidence-limited explanation points somewhere", () => {
  /*
   * Every other absent state on this product carries an action: "Not
   * configured" names an admin and ships a button, the stale banner ships a
   * Refresh. This one used to end "The range narrows on its own as view history
   * is recorded" — which on this deployment is false, because `autoRefreshEnabled`
   * is off and nothing writes the history that would narrow it. A reassurance
   * that the problem resolves itself, attached to a problem that will not.
   */
  it("names the setting that actually starts the history accumulating", () => {
    expect(EVIDENCE_LIMITED_EXPLANATION).toContain("automatic refresh");
    expect(EVIDENCE_LIMITED_EXPLANATION).toContain("Settings");
  });

  it("no longer promises it fixes itself", () => {
    expect(EVIDENCE_LIMITED_EXPLANATION).not.toContain("on its own");
  });

  it("still explains what the two ends of the range mean", () => {
    expect(EVIDENCE_LIMITED_EXPLANATION).toContain("too slow");
    expect(EVIDENCE_LIMITED_EXPLANATION).toContain("as a hit");
  });
});

describe("what the app says INSTEAD of a views-earned figure", () => {
  it("states that the figure is absent, and why", () => {
    expect(VIEWS_EARNED_NOT_AVAILABLE).toContain("is not shown here");
    expect(VIEWS_EARNED_NOT_AVAILABLE).toContain("both ends of the window");
  });

  it("counts the history honestly at zero, one and many days", () => {
    expect(viewHistoryNote(0)).toContain("No view history has been recorded");
    expect(viewHistoryNote(1)).toContain("1 day of view history");
    expect(viewHistoryNote(1)).not.toContain("days");
    expect(viewHistoryNote(9)).toContain("9 days of view history");
  });

  it("appends the absence and the history only where a day count is supplied", () => {
    // The cramped surfaces get the definition alone rather than a sentence
    // about history they were not given.
    expect(uploadViewsTip(null)).toBe(UPLOAD_VIEWS_TIP);

    const roomy = uploadViewsTip(0);
    expect(roomy).toContain(TOTAL_VIEWS_DEFINITION);
    expect(roomy).toContain(VIEWS_EARNED_NOT_AVAILABLE);
    expect(roomy).toContain("No view history has been recorded");
  });
});

describe("the stale-data warning", () => {
  it("waits two days, so it is still worth reading when it appears", () => {
    expect(STALE_DATA_THRESHOLD_MS).toBe(48 * 60 * 60 * 1000);
  });

  it("says the period really ends at the last refresh, not today", () => {
    const copy = staleDataExplanation("5 days ago");
    expect(STALE_DATA_TITLE).toBe("These numbers are out of date");
    expect(copy).toContain("last refreshed 5 days ago");
    expect(copy).toContain("really ends at the last refresh, not today");
    expect(copy).toContain("automatic refresh");
  });
});

/**
 * THE REGRESSION GUARD.
 *
 * This bug was a name that existed correctly on two surfaces and wrongly on
 * four. Nothing in the type system stops somebody typing a fifth one, so the
 * check is on the source: every surface that renders this figure imports the
 * shared constant, and none of them spells the old names out by hand.
 */
describe("no surface invents its own name for this figure", () => {
  const SURFACES = [
    "components/dashboard/channel-table.tsx",
    "components/dashboard/summary-cards.tsx",
    "components/dashboard/content-type-performance-table.tsx",
    "components/channel/kpi-cards.tsx",
    "app/(app)/admin/page.tsx",
    "app/(app)/channels/page.tsx",
  ] as const;

  it.each(SURFACES)("%s uses the shared label", (relative) => {
    expect(readSource(relative)).toContain("UPLOAD_VIEWS_LABEL");
  });

  /*
   * The five names this figure used to go by, matched where they would be
   * ASSIGNED as a label rather than merely mentioned — the comments in these
   * files quote the old names on purpose, and a check that forbade the words
   * outright would forbid explaining the bug.
   */
  const DEAD_LABELS = [
    /label[:=]\s*"Total views"/,
    /label[:=]\s*"Total Shorts views"/,
    /label[:=]\s*"Views of period uploads"/,
    /label[:=]\s*"Views"/,
  ] as const;

  it.each(SURFACES)("%s no longer hard-codes a rival name", (relative) => {
    const source = readSource(relative);
    for (const dead of DEAD_LABELS) {
      expect(source).not.toMatch(dead);
    }
  });

  it("carries the disclosure on the column the bug was reported against", () => {
    // `totalViews` was the only numeric column in the channels table with no
    // `tip`, while every neighbour had one.
    const source = readSource("components/dashboard/channel-table.tsx");
    expect(source).toMatch(/key: "totalViews"[^}]*tip: UPLOAD_VIEWS_TIP/);
  });
});
