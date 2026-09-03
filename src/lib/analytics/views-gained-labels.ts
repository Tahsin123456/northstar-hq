import { RPM_MIN_SNAPSHOT_COVERAGE } from "./niche-rpm";

/**
 * =========================================================================
 * RETAINED: HOW A "VIEWS GAINED IN THIS PERIOD" FIGURE WOULD LABEL ITSELF
 * =========================================================================
 *
 * NOTHING ON SCREEN READS THIS FILE TODAY, AND THAT IS DELIBERATE.
 *
 * The niche money surfaces — the Overview earnings panel and the niche card's
 * value strip — price EVERY view the tracked channels have, at the niche's
 * rate. That basis needs no snapshot history, no coverage floor and no span
 * label, so none of the machinery below touches a rendered figure.
 *
 * It is kept because it is correct and tested, and because "what did this
 * period actually pay?" is a question worth answering once the recorded view
 * history is deep enough to answer it honestly. When that day comes, this is
 * the vocabulary that figure needs: a coverage predicate that decides whether
 * a delta may be priced at all, and the sentences that state what span was
 * really measured and where the readings are ragged.
 *
 * THE COMPANION SERVER MACHINERY is `views-gained-service.ts`,
 * `niche-views-gained-service.ts`, `/api/niches/views-gained` and
 * `use-views-gained.ts`. All of it still runs; none of it decides what money
 * renders.
 *
 * ONE EXCEPTION, AND IT IS LIVE: `niche-rpm-service.ts` derives a measured RPM
 * from `viewsGainedByChannel`, which is a different feature with its own
 * window and its own identity pin. That path is untouched by any of this.
 *
 * These functions live HERE rather than in `niche-earnings.ts` for one
 * concrete reason: that module is the money panel's copy, and a reader hunting
 * for the sentence behind a figure must not find a paragraph about view
 * history that no figure on the page depends on.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** The coverage behind one niche's measured gains, or `null` when nothing
 * could be measured at all (no history reaches the period). */
export type MeasuredCoverage = {
  readonly coveredVideos: number;
  readonly totalVideos: number;
} | null;

/**
 * Is a gains measurement trustworthy enough to price?
 *
 * `null` coverage means the endpoint had nothing to measure (or omitted the
 * niche), which is the same refusal said harder. A library of zero videos is
 * NOT insufficient — there is nothing the measurement failed to cover.
 *
 * The floor is `RPM_MIN_SNAPSHOT_COVERAGE` — 0.9, the DOLLAR floor, not the
 * 0.8 the history chart uses: missing videos shift a chart's shape, but they
 * subtract someone's views from a money figure.
 */
export function hasUsableGainsHistory(measured: MeasuredCoverage): boolean {
  if (measured === null) return false;
  if (measured.totalVideos === 0) return true;
  return measured.coveredVideos / measured.totalVideos >= RPM_MIN_SNAPSHOT_COVERAGE;
}

/**
 * The label for a period the view history only partly covers.
 *
 * The figure is real; what it covers is not the whole period on the selector,
 * and a money number wearing a 30-day label while measuring 9 days is the
 * partial-sum-as-total mistake in time instead of across niches.
 */
export function measuredSpanNote(measuredDays: number, periodDays: number): string {
  return `Measured over the last ${measuredDays} of ${periodDays} ${
    periodDays === 1 ? "day" : "days"
  } — view history begins there.`;
}

/** The lead sentence when the history did cover the whole period. */
export function fullSpanNote(periodDays: number): string {
  return `Measured over the full ${periodDays} ${periodDays === 1 ? "day" : "days"}.`;
}

/**
 * The smallest lag worth a sentence: one minute, the smallest unit the note
 * can express. Below it "up to 0 minutes" is not a caveat, it is noise under
 * every figure forever.
 */
export const BASELINE_LAG_FLOOR_MS = 60_000;

/**
 * The second floor, and the one that does the work: a gap is only worth a
 * sentence when it is at least this much of the span it is a gap in.
 *
 * WHY A PROPORTION AND NOT JUST A MINUTE. Both gaps are reported, and the tail
 * gap is almost never exactly zero — the last reading of the last channel the
 * sweep reached is minutes-to-hours old at any instant. A minute-floored
 * caveat would print under EVERY figure forever, which teaches a reader to
 * skip the sentence, which costs them the one reading of it that mattered.
 *
 * A hundredth of the span is the line: 7 hours on a 30-day period, 22 minutes
 * on a 36-hour one.
 */
export const LAG_NOTE_SPAN_FRACTION = 0.01;

/** Is this gap big enough, against this span, to be worth stating? */
export function lagWorthStating(lagMs: number | null, spanMs: number): boolean {
  if (lagMs === null) return false;
  return lagMs >= Math.max(BASELINE_LAG_FLOOR_MS, spanMs * LAG_NOTE_SPAN_FRACTION);
}

/**
 * A duration for a non-technical reader, ROUNDED UP.
 *
 * Up, always, because the number lands in a sentence that says "up to": round
 * 100 minutes down to an hour and the label states a bound the arithmetic does
 * not support, which is the one way this caveat could become a lie.
 */
export function approxDurationCeil(ms: number): string {
  if (ms < HOUR_MS) {
    const minutes = Math.max(1, Math.ceil(ms / 60_000));
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  if (ms < 48 * HOUR_MS) {
    const hours = Math.ceil(ms / HOUR_MS);
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const days = Math.ceil(ms / DAY_MS);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * The caveat for a span some videos only join part way through, or leave early.
 *
 * The measurement baselines a video whose own history starts a little inside
 * the window on its own first reading instead of dropping it — see
 * `BASELINE_GRACE_FRACTION` — which gives up the claim that every video was
 * measured over the identical span. The label may not keep making that claim
 * silently: it names the gap, and it names the DIRECTION of the error.
 *
 * BOTH ENDS, because the tail is usually the bigger one. A video past its hit
 * window is snapshotted at most daily, so its last reading can sit a day
 * behind the period's close.
 *
 * The gaps are stated in TIME, not as a percentage of the money: a Short can
 * take most of its lifetime views in its first hours, so "understated by at
 * most 0.6%" would be a bound nobody can support.
 */
export function coverageGapNote(headLagMs: number, tailLagMs: number): string {
  const head = headLagMs > 0 ? approxDurationCeil(headLagMs) : null;
  const tail = tailLagMs > 0 ? approxDurationCeil(tailLagMs) : null;

  if (head !== null && tail !== null) {
    return (
      `The app started recording some of these videos up to ${head} into that span, ` +
      `and its latest reading for some of them is up to ${tail} before the period ends, ` +
      `so those views are missing and this figure is a little low.`
    );
  }
  if (head !== null) {
    return (
      `The app started recording some of these videos up to ${head} into that span, ` +
      `so their first views are missing and this figure is a little low.`
    );
  }
  return (
    `The latest reading for some of these videos is up to ${tail} before the period ends, ` +
    `so their last views are missing and this figure is a little low.`
  );
}

/**
 * The note for one response, or `null` when the whole period was measured from
 * end to end for every video.
 *
 * Derived from the server's own `requestedStartMs`/`measuredFromMs` echo rather
 * than from a client's copy of the range, so the label describes the span that
 * was actually measured even if the two ever disagree. Day counts are rounded
 * and floored at 1: a partial day of history is still history.
 */
export function measuredSpanNoteFrom(response: {
  readonly requestedStartMs: number;
  readonly measuredFromMs: number | null;
  readonly endMs: number;
  readonly maxBaselineLagMs: number | null;
  readonly maxEndLagMs: number | null;
}): string | null {
  const { requestedStartMs, measuredFromMs, endMs, maxBaselineLagMs, maxEndLagMs } =
    response;
  if (measuredFromMs === null) return null;

  const periodDays = Math.max(1, Math.round((endMs - requestedStartMs) / DAY_MS));
  const clamped = measuredFromMs > requestedStartMs;

  // Both gaps are judged against the span they are gaps IN, not the period the
  // selector names: a two-hour head is noise in thirty days and a twentieth of
  // the figure in a day and a half.
  const spanMs = Math.max(0, endMs - measuredFromMs);
  const headMs =
    maxBaselineLagMs !== null && lagWorthStating(maxBaselineLagMs, spanMs)
      ? maxBaselineLagMs
      : 0;
  const tailMs =
    maxEndLagMs !== null && lagWorthStating(maxEndLagMs, spanMs) ? maxEndLagMs : 0;

  if (!clamped && headMs === 0 && tailMs === 0) return null;

  const measuredDays = Math.max(1, Math.round((endMs - measuredFromMs) / DAY_MS));
  const span = clamped
    ? measuredSpanNote(measuredDays, periodDays)
    : fullSpanNote(periodDays);
  if (headMs === 0 && tailMs === 0) return span;
  return `${span} ${coverageGapNote(headMs, tailMs)}`;
}

/**
 * The same note for ONE niche, off that niche's own gaps.
 *
 * The span half is a fact about the page — the history begins where it begins —
 * so it comes from the response. The raggedness half is a fact about the videos
 * in THIS niche, so it comes from the entry.
 */
export function nicheMeasuredSpanNote(
  response: {
    readonly requestedStartMs: number;
    readonly measuredFromMs: number | null;
    readonly endMs: number;
  },
  entry: {
    readonly maxBaselineLagMs: number;
    readonly maxEndLagMs: number;
  } | null,
): string | null {
  return measuredSpanNoteFrom({
    requestedStartMs: response.requestedStartMs,
    measuredFromMs: response.measuredFromMs,
    endMs: response.endMs,
    maxBaselineLagMs: entry === null ? null : entry.maxBaselineLagMs,
    maxEndLagMs: entry === null ? null : entry.maxEndLagMs,
  });
}

/**
 * The gains read failed outright — a network or server error, not a data state.
 * Retained with the rest of this vocabulary; no money surface fetches gains any
 * more, so nothing renders it today.
 */
export const VIEWS_GAINED_UNAVAILABLE =
  "View gains could not be loaded just now, so no figure is shown. Reload the page to try again.";
