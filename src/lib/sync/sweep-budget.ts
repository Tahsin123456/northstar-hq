/**
 * The scheduled sweep's time budget: stop STARTING channels before the platform
 * kills the run.
 *
 * WHY THIS EXISTS. The cron route declares `maxDuration = 300`, and Vercel
 * enforces it by killing the function mid-flight. The sweep is sequential and
 * a large channel can take tens of seconds, so a busy hour reaches the limit
 * with channels still queued — observed on 2026-08-31 and again on 2026-09-03,
 * as `Task timed out after 300 seconds` on /api/cron/sync.
 *
 * A kill is not the same as stopping. Three things are lost when the platform
 * pulls the plug: the channel in flight is left half-synced (its refresh-run
 * row stays "running", its snapshots for that pass may be partial); the hit
 * evaluation and revenue steps, which deliberately run AFTER the loop, never
 * run at all that hour; and the summary is never written, so the admin surface
 * cannot say what happened. The channels that were reached keep their work —
 * every write is per channel and there is no outer transaction — and the
 * stalest-first ordering means the unreached tail goes first next hour, so
 * nothing starves. But the tail's readings arrive an hour late, and on the day
 * the channel-view readings started that is the difference between a niche
 * showing money and showing "Measuring".
 *
 * So the loop checks, before starting each channel, whether enough of the
 * budget remains to plausibly finish one more and still run the steps after
 * the loop. If not, it stops cleanly, counts what it deferred, and returns a
 * summary — the same rotation as a kill, without the collateral.
 *
 * THE FIRST CHANNEL ALWAYS RUNS. A budget that could defer index 0 would turn
 * a slow cold start into a sweep that syncs nothing, every hour, forever; the
 * whole point is progress, and one channel is progress.
 */

/**
 * How much of the route's 300-second ceiling the loop may spend starting
 * channels. The remainder is reserved for the channel already in flight (a big
 * one can run ~60s), the hit-evaluation and revenue steps, and writing the
 * summary. 210s leaves 90s for all of that, which the longest observed
 * post-loop work fits inside with room.
 */
export const SWEEP_TIME_BUDGET_MS = 210_000;

/**
 * Whether to defer the channel at `index` rather than start it.
 *
 * Pure so the rule is testable without a database or a clock: the caller
 * measures elapsed time, this decides. `index > 0` is the always-run-one rule
 * above; `>=` rather than `>` so a budget of exactly zero still lets the first
 * channel through and defers everything after it.
 */
export function shouldDeferForTime(index: number, elapsedMs: number, budgetMs: number): boolean {
  return index > 0 && elapsedMs >= budgetMs;
}
