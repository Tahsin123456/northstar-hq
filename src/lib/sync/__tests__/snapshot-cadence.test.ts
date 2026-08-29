import { describe, expect, it } from "vitest";
import {
  densePhaseHours,
  isInsideWindow,
  snapshotIntervalMinutes,
  snapshotPhase,
} from "../snapshot-cadence";

/**
 * WHAT THE SAMPLING SCHEDULE COSTS AND BUYS.
 *
 * The old cadence was one number for everything, and the state of the library
 * is the proof of what that produced: 3,196 snapshots over 2,594 videos, and
 * only 59 Shorts with any reading inside seven days of publishing. Almost every
 * row was taken too late to decide anything.
 *
 * These tests pin the two properties that matter — the boundaries come from the
 * niche's own window rather than from a hardcoded number of days, and the total
 * cost stays bounded — because both are the kind of thing a later "just make it
 * a bit denser" quietly breaks.
 */

const BASE = 360; // the organization's configured interval, in minutes
const WEEK = 168; // the canonical window, in hours

describe("the boundaries come from the window, not from the calendar", () => {
  it("gives a seven-day rule its first day at an hourly cadence", () => {
    expect(densePhaseHours(WEEK)).toBe(24);
    expect(snapshotIntervalMinutes({ ageHours: 0, windowHours: WEEK, baseIntervalMinutes: BASE })).toBe(60);
    expect(snapshotIntervalMinutes({ ageHours: 23, windowHours: WEEK, baseIntervalMinutes: BASE })).toBe(60);
  });

  it("scales the dense phase down for a tighter rule", () => {
    // A 48-hour window gets roughly its first seven hours hourly. A hardcoded
    // "first 24 hours" would have spent half of a two-day window on the dense
    // schedule, which is a different rule wearing the same code.
    expect(densePhaseHours(48)).toBe(7);
    expect(snapshotIntervalMinutes({ ageHours: 6, windowHours: 48, baseIntervalMinutes: BASE })).toBe(60);
    expect(snapshotIntervalMinutes({ ageHours: 8, windowHours: 48, baseIntervalMinutes: BASE })).toBe(360);
  });

  it("keeps a dense phase even for a very short rule", () => {
    // Six hours divided by seven is under an hour, and a rule that tight is the
    // one that can least afford to be sampled coarsely.
    expect(densePhaseHours(6)).toBe(1);
  });

  it("caps the dense phase so a long rule cannot demand days of hourly reads", () => {
    // A 30-day window: a seventh of it is over four days, and 100 hourly
    // readings is not four times the information of 24.
    expect(densePhaseHours(720)).toBe(24);
  });
});

describe("the three phases", () => {
  const inWeek = (ageHours: number) =>
    snapshotIntervalMinutes({ ageHours, windowHours: WEEK, baseIntervalMinutes: BASE });

  it("samples four times a day for the rest of the window", () => {
    expect(snapshotPhase({ ageHours: 100, windowHours: WEEK, baseIntervalMinutes: BASE })).toBe(
      "in-window",
    );
    expect(inWeek(24)).toBe(360);
    expect(inWeek(167)).toBe(360);
  });

  it("drops to daily the moment the window shuts", () => {
    // The verdict is frozen from here on, so anything more is storage spent on
    // a question that has already been answered.
    expect(snapshotPhase({ ageHours: 168, windowHours: WEEK, baseIntervalMinutes: BASE })).toBe(
      "after-window",
    );
    expect(inWeek(168)).toBe(1_440);
    expect(inWeek(9_000)).toBe(1_440);
  });

  it("leaves a video with no window on the organization's own interval", () => {
    // Long-form, and Shorts on a channel filed under no configured niche.
    // Nothing about the old behaviour changes for them.
    expect(
      snapshotIntervalMinutes({ ageHours: 2, windowHours: null, baseIntervalMinutes: BASE }),
    ).toBe(BASE);
    expect(
      snapshotIntervalMinutes({ ageHours: 5_000, windowHours: null, baseIntervalMinutes: BASE }),
    ).toBe(BASE);
  });
});

describe("the organization's setting still means something", () => {
  it("respects a team that has chosen to sample more often than this asks", () => {
    // 15-minute sampling is a deliberate, paid-for choice. This function exists
    // to stop the back catalogue wasting rows, not to slow anybody down.
    expect(
      snapshotIntervalMinutes({ ageHours: 2, windowHours: WEEK, baseIntervalMinutes: 15 }),
    ).toBe(15);
    expect(
      snapshotIntervalMinutes({ ageHours: 100, windowHours: WEEK, baseIntervalMinutes: 15 }),
    ).toBe(15);
  });

  it("treats the setting as a floor once the window has shut", () => {
    // The one phase where the organization's number wins by being the SLOWER of
    // the two: a team asking for weekly readings on a settled Short gets them.
    expect(
      snapshotIntervalMinutes({ ageHours: 500, windowHours: WEEK, baseIntervalMinutes: 10_080 }),
    ).toBe(10_080);
  });
});

describe("what it costs", () => {
  /**
   * Rows per Short per window at the ceiling, ignoring the `changed` guard that
   * drops identical readings — so this is the worst case, not the expectation.
   */
  function rowsInsideWindow(windowHours: number, baseIntervalMinutes = BASE): number {
    let rows = 0;
    let ageHours = 0;
    while (ageHours < windowHours) {
      rows += 1;
      ageHours += snapshotIntervalMinutes({ ageHours, windowHours, baseIntervalMinutes }) / 60;
    }
    return rows;
  }

  it("costs at most 48 rows per Short inside a seven-day window", () => {
    // 24 hourly in the opening day, 24 more at six-hourly across the remaining
    // six. The number is worth pinning: it is the answer to "what does this
    // change do to the snapshot table", and a future edit that doubles it
    // should have to say so here first.
    expect(rowsInsideWindow(WEEK)).toBe(48);
  });

  it("stays proportionate on a tighter window", () => {
    // 7 hourly, then 41 hours at six-hourly.
    expect(rowsInsideWindow(48)).toBe(14);
  });

  it("costs less than the old flat cadence for anything past its window", () => {
    // The trade in one line: denser while it matters, four times cheaper
    // afterwards. A Short past about a fortnight is cheaper than it was.
    const oldFlatRowsPerDay = (24 * 60) / BASE;
    const newRowsPerDay =
      (24 * 60) /
      snapshotIntervalMinutes({ ageHours: 800, windowHours: WEEK, baseIntervalMinutes: BASE });

    expect(oldFlatRowsPerDay).toBe(4);
    expect(newRowsPerDay).toBe(1);
  });
});

describe("isInsideWindow", () => {
  const published = Date.UTC(2026, 0, 1);
  const hour = 3_600_000;

  it("is open right up to the close and shut at it", () => {
    expect(isInsideWindow(published, WEEK, published + 167 * hour)).toBe(true);
    expect(isInsideWindow(published, WEEK, published + 168 * hour)).toBe(false);
  });

  it("is never open without a window", () => {
    expect(isInsideWindow(published, null, published)).toBe(false);
    expect(isInsideWindow(published, 0, published)).toBe(false);
  });
});
