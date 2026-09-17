import { describe, expect, it } from "vitest";
import {
  OPEN_WINDOW_REFRESH_MINUTES,
  compareByUrgency,
  isChannelDue,
  type DueCandidate,
} from "../due-channels";

/**
 * =========================================================================
 * WHO THE SWEEP VISITS, AND WHO IT STARVES
 * =========================================================================
 *
 * The hourly run has a hard per-run cap (25 channels by default), so these
 * two rules are an allocation rather than a preference: every slot one
 * channel takes is a slot another does not get.
 *
 * THE BUG. Both rules used to read `lastFetchedAt`, the last SUCCESSFUL read.
 * The sync's failure path deliberately does not advance that column, because
 * the freshness notice reads it and must never claim data nobody could fetch.
 * So a channel that failed stayed null — and null means "never fetched",
 * which sorts first as the most urgent state there is. Every hour. Forever.
 * Twenty-five such channels and no healthy channel is ever synced again.
 *
 * That is not hypothetical: a Google connection stuck needing
 * re-authorisation makes every own channel behind it fail at step 0 of the
 * sync, repeatedly.
 *
 * Both rules now read the ATTEMPT instead, and the cases below are written
 * around the distinction that fix turns on — tried-and-failed is not the same
 * state as never-tried.
 */

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 8, 17, 12, 0, 0);

function channel(overrides: Partial<DueCandidate> = {}): DueCandidate {
  return { lastAttemptedAt: new Date(NOW), hasOpenWindow: false, ...overrides };
}

describe("isChannelDue", () => {
  it("is due when the sweep has never attempted it", () => {
    expect(isChannelDue(channel({ lastAttemptedAt: null }), 360, NOW)).toBe(true);
  });

  it("is not due again until the interval has passed", () => {
    const attempted = new Date(NOW - 359 * MINUTE);
    expect(isChannelDue(channel({ lastAttemptedAt: attempted }), 360, NOW)).toBe(false);
    expect(isChannelDue(channel({ lastAttemptedAt: new Date(NOW - 361 * MINUTE) }), 360, NOW)).toBe(
      true,
    );
  });

  /**
   * THE FIX, AS A PROPERTY. A channel that was tried an instant ago is not
   * due, whether that attempt succeeded or failed — because the caller stamps
   * the attempt either way. Under the old rule a failing channel carried a
   * null here forever and was due on every single run.
   */
  it("treats a failed attempt as an attempt", () => {
    const justTried = channel({ lastAttemptedAt: new Date(NOW - MINUTE) });
    expect(isChannelDue(justTried, 360, NOW)).toBe(false);
  });

  it("holds a channel with an open window to the tighter interval", () => {
    const attempted = new Date(NOW - (OPEN_WINDOW_REFRESH_MINUTES + 1) * MINUTE);
    // Same row, same clock: due only because a window is open.
    expect(isChannelDue({ lastAttemptedAt: attempted, hasOpenWindow: true }, 360, NOW)).toBe(true);
    expect(isChannelDue({ lastAttemptedAt: attempted, hasOpenWindow: false }, 360, NOW)).toBe(
      false,
    );
  });

  it("never slows a team that refreshes faster than the open-window interval", () => {
    // `min`, not a flat 60: a 15-minute interval stays 15 minutes.
    const attempted = new Date(NOW - 16 * MINUTE);
    expect(isChannelDue({ lastAttemptedAt: attempted, hasOpenWindow: true }, 15, NOW)).toBe(true);
  });

  it("makes a zero interval mean always due, which is what Settings promises", () => {
    // Any attempt in the past qualifies. The comparison is strictly-less-than,
    // so an attempt stamped at this exact millisecond does not — an edge the
    // clock cannot actually produce between two runs, and unchanged from the
    // rule this replaced.
    expect(isChannelDue(channel({ lastAttemptedAt: new Date(NOW - 1) }), 0, NOW)).toBe(true);
  });
});

describe("compareByUrgency", () => {
  const sorted = (channels: readonly DueCandidate[]) => [...channels].sort(compareByUrgency);

  it("puts a never-attempted channel first", () => {
    const fresh = channel({ lastAttemptedAt: null });
    const old = channel({ lastAttemptedAt: new Date(NOW - 10_000 * MINUTE) });
    expect(sorted([old, fresh])[0]).toBe(fresh);
  });

  /**
   * THE STARVATION CASE, spelled out. The failing channel was attempted a
   * moment ago and the healthy one hours back, so the healthy one goes first
   * and the batch is not consumed by rows that cannot be read. Under the old
   * rule the failing channel's `lastFetchedAt` was null and it won every time.
   */
  it("does not let a channel that keeps failing hold the head of the queue", () => {
    const failingJustTried = channel({ lastAttemptedAt: new Date(NOW - MINUTE) });
    const healthyStale = channel({ lastAttemptedAt: new Date(NOW - 600 * MINUTE) });

    expect(sorted([failingJustTried, healthyStale])[0]).toBe(healthyStale);
  });

  it("keeps twenty-five failing channels from starving a healthy one at the cap", () => {
    // The shape of the real incident: a connection dies, every own channel
    // behind it fails, and the cap is 25.
    const failing = Array.from({ length: 25 }, () =>
      channel({ lastAttemptedAt: new Date(NOW - MINUTE) }),
    );
    const healthy = channel({ lastAttemptedAt: new Date(NOW - 600 * MINUTE) });

    const batch = sorted([...failing, healthy]).slice(0, 25);
    expect(batch).toContain(healthy);
    expect(batch[0]).toBe(healthy);
  });

  it("prefers an open window over mere staleness, because that evidence expires", () => {
    const openButRecent = { lastAttemptedAt: new Date(NOW - 100 * MINUTE), hasOpenWindow: true };
    const closedAndOlder = { lastAttemptedAt: new Date(NOW - 900 * MINUTE), hasOpenWindow: false };
    expect(sorted([closedAndOlder, openButRecent])[0]).toBe(openButRecent);
  });

  it("falls back to oldest attempt first", () => {
    const older = channel({ lastAttemptedAt: new Date(NOW - 900 * MINUTE) });
    const newer = channel({ lastAttemptedAt: new Date(NOW - 100 * MINUTE) });
    expect(sorted([newer, older])).toEqual([older, newer]);
  });
});
