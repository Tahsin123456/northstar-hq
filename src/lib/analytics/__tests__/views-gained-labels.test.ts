import { describe, expect, it } from "vitest";
import {
  BASELINE_LAG_FLOOR_MS,
  LAG_NOTE_SPAN_FRACTION,
  approxDurationCeil,
  hasUsableGainsHistory,
  measuredSpanNote,
  measuredSpanNoteFrom,
  nicheMeasuredSpanNote,
} from "../views-gained-labels";
import { RPM_MIN_SNAPSHOT_COVERAGE } from "../niche-rpm";

/**
 * =========================================================================
 * THE RETAINED "VIEWS GAINED IN THIS PERIOD" VOCABULARY
 * =========================================================================
 *
 * NOTHING ON SCREEN RENDERS THESE SENTENCES TODAY, and these tests are kept
 * anyway. The niche money surfaces price every view the tracked channels have
 * — no history, no coverage floor, no span label — but the server machinery
 * that measures a period's GAINS is still in place for the day the recorded
 * history is deep enough to answer "what did this period actually pay?".
 * `views-gained-labels.ts` is the vocabulary that figure will need, and an
 * untested retained module is a module nobody will trust enough to reuse.
 *
 * These assertions moved here verbatim from `niche-earnings.test.ts` when the
 * money basis changed. They passed before the move and they pass after it,
 * which is the whole claim: the measurement and its labels are unchanged, they
 * simply no longer decide what money renders.
 */

describe("the coverage floor a gains figure would have to clear", () => {
  /**
   * 0.9 — the DOLLAR floor, not the 0.8 the history chart uses. An uncovered
   * video's views are silently missing from a gains sum, so below the floor a
   * figure would be priced from an incomplete count.
   */
  it("refuses at 0.899 and grants at exactly 0.9", () => {
    expect(RPM_MIN_SNAPSHOT_COVERAGE).toBe(0.9);
    expect(hasUsableGainsHistory({ coveredVideos: 899, totalVideos: 1000 })).toBe(false);
    expect(hasUsableGainsHistory({ coveredVideos: 900, totalVideos: 1000 })).toBe(true);
  });

  /** No measurement at all is the same refusal said harder. */
  it("treats an unmeasured niche as unusable", () => {
    expect(hasUsableGainsHistory(null)).toBe(false);
  });

  /**
   * A library of zero videos is NOT thin history — there is nothing the
   * measurement failed to cover.
   */
  it("does not call an empty library insufficient", () => {
    expect(hasUsableGainsHistory({ coveredVideos: 0, totalVideos: 0 })).toBe(true);
  });
});

describe("the measured-span label", () => {
  it("says exactly how much of the period the history covers", () => {
    expect(measuredSpanNote(9, 30)).toBe(
      "Measured over the last 9 of 30 days — view history begins there.",
    );
  });

  it("is singular-safe", () => {
    expect(measuredSpanNote(1, 1)).toBe(
      "Measured over the last 1 of 1 day — view history begins there.",
    );
  });

  const DAY_MS = 86_400_000;
  const HOUR_MS = 3_600_000;
  const END = Date.UTC(2026, 7, 31);

  it("derives the note from the server's own echo of the request", () => {
    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 30 * DAY_MS,
        measuredFromMs: END - 9 * DAY_MS,
        endMs: END,
        maxBaselineLagMs: 0,
        maxEndLagMs: 0,
      }),
    ).toBe("Measured over the last 9 of 30 days — view history begins there.");
  });

  it("says nothing when the whole period was measured, for every video", () => {
    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 30 * DAY_MS,
        measuredFromMs: END - 30 * DAY_MS,
        endMs: END,
        maxBaselineLagMs: 0,
        maxEndLagMs: 0,
      }),
    ).toBeNull();
    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 30 * DAY_MS,
        measuredFromMs: null,
        endMs: END,
        maxBaselineLagMs: null,
        maxEndLagMs: null,
      }),
    ).toBeNull();
  });

  /**
   * Videos are baselined on their own first reading when the sweep reached
   * them late, so the span is not uniform across every video — and a note that
   * went silent whenever the clamp had not fired would hide the caveat exactly
   * where it is the only thing left to say.
   */
  it("speaks about ragged baselines even when the clamp never fired", () => {
    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 30 * DAY_MS,
        measuredFromMs: END - 30 * DAY_MS,
        endMs: END,
        maxBaselineLagMs: 12 * HOUR_MS,
        maxEndLagMs: 0,
      }),
    ).toBe(
      "Measured over the full 30 days. The app started recording some of these " +
        "videos up to 12 hours into that span, so their first views are missing " +
        "and this figure is a little low.",
    );
  });

  /**
   * A video past its hit window is snapshotted at most daily and not at all
   * while its count has not moved, so the last reading inside the period can
   * sit a long way before its close. On a short measured span that is the
   * BIGGER of the two gaps.
   */
  it("states the tail gap on its own, with no ragged head to report", () => {
    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 30 * DAY_MS,
        measuredFromMs: END - 36 * HOUR_MS,
        endMs: END,
        maxBaselineLagMs: 0,
        maxEndLagMs: 12 * HOUR_MS,
      }),
    ).toBe(
      "Measured over the last 2 of 30 days — view history begins there. " +
        "The latest reading for some of these videos is up to 12 hours before " +
        "the period ends, so their last views are missing and this figure is a " +
        "little low.",
    );
  });

  it("states both gaps in one sentence when both ends are ragged", () => {
    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 30 * DAY_MS,
        measuredFromMs: END - 9 * DAY_MS,
        endMs: END,
        maxBaselineLagMs: 3 * HOUR_MS,
        maxEndLagMs: 25 * HOUR_MS,
      }),
    ).toBe(
      "Measured over the last 9 of 30 days — view history begins there. " +
        "The app started recording some of these videos up to 3 hours into that " +
        "span, and its latest reading for some of them is up to 25 hours before " +
        "the period ends, so those views are missing and this figure is a little low.",
    );
  });

  /** A bound is only a bound if it rounds the safe way. */
  it("rounds the stated gap UP, so 'up to' is never a claim the data cannot support", () => {
    expect(approxDurationCeil(61 * 60_000)).toBe("2 hours");
    expect(approxDurationCeil(90 * 1_000)).toBe("2 minutes");
    expect(approxDurationCeil(3_600_000)).toBe("1 hour");
    expect(approxDurationCeil(49 * HOUR_MS)).toBe("3 days");
  });

  it("stays quiet below the smallest unit it can express", () => {
    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 30 * DAY_MS,
        measuredFromMs: END - 30 * DAY_MS,
        endMs: END,
        maxBaselineLagMs: 30_000,
        maxEndLagMs: 30_000,
      }),
    ).toBeNull();
    expect(BASELINE_LAG_FLOOR_MS).toBe(60_000);
  });

  /**
   * The tail gap is essentially never zero — the last channel the sweep
   * reached was read minutes-to-hours ago at any instant — so a minute-floored
   * caveat would print under every figure forever. A hundredth of the span is
   * the line: 7 hours out of 30 days is noise, 22 minutes out of 36 hours is
   * not, and the same rule says so.
   */
  it("judges a gap against the span it is a gap in, not against the clock alone", () => {
    expect(LAG_NOTE_SPAN_FRACTION).toBe(0.01);

    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 30 * DAY_MS,
        measuredFromMs: END - 30 * DAY_MS,
        endMs: END,
        maxBaselineLagMs: 2 * HOUR_MS,
        maxEndLagMs: 2 * HOUR_MS,
      }),
    ).toBeNull();

    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 36 * HOUR_MS,
        measuredFromMs: END - 36 * HOUR_MS,
        endMs: END,
        maxBaselineLagMs: 2 * HOUR_MS,
        maxEndLagMs: 0,
      }),
    ).toBe(
      "Measured over the full 2 days. The app started recording some of these " +
        "videos up to 2 hours into that span, so their first views are missing " +
        "and this figure is a little low.",
    );
  });
});

/**
 * The sentence would render directly beneath ONE niche's figure. Fed the
 * page-wide maxima it asserted a shortfall that niche may not have — "some of
 * these videos" and "this figure is a little low" are both false of a niche
 * whose every video was measured end to end.
 */
describe("the per-niche measured-span note", () => {
  const DAY_MS = 86_400_000;
  const HOUR_MS = 3_600_000;
  const END = Date.UTC(2026, 7, 31);
  const response = {
    requestedStartMs: END - 30 * DAY_MS,
    measuredFromMs: END - 9 * DAY_MS,
    endMs: END,
  };

  it("says only what is true of THIS niche's videos", () => {
    expect(
      nicheMeasuredSpanNote(response, { maxBaselineLagMs: 0, maxEndLagMs: 0 }),
    ).toBe("Measured over the last 9 of 30 days — view history begins there.");

    expect(
      nicheMeasuredSpanNote(response, {
        maxBaselineLagMs: 3 * HOUR_MS,
        maxEndLagMs: 0,
      }),
    ).toBe(
      "Measured over the last 9 of 30 days — view history begins there. " +
        "The app started recording some of these videos up to 3 hours into that " +
        "span, so their first views are missing and this figure is a little low.",
    );
  });

  it("falls back to the span alone for a niche the response did not answer for", () => {
    expect(nicheMeasuredSpanNote(response, null)).toBe(
      "Measured over the last 9 of 30 days — view history begins there.",
    );
  });
});
