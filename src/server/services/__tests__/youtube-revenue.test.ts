import { beforeAll, describe, expect, it } from "vitest";

// Not from the service: the ledger reads the mark through this module, and a
// test that went through the service would pass even if the two disagreed.
import { isUnmaintainedNote } from "@/lib/finance/unmaintained";

/**
 * The two places a revenue figure can be silently wrong.
 *
 * Everything else in the revenue service is I/O against Google or writes
 * through Prisma. These two are arithmetic and shape-reading, they run on every
 * imported figure, and both fail in the way that is hardest to notice: the
 * ledger still balances, the totals still look plausible, and the number is
 * simply not the one YouTube reported. No database and no network here — the
 * point is to pin the decisions, not to rehearse the plumbing.
 */

// The revenue service reaches the DAL through finance-service, and the DAL
// reads SESSION_SECRET through auth-env at import time. Set it before the
// dynamic import below, as the niche-scope tests do — nothing here touches a
// session, but the module graph still has to load.
process.env.SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");

type RevenueModule = typeof import("../youtube-revenue-service");

let revenue: RevenueModule;

beforeAll(async () => {
  revenue = await import("../youtube-revenue-service");
});

describe("toMinorUnits", () => {
  const toMinorUnits = (value: unknown, currency: string) =>
    revenue.toMinorUnits(value, currency);

  it("converts a reported float to integer minor units", () => {
    expect(toMinorUnits(12.34, "USD")).toBe(1234);
    expect(toMinorUnits(0, "USD")).toBe(0);
    expect(toMinorUnits(1, "USD")).toBe(100);
  });

  /**
   * The reason this function exists at all.
   *
   * Both obvious implementations lose this cent: `Math.round(1.005 * 100)` is
   * 100, and so is `(1.005).toFixed(2)` — the double nearest 1.005 is slightly
   * below it, and `toFixed` rounds the exact binary value rather than the
   * decimal anyone would write. Rounding the shortest round-tripping digit
   * string gives 101, which is the figure Google sent.
   */
  it("rounds the decimal Google sent, not the binary approximation of it", () => {
    expect(toMinorUnits(1.005, "USD")).toBe(101);
    expect(Math.round(1.005 * 100)).toBe(100);
    expect((1.005).toFixed(2)).toBe("1.00");
  });

  /**
   * A daily figure smaller than a cent is rounded, not rejected. JavaScript
   * prints these in exponential notation, which the digit path cannot read —
   * so they are answered before it, rather than being reported as a day that
   * could not be parsed.
   */
  it("rounds a sub-cent figure to zero instead of calling it malformed", () => {
    expect(toMinorUnits(1e-7, "USD")).toBe(0);
    expect(toMinorUnits(0.004, "USD")).toBe(0);
    expect(toMinorUnits(0.005, "USD")).toBe(1);
  });

  it("scales by the currency's own minor digits rather than assuming two", () => {
    // JPY has no minor unit at all. Assuming 100 would report ¥1,200 as ¥12.
    expect(toMinorUnits(1200, "JPY")).toBe(1200);
    expect(toMinorUnits(1200.6, "JPY")).toBe(1201);
  });

  /** A negative is possible: YouTube can claw an over-reported day back. */
  it("keeps the sign of a negative adjustment", () => {
    expect(toMinorUnits(-4.5, "USD")).toBe(-450);
  });

  /**
   * Null, never zero. Zero is a revenue figure, and returning one for a value
   * that could not be read would put a fabricated number in the ledger.
   */
  it("returns null for anything it cannot read", () => {
    expect(toMinorUnits(null, "USD")).toBeNull();
    expect(toMinorUnits(undefined, "USD")).toBeNull();
    expect(toMinorUnits("not a number", "USD")).toBeNull();
    expect(toMinorUnits(Number.NaN, "USD")).toBeNull();
    expect(toMinorUnits(Number.POSITIVE_INFINITY, "USD")).toBeNull();
    // Beyond what the Int column can hold: refused rather than truncated.
    expect(toMinorUnits(1e11, "USD")).toBeNull();
  });
});

describe("readReport", () => {
  const headers = (...names: string[]) => names.map((name) => ({ name }));
  const readReport = (report: Parameters<RevenueModule["readReport"]>[0], currency: string) =>
    revenue.readReport(report, currency);

  it("reads columns by name", () => {
    const { days } = readReport(
      {
        columnHeaders: headers(
          "day",
          "estimatedRevenue",
          "estimatedAdRevenue",
          "estimatedRedPartnerRevenue",
        ),
        rows: [["2026-08-01", 10.5, 8.25, 2.25]],
      },
      "USD",
    );

    expect(days).toHaveLength(1);
    expect(days[0]?.day.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(days[0]?.estimatedRevenueMinor).toBe(1050);
    expect(days[0]?.estimatedAdRevenueMinor).toBe(825);
    expect(days[0]?.estimatedRedPartnerRevenueMinor).toBe(225);
  });

  /**
   * The failure this guards against is total and silent: if Google reordered
   * the columns and we indexed by position, ad revenue would be stored as total
   * revenue and every figure downstream would be wrong with no error anywhere.
   */
  it("is unaffected by the order Google returns the columns in", () => {
    const { days } = readReport(
      {
        columnHeaders: headers("estimatedAdRevenue", "estimatedRevenue", "day"),
        rows: [[8.25, 10.5, "2026-08-01"]],
      },
      "USD",
    );

    expect(days[0]?.estimatedRevenueMinor).toBe(1050);
    expect(days[0]?.estimatedAdRevenueMinor).toBe(825);
  });

  it("drops an unreadable row whole rather than salvaging half of it", () => {
    const { days, malformedRows } = readReport(
      {
        columnHeaders: headers("day", "estimatedRevenue", "estimatedAdRevenue"),
        rows: [
          ["2026-08-01", 10.5, 8.25],
          // A readable total with an unreadable breakdown is still half a row,
          // and half a row is a made-up row.
          ["2026-08-02", 4.0, "—"],
          ["not-a-date", 1.0, 1.0],
        ],
      },
      "USD",
    );

    expect(days).toHaveLength(1);
    expect(malformedRows).toBe(2);
  });

  it("treats an empty report as no days rather than as zero revenue", () => {
    const { days, malformedRows } = readReport(
      { columnHeaders: headers("day", "estimatedRevenue"), rows: [] },
      "USD",
    );
    expect(days).toHaveLength(0);
    expect(malformedRows).toBe(0);
  });

  /** A response missing the columns we asked for is not a report of zero. */
  it("refuses a report without the day and revenue columns", () => {
    expect(() =>
      readReport({ columnHeaders: headers("views"), rows: [[42]] }, "USD"),
    ).toThrow();
  });
});

/**
 * The note that tells the ledger a month has stopped being maintained.
 *
 * Pure string work, and the only part of the mark that has to be exactly right:
 * the mark is written when a month's currencies disagree and taken off again
 * when they stop disagreeing, and the two halves agree on nothing except this
 * format. A separator either side reads differently and an admin's own
 * annotation is silently eaten.
 */
describe("unmaintainedNote / restoredNote", () => {
  // Read through `revenue` at call time, not destructured here: the module is
  // imported in `beforeAll`, which runs after these bodies are collected.
  const unmaintainedNote = (month: string, carried: string | null) =>
    revenue.unmaintainedNote(month, carried);
  const restoredNote = (marked: string) => revenue.restoredNote(marked);

  it("leads with the warning, so a truncated Notes cell still shows it", () => {
    const note = unmaintainedNote("2026-08", "Imported from YouTube Analytics.");
    expect(note.startsWith("NOT BEING UPDATED")).toBe(true);
    // The month is named: "one of your rows is stale" is not an actionable
    // sentence, "August's rows are stale" is.
    expect(note).toContain("2026-08");
  });

  it("hands the previous note back verbatim when the month recovers", () => {
    const carried = "Checked against the bank statement on the 3rd — figure agrees.";
    expect(restoredNote(unmaintainedNote("2026-08", carried))).toBe(carried);
  });

  it("keeps every line of a multi-line note, not just the first", () => {
    const carried = "Line one.\nLine two.";
    expect(restoredNote(unmaintainedNote("2026-08", carried))).toBe(carried);
  });

  /** An entry with no note had nothing to say before, and says nothing after. */
  it("restores to null when there was no note to carry", () => {
    expect(restoredNote(unmaintainedNote("2026-08", null))).toBeNull();
  });

  /**
   * Marking is guarded by a prefix check, so the marked note must itself be
   * recognisable as marked — otherwise every run would re-mark the same month
   * and bury the admin's note one copy of the warning deeper each time.
   */
  it("produces a note that is recognisable as already marked", () => {
    const once = unmaintainedNote("2026-08", "Original.");
    expect(unmaintainedNote("2026-08", once).startsWith("NOT BEING UPDATED")).toBe(true);
    expect(once.startsWith("NOT BEING UPDATED")).toBe(true);
  });

  /**
   * The other end of the same contract: the LEDGER has to recognise what the
   * connector wrote.
   *
   * The mark is the only thing standing between a row nobody is maintaining and
   * an "Est" chip promising a month-end revision that is not coming, and the two
   * halves of it live in different files — the note is composed here, the row is
   * drawn from `isUnmaintainedNote`. Pinned by feeding one into the other, so
   * rewording the prefix fails a test instead of silently putting the old claim
   * back on the row.
   */
  it("is recognised by the ledger's own reader", () => {
    expect(isUnmaintainedNote(unmaintainedNote("2026-08", "Original."))).toBe(true);
    expect(isUnmaintainedNote(unmaintainedNote("2026-08", null))).toBe(true);
  });

  /**
   * `notes` is one of the two fields an admin may edit on an imported row, so
   * the reader is deliberately looser than the writer: a retyped dash or a
   * stray leading space must not take the warning off a figure that is still
   * not being re-checked. Being generous here can only leave a warning up too
   * long — the connector's own guards stay exact, and it lifts the mark itself
   * when the month totals again.
   */
  it("still recognises a mark an admin has lightly mangled", () => {
    expect(isUnmaintainedNote("  NOT BEING UPDATED — 2026-08's daily figures...")).toBe(true);
    expect(isUnmaintainedNote("Not being updated - 2026-08's daily figures...")).toBe(true);
  });

  /** And says nothing about a row carrying an ordinary note, or none at all. */
  it("does not see a mark that is not there", () => {
    expect(isUnmaintainedNote(null)).toBe(false);
    expect(isUnmaintainedNote("")).toBe(false);
    expect(
      isUnmaintainedNote(
        "Imported from YouTube Analytics. Estimated 2026-08 revenue, subject to YouTube's " +
          "month-end adjustment.",
      ),
    ).toBe(false);
    // The words have to LEAD, because the ledger truncates the cell to one line.
    expect(isUnmaintainedNote("August looks fine. NOT BEING UPDATED — ...")).toBe(false);
  });
});

describe("revenueWindowFor", () => {
  const revenueWindowFor = (now: Date) => revenue.revenueWindowFor(now);

  /**
   * The window has to reach back into the previous month early in a month, or a
   * revision to the month that just closed — the most likely revision there is,
   * since YouTube adjusts at month end — would never be re-read.
   */
  it("covers the whole current month plus the trailing days", () => {
    const { startDate, endDate } = revenueWindowFor(new Date("2026-08-03T09:00:00.000Z"));
    expect(startDate.toISOString()).toBe("2026-07-24T00:00:00.000Z");
    expect(endDate.toISOString()).toBe("2026-08-03T00:00:00.000Z");
  });

  it("reaches the first of the month when the trailing window would not", () => {
    const { startDate, endDate } = revenueWindowFor(new Date("2026-08-28T09:00:00.000Z"));
    expect(startDate.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(endDate.toISOString()).toBe("2026-08-28T00:00:00.000Z");
  });
});
