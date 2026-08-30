import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";

/**
 * =========================================================================
 * WHAT A CONNECTION'S OWN ROW IS ALLOWED TO SAY ABOUT ITSELF
 * =========================================================================
 *
 * WHY THIS IS A MODULE AND NOT A FUNCTION IN ONE OF THE TWO FILES THAT NEED IT
 * `youtube-oauth-service` already imports `channel-sync` (for `upsertChannel`),
 * so `channel-sync` cannot import it back. The recording has to live somewhere
 * both can reach, and it is small enough that a module of its own is cheaper
 * than a cycle or a duplicated write.
 *
 * WHAT IT FIXES
 * "Last sync" on Admin → YouTube was written in exactly one place: a successful
 * revenue report. Any connection without the monetary Analytics scope fails
 * revenue on every run, so it read "Never synced" forever — while the channel
 * behind it had been syncing correctly every hour. That is the precise sentence
 * the field exists to make honest, and it was the one thing it could not say.
 *
 * And the other half: a channel sync that failed for a reason that is NOT the
 * grant — the channel was deleted, the daily quota is gone, a 403 that is not a
 * dead token — wrote nothing to the connection at all. On the connection card it
 * was indistinguishable from a healthy one, and the failure surfaced only on the
 * channel row.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH
 * `status` and `lastError`. Those belong to the TOKEN lifecycle in
 * `youtube-oauth-service` — "Google will not honour these credentials" — and a
 * run that failed because a channel was deleted must not tell an admin to
 * reconnect a perfectly good account. A sync failure gets its own three columns
 * so the two facts stay separable on screen.
 */

/** The status values `YouTubeConnection.channelSyncStatus` may hold. */
export type ChannelSyncStatus = "never" | "ok" | "error";

export interface ChannelSyncOutcome {
  readonly ok: boolean;
  /** The user-facing failure sentence. Ignored when `ok`. */
  readonly error?: string | null;
  readonly at: Date;
}

/**
 * The exact columns an outcome writes — separated from the write so the
 * decision can be tested without a database, and so both callers cannot drift.
 *
 * `lastSyncAt` is set on success because it is the connection's general "last
 * successfully used" marker, which a completed channel sync proves just as well
 * as a completed revenue report does. That is the whole repair: two things spend
 * this grant, and both now say so.
 */
export function channelSyncOutcomeData(
  outcome: ChannelSyncOutcome,
): Prisma.YouTubeConnectionUpdateInput {
  if (outcome.ok) {
    return {
      channelSyncStatus: "ok",
      channelSyncError: null,
      lastChannelSyncAt: outcome.at,
      lastSyncAt: outcome.at,
    };
  }

  return {
    channelSyncStatus: "error",
    // Truncated for the same reason `lastError` is: an upstream message is not a
    // field this app controls the length of.
    channelSyncError: outcome.error ? outcome.error.slice(0, 500) : null,
    // `lastChannelSyncAt` and `lastSyncAt` are NOT touched on failure. They mean
    // "last time this worked", and a failed run does not move that — overwriting
    // it would erase the only evidence of how long a connection has been broken.
  };
}

/**
 * Record how a channel/video sync through this connection went.
 *
 * Never throws. This is bookkeeping attached to a sync that has already
 * finished; a failure to write the note must not turn a successful refresh into
 * a failed one, and must not unwind a scheduled sweep over twenty channels.
 */
export async function recordConnectionChannelSync(
  connectionId: string,
  outcome: ChannelSyncOutcome,
): Promise<void> {
  await prisma.youTubeConnection
    .update({
      where: { id: connectionId },
      data: channelSyncOutcomeData(outcome),
      // Returning the full row here would materialise `accessTokenEnc` and
      // `refreshTokenEnc` into memory for a value nobody reads.
      select: { id: true },
    })
    .catch(() => undefined);
}
