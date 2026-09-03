import { describe, expect, it } from "vitest";
import {
  computeNicheViewsGained,
  formatShareFactor,
  measureChannel,
  measurementStart,
  shortsShareOf,
  type ChannelGainsSource,
  type ChannelViewsGainedInput,
  type NicheMember,
} from "../channel-views-gained";

/**
 * =========================================================================
 * VIEWS GAINED FROM THE CHANNEL COUNTER — THE RULES, PINNED
 * =========================================================================
 *
 * THE REGRESSION THIS SUITE EXISTS FOR, in the owner's words, twice over. "It
 * still says 'Not enough view history yet'" — the per-video delta anchored on
 * the org-wide MINIMUM first capture and dropped every video the sweep
 * reached a few minutes later, so coverage sat at a few percent and every
 * niche printed words. Then "$177.5K–$310.6K is WAY TOO HIGH" — the lifetime
 * basis priced every view the channels had ever had under a 30-day label.
 *
 * The basis pinned here is the one he described: each channel's counter at
 * the period's close minus the same counter at its start, every video inside
 * it however old, split between Shorts and long-form by the channel's mix.
 * The staggered-sweep fixture below is the exact shape that blacked out the
 * per-video pipeline, and the assertion is that every channel in it is
 * measured.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const START_MS = Date.UTC(2026, 7, 1);
const END_MS = Date.UTC(2026, 7, 31);
/** Noon on the last day: the period has not closed yet. */
const NOW_MS = END_MS - 12 * HOUR_MS;

function reading(capturedMs: number, views: number) {
  return { capturedMs, views };
}

function channel(
  channelId: string,
  readings: readonly { capturedMs: number; views: number }[],
  shortsShare: number | null = 1,
): ChannelGainsSource {
  return { channelId, readings, shortsShare };
}

function member(channelId: string, ownershipType: string): NicheMember {
  return { channelId, ownershipType };
}

function input(
  channels: readonly ChannelGainsSource[],
  membersByNiche: ReadonlyMap<string, readonly NicheMember[]>,
  overrides: Partial<ChannelViewsGainedInput> = {},
): ChannelViewsGainedInput {
  return {
    format: "shorts",
    requestedStartMs: START_MS,
    endMs: END_MS,
    nowMs: NOW_MS,
    nicheIds: [...membersByNiche.keys()],
    membersByNiche,
    channels,
    ...overrides,
  };
}

describe("the delta", () => {
  it("is the counter at the close minus the counter at the start, every video included", () => {
    // Nothing here knows about videos at all: the readings are the channel's
    // lifetime total, so a Short from 2024 that took 40,000 views in August
    // is inside this number by construction.
    const result = computeNicheViewsGained(
      input(
        [channel("chan_ours", [reading(START_MS - DAY_MS, 1_000_000), reading(NOW_MS - HOUR_MS, 1_140_000)])],
        new Map([["niche_gta", [member("chan_ours", "own")]]]),
      ),
    );

    expect(result.measuredFromMs).toBe(START_MS);
    expect(result.niches).toEqual([
      {
        nicheId: "niche_gta",
        ourViewsGained: 140_000,
        competitorViewsGained: 0,
        measuredChannels: 1,
        totalChannels: 1,
        ownChannelIds: ["chan_ours"],
        shareBasis: "estimated",
      },
    ]);
  });

  it("uses the last reading at or before each end, not the nearest", () => {
    const measured = measureChannel(
      channel("c", [
        reading(START_MS - 3 * DAY_MS, 900_000),
        reading(START_MS - HOUR_MS, 1_000_000),
        // Just after the start: NOT the baseline, whatever it says.
        reading(START_MS + HOUR_MS, 1_500_000),
        reading(NOW_MS - 2 * HOUR_MS, 1_200_000),
        // After now: cannot exist, and must not be read if it somehow does.
        reading(NOW_MS + HOUR_MS, 9_000_000),
      ]),
      "shorts",
      START_MS,
      NOW_MS,
    );

    expect(measured).toEqual({ viewsGained: 200_000, endLagMs: 2 * HOUR_MS });
  });

  /**
   * `channels.viewCount` at `channels.lastFetchedAt` is a reading the series
   * deliberately does not duplicate. When it is the newest one, it is the
   * one the close is read from — and it closes the tail gap a sweep leaves.
   */
  it("reads the close from the live counter when that is the latest reading", () => {
    const stored = [reading(START_MS - DAY_MS, 1_000_000), reading(NOW_MS - 6 * HOUR_MS, 1_050_000)];
    const withoutLive = measureChannel(channel("c", stored), "shorts", START_MS, NOW_MS);
    const withLive = measureChannel(
      channel("c", [...stored, reading(NOW_MS - 10 * 60_000, 1_080_000)]),
      "shorts",
      START_MS,
      NOW_MS,
    );

    expect(withoutLive).toEqual({ viewsGained: 50_000, endLagMs: 6 * HOUR_MS });
    expect(withLive).toEqual({ viewsGained: 80_000, endLagMs: 10 * 60_000 });
  });

  it("keeps a negative delta rather than clamping it", () => {
    // YouTube purges inflated counts. Clamping each channel's negative to
    // zero would bias every niche total upward one channel at a time.
    const measured = measureChannel(
      channel("c", [reading(START_MS - DAY_MS, 1_000_000), reading(NOW_MS - HOUR_MS, 940_000)]),
      "shorts",
      START_MS,
      NOW_MS,
    );

    expect(measured?.viewsGained).toBe(-60_000);
  });

  it("refuses a channel with one distinct reading — the migration's seed alone is no delta", () => {
    const seedMs = START_MS - 2 * DAY_MS;
    // The seed row and the live pair are the SAME reading at the same instant;
    // two copies of one instant are one reading.
    const onlySeed = channel("c", [reading(seedMs, 1_000_000), reading(seedMs, 1_000_000)]);
    expect(measureChannel(onlySeed, "shorts", START_MS, NOW_MS)).toBeNull();

    // And a channel whose readings all sit at or before the span's start has
    // nothing on the far side to subtract from — "gained nothing" would be a
    // claim about a channel nobody has looked at since.
    const stale = channel("c", [reading(seedMs, 1_000_000), reading(seedMs + HOUR_MS, 1_010_000)]);
    expect(measureChannel(stale, "shorts", START_MS, NOW_MS)).toBeNull();
  });
});

describe("the span: max of first readings, bracketed for every channel", () => {
  /**
   * =======================================================================
   * THE STAGGERED SWEEP — THE FIXTURE THAT BLACKED OUT THE PER-VIDEO BASIS
   * =======================================================================
   *
   * Three channels first read 0, 1.5 and 3 hours into the sweep, and a period
   * reaching back three weeks before any of them. The org-wide MINIMUM would
   * anchor the span at the first channel's first reading, where the other
   * two hold nothing at-or-before it and are dropped: one of three measured.
   * The max of firsts starts three hours later and every channel is inside.
   */
  const SWEEP_MS = START_MS + 21 * DAY_MS;
  const staggered = [
    channel("chan_first", [reading(SWEEP_MS, 1_000_000), reading(NOW_MS - HOUR_MS, 1_050_000)]),
    channel("chan_later", [
      reading(SWEEP_MS + 90 * 60_000, 2_000_000),
      reading(NOW_MS - HOUR_MS, 2_020_000),
    ]),
    channel("chan_rival", [
      reading(SWEEP_MS + 3 * HOUR_MS, 3_000_000),
      reading(NOW_MS - HOUR_MS, 3_030_000),
    ]),
  ];
  const members = new Map([
    [
      "niche_gta",
      [member("chan_first", "own"), member("chan_later", "own"), member("chan_rival", "competitor")],
    ],
  ]);

  it("measures EVERY channel whose first readings are staggered across the sweep", () => {
    const result = computeNicheViewsGained(input(staggered, members));

    // The span starts where the LAST channel's history does, not the first's.
    expect(result.measuredFromMs).toBe(SWEEP_MS + 3 * HOUR_MS);
    expect(result.historyBeganMs).toBe(SWEEP_MS + 3 * HOUR_MS);
    expect(result.niches[0]).toEqual({
      nicheId: "niche_gta",
      ourViewsGained: 70_000,
      competitorViewsGained: 30_000,
      measuredChannels: 3,
      totalChannels: 3,
      ownChannelIds: ["chan_first", "chan_later"],
      shareBasis: "estimated",
    });
    expect(result.maxEndLagMs).toBe(HOUR_MS);
  });

  it("pins the anchor as the MAX of first readings, so the org-wide minimum cannot come back", () => {
    const { measuredFromMs } = measurementStart(staggered, {
      requestedStartMs: START_MS,
      endMs: END_MS,
      nowMs: NOW_MS,
    });
    // Under the minimum, `chan_rival` would hold no reading at the anchor.
    expect(measuredFromMs).not.toBe(SWEEP_MS);
    expect(measuredFromMs).toBe(SWEEP_MS + 3 * HOUR_MS);
  });

  it("does not clamp when every channel's history reaches back past the period", () => {
    const { measuredFromMs, historyBeganMs } = measurementStart(
      [
        channel("a", [reading(START_MS - 10 * DAY_MS, 1), reading(NOW_MS, 2)]),
        channel("b", [reading(START_MS - 2 * DAY_MS, 1), reading(NOW_MS, 2)]),
      ],
      { requestedStartMs: START_MS, endMs: END_MS, nowMs: NOW_MS },
    );

    expect(measuredFromMs).toBe(START_MS);
    // The history began where the latest-starting channel's did.
    expect(historyBeganMs).toBe(START_MS - 2 * DAY_MS);
  });

  it("answers the no-history shape when no channel holds a reading", () => {
    const result = computeNicheViewsGained(
      input([channel("c", [])], new Map([["niche_gta", [member("c", "own")]]])),
    );

    expect(result).toEqual({
      requestedStartMs: START_MS,
      endMs: END_MS,
      measuredFromMs: null,
      historyBeganMs: null,
      maxEndLagMs: null,
      niches: [],
    });
  });

  it("answers the no-history shape when the history begins at or after the close", () => {
    const result = computeNicheViewsGained(
      input(
        [channel("c", [reading(END_MS + DAY_MS, 1), reading(END_MS + 2 * DAY_MS, 2)])],
        new Map([["niche_gta", [member("c", "own")]]]),
        // The period has closed; nothing inside it was ever read.
        { nowMs: END_MS + 3 * DAY_MS },
      ),
    );

    expect(result.measuredFromMs).toBeNull();
    expect(result.niches).toEqual([]);
  });

  /**
   * A channel added this morning has its first reading after the period's
   * close (or after now). Letting it into the max would push the span past
   * the close and blank EVERY niche because one competitor was added. It is
   * unmeasured instead, and the others keep their figure.
   */
  it("leaves a channel first read after the close out of the span instead of blanking the page", () => {
    const result = computeNicheViewsGained(
      input(
        [
          channel("chan_old", [reading(START_MS - DAY_MS, 1_000_000), reading(NOW_MS - HOUR_MS, 1_100_000)]),
          channel("chan_new", [reading(NOW_MS + HOUR_MS, 5_000_000)]),
        ],
        new Map([["niche_gta", [member("chan_old", "own"), member("chan_new", "competitor")]]]),
      ),
    );

    expect(result.measuredFromMs).toBe(START_MS);
    expect(result.niches[0]).toMatchObject({
      ourViewsGained: 100_000,
      competitorViewsGained: 0,
      measuredChannels: 1,
      totalChannels: 2,
    });
  });
});

describe("the format share", () => {
  it("is Shorts over classified, with uncertain videos in neither side", () => {
    expect(shortsShareOf(3, 1)).toBe(0.75);
    expect(shortsShareOf(0, 4)).toBe(0);
    // No classified video at all: no share, never 100%.
    expect(shortsShareOf(0, 0)).toBeNull();
  });

  it("scales a Shorts niche by the share and a Long Form niche by its complement", () => {
    expect(formatShareFactor(0.75, "shorts")).toBe(0.75);
    expect(formatShareFactor(0.75, "longform")).toBe(0.25);
    expect(formatShareFactor(null, "shorts")).toBeNull();
    expect(formatShareFactor(null, "longform")).toBeNull();
  });

  it("prices only the estimated share of a mixed channel's delta", () => {
    const mixed = channel(
      "c",
      [reading(START_MS - DAY_MS, 1_000_000), reading(NOW_MS - HOUR_MS, 1_100_000)],
      0.75,
    );

    expect(measureChannel(mixed, "shorts", START_MS, NOW_MS)?.viewsGained).toBe(75_000);
    expect(measureChannel(mixed, "longform", START_MS, NOW_MS)?.viewsGained).toBe(25_000);
  });

  it("excludes a channel with no classified video, and counts it as unmeasured", () => {
    const result = computeNicheViewsGained(
      input(
        [
          channel("chan_known", [reading(START_MS - DAY_MS, 1_000_000), reading(NOW_MS - HOUR_MS, 1_100_000)], 1),
          // A long-form channel's whole month would land in a Shorts niche if
          // a null share were read as "all Shorts".
          channel("chan_dark", [reading(START_MS - DAY_MS, 1_000_000), reading(NOW_MS - HOUR_MS, 9_000_000)], null),
        ],
        new Map([["niche_gta", [member("chan_known", "own"), member("chan_dark", "own")]]]),
      ),
    );

    expect(result.niches[0]).toMatchObject({
      ourViewsGained: 100_000,
      measuredChannels: 1,
      totalChannels: 2,
      ownChannelIds: ["chan_known"],
    });
  });
});

describe("grouping and the own/competitor split", () => {
  it("counts a channel filed under two niches in both, and splits by ownership", () => {
    const result = computeNicheViewsGained(
      input(
        [
          channel("chan_ours", [reading(START_MS - DAY_MS, 1_000_000), reading(NOW_MS - HOUR_MS, 1_100_000)]),
          channel("chan_rival", [reading(START_MS - DAY_MS, 5_000_000), reading(NOW_MS - HOUR_MS, 5_040_000)]),
        ],
        new Map([
          ["niche_gta", [member("chan_ours", "own"), member("chan_rival", "competitor")]],
          ["niche_football", [member("chan_ours", "own")]],
        ]),
      ),
    );

    expect(result.niches).toEqual([
      {
        nicheId: "niche_gta",
        ourViewsGained: 100_000,
        competitorViewsGained: 40_000,
        measuredChannels: 2,
        totalChannels: 2,
        ownChannelIds: ["chan_ours"],
        shareBasis: "estimated",
      },
      // The shared channel counts here TOO — correct per niche, and exactly
      // why the earnings builder refuses to SUM niches sharing a channel.
      {
        nicheId: "niche_football",
        ourViewsGained: 100_000,
        competitorViewsGained: 0,
        measuredChannels: 1,
        totalChannels: 1,
        ownChannelIds: ["chan_ours"],
        shareBasis: "estimated",
      },
    ]);
    // Swapping the two sides is a silent, plausible-looking mutation.
    expect(result.niches[0]!.ourViewsGained).not.toBe(result.niches[0]!.competitorViewsGained);
  });

  it("counts an unmeasured channel toward the total and toward nothing else", () => {
    const result = computeNicheViewsGained(
      input(
        [
          channel("chan_ours", [reading(START_MS - DAY_MS, 1_000_000), reading(NOW_MS - HOUR_MS, 1_100_000)]),
          // The seed alone — one reading. Its zero is "could not measure".
          channel("chan_seeded", [reading(START_MS - DAY_MS, 1_000_000)]),
        ],
        new Map([["niche_gta", [member("chan_ours", "own"), member("chan_seeded", "own")]]]),
      ),
    );

    expect(result.niches[0]).toEqual({
      nicheId: "niche_gta",
      ourViewsGained: 100_000,
      competitorViewsGained: 0,
      measuredChannels: 1,
      totalChannels: 2,
      // Not an id the total's double-count check needs to see.
      ownChannelIds: ["chan_ours"],
      shareBasis: "estimated",
    });
  });

  it("reports an empty niche as zero of zero channels, measured from the page's span", () => {
    const result = computeNicheViewsGained(
      input(
        [channel("chan_ours", [reading(START_MS - DAY_MS, 1), reading(NOW_MS, 2)])],
        new Map([
          ["niche_gta", [member("chan_ours", "own")]],
          ["niche_empty", []],
        ]),
      ),
    );

    expect(result.niches[1]).toMatchObject({
      nicheId: "niche_empty",
      measuredChannels: 0,
      totalChannels: 0,
      ourViewsGained: 0,
    });
  });
});
