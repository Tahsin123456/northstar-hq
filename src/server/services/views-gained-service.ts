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
 *
 * WHAT IS SHARED AND NOT OPTIONAL is `Video.statsFetchedAt` as a reading —
 * see `observedReading`. It is not a per-caller choice because it is not a
 * policy: it is a view count YouTube actually returned at a known instant, and
 * a measurement that ignores a reading it holds is not being conservative, it
 * is discarding evidence.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

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
 * in the local database, and a full hour further apart for every additional 25
 * channels an org tracks, because that is one more hourly batch.
 *
 * The niche caller measures from `max(requestedStart, earliest snapshot among
 * the videos being priced)`. Whenever the requested period reaches back past
 * the history — every 30- and 90-day period between now and December — that
 * resolves to THE ONE INSTANT AT WHICH COVERAGE IS MINIMISED: the only videos
 * holding a reading at-or-before it are the ones in whichever channel happened
 * to be swept first. Every other video was dropped from both the sum and the
 * covered count, so coverage came out at 6% against a 0.9 floor and every niche
 * rendered "Not enough view history yet" while an owner had RPM ranges entered.
 *
 * It is not a launch artifact, either. The identical trap re-fires for a full
 * period EVERY TIME A CHANNEL IS ADDED to the tracker: its videos hold no
 * reading before `now − 30d` for the next thirty days, so they are all dropped
 * and all counted in the total, and one new channel holding a third of a
 * niche's library blacks that niche's money figure out for a month.
 *
 * So a video whose own history starts a little INSIDE the window is measured
 * from its own first reading instead of being thrown away.
 *
 * ---------------------------------------------------------------------------
 * WHY "A LITTLE" IS A FRACTION *AND* A FLOOR, AND WHAT THE FRACTION ALONE COST
 * ---------------------------------------------------------------------------
 * The fraction alone was wrong on the exact day this fix exists to rescue. The
 * sweep's spread is an ABSOLUTE quantity — an hour per 25 channels, whatever
 * the period on the selector — while a fraction of the span is smallest
 * precisely when the history is youngest and the spread is proportionally
 * largest. At 5% of the span, the rescue only fired when the sweep spread was
 * under a twentieth of the elapsed history: on 2 September, with history from
 * the 1st, that is 108 minutes of allowance against a spread that is already
 * an hour at 25 channels and three hours at 60. Simulated at 60 channels the
 * page still read "Not enough view history yet" on both the 7- and 30-day
 * periods — the fix had not fixed the day it was written for.
 *
 * So the allowance is `clamp(span × FRACTION, FLOOR, span × MAX_FRACTION)`:
 *
 *   • the FLOOR is sized to the collector, not to the period. Six hours covers
 *     a sweep of 150 channels, which is the spread that matters on day two.
 *   • the FRACTION governs once the span is long enough for it to dominate —
 *     36 hours out of 30 days, 8.4 out of 7 — which is what keeps a newly
 *     added channel's missing WEEKS outside the grace on a long period.
 *   • the MAX_FRACTION stops the floor from swallowing a very short span: a
 *     six-hour allowance on an eight-hour window would mean baselining videos
 *     three-quarters of the way through it and calling that the period.
 *
 * That is what keeps the coverage floor meaningful: a video whose history
 * starts three weeks into a thirty-day window is still dropped, because calling
 * its last nine days a thirty-day gain is a distortion, not a rounding.
 *
 * DO NOT REPLACE THIS WITH A LATER ORG-WIDE MINIMUM. Moving the one shared
 * start forward to a percentile of first-snapshot times looks equivalent and is
 * not: a single newly-onboarded channel holding a tenth of the library would
 * then collapse the measured span for the WHOLE organization from thirty days
 * to hours, silently, under a label that stayed technically true.
 */
export const BASELINE_GRACE_FRACTION = 0.05;

/**
 * The smallest grace any span earns, sized to the SWEEP rather than the period.
 *
 * Six hours is nine hourly batches of 25 channels — 150 channels' worth of
 * first-ever captures — so the day-two rescue no longer depends on the org
 * being small. See `BASELINE_GRACE_FRACTION` for the failure this floor kills.
 */
export const BASELINE_GRACE_FLOOR_MS = 6 * HOUR_MS;

/**
 * The hard cap on the grace, as a fraction of the span.
 *
 * The floor may never take more than a quarter of the window: past that, "a
 * video whose history starts a little inside the window" stops being true and
 * the label's bound stops being a caveat and starts being the figure.
 */
export const BASELINE_GRACE_MAX_FRACTION = 0.25;

/** The grace an `[startMs, endMs)` span earns. See the constants above. */
export function baselineGraceMsFor(startMs: number, endMs: number): number {
  const spanMs = Math.max(0, endMs - startMs);
  return Math.round(
    Math.min(
      spanMs * BASELINE_GRACE_MAX_FRACTION,
      Math.max(spanMs * BASELINE_GRACE_FRACTION, BASELINE_GRACE_FLOOR_MS),
    ),
  );
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
   * 0 — and always 0 without `baselineGraceMs` — means no covered video was
   * baselined after the window opened. It says nothing about the OTHER end of
   * the span; `maxEndLagMs` is that half, and the two are reported separately
   * because they have different causes and different sizes.
   *
   * Above 0 it is the exact size of the head of the span the raggedest video is
   * missing, which is what lets the label state a TRUE bound rather than the
   * cap's worst case. The missing head USUALLY understates the figure — a later
   * baseline subtracts views that were already there — but not always: if
   * YouTube purged that video's count between the window's start and its
   * effective baseline, the purge is invisible to the delta and the figure is
   * overstated by it. Bounded in TIME by the grace, not in magnitude. Kept
   * anyway, because the alternative (dropping the video) distorts the total and
   * the own/competitor split by sweep order, which is worse and unbounded.
   */
  readonly maxBaselineLagMs: number;
  /**
   * The worst END reading actually used, as milliseconds BEFORE the window's
   * close (or before now, when the window has not closed yet — no reading can
   * exist in the future, so counting the unelapsed remainder of today as a
   * measurement gap would be nonsense).
   *
   * THE TAIL IS NOT SYMMETRIC WITH THE HEAD AND IS OFTEN THE LARGER GAP. A
   * video past its hit window is snapshotted at most daily
   * (`AFTER_WINDOW_INTERVAL_MINUTES`), and `channel-sync` writes no row at all
   * when the count has not moved, so the last SNAPSHOT can sit a day or more
   * behind the window's close. On a 36-hour measured span that is a third of
   * the span missing at the end, with a perfectly clean head — which is exactly
   * the case a head-only caveat went silent for while the figure was a third
   * low. `observedReading` closes most of this gap by treating the live
   * `Video.viewCount` as the reading it is; what remains is reported here.
   */
  readonly maxEndLagMs: number;
}

/** The video columns the measurement reads. */
interface VideoRow {
  readonly snapshots: readonly { capturedAt: Date; viewCount: bigint }[];
  /** The live lifetime counter, as of `statsFetchedAt`. */
  readonly viewCount?: bigint | number | null;
  /** When YouTube last returned statistics for this video. */
  readonly statsFetchedAt?: Date | null;
  /** False once YouTube stops returning it — see `observedReading`. */
  readonly isAvailable?: boolean | null;
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
   * baseline USUALLY UNDERSTATES money, which is the safe direction, while the
   * derived rate is `revenue / viewsGained`, so a denominator short by a tenth
   * raises the rate by a ninth — and that rate then multiplies EVERY niche's
   * views into money. There, refusing with `no_view_history` until the history
   * genuinely brackets the window, and falling through to the owner's
   * hand-entered range, is the honest answer.
   */
  readonly baselineGraceMs?: number;
  /**
   * The present instant, for the END-lag report only — never for choosing a
   * reading. Injected so a test can pin the tail gap without reaching for the
   * clock; production leaves it alone.
   */
  readonly nowMs?: number;
}): Promise<ReadonlyMap<string, ChannelViewsGained>> {
  const { organizationId, channelIds, window, format } = params;
  const baselineGraceMs = Math.max(0, params.baselineGraceMs ?? 0);
  const graceLimitMs = window.startMs + baselineGraceMs;
  const endDate = new Date(window.endMs);
  const lookbackFromMs = window.startMs - SNAPSHOT_LOOKBACK_DAYS * DAY_MS;
  const lookbackFrom = new Date(lookbackFromMs);
  /** The same bounds for every reading, snapshot or live counter alike. */
  const reach = { fromMs: lookbackFromMs, toMs: window.endMs };
  /*
   * What the END lag is measured back from. `endMs` is routinely in the FUTURE
   * — the niches page snaps its range up to the next UTC midnight — and no
   * reading can be taken after now, so measuring the tail against `endMs`
   * would report the unelapsed remainder of today as missing data under every
   * figure on the page.
   */
  const lagAnchorMs = Math.min(window.endMs, params.nowMs ?? Date.now());

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
      // The live counter and the instant it was fetched: together they are a
      // reading the snapshot series deliberately does not duplicate. See
      // `observedReading`.
      viewCount: true,
      statsFetchedAt: true,
      isAvailable: true,
      snapshots: {
        where: { capturedAt: { gte: lookbackFrom, lt: endDate } },
        select: { capturedAt: true, viewCount: true },
        orderBy: { capturedAt: "asc" },
      },
    },
  });

  const totals = new Map<
    string,
    {
      gained: number;
      covered: number;
      total: number;
      baselineLagMs: number;
      endLagMs: number;
    }
  >();
  // Seeded for every asked-about channel, so a channel with no videos at all
  // answers `{ 0, 0, 0 }` rather than vanishing — "nothing to measure" is an
  // answer the coverage arithmetic downstream has to be able to count.
  for (const channelId of channelIds) {
    totals.set(channelId, {
      gained: 0,
      covered: 0,
      total: 0,
      baselineLagMs: 0,
      endLagMs: 0,
    });
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

    const readings = readingsFor(video, reach);

    // Views at the window's close: the last reading taken before it. The
    // current lifetime total is NOT a substitute for the window's end — it is
    // today's number — but it IS a reading at its own fetch instant, which is
    // why `readingsFor` carries it and `maxEndLagMs` reports how far short of
    // the close the reading actually used falls.
    const atEnd = lastAtOrBefore(readings, window.endMs);
    if (atEnd === null) continue;

    const endLagMs = Math.max(0, lagAnchorMs - atEnd.capturedMs);

    if (video.publishedAt !== null && video.publishedAt.getTime() >= window.startMs) {
      // Published inside the window, so it started at nothing. This is the
      // one case where a zero baseline is a fact rather than an assumption.
      // It carries no head lag: publication IS the baseline instant, exactly.
      bucket.gained += atEnd.views;
      bucket.covered += 1;
      if (endLagMs > bucket.endLagMs) bucket.endLagMs = endLagMs;
      continue;
    }

    const atStart = lastAtOrBefore(readings, window.startMs);
    if (atStart !== null) {
      // Views can fall when YouTube purges inflated counts, and a negative
      // delta is real. It is kept rather than clamped: clamping every
      // negative to zero would bias the total upward, one video at a time.
      bucket.gained += atEnd.views - atStart.views;
      bucket.covered += 1;
      if (endLagMs > bucket.endLagMs) bucket.endLagMs = endLagMs;
      continue;
    }

    /*
     * NO READING AT THE WINDOW'S START — the case that blacked out every niche.
     *
     * Its views at that instant are still genuinely unknown, so it is still
     * never zero-based; what changes is that its OWN first reading may stand in
     * as the baseline when that reading sits within the grace. The gain then
     * covers a slightly shorter span than the window, which normally
     * UNDERSTATES it — views the video already held at that first reading are
     * subtracted out — and `maxBaselineLagMs` carries exactly how short so the
     * label can say so. The exception is a purge landing inside that head, which
     * the delta cannot see and which overstates instead; it is bounded in time
     * by the grace and pinned by a test rather than asserted away. Dropping the
     * video instead loses 100% of its gains AND, through `coveredVideos`,
     * decides the own/competitor split by sweep order.
     *
     * TWO READINGS ARE REQUIRED, not one. A video whose only reading in the
     * window is its baseline has no delta to measure at all; counting it as
     * covered at zero gain would inflate coverage with a video nothing was
     * measured from and hide it behind the very floor meant to catch it. This
     * is NOT the stalled-video case — a Short nobody is watching still gets its
     * counter fetched, so `observedReading` gives it a genuine second reading
     * and a genuine zero. See that function for why that distinction matters.
     */
    if (baselineGraceMs === 0) continue;
    const effective = firstInRange(readings, window.startMs, graceLimitMs);
    if (effective === null || effective.capturedMs >= atEnd.capturedMs) continue;

    bucket.gained += atEnd.views - effective.views;
    bucket.covered += 1;
    const baselineLagMs = effective.capturedMs - window.startMs;
    if (baselineLagMs > bucket.baselineLagMs) bucket.baselineLagMs = baselineLagMs;
    if (endLagMs > bucket.endLagMs) bucket.endLagMs = endLagMs;
  }

  const map = new Map<string, ChannelViewsGained>();
  for (const [channelId, bucket] of totals) {
    map.set(channelId, {
      viewsGained: bucket.gained,
      coveredVideos: bucket.covered,
      totalVideos: bucket.total,
      maxBaselineLagMs: bucket.baselineLagMs,
      maxEndLagMs: bucket.endLagMs,
    });
  }
  return map;
}

interface Reading {
  readonly capturedMs: number;
  readonly views: number;
}

/**
 * THE READING THE SNAPSHOT SERIES DELIBERATELY DOES NOT HOLD.
 *
 * `channel-sync` writes a `VideoSnapshot` row only when the interval has
 * elapsed AND the count actually moved (`if (!dueByTime || !changed) continue`).
 * That is the right storage decision and it creates a measurement trap: a
 * stalled Short — one the sync fetched, looked at, and found unchanged — keeps
 * exactly ONE row forever. Under the delta rules alone that video is
 * "unmeasured", so it is dropped and it DEPRESSES COVERAGE, pushing a niche
 * under the 0.9 floor and printing "Not enough view history yet" over a library
 * whose gain is not unknown at all: it is known, and it is zero. Simulated on a
 * mature library with a benign 49-minute sweep spread, three stalled Shorts in
 * ten took coverage to 0.73 on their own.
 *
 * `Video.viewCount` and `Video.statsFetchedAt` are written together on every
 * successful fetch, so the pair IS a reading: "this video had exactly this many
 * views at this instant". Admitting it is not an assumption and not a
 * relaxation of the two-readings rule — it is the second reading, and the app
 * had it all along.
 *
 * THREE CONDITIONS, each load-bearing:
 *   • `isAvailable`, because the vanished-video path stamps `statsFetchedAt`
 *     WITHOUT refreshing `viewCount` (`channel-sync.ts`: `data: { isAvailable:
 *     false, statsFetchedAt: now }`). Reading that pair would date a stale
 *     count to a fresh instant, which is the one way this could fabricate.
 *   • inside the same `SNAPSHOT_LOOKBACK_DAYS` window the snapshot query is
 *     bounded by, at both ends. Past the close it is not a reading in this
 *     window; before the lookback it is the reading of a video the collector
 *     has genuinely stopped seeing, which that constant deliberately treats as
 *     UNCOVERED rather than as having stood still.
 *   • present at all — a caller or fixture that did not select these columns
 *     gets the snapshot-only behaviour, unchanged.
 *
 * WHAT THIS DOES TO THE DERIVED-RPM CALLER: nothing, in production. That
 * window ends `RPM_SETTLE_DAYS` before today, so `statsFetchedAt` is always
 * after it and this reading is never eligible. Where it ever were — a channel
 * not synced for longer than the settle — it can only ADD a later end reading,
 * which grows the denominator and LOWERS the derived rate. The unsafe direction
 * for that caller is a short denominator, and this cannot produce one.
 */
function observedReading(video: VideoRow, reach: ReadingReach): Reading | null {
  const { statsFetchedAt, viewCount, isAvailable } = video;
  if (!statsFetchedAt || viewCount === null || viewCount === undefined) return null;
  if (isAvailable !== true) return null;

  const capturedMs = statsFetchedAt.getTime();
  if (!Number.isFinite(capturedMs)) return null;
  if (capturedMs > reach.toMs || capturedMs < reach.fromMs) return null;

  const views = Number(viewCount);
  if (!Number.isFinite(views)) return null;
  return { capturedMs, views };
}

/** The instants a reading may fall between — the snapshot query's own bounds. */
interface ReadingReach {
  readonly fromMs: number;
  readonly toMs: number;
}

/** Every reading this video offers inside the window's reach, unordered. */
function readingsFor(video: VideoRow, reach: ReadingReach): readonly Reading[] {
  const readings: Reading[] = video.snapshots.map((snapshot) => ({
    capturedMs: snapshot.capturedAt.getTime(),
    views: Number(snapshot.viewCount),
  }));
  const observed = observedReading(video, reach);
  if (observed !== null) readings.push(observed);
  return readings;
}

/** The last reading at or before an instant, or null when there is none. */
function lastAtOrBefore(readings: readonly Reading[], atMs: number): Reading | null {
  let best: Reading | null = null;
  for (const reading of readings) {
    if (reading.capturedMs > atMs) continue;
    if (best === null || reading.capturedMs > best.capturedMs) best = reading;
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
  readings: readonly Reading[],
  fromMs: number,
  toMs: number,
): Reading | null {
  let best: Reading | null = null;
  for (const reading of readings) {
    if (reading.capturedMs < fromMs || reading.capturedMs > toMs) continue;
    if (best === null || reading.capturedMs < best.capturedMs) best = reading;
  }
  return best;
}
