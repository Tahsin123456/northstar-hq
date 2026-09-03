import { describe, expect, it } from "vitest";
import {
  END_LAG_NOTE_FLOOR_MS,
  VIEWS_GAINED_UNAVAILABLE,
  latestReadingNote,
  measuredChannelsCaption,
  measuredSpanNote,
  measuredSpanNoteFrom,
} from "../views-gained-labels";

/**
 * =========================================================================
 * HOW THE "VIEWS GAINED IN THIS PERIOD" FIGURE LABELS ITSELF
 * =========================================================================
 *
 * Two facts a money figure has to state and one it must not invent: where
 * the measurement starts when that is not where the period does; how old the
 * newest reading is when that is worth saying; and — no longer — a ragged
 * head, because the channel counter is bracketed for every measured channel
 * by construction. The per-video vocabulary (coverage floor, baseline grace,
 * "started recording some of these videos up to N hours into that span") is
 * gone with the basis that needed it.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const END = Date.UTC(2026, 7, 31);

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

  it("derives the note from the server's own echo of the request", () => {
    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 30 * DAY_MS,
        measuredFromMs: END - 9 * DAY_MS,
        endMs: END,
        maxEndLagMs: 0,
      }),
    ).toBe("Measured over the last 9 of 30 days — view history begins there.");
  });

  it("says nothing when the whole period was measured and the reading is fresh", () => {
    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 30 * DAY_MS,
        measuredFromMs: END - 30 * DAY_MS,
        endMs: END,
        maxEndLagMs: 20 * 60_000,
      }),
    ).toBeNull();
    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 30 * DAY_MS,
        measuredFromMs: null,
        endMs: END,
        maxEndLagMs: null,
      }),
    ).toBeNull();
  });

  /**
   * Readings arrive on the sweep, so the newest is minutes-to-hours old at
   * any instant. An hour is the line: under it the sentence would print
   * under every figure forever and teach the reader to skip it.
   */
  it("states the age of the latest reading only past an hour", () => {
    expect(END_LAG_NOTE_FLOOR_MS).toBe(HOUR_MS);

    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 30 * DAY_MS,
        measuredFromMs: END - 30 * DAY_MS,
        endMs: END,
        maxEndLagMs: HOUR_MS,
      }),
    ).toBeNull();

    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 30 * DAY_MS,
        measuredFromMs: END - 30 * DAY_MS,
        endMs: END,
        maxEndLagMs: 7 * HOUR_MS,
      }),
    ).toBe("Latest reading 7h ago.");
  });

  it("appends the reading's age to the span sentence when both apply", () => {
    expect(
      measuredSpanNoteFrom({
        requestedStartMs: END - 30 * DAY_MS,
        measuredFromMs: END - 9 * DAY_MS,
        endMs: END,
        maxEndLagMs: 6 * HOUR_MS + 20 * 60_000,
      }),
    ).toBe(
      "Measured over the last 9 of 30 days — view history begins there. Latest reading 6h ago.",
    );
  });

  it("speaks in days once the reading is two days old", () => {
    expect(latestReadingNote(49 * HOUR_MS)).toBe("Latest reading 2d ago.");
    expect(latestReadingNote(90 * 60_000)).toBe("Latest reading 2h ago.");
  });
});

describe("the partial-niche caption", () => {
  it("names the covered part when the figure misses channels", () => {
    expect(measuredChannelsCaption({ measuredChannels: 3, totalChannels: 5 })).toBe(
      "3 of 5 channels measured",
    );
  });

  it("is silent when every channel is in, and when none is", () => {
    // Every channel: nothing to caveat. None: a different state entirely —
    // the measuring sentence — not a caption under a figure.
    expect(measuredChannelsCaption({ measuredChannels: 5, totalChannels: 5 })).toBeNull();
    expect(measuredChannelsCaption({ measuredChannels: 0, totalChannels: 5 })).toBeNull();
    expect(measuredChannelsCaption({ measuredChannels: 0, totalChannels: 0 })).toBeNull();
  });
});

describe("the failure sentence", () => {
  it("names the one action that helps and invents no figure", () => {
    expect(VIEWS_GAINED_UNAVAILABLE).toContain("Reload the page");
    expect(VIEWS_GAINED_UNAVAILABLE).not.toMatch(/\$|0/);
  });
});
