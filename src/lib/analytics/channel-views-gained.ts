import type { NicheViewsGainedDTO, NicheViewsGainedEntryDTO } from "@/lib/dto";
import type { NicheFormat } from "@/lib/niches/niche-format";

/**
 * =========================================================================
 * VIEWS A CHANNEL GAINED IN A PERIOD — FROM THE CHANNEL COUNTER, NOT THE VIDEOS
 * =========================================================================
 *
 * The owner's definition, verbatim: "Niche earnings = the overall views a
 * channel generated in the given timeframe — the channel might have videos
 * from 2-3 months before that still generate views and they should count — x
 * the set niche RPM range."
 *
 * THE BASIS IS ONE NUMBER PER CHANNEL. YouTube reports a channel's lifetime
 * view count — over every upload it has ever made — and the sync records it
 * as a `ChannelViewSnapshot` every time it runs. "Views gained in the period"
 * is then one subtraction per channel: the last reading at or before the
 * period's close, minus the last reading at or before its start. Every video
 * the channel has is inside that number however old it is; nothing depends on
 * which videos the app holds rows for, whether the walk reached them, or
 * whether each of them happened to hold a reading at both ends.
 *
 * That last point is the whole reason this file exists beside
 * `views-gained-service.ts`. The per-video delta is right for the derived RPM
 * — its numerator is money and its denominator must be the very views that
 * money was paid on — and it was wrong for this figure twice over: it could
 * only see the videos inside the lookback, and its coverage floor blacked out
 * every niche whenever the sweep had reached the channels a few hours apart.
 * The channel counter has neither problem.
 *
 * ---------------------------------------------------------------------------
 * ONE UNIFORM SPAN, BRACKETED BY CONSTRUCTION
 * ---------------------------------------------------------------------------
 * `measuredFromMs = max(requestedStartMs, max over channels of each channel's
 * FIRST reading)`. Every measured channel therefore holds a reading at or
 * before the instant the measurement starts, so no channel is dropped for
 * want of a baseline and no channel is measured over a different span from
 * its neighbours.
 *
 * WHY THE MAX AND NOT THE MIN — the per-video pipeline's bug, not repeated.
 * That pipeline anchored on the org-wide MINIMUM first capture, which is the
 * single instant at which the FEWEST videos hold a reading: everything swept
 * a few minutes later had nothing at-or-before it and was thrown out, and
 * coverage landed at a few percent against a 0.9 floor. The max-of-firsts is
 * the mirror image: it is the first instant at which EVERY channel holds a
 * reading, so the span is bracketed for all of them. What it costs is the gap
 * between the first channel's first reading and the last channel's — the
 * hours a sweep takes — and the label says exactly that ("measured over the
 * last N of M days").
 *
 * A channel whose first reading falls at or after the period's close cannot
 * be measured over any part of the period. It is counted as unmeasured
 * rather than allowed to push the span past the close — which would render
 * every OTHER channel unmeasurable because one was added this morning.
 *
 * ---------------------------------------------------------------------------
 * THE FORMAT SPLIT IS AN ESTIMATE, AND IS LABELLED AS ONE
 * ---------------------------------------------------------------------------
 * The channel counter is over every upload, Shorts and long-form together,
 * and YouTube does not break it down. The owner's decision is to scale the
 * channel's delta by its Shorts SHARE — Shorts views over (Shorts + long-form
 * views) among the videos the app holds for it, with unresolved videos in
 * neither side — for a Shorts niche, and by the complement for a Long Form
 * niche. A channel with no classified video at all has no share, is left out
 * of the figure and counted as unmeasured: silently treating it as 100%
 * Shorts would price a long-form channel's whole month into a Shorts niche.
 * `shareBasis: "estimated"` travels on every entry so the surfaces cannot
 * forget to say so.
 *
 * PURE AND ISOMORPHIC — no clock, no Prisma. The service loads the readings
 * and the shares; everything below is arithmetic on them, which is what lets
 * the bracketing rule be tested against the exact staggered-sweep fixture
 * that broke the previous basis.
 */

/** One reading of a channel's lifetime view counter. */
export interface ChannelReading {
  readonly capturedMs: number;
  readonly views: number;
}

/** Everything the measurement needs to know about one member channel. */
export interface ChannelGainsSource {
  readonly channelId: string;
  /**
   * Every reading available for the channel, stored rows and the live
   * counter alike, in any order. Two readings at the same instant are one
   * reading — the live counter duplicates the row the sync wrote for it.
   */
  readonly readings: readonly ChannelReading[];
  /**
   * The channel's estimated Shorts share of views, 0..1, over the videos the
   * app holds for it — or `null` when it holds no classified video at all.
   */
  readonly shortsShare: number | null;
}

/** A member of a niche, as the grouping needs it. */
export interface NicheMember {
  readonly channelId: string;
  readonly ownershipType: string;
}

/** The whole question, as one input. */
export interface ChannelViewsGainedInput {
  readonly format: NicheFormat;
  readonly requestedStartMs: number;
  /** Exclusive. */
  readonly endMs: number;
  /** The present instant — the latest any reading can exist. */
  readonly nowMs: number;
  /** Every visible niche of the format, in the order the response lists them. */
  readonly nicheIds: readonly string[];
  readonly membersByNiche: ReadonlyMap<string, readonly NicheMember[]>;
  readonly channels: readonly ChannelGainsSource[];
}

/** One measured channel's delta, already scaled to the niche's format. */
export interface ChannelViewsGainedResult {
  readonly viewsGained: number;
  /** How far before the period's close (or before now) the end reading sits. */
  readonly endLagMs: number;
}

/** The earliest instant a channel holds a reading for, or null with none. */
export function firstReadingMs(readings: readonly ChannelReading[]): number | null {
  let first: number | null = null;
  for (const reading of readings) {
    if (first === null || reading.capturedMs < first) first = reading.capturedMs;
  }
  return first;
}

/** The last reading at or before an instant, or null when there is none. */
export function lastAtOrBefore(
  readings: readonly ChannelReading[],
  atMs: number,
): ChannelReading | null {
  let best: ChannelReading | null = null;
  for (const reading of readings) {
    if (reading.capturedMs > atMs) continue;
    if (best === null || reading.capturedMs > best.capturedMs) best = reading;
  }
  return best;
}

/**
 * Where the measurement starts, and where the history began.
 *
 * `historyBeganMs` is the max-of-firsts itself — the first instant every
 * measurable channel holds a reading — and is reported so a tooltip can say
 * "view history began on …". `measuredFromMs` is that clamped to the
 * requested start, or null when the span would be empty: no readings at all,
 * or a history that begins at or after the period's close.
 */
export function measurementStart(
  channels: readonly ChannelGainsSource[],
  span: { readonly requestedStartMs: number; readonly endMs: number; readonly nowMs: number },
): { readonly measuredFromMs: number | null; readonly historyBeganMs: number | null } {
  const lagAnchorMs = Math.min(span.endMs, span.nowMs);
  let historyBeganMs: number | null = null;
  for (const channel of channels) {
    const first = firstReadingMs(channel.readings);
    // No reading, or a first reading the period cannot bracket: unmeasured,
    // and not allowed to drag the span past the close for everybody else.
    if (first === null || first >= lagAnchorMs) continue;
    if (historyBeganMs === null || first > historyBeganMs) historyBeganMs = first;
  }
  if (historyBeganMs === null) return { measuredFromMs: null, historyBeganMs: null };

  const measuredFromMs = Math.max(span.requestedStartMs, historyBeganMs);
  if (measuredFromMs >= lagAnchorMs) return { measuredFromMs: null, historyBeganMs };
  return { measuredFromMs, historyBeganMs };
}

/**
 * The factor a channel's delta is multiplied by for one format's niche, or
 * null when the channel has no classified video to estimate one from.
 */
export function formatShareFactor(
  shortsShare: number | null,
  format: NicheFormat,
): number | null {
  if (shortsShare === null || !Number.isFinite(shortsShare)) return null;
  const share = Math.min(1, Math.max(0, shortsShare));
  return format === "shorts" ? share : 1 - share;
}

/**
 * A channel's Shorts share from its classified video counts.
 *
 * `uncertain` videos are in NEITHER count — the same asymmetry
 * `isVideoOfFormat` pins everywhere — so a channel the classifier could not
 * resolve at all has no share rather than a share of zero.
 */
export function shortsShareOf(shortsVideos: number, longformVideos: number): number | null {
  const classified = shortsVideos + longformVideos;
  if (classified <= 0) return null;
  return shortsVideos / classified;
}

/**
 * One channel's gain over `[measuredFromMs, min(endMs, now)]`, scaled to the
 * format — or null when it cannot be measured.
 *
 * TWO DISTINCT READINGS, ON OPPOSITE SIDES OF THE SPAN, OR NOTHING. A channel
 * holding only the migration's seed row — or only readings that all sit at or
 * before the span's start — has no delta to state, and a zero would read as
 * "gained nothing" for a channel nobody has looked at since. Negative deltas
 * are kept: YouTube purges inflated counts, and clamping every negative to
 * zero would bias the total upward one channel at a time.
 */
export function measureChannel(
  channel: ChannelGainsSource,
  format: NicheFormat,
  measuredFromMs: number,
  lagAnchorMs: number,
): ChannelViewsGainedResult | null {
  const factor = formatShareFactor(channel.shortsShare, format);
  if (factor === null) return null;

  const atStart = lastAtOrBefore(channel.readings, measuredFromMs);
  const atEnd = lastAtOrBefore(channel.readings, lagAnchorMs);
  if (atStart === null || atEnd === null) return null;
  if (atEnd.capturedMs <= atStart.capturedMs) return null;

  const delta = atEnd.views - atStart.views;
  return {
    // Rounded per channel so the niche sum is an integer number of views; the
    // rounding error is under one view per channel and the figure is priced
    // per thousand.
    viewsGained: Math.round(delta * factor),
    endLagMs: Math.max(0, lagAnchorMs - atEnd.capturedMs),
  };
}

/**
 * The per-niche grouping: measured channels' gains, filed under each niche.
 *
 * A CHANNEL IN TWO NICHES COUNTS IN BOTH — correct for a per-niche figure,
 * and the reason the earnings builder downstream refuses to SUM niches that
 * share a channel. An unmeasured channel contributes to `totalChannels` and
 * to nothing else: its absence is "could not measure", never "gained
 * nothing", and `ownChannelIds` lists only the own channels that actually
 * measured something, because a channel contributing no views to two niches
 * cannot double anything.
 */
export function groupNicheViewsGained(
  nicheIds: readonly string[],
  membersByNiche: ReadonlyMap<string, readonly NicheMember[]>,
  gainsByChannel: ReadonlyMap<string, ChannelViewsGainedResult | null>,
): NicheViewsGainedEntryDTO[] {
  return nicheIds.map((nicheId) => {
    let ourViewsGained = 0;
    let competitorViewsGained = 0;
    let measuredChannels = 0;
    let totalChannels = 0;
    const ownChannelIds: string[] = [];

    for (const member of membersByNiche.get(nicheId) ?? []) {
      totalChannels += 1;
      const gains = gainsByChannel.get(member.channelId) ?? null;
      if (gains === null) continue;
      measuredChannels += 1;
      if (member.ownershipType === "own") {
        ourViewsGained += gains.viewsGained;
        ownChannelIds.push(member.channelId);
      } else {
        competitorViewsGained += gains.viewsGained;
      }
    }

    return {
      nicheId,
      ourViewsGained,
      competitorViewsGained,
      measuredChannels,
      totalChannels,
      ownChannelIds,
      shareBasis: "estimated",
    };
  });
}

/**
 * The whole answer, from readings to response.
 *
 * NOTHING TO MEASURE IS SAID, NOT COMPUTED. With no span — no readings, or a
 * history beginning at or after the close — every delta would be the absence
 * of a reading dressed as a zero, so the response carries an empty `niches`
 * array and a null `measuredFromMs`, which the surfaces render as words.
 */
export function computeNicheViewsGained(input: ChannelViewsGainedInput): NicheViewsGainedDTO {
  const { format, requestedStartMs, endMs, nowMs, nicheIds, membersByNiche, channels } = input;
  const lagAnchorMs = Math.min(endMs, nowMs);
  const { measuredFromMs, historyBeganMs } = measurementStart(channels, {
    requestedStartMs,
    endMs,
    nowMs,
  });

  if (measuredFromMs === null) {
    return {
      requestedStartMs,
      endMs,
      measuredFromMs: null,
      historyBeganMs,
      // No measurement ran, so there is no lag to report. `null` rather than
      // 0, which would read as "measured, and read at the very close".
      maxEndLagMs: null,
      niches: [],
    };
  }

  const gainsByChannel = new Map<string, ChannelViewsGainedResult | null>();
  let maxEndLagMs: number | null = null;
  for (const channel of channels) {
    const measured = measureChannel(channel, format, measuredFromMs, lagAnchorMs);
    gainsByChannel.set(channel.channelId, measured);
    if (measured !== null && (maxEndLagMs === null || measured.endLagMs > maxEndLagMs)) {
      maxEndLagMs = measured.endLagMs;
    }
  }

  return {
    requestedStartMs,
    endMs,
    measuredFromMs,
    historyBeganMs,
    maxEndLagMs,
    niches: groupNicheViewsGained(nicheIds, membersByNiche, gainsByChannel),
  };
}
