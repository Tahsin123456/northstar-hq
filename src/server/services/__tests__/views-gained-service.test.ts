import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * =========================================================================
 * VIEWS GAINED — THE MEASUREMENT'S OWN RULES, PINNED AT THE SOURCE
 * =========================================================================
 *
 * The adapter-level pin (`niche-rpm-views-gained-pin.test.ts`) proves the
 * derived RPM did not move across the extraction. This file pins the shared
 * measurement itself, rule by rule, because it now feeds a second caller —
 * the niche money figures — whose refusals are built out of `coveredVideos`
 * and `totalVideos` rather than out of the RPM judge.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 19).toString("base64");

const ORG_ID = "org_northstar";
const DAY_MS = 86_400_000;
const START_MS = Date.UTC(2026, 7, 1);
const END_MS = Date.UTC(2026, 7, 31);
const WINDOW = { startMs: START_MS, endMs: END_MS };

const mocks = vi.hoisted(() => ({
  videoFindMany: vi.fn(),
}));

vi.mock("@/server/db", () => ({
  prisma: { video: { findMany: mocks.videoFindMany } },
}));

const { viewsGainedByChannel, SNAPSHOT_LOOKBACK_DAYS, baselineGraceMsFor } = await import(
  "../views-gained-service"
);

const HOUR_MS = 3_600_000;
/** 5% of the 30-day fixture window: 36 hours. */
const GRACE_MS = baselineGraceMsFor(START_MS, END_MS);

function snapshot(capturedAtMs: number, viewCount: number) {
  return { capturedAt: new Date(capturedAtMs), viewCount: BigInt(viewCount) };
}

/** A video row as the service selects it. A positively classified Short. */
function video(overrides: {
  id: string;
  channelId: string;
  publishedAtMs: number;
  snapshots: readonly { capturedAt: Date; viewCount: bigint }[];
  isShort?: boolean;
  classification?: string;
}) {
  return {
    id: overrides.id,
    channelId: overrides.channelId,
    publishedAt: new Date(overrides.publishedAtMs),
    isShort: overrides.isShort ?? true,
    classification: overrides.classification ?? "short",
    snapshots: overrides.snapshots,
  };
}

async function measure(
  rows: readonly unknown[],
  options: {
    channelIds?: readonly string[];
    format?: "shorts" | "longform";
    baselineGraceMs?: number;
  } = {},
) {
  mocks.videoFindMany.mockResolvedValue(rows);
  return viewsGainedByChannel({
    organizationId: ORG_ID,
    channelIds: options.channelIds ?? ["chan_a"],
    window: WINDOW,
    ...(options.format === undefined ? {} : { format: options.format }),
    ...(options.baselineGraceMs === undefined
      ? {}
      : { baselineGraceMs: options.baselineGraceMs }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the delta rules", () => {
  it("zero-bases a video born inside the window — the one factual zero", async () => {
    const gained = await measure([
      video({
        id: "vid_new",
        channelId: "chan_a",
        publishedAtMs: START_MS + 5 * DAY_MS,
        // No reading at the window's start exists and none is needed: the
        // video did not exist, so its whole end reading is the delta.
        snapshots: [snapshot(END_MS - DAY_MS, 120_000)],
      }),
    ]);

    expect(gained.get("chan_a")).toEqual({
      viewsGained: 120_000,
      coveredVideos: 1,
      totalVideos: 1,
      // Publication IS the baseline instant, so nothing is missing from the head
      // of the span — a factual zero carries no lag.
      maxBaselineLagMs: 0,
    });
  });

  it("drops an OLD video with no start reading from the sum but not from the total", async () => {
    const gained = await measure([
      video({
        id: "vid_covered",
        channelId: "chan_a",
        publishedAtMs: START_MS - 90 * DAY_MS,
        snapshots: [snapshot(START_MS - DAY_MS, 100_000), snapshot(END_MS - DAY_MS, 150_000)],
      }),
      video({
        id: "vid_uncovered",
        channelId: "chan_a",
        publishedAtMs: START_MS - 90 * DAY_MS,
        // Only an end reading: its start count is unknown, and zero-basing it
        // would credit the window with nine million lifetime views.
        snapshots: [snapshot(END_MS - DAY_MS, 9_000_000)],
      }),
    ]);

    // Covered shrinks; total does not. The gap IS the coverage figure every
    // money caller holds a floor against.
    expect(gained.get("chan_a")).toEqual({
      viewsGained: 50_000,
      coveredVideos: 1,
      totalVideos: 2,
      // No grace was asked for, so nothing was baselined late.
      maxBaselineLagMs: 0,
    });
  });

  it("keeps a negative delta rather than clamping it", async () => {
    const gained = await measure([
      video({
        id: "vid_purged",
        channelId: "chan_a",
        publishedAtMs: START_MS - 90 * DAY_MS,
        snapshots: [snapshot(START_MS - DAY_MS, 500_000), snapshot(END_MS - DAY_MS, 420_000)],
      }),
    ]);

    expect(gained.get("chan_a")?.viewsGained).toBe(-80_000);
    expect(gained.get("chan_a")?.coveredVideos).toBe(1);
  });

  it("keeps a covered-nothing channel IN the map, at zero coverage", async () => {
    const gained = await measure(
      [
        video({
          id: "vid_dark",
          channelId: "chan_dark",
          publishedAtMs: START_MS - 90 * DAY_MS,
          snapshots: [],
        }),
      ],
      { channelIds: ["chan_dark", "chan_empty"] },
    );

    // Present, so the niche caller can count the unmeasured library toward
    // its coverage denominator. The RPM adapter re-applies its own omission.
    expect(gained.get("chan_dark")).toEqual({
      viewsGained: 0,
      coveredVideos: 0,
      totalVideos: 1,
      maxBaselineLagMs: 0,
    });
    // A channel with no videos at all still answers, with an empty library.
    expect(gained.get("chan_empty")).toEqual({
      viewsGained: 0,
      coveredVideos: 0,
      totalVideos: 0,
      maxBaselineLagMs: 0,
    });
  });
});

/**
 * =========================================================================
 * THE BASELINE GRACE — THE 1 SEPTEMBER BLACKOUT, PINNED IN BOTH DIRECTIONS
 * =========================================================================
 *
 * First-ever snapshots are written channel by channel over minutes to hours,
 * so the org-wide earliest capture is the instant at which the FEWEST videos
 * hold a reading. Every video first captured moments later was dropped from
 * the sum AND from `coveredVideos`, which is how coverage reached a few
 * percent against a 0.9 floor and every niche printed "Not enough view history
 * yet" while the owner had rates entered.
 *
 * Each case below pins one half of the fix: what the grace now admits, what it
 * still refuses, and that admitting can only ever subtract.
 */
describe("the baseline grace", () => {
  /** The straggler: no reading at the window's start, first seen two hours in. */
  const straggler = (firstReadingMs: number) =>
    video({
      id: "vid_late",
      channelId: "chan_a",
      publishedAtMs: START_MS - 90 * DAY_MS,
      snapshots: [
        snapshot(firstReadingMs, 8_900_000),
        snapshot(END_MS - DAY_MS, 9_000_000),
      ],
    });

  it("measures a late-baselined video from its own first reading instead of dropping it", async () => {
    const rows = [
      video({
        id: "vid_covered",
        channelId: "chan_a",
        publishedAtMs: START_MS - 90 * DAY_MS,
        snapshots: [
          snapshot(START_MS - DAY_MS, 100_000),
          snapshot(END_MS - DAY_MS, 150_000),
        ],
      }),
      straggler(START_MS + 2 * HOUR_MS),
    ];

    // THE OLD RULE, still the default: the straggler is thrown away whole, and
    // coverage lands at 0.5 — under the 0.9 floor, so nothing prices.
    expect(await measure(rows)).toEqual(
      new Map([
        [
          "chan_a",
          { viewsGained: 50_000, coveredVideos: 1, totalVideos: 2, maxBaselineLagMs: 0 },
        ],
      ]),
    );

    // THE NEW RULE: 100,000 of its own gains join the sum, coverage is whole,
    // and the two hours it is missing travel back so the label can say so.
    expect(await measure(rows, { baselineGraceMs: GRACE_MS })).toEqual(
      new Map([
        [
          "chan_a",
          {
            viewsGained: 150_000,
            coveredVideos: 2,
            totalVideos: 2,
            maxBaselineLagMs: 2 * HOUR_MS,
          },
        ],
      ]),
    );
  });

  it("understates rather than overstates — the graced gain never exceeds the true one", async () => {
    // The same video twice: once with the pre-window reading it would have had
    // if the sweep had reached it in time, once without.
    const truth = await measure([
      video({
        id: "vid_late",
        channelId: "chan_a",
        publishedAtMs: START_MS - 90 * DAY_MS,
        snapshots: [
          snapshot(START_MS - HOUR_MS, 8_800_000),
          snapshot(START_MS + 2 * HOUR_MS, 8_900_000),
          snapshot(END_MS - DAY_MS, 9_000_000),
        ],
      }),
    ]);
    const graced = await measure([straggler(START_MS + 2 * HOUR_MS)], {
      baselineGraceMs: GRACE_MS,
    });

    // 200,000 is what really happened; 100,000 is what the grace can prove.
    expect(truth.get("chan_a")?.viewsGained).toBe(200_000);
    expect(graced.get("chan_a")?.viewsGained).toBe(100_000);
    expect(graced.get("chan_a")!.viewsGained).toBeLessThan(
      truth.get("chan_a")!.viewsGained,
    );
    // And the shortfall is exactly the head of the span the label reports.
    expect(graced.get("chan_a")?.maxBaselineLagMs).toBe(2 * HOUR_MS);
  });

  it("still drops a straggler beyond the grace, and still lets it depress coverage", async () => {
    const gained = await measure(
      [
        video({
          id: "vid_covered",
          channelId: "chan_a",
          publishedAtMs: START_MS - 90 * DAY_MS,
          snapshots: [
            snapshot(START_MS - DAY_MS, 100_000),
            snapshot(END_MS - DAY_MS, 150_000),
          ],
        }),
        // Onboarded two days in — outside the 36-hour grace. Calling its last
        // 28 days a 30-day gain is a distortion, not a rounding, so the floor
        // is meant to catch this niche and does.
        straggler(START_MS + 2 * DAY_MS),
      ],
      { baselineGraceMs: GRACE_MS },
    );

    expect(gained.get("chan_a")).toEqual({
      viewsGained: 50_000,
      coveredVideos: 1,
      totalVideos: 2,
      maxBaselineLagMs: 0,
    });
  });

  it("refuses a video seen only once inside the window — one reading is no delta", async () => {
    const gained = await measure(
      [
        video({
          id: "vid_once",
          channelId: "chan_a",
          publishedAtMs: START_MS - 90 * DAY_MS,
          snapshots: [snapshot(START_MS + HOUR_MS, 4_000_000)],
        }),
      ],
      { baselineGraceMs: GRACE_MS },
    );

    // Covered at zero gain would be worse than dropped: it would hide a video
    // nothing was measured from behind the very floor meant to catch it.
    expect(gained.get("chan_a")).toEqual({
      viewsGained: 0,
      coveredVideos: 0,
      totalVideos: 1,
      maxBaselineLagMs: 0,
    });
  });

  it("leaves the other rules alone — a born-inside video and a negative delta", async () => {
    const gained = await measure(
      [
        video({
          id: "vid_new",
          channelId: "chan_a",
          publishedAtMs: START_MS + 5 * DAY_MS,
          snapshots: [snapshot(END_MS - DAY_MS, 120_000)],
        }),
        video({
          id: "vid_purged",
          channelId: "chan_a",
          publishedAtMs: START_MS - 90 * DAY_MS,
          snapshots: [
            snapshot(START_MS - DAY_MS, 500_000),
            snapshot(END_MS - DAY_MS, 420_000),
          ],
        }),
      ],
      { baselineGraceMs: GRACE_MS },
    );

    // 120,000 − 80,000. The factual zero still applies and the negative is
    // still kept; neither video is baselined late, so the lag stays 0.
    expect(gained.get("chan_a")).toEqual({
      viewsGained: 40_000,
      coveredVideos: 2,
      totalVideos: 2,
      maxBaselineLagMs: 0,
    });
  });

  it("sizes the grace at a twentieth of the span, so it scales with the period", () => {
    expect(baselineGraceMsFor(START_MS, END_MS)).toBe(36 * HOUR_MS);
    expect(baselineGraceMsFor(START_MS, START_MS + 7 * DAY_MS)).toBe(8.4 * HOUR_MS);
    // A window with no width earns no allowance at all.
    expect(baselineGraceMsFor(START_MS, START_MS)).toBe(0);
  });
});

describe("the format filter", () => {
  const rows = [
    video({
      id: "vid_short",
      channelId: "chan_a",
      publishedAtMs: START_MS + DAY_MS,
      isShort: true,
      classification: "short",
      snapshots: [snapshot(END_MS - DAY_MS, 1_000)],
    }),
    video({
      id: "vid_long",
      channelId: "chan_a",
      publishedAtMs: START_MS + DAY_MS,
      isShort: false,
      classification: "not_short",
      snapshots: [snapshot(END_MS - DAY_MS, 20_000)],
    }),
    video({
      id: "vid_uncertain",
      channelId: "chan_a",
      publishedAtMs: START_MS + DAY_MS,
      isShort: false,
      classification: "uncertain",
      snapshots: [snapshot(END_MS - DAY_MS, 300_000)],
    }),
  ];

  it("counts only positively identified Shorts for the shorts format", async () => {
    const gained = await measure(rows, { format: "shorts" });

    expect(gained.get("chan_a")).toEqual({
      viewsGained: 1_000,
      coveredVideos: 1,
      totalVideos: 1,
      maxBaselineLagMs: 0,
    });
  });

  it("counts only positively identified long-form for the longform format — never !isShort", async () => {
    const gained = await measure(rows, { format: "longform" });

    // 20,000, not 320,000: the uncertain video has `isShort: false` too, and
    // catching it here is exactly the inflation `isVideoOfFormat` forbids.
    expect(gained.get("chan_a")).toEqual({
      viewsGained: 20_000,
      coveredVideos: 1,
      totalVideos: 1,
      maxBaselineLagMs: 0,
    });
  });

  it("measures channel-wide when no format is named — the RPM denominator's contract", async () => {
    const gained = await measure(rows);

    expect(gained.get("chan_a")).toEqual({
      viewsGained: 321_000,
      coveredVideos: 3,
      totalVideos: 3,
      maxBaselineLagMs: 0,
    });
  });
});

describe("what is asked of the database", () => {
  it("bounds the snapshot read to the 60-day lookback and scopes it to the organization", async () => {
    await measure([]);

    const args = mocks.videoFindMany.mock.calls[0][0];
    expect(args.where.channel).toEqual({
      trackedBy: { some: { organizationId: ORG_ID, isActive: true } },
    });
    expect(args.select.snapshots.where.capturedAt).toEqual({
      gte: new Date(START_MS - SNAPSHOT_LOOKBACK_DAYS * DAY_MS),
      lt: new Date(END_MS),
    });
  });
});
