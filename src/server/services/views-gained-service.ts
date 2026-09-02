import "server-only";

import { prisma } from "@/server/db";
import { isVideoOfFormat, type NicheFormat } from "@/lib/niches/niche-format";

/**
 * =========================================================================
 * VIEWS GAINED IN A WINDOW — THE ONE HONEST SOURCE, IN ONE PLACE
 * =========================================================================
 *
 * `Channel.viewCount` and `Video.viewCount` are lifetime totals overwritten on
 * every sync, so neither can say what a period earned; `ChannelRevenueDay`
 * carries no view metric. `VideoSnapshot` is the only append-only series, and
 * the delta between two of its readings is the only number that means "views
 * gained between these instants". Automatic refresh has been writing that
 * series since it was switched on, so the delta is computable wherever the
 * history reaches — and refused, video by video, wherever it does not.
 *
 * This module grew out of `niche-rpm-service.ts`, where the delta fed one
 * caller: the denominator of a derived RPM. The niche money figures now price
 * views gained too, so the measurement lives here and both callers consume
 * it. The RULES ARE SHARED AND MUST NOT FORK — a video with no reading at the
 * window's start is dropped from both sides, a video born inside the window
 * starts from a true zero, a negative delta is real — because two versions of
 * "views gained" that disagree by one rule would put two different numbers on
 * two screens describing the same period.
 *
 * WHAT DIFFERS PER CALLER IS DECLARED, NOT COPIED:
 *
 *   • FORMAT. The RPM caller is deliberately channel-wide — its numerator is
 *     what the whole channel earned, long-form and Premium included, so a
 *     filtered denominator would inflate the rate by every long-form dollar.
 *     The niche money caller prices one format's niche, so it passes the
 *     niche's format and only that format's videos are measured. The filter
 *     is `isVideoOfFormat`: an uncertain video is in NEITHER format, the same
 *     conservative asymmetry every other format surface pins.
 *
 *   • THE EMPTY CHANNEL. A channel none of whose videos could be bracketed
 *     STAYS IN THE MAP here, with `coveredVideos: 0`, because "we measured
 *     nothing" is a fact the niche caller must count toward its coverage
 *     denominator. The RPM adapter re-applies its own omit rule — absence
 *     becomes `viewsGained: null` becomes `no_view_history` — at its own
 *     boundary, where that meaning belongs.
 */

const DAY_MS = 86_400_000;

/**
 * How far before the window's start a view reading may be and still bracket it.
 *
 * A video's views at the window's start come from the last snapshot taken at or
 * before that instant. Searching backwards without limit would mean loading a
 * channel's entire snapshot history to answer a question about one month, so
 * the search is bounded — and a video whose most recent reading is older than
 * this is treated as UNCOVERED rather than as having stood still.
 *
 * The bound is deliberately far wider than any sync cadence the app offers, so
 * it only ever excludes a video the collector has genuinely stopped seeing. The
 * cost of being wrong is bounded in the safe direction as well: an uncovered
 * video is dropped from the denominator, which the coverage floors downstream
 * then measure and refuse if too much of the library is missing.
 */
export const SNAPSHOT_LOOKBACK_DAYS = 60;

/** The half-open instant window a delta is measured over. */
export interface ViewsGainedWindow {
  readonly startMs: number;
  /** Exclusive. */
  readonly endMs: number;
}

/** One channel's measured delta, with the coverage to judge it by. */
export interface ChannelViewsGained {
  /** Sum of per-video deltas over the covered videos. Negative deltas kept. */
  readonly viewsGained: number;
  /** Videos whose views at BOTH ends of the window are actually known. */
  readonly coveredVideos: number;
  /** Every counted video published before the window's end. */
  readonly totalVideos: number;
}

/**
 * Views gained across the window, per channel, from the snapshot series.
 *
 * A VIDEO WITH NO READING AT THE WINDOW'S START IS DROPPED, NOT ZERO-BASED.
 * Its views at that instant are genuinely unknown, and assuming zero would
 * credit the window with a lifetime of views. Dropping shrinks the measured
 * set, which is why `coveredVideos` and `totalVideos` travel with the sum:
 * every caller that turns this into money holds a coverage floor against them.
 *
 * THE ONE EXCEPTION IS A TRUE ZERO: a video published inside the window
 * started at nothing as a matter of fact, so its reading at the end is its
 * whole delta and it counts as covered.
 *
 * NEGATIVE DELTAS ARE KEPT. Views fall when YouTube purges inflated counts,
 * and clamping every negative to zero would bias the total upward one video
 * at a time.
 */
export async function viewsGainedByChannel(params: {
  readonly organizationId: string;
  readonly channelIds: readonly string[];
  readonly window: ViewsGainedWindow;
  /**
   * Measure only this format's videos. Omitted means channel-wide — the RPM
   * denominator's deliberate choice, documented above. An uncertain video is
   * in neither format and is excluded from BOTH the sum and the totals when a
   * format is named: it is not part of the population being priced, so
   * counting it as an uncovered member would depress coverage with videos the
   * figure never claimed to include.
   */
  readonly format?: NicheFormat;
}): Promise<ReadonlyMap<string, ChannelViewsGained>> {
  const { organizationId, channelIds, window, format } = params;
  const endDate = new Date(window.endMs);
  const lookbackFrom = new Date(window.startMs - SNAPSHOT_LOOKBACK_DAYS * DAY_MS);

  const videos = await prisma.video.findMany({
    where: {
      channelId: { in: [...channelIds] },
      publishedAt: { lt: endDate },
      // Reachability through this organization's own tracker. `Video` and
      // `VideoSnapshot` are global deduplicated rows with no tenant column, so
      // this is the only thing that makes the history ours to read.
      channel: { trackedBy: { some: { organizationId, isActive: true } } },
    },
    select: {
      id: true,
      channelId: true,
      publishedAt: true,
      // Both format columns, because the two formats are decided from
      // different columns — `isVideoOfFormat` is the one home of that rule.
      isShort: true,
      classification: true,
      snapshots: {
        where: { capturedAt: { gte: lookbackFrom, lt: endDate } },
        select: { capturedAt: true, viewCount: true },
        orderBy: { capturedAt: "asc" },
      },
    },
  });

  const totals = new Map<string, { gained: number; covered: number; total: number }>();
  // Seeded for every asked-about channel, so a channel with no videos at all
  // answers `{ 0, 0, 0 }` rather than vanishing — "nothing to measure" is an
  // answer the coverage arithmetic downstream has to be able to count.
  for (const channelId of channelIds) {
    totals.set(channelId, { gained: 0, covered: 0, total: 0 });
  }

  for (const video of videos) {
    // In memory rather than in the query: the shorts side of the `where`
    // would be easy, but longform must be `classification == "not_short"` and
    // NEVER `isShort: false` — routing every caller through the one predicate
    // is what keeps the uncertain population out of both formats.
    if (format !== undefined && !isVideoOfFormat(video, format)) continue;

    const bucket = totals.get(video.channelId);
    if (!bucket) continue;
    bucket.total += 1;

    // Views at the window's close: the last reading taken before it. The
    // current lifetime total is NOT a substitute — it is today's number, and
    // using it would credit the window with everything earned since.
    const atEnd = lastAtOrBefore(video.snapshots, window.endMs);

    if (atEnd !== null) {
      if (video.publishedAt !== null && video.publishedAt.getTime() >= window.startMs) {
        // Published inside the window, so it started at nothing. This is the
        // one case where a zero baseline is a fact rather than an assumption.
        bucket.gained += atEnd;
        bucket.covered += 1;
      } else {
        const atStart = lastAtOrBefore(video.snapshots, window.startMs);
        if (atStart !== null) {
          // Views can fall when YouTube purges inflated counts, and a negative
          // delta is real. It is kept rather than clamped: clamping every
          // negative to zero would bias the total upward, one video at a time.
          bucket.gained += atEnd - atStart;
          bucket.covered += 1;
        }
      }
    }
  }

  const map = new Map<string, ChannelViewsGained>();
  for (const [channelId, bucket] of totals) {
    map.set(channelId, {
      viewsGained: bucket.gained,
      coveredVideos: bucket.covered,
      totalVideos: bucket.total,
    });
  }
  return map;
}

/** The last reading at or before an instant, in views, or null when there is none. */
function lastAtOrBefore(
  snapshots: readonly { capturedAt: Date; viewCount: bigint }[],
  atMs: number,
): number | null {
  let best: { capturedAt: Date; viewCount: bigint } | null = null;
  for (const snapshot of snapshots) {
    const capturedMs = snapshot.capturedAt.getTime();
    if (capturedMs > atMs) continue;
    if (best === null || capturedMs > best.capturedAt.getTime()) best = snapshot;
  }
  return best === null ? null : Number(best.viewCount);
}
