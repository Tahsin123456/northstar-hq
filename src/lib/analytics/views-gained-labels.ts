/**
 * =========================================================================
 * HOW A "VIEWS GAINED IN THIS PERIOD" FIGURE LABELS ITSELF
 * =========================================================================
 *
 * The niche money surfaces — the Overview earnings panel and the niche card's
 * value strip — price the views each tracked channel GAINED over the selected
 * period, read from the channel counter series (`ChannelViewSnapshot`). That
 * series has a beginning and a most-recent reading, and both are facts a
 * money figure has to state: a 30-day label over a 9-day measurement is the
 * partial-sum-as-total mistake in time, and a figure read six hours ago is
 * six hours short of "today".
 *
 * These sentences live HERE rather than in `niche-earnings.ts` for one
 * concrete reason: that module is the money panel's copy and arithmetic, and
 * the span vocabulary is shared with the niche card, which does not build a
 * panel at all.
 *
 * WHAT IS DELIBERATELY NOT HERE ANY MORE: the per-video coverage floor, the
 * baseline grace and the "started recording some of these videos up to N
 * hours into that span" caveat. Those described the per-video snapshot delta,
 * whose raggedness came from which videos the sweep reached and when. The
 * channel counter is bracketed for every measured channel by construction —
 * see `channel-views-gained.ts` — so there is no ragged head to confess. What
 * remains is the span and the tail, and a per-channel count for a niche the
 * figure only partly covers.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

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

/**
 * The smallest end lag worth a sentence: one hour.
 *
 * Readings arrive on the sweep, so the latest one is minutes-to-hours old at
 * any instant and the lag is essentially never zero. A caveat that printed
 * under every figure forever teaches a reader to skip it, which costs them
 * the one reading of it that mattered — the day the sweep has stalled.
 */
export const END_LAG_NOTE_FLOOR_MS = HOUR_MS;

/**
 * How stale the newest reading behind the figure is, for a person.
 *
 * Hours, rounded to the nearest; days past two of them. Rounded to nearest
 * rather than up because this is a statement of age, not a bound — "up to"
 * is not in the sentence.
 */
export function latestReadingNote(lagMs: number): string {
  if (lagMs >= 48 * HOUR_MS) {
    const days = Math.round(lagMs / DAY_MS);
    return `Latest reading ${days}d ago.`;
  }
  const hours = Math.max(1, Math.round(lagMs / HOUR_MS));
  return `Latest reading ${hours}h ago.`;
}

/**
 * The note for one response, or `null` when the whole period was measured
 * and the newest reading is recent.
 *
 * Derived from the server's own `requestedStartMs`/`measuredFromMs` echo
 * rather than from a client's copy of the range, so the label describes the
 * span that was actually measured even if the two ever disagree. Day counts
 * are rounded and floored at 1: a partial day of history is still history.
 */
export function measuredSpanNoteFrom(response: {
  readonly requestedStartMs: number;
  readonly measuredFromMs: number | null;
  readonly endMs: number;
  readonly maxEndLagMs: number | null;
}): string | null {
  const { requestedStartMs, measuredFromMs, endMs, maxEndLagMs } = response;
  if (measuredFromMs === null) return null;

  const clamped = measuredFromMs > requestedStartMs;
  const stale = maxEndLagMs !== null && maxEndLagMs > END_LAG_NOTE_FLOOR_MS;
  if (!clamped && !stale) return null;

  const parts: string[] = [];
  if (clamped) {
    const periodDays = Math.max(1, Math.round((endMs - requestedStartMs) / DAY_MS));
    const measuredDays = Math.max(1, Math.round((endMs - measuredFromMs) / DAY_MS));
    parts.push(measuredSpanNote(measuredDays, periodDays));
  }
  if (stale) parts.push(latestReadingNote(maxEndLagMs));
  return parts.join(" ");
}

/**
 * The caption for a niche the figure only partly covers — "3 of 5 channels
 * measured" — or `null` when it covers every channel, or none.
 *
 * NONE IS NOT A CAPTION, it is a different state: a niche with nothing
 * measured renders the measuring sentence instead of a figure, so the caption
 * only ever sits under a real number and says which part of the niche the
 * number is missing.
 */
export function measuredChannelsCaption(measured: {
  readonly measuredChannels: number;
  readonly totalChannels: number;
}): string | null {
  const { measuredChannels, totalChannels } = measured;
  if (measuredChannels <= 0 || measuredChannels >= totalChannels) return null;
  return `${measuredChannels} of ${totalChannels} channels measured`;
}

/**
 * The gains read failed outright — a network or server error, not a data
 * state. Nothing is priced from a stale cache and nothing is invented; the
 * one action that helps is named.
 */
export const VIEWS_GAINED_UNAVAILABLE =
  "View gains could not be loaded just now, so no figure is shown. Reload the page to try again.";
