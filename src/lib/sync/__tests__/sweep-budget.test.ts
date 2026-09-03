import { describe, expect, it } from "vitest";
import { SWEEP_TIME_BUDGET_MS, shouldDeferForTime } from "../sweep-budget";

/**
 * The rule that turns a platform kill into a clean stop.
 *
 * Pinned as values because the two ways to get it wrong are both quiet: a rule
 * that can defer index 0 makes a slow cold start sync nothing every hour, and a
 * rule that uses `>` instead of `>=` lets a channel start at the exact deadline
 * — which is the case a test with budget 0 exercises directly.
 */
describe("the sweep's time budget", () => {
  it("always lets the first channel run, however late it is", () => {
    expect(shouldDeferForTime(0, 0, 0)).toBe(false);
    expect(shouldDeferForTime(0, SWEEP_TIME_BUDGET_MS * 10, SWEEP_TIME_BUDGET_MS)).toBe(false);
  });

  it("defers every later channel once the budget is reached", () => {
    expect(shouldDeferForTime(1, SWEEP_TIME_BUDGET_MS, SWEEP_TIME_BUDGET_MS)).toBe(true);
    expect(shouldDeferForTime(7, SWEEP_TIME_BUDGET_MS + 1, SWEEP_TIME_BUDGET_MS)).toBe(true);
    // Budget zero: first runs, second is deferred — the deterministic shape a
    // sweep test can rely on without a clock.
    expect(shouldDeferForTime(1, 0, 0)).toBe(true);
  });

  it("keeps starting channels while there is budget left", () => {
    expect(shouldDeferForTime(1, SWEEP_TIME_BUDGET_MS - 1, SWEEP_TIME_BUDGET_MS)).toBe(false);
    expect(shouldDeferForTime(24, 1_000, SWEEP_TIME_BUDGET_MS)).toBe(false);
  });

  /**
   * The budget must sit inside the route's ceiling with room for the channel
   * in flight and the post-loop steps. 300s is `maxDuration` on
   * /api/cron/sync; pinning the relationship stops a future "bump the budget"
   * from quietly recreating the kill it exists to prevent.
   */
  it("leaves at least a minute of the 300-second ceiling for finishing up", () => {
    expect(SWEEP_TIME_BUDGET_MS).toBeLessThanOrEqual(300_000 - 60_000);
    expect(SWEEP_TIME_BUDGET_MS).toBeGreaterThan(0);
  });
});
