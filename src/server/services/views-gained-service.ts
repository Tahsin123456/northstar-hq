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
 *   • THE BASELINE GRACE. A video whose own view history starts a little way
 *     into the window is measured from its own first reading rather than
 *     dropped — see `BASELINE_GRACE_FRACTION` for the failure this exists to
 *     stop. The niche money caller opts in; the RPM denominator does NOT and
 *     must not, because there a short baseline inflates a rate instead of
 *     understating a total.
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

/**
 * How far into the window a video's own first reading may sit and still serve
 * as its baseline, as a fraction of the measured span.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS — THE 1 SEPTEMBER BLACKOUT, AND WHY "IT SELF-HEALS" WAS WRONG
 * ---------------------------------------------------------------------------
 * First-ever snapshots are NOT written at one instant. The scheduled sweep
 * takes at most `SYNC_MAX_CHANNELS_PER_RUN` channels an hour and walks them
 * sequentially, so the first capture of channel 1 and the first capture of
 * channel 10 are minutes-to-hours apart — 49 minutes apart across ten channels
 * in the local database, and further apart the more channels an org tracks.
 *
 * The niche caller measures from `max(requestedStart, earliest snapshot in the
 * org)`. Whenever the requested period reaches back past the history — every
 * 30- and 90-day period between now and December — that resolves to THE ONE
 * INSTANT AT WHICH COVERAGE IS MINIMISED: the only videos holding a reading
 * at-or-before it are the ones in whichever channel happened to be swept first.
 * Every other video was dropped from both the sum and the covered count, so
 * coverage came out at 6% against a 0.9 floor and every niche rendered "Not
 * enough view history yet" while an owner had RPM ranges entered.
 *
 * It is not a launch artifact, either. The identical trap re-fires for a full
 * period EVERY TIME A CHANNEL IS ADDED to the tracker: its videos hold no
 * reading before `now − 30d` for the next thirty days, so they are all dropped
 * and all counted in the total, and one new channel holding a third of a
 * niche's library blacks that niche's money figure out for a month.
 *
 * So a video whose own history starts a little INSIDE the window is measured
 * from its own first reading instead of being thrown away. "A little" is this
 * fraction of the span — 36 hours out of 30 days, 8.4 hours out of 7 — which is
 * far wider than any sweep spread and far narrower than a newly-added channel's
 * missing weeks. That is what keeps the coverage floor meaningful: a video whose
 * history starts three weeks into a thirty-day window is still dropped, because
 * calling its last nine days a thirty-day gain is a distortion, not a rounding.
 *
 * DO NOT REPLACE THIS WITH A LATER ORG-WIDE MINIMUM. Moving the one shared
 * start forward to a percentile of first-snapshot times looks equivalent and is
 * not: a single newly-onboarded channel holding a tenth of the library would
 * then collapse the measured span for the WHOLE organization from thirty days
 * to hours, silently, under a label that stayed technically true.
 */
export const BASELINE_GRACE_FRACTION = 0.05;

/** The grace an `[startMs, endMs)` span earns under `BASELINE_GRACE_FRACTION`. */
export function baselineGraceMsFor(startMs: number, endMs: number): number {
  return Math.max(0, Math.round((endMs - startMs) * BASELINE_GRACE_FRACTION));
}

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
  /**
   * The worst baseline actually used, as milliseconds after `window.startMs`.
   *
   * 0 — and always 0 without `baselineGraceMs` — means every covered video was
   * measured from a reading at or before the window's start, so the sum covers
   * the whole span for every video in it. Above 0 it is the exact size of the
   * head of the span that the raggedest video is missing, which is what lets
   * the label state a TRUE bound rather than the cap's worst case. The figure
   * is understated by at most this much of one video's history and never
   * overstated: a later baseline can only subtract views that were already
   * there.
   */
  readonly maxBaselineLagMs: number;
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
  /**
   * Admit a video whose own history starts up to this far INSIDE the window,
   * measured from that first reading of its own. Omitted — the default, and
   * what the derived-RPM caller passes — drops it exactly as before.
   *
   * OPT-IN, AND THE RPM DENOMINATOR MUST NEVER OPT IN. See
   * `BASELINE_GRACE_FRACTION` for why the niche money figures need this. The
   * asymmetry that keeps it off the other caller: in the niche figures a short
   * baseline UNDERSTATES money, which is the safe direction, while the derived
   * rate is `revenue / viewsGained`, so a denominator short by a tenth raises
   * the rate by an ninth — and that rate then multiplies EVERY niche's views
   * into money. There, refusing with `no_view_history` until the history
   * genuinely brackets the window, and falling through to the owner's
   * hand-entered range, is the honest answer.
   */
  readonly baselineGraceMs?: number;
}): Promise<ReadonlyMap<string, ChannelViewsGained>> {
  const { organizationId, channelIds, window, format } = params;
  const baselineGraceMs = Math.max(0, params.baselineGraceMs ?? 0);
  const graceLimitMs = window.startMs + baselineGraceMs;
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

  const totals = new Map<
    string,
    { gained: number; covered: number; total: number; lagMs: number }
  >();
  // Seeded for every asked-about channel, so a channel with no videos at all
  // answers `{ 0, 0, 0 }` rather than vanishing — "nothing to measure" is an
  // answer the coverage arithmetic downstream has to be able to count.
  for (const channelId of channelIds) {
    totals.set(channelId, { gained: 0, covered: 0, total: 0, lagMs: 0 });
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
    if (atEnd === null) continue;

    if (video.publishedAt !== null && video.publishedAt.getTime() >= window.startMs) {
      // Published inside the window, so it started at nothing. This is the
      // one case where a zero baseline is a fact rather than an assumption.
      // It carries no lag: publication IS the baseline instant, exactly.
      bucket.gained += atEnd.views;
      bucket.covered += 1;
      continue;
    }

    const atStart = lastAtOrBefore(video.snapshots, window.startMs);
    if (atStart !== null) {
      // Views can fall when YouTube purges inflated counts, and a negative
      // delta is real. It is kept rather than clamped: clamping every
      // negative to zero would bias the total upward, one video at a time.
      bucket.gained += atEnd.views - atStart.views;
      bucket.covered += 1;
      continue;
    }

    /*
     * NO READING AT THE WINDOW'S START — the case that blacked out every niche.
     *
     * Its views at that instant are still genuinely unknown, so it is still
     * never zero-based; what changes is that its OWN first reading may stand in
     * as the baseline when that reading sits within the grace. The gain then
     * covers a slightly shorter span than the window, which UNDERSTATES it —
     * views the video already held at that first reading are subtracted out,
     * and a reading can only be larger than an earlier one absent a purge — and
     * `maxBaselineLagMs` carries exactly how short so the label can say so.
     * Dropping it instead loses 100% of that video's gains AND, through
     * `coveredVideos`, decides the own/competitor split by sweep order.
     *
     * TWO READINGS ARE REQUIRED, not one. A video whose only reading in the
     * window is its baseline has no delta to measure at all; counting it as
     * covered at zero gain would inflate coverage with a video nothing was
     * measured from and hide it behind the very floor meant to catch it.
     */
    if (baselineGraceMs === 0) continue;
    const effective = firstInRange(video.snapshots, window.startMs, graceLimitMs);
    if (effective === null || effective.capturedMs >= atEnd.capturedMs) continue;

    bucket.gained += atEnd.views - effective.views;
    bucket.covered += 1;
    const lagMs = effective.capturedMs - window.startMs;
    if (lagMs > bucket.lagMs) bucket.lagMs = lagMs;
  }

  const map = new Map<string, ChannelViewsGained>();
  for (const [channelId, bucket] of totals) {
    map.set(channelId, {
      viewsGained: bucket.gained,
      coveredVideos: bucket.covered,
      totalVideos: bucket.total,
      maxBaselineLagMs: bucket.lagMs,
    });
  }
  return map;
}

interface Reading {
  readonly capturedMs: number;
  readonly views: number;
}

/** The last reading at or before an instant, or null when there is none. */
function lastAtOrBefore(
  snapshots: readonly { capturedAt: Date; viewCount: bigint }[],
  atMs: number,
): Reading | null {
  let best: Reading | null = null;
  for (const snapshot of snapshots) {
    const capturedMs = snapshot.capturedAt.getTime();
    if (capturedMs > atMs) continue;
    if (best === null || capturedMs > best.capturedMs) {
      best = { capturedMs, views: Number(snapshot.viewCount) };
    }
  }
  return best;
}

/**
 * The EARLIEST reading in `[fromMs, toMs]`, or null when there is none.
 *
 * Scanned rather than read off the head of the array: the rows arrive ordered,
 * but a measurement this feeds money must not be one `orderBy` edit away from
 * baselining a video on whichever reading happened to be listed first.
 */
function firstInRange(
  snapshots: readonly { capturedAt: Date; viewCount: bigint }[],
  fromMs: number,
  toMs: number,
): Reading | null {
  let best: Reading | null = null;
  for (const snapshot of snapshots) {
    const capturedMs = snapshot.capturedAt.getTime();
    if (capturedMs < fromMs || capturedMs > toMs) continue;
    if (best === null || capturedMs < best.capturedMs) {
      best = { capturedMs, views: Number(snapshot.viewCount) };
    }
  }
  return best;
}
