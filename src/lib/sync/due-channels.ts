/**
 * Who the hourly sweep visits, and in what order.
 *
 * Pure, and beside `sweep-budget.ts` for the same reason that one is: the
 * per-run cap makes this an allocation, not a preference. Twenty-five slots
 * an hour are handed out by these two functions, so "who is starved" is
 * decided here and nowhere else — and it is exactly the kind of rule that can
 * only be checked by constructing the awkward cases, which needs no database
 * and no clock.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE BUG THIS SHAPE EXISTS TO PREVENT
 * ─────────────────────────────────────────────────────────────────────────
 * Both answers used to be measured from `lastFetchedAt`, the last SUCCESSFUL
 * read. The sync's failure path deliberately does not advance that column —
 * it feeds the freshness notice, which must never claim data nobody could
 * fetch — so a channel that failed stayed null. Null means "never fetched",
 * which is the most urgent state there is, so it sorted first. Every hour.
 * Forever.
 *
 * With the cap at 25, twenty-five permanently failing channels meant no other
 * channel was ever synced again and the dashboard silently froze on whatever
 * it held the hour the failures started. That is reachable today: a Google
 * connection stuck needing re-authorisation makes every own channel behind it
 * fail at step 0 of the sync, over and over.
 *
 * So both answers are measured from the ATTEMPT instead. `lastFetchedAt`
 * keeps its meaning for display; a channel that was tried and failed goes to
 * the back of the queue like everybody else, and is retried when its turn
 * comes round rather than instead of everybody else's.
 */

/** What either rule needs to know about a channel. Nothing else is read. */
export interface DueCandidate {
  /** Last attempt, successful or not. Null means the sweep has never tried. */
  readonly lastAttemptedAt: Date | null;
  /** At least one video on this channel is still inside its hit window. */
  readonly hasOpenWindow: boolean;
}

/**
 * How often a channel with an open hit window is revisited, in minutes.
 *
 * Tighter than the organization's own interval because those are the only
 * hours in which a reading can prove anything, and `min` rather than a flat
 * value so a team that has chosen to refresh every 15 minutes is not slowed
 * down by this.
 */
export const OPEN_WINDOW_REFRESH_MINUTES = 60;

const MS_PER_MINUTE = 60_000;

/**
 * Whether this channel is due, measured from its last ATTEMPT.
 *
 * A zero interval means "always due", which is what the Settings minimum of 0
 * promises; computing the cutoff from it gives that for free.
 */
export function isChannelDue(
  channel: DueCandidate,
  refreshIntervalMinutes: number,
  nowMs: number,
): boolean {
  const intervalMinutes = channel.hasOpenWindow
    ? Math.min(refreshIntervalMinutes, OPEN_WINDOW_REFRESH_MINUTES)
    : refreshIntervalMinutes;
  const staleBefore = nowMs - intervalMinutes * MS_PER_MINUTE;
  const lastAttemptedAt = channel.lastAttemptedAt;
  return lastAttemptedAt === null || lastAttemptedAt.getTime() < staleBefore;
}

/**
 * Sort comparator: most urgent first.
 *
 *   1. Never ATTEMPTED. The only state where the dashboard shows a channel
 *      with no numbers at all and the sweep has not yet had a turn at it. A
 *      channel that was tried and failed is NOT this state — that distinction
 *      is the whole fix.
 *   2. An open hit window, because that evidence expires. A stale channel
 *      whose videos have all been judged loses nothing by waiting an hour; one
 *      three hours into a 48-hour window loses a reading that can never be
 *      taken again. The only rule here about information rather than fairness.
 *   3. Oldest attempt first.
 */
export function compareByUrgency(a: DueCandidate, b: DueCandidate): number {
  if (a.lastAttemptedAt === null) return b.lastAttemptedAt === null ? 0 : -1;
  if (b.lastAttemptedAt === null) return 1;
  if (a.hasOpenWindow !== b.hasOpenWindow) return a.hasOpenWindow ? -1 : 1;
  return a.lastAttemptedAt.getTime() - b.lastAttemptedAt.getTime();
}
