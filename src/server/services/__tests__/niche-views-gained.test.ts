import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * =========================================================================
 * VIEWS GAINED, GROUPED PER NICHE — WHAT THE SERVICE LOADS, AND FOR WHOM
 * =========================================================================
 *
 * The arithmetic lives in `channel-views-gained.ts` and is pinned there. What
 * this file holds the SERVICE to is the loading:
 *
 *   • the READINGS: each member channel's `ChannelViewSnapshot` rows inside
 *     the lookback, PLUS the live pair (`channels.viewCount` at
 *     `channels.lastFetchedAt`), reached through the organization's tracker;
 *   • the SHARE: Shorts and long-form video counts per channel, grouped on
 *     both format columns so an uncertain video lands in neither;
 *   • the SCOPE: a niche-scoped reader's invisible niches are omitted from
 *     the response, because even a view total is a statement about a niche
 *     they were not assigned.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 19).toString("base64");

const ORG_ID = "org_northstar";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const START_MS = Date.UTC(2026, 7, 1);
const END_MS = Date.UTC(2026, 7, 31);
const NOW_MS = END_MS - 12 * HOUR_MS;

const mocks = vi.hoisted(() => ({
  nicheFindMany: vi.fn(),
  trackedFindMany: vi.fn(),
  channelFindMany: vi.fn(),
  videoGroupBy: vi.fn(),
  memberNicheFindMany: vi.fn(),
  role: "admin" as string,
}));

vi.mock("@/server/db", () => ({
  prisma: {
    niche: { findMany: mocks.nicheFindMany },
    trackedChannel: { findMany: mocks.trackedFindMany },
    channel: { findMany: mocks.channelFindMany },
    video: { groupBy: mocks.videoGroupBy },
    memberNiche: { findMany: mocks.memberNicheFindMany },
  },
}));

vi.mock("@/server/auth/dal", () => ({
  requireActor: async () => ({
    userId: "user_1",
    organizationId: ORG_ID,
    role: mocks.role,
  }),
}));

vi.mock("../user-service", () => ({
  getCurrentOrgId: async () => ORG_ID,
}));

const { getNicheViewsGained, CHANNEL_READING_LOOKBACK_DAYS } = await import(
  "../niche-views-gained-service"
);

function snapshot(capturedAtMs: number, viewCount: number) {
  return { capturedAt: new Date(capturedAtMs), viewCount: BigInt(viewCount) };
}

/** A channel row as the service selects it: readings, plus the live pair. */
function channelRow(
  id: string,
  snapshots: readonly { capturedAt: Date; viewCount: bigint }[],
  live: { viewCount: number; lastFetchedAt: number } | null = null,
) {
  return {
    id,
    viewCount: live === null ? null : BigInt(live.viewCount),
    lastFetchedAt: live === null ? null : new Date(live.lastFetchedAt),
    viewSnapshots: snapshots,
  };
}

/** One groupBy row: `count` videos of this channel with these two columns. */
function shareRow(channelId: string, isShort: boolean, classification: string, count: number) {
  return { channelId, isShort, classification, _count: { _all: count } };
}

function tracked(channelId: string, ownershipType: string, nicheIds: readonly string[]) {
  return {
    channelId,
    ownershipType,
    niches: nicheIds.map((nicheId) => ({ nicheId })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = "admin";
  mocks.memberNicheFindMany.mockResolvedValue([]);
  mocks.nicheFindMany.mockResolvedValue([{ id: "niche_gta" }, { id: "niche_football" }]);
  mocks.trackedFindMany.mockResolvedValue([]);
  mocks.channelFindMany.mockResolvedValue([]);
  mocks.videoGroupBy.mockResolvedValue([]);
});

const request = () =>
  getNicheViewsGained({ format: "shorts", startMs: START_MS, endMs: END_MS, nowMs: NOW_MS });

describe("the readings the service measures from", () => {
  it("brackets each channel from its stored readings and splits by ownership", async () => {
    mocks.trackedFindMany.mockResolvedValue([
      tracked("chan_ours", "own", ["niche_gta", "niche_football"]),
      tracked("chan_rival", "competitor", ["niche_gta"]),
    ]);
    mocks.channelFindMany.mockResolvedValue([
      channelRow("chan_ours", [
        snapshot(START_MS - DAY_MS, 1_000_000),
        snapshot(NOW_MS - HOUR_MS, 1_100_000),
      ]),
      channelRow("chan_rival", [
        snapshot(START_MS - DAY_MS, 5_000_000),
        snapshot(NOW_MS - HOUR_MS, 5_040_000),
      ]),
    ]);
    mocks.videoGroupBy.mockResolvedValue([
      shareRow("chan_ours", true, "short", 10),
      shareRow("chan_rival", true, "short", 4),
    ]);

    const result = await request();

    expect(result.measuredFromMs).toBe(START_MS);
    expect(result.maxEndLagMs).toBe(HOUR_MS);
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
  });

  /**
   * `channels.viewCount` is overwritten at step 1 of every sync and the row
   * for it is written at the same instant, but a channel whose latest sync
   * predates this deploy holds only the migration's seed — and the seed IS
   * the live pair. Either way the live pair is a reading the service must
   * offer; the core decides whether it is new.
   */
  it("adds the live counter as a reading at its own fetch instant", async () => {
    mocks.trackedFindMany.mockResolvedValue([tracked("chan_ours", "own", ["niche_gta"])]);
    mocks.channelFindMany.mockResolvedValue([
      channelRow(
        "chan_ours",
        [snapshot(START_MS - DAY_MS, 1_000_000)],
        // Fetched an hour ago, and no row for it (yet).
        { viewCount: 1_250_000, lastFetchedAt: NOW_MS - HOUR_MS },
      ),
    ]);
    mocks.videoGroupBy.mockResolvedValue([shareRow("chan_ours", true, "short", 1)]);

    const result = await request();

    expect(result.niches[0]).toMatchObject({ ourViewsGained: 250_000, measuredChannels: 1 });
    expect(result.maxEndLagMs).toBe(HOUR_MS);
  });

  it("leaves a channel with nothing but its seed unmeasured, and counts it", async () => {
    const seedMs = START_MS - DAY_MS;
    mocks.trackedFindMany.mockResolvedValue([
      tracked("chan_ours", "own", ["niche_gta"]),
      tracked("chan_seeded", "own", ["niche_gta"]),
    ]);
    mocks.channelFindMany.mockResolvedValue([
      channelRow("chan_ours", [snapshot(START_MS - DAY_MS, 1_000_000), snapshot(NOW_MS - HOUR_MS, 1_100_000)]),
      // The seed row and the live pair are one reading: same instant.
      channelRow("chan_seeded", [snapshot(seedMs, 3_000_000)], {
        viewCount: 3_000_000,
        lastFetchedAt: seedMs,
      }),
    ]);
    mocks.videoGroupBy.mockResolvedValue([
      shareRow("chan_ours", true, "short", 1),
      shareRow("chan_seeded", true, "short", 1),
    ]);

    const result = await request();

    expect(result.niches[0]).toMatchObject({
      ourViewsGained: 100_000,
      measuredChannels: 1,
      totalChannels: 2,
      ownChannelIds: ["chan_ours"],
    });
  });

  it("bounds the reading load to the lookback, scoped to the organization's tracker", async () => {
    mocks.trackedFindMany.mockResolvedValue([tracked("chan_ours", "own", ["niche_gta"])]);

    await request();

    const args = mocks.channelFindMany.mock.calls[0][0];
    expect(CHANNEL_READING_LOOKBACK_DAYS).toBe(60);
    expect(args.where.id).toEqual({ in: ["chan_ours"] });
    expect(args.where.trackedBy).toEqual({ some: { organizationId: ORG_ID, isActive: true } });
    expect(args.select.viewSnapshots.where.capturedAt).toEqual({
      gte: new Date(START_MS - 60 * DAY_MS),
      lte: new Date(END_MS),
    });
    // The live pair travels on the same select.
    expect(args.select.viewCount).toBe(true);
    expect(args.select.lastFetchedAt).toBe(true);
  });

  it("asks nothing of the channel series when no channel is being priced", async () => {
    mocks.trackedFindMany.mockResolvedValue([]);

    const result = await request();

    expect(mocks.channelFindMany).not.toHaveBeenCalled();
    expect(mocks.videoGroupBy).not.toHaveBeenCalled();
    expect(result.measuredFromMs).toBeNull();
    expect(result.niches).toEqual([]);
  });
});

describe("the Shorts share", () => {
  const readings = [snapshot(START_MS - DAY_MS, 1_000_000), snapshot(NOW_MS - HOUR_MS, 1_100_000)];

  it("is grouped on both format columns, and scales the delta", async () => {
    mocks.trackedFindMany.mockResolvedValue([tracked("chan_mixed", "own", ["niche_gta"])]);
    mocks.channelFindMany.mockResolvedValue([channelRow("chan_mixed", readings)]);
    mocks.videoGroupBy.mockResolvedValue([
      shareRow("chan_mixed", true, "short", 3),
      shareRow("chan_mixed", false, "not_short", 1),
      // Uncertain: in NEITHER side of the share.
      shareRow("chan_mixed", false, "uncertain", 12),
    ]);

    const shorts = await request();
    expect(shorts.niches[0]!.ourViewsGained).toBe(75_000);

    const longform = await getNicheViewsGained({
      format: "longform",
      startMs: START_MS,
      endMs: END_MS,
      nowMs: NOW_MS,
    });
    expect(longform.niches[0]!.ourViewsGained).toBe(25_000);

    const args = mocks.videoGroupBy.mock.calls[0][0];
    expect(args.by).toEqual(["channelId", "isShort", "classification"]);
    expect(args.where).toEqual({ channelId: { in: ["chan_mixed"] } });
  });

  it("excludes a channel with no classified video rather than calling it all Shorts", async () => {
    mocks.trackedFindMany.mockResolvedValue([tracked("chan_dark", "own", ["niche_gta"])]);
    mocks.channelFindMany.mockResolvedValue([channelRow("chan_dark", readings)]);
    mocks.videoGroupBy.mockResolvedValue([shareRow("chan_dark", false, "uncertain", 5)]);

    const result = await request();

    expect(result.niches[0]).toMatchObject({
      ourViewsGained: 0,
      measuredChannels: 0,
      totalChannels: 1,
      ownChannelIds: [],
    });
  });
});

describe("the measured span", () => {
  it("clamps the measurement to where the LAST channel's history begins", async () => {
    const sweepMs = START_MS + 21 * DAY_MS;
    mocks.trackedFindMany.mockResolvedValue([
      tracked("chan_first", "own", ["niche_gta"]),
      tracked("chan_rival", "competitor", ["niche_gta"]),
    ]);
    mocks.channelFindMany.mockResolvedValue([
      channelRow("chan_first", [snapshot(sweepMs, 1_000_000), snapshot(NOW_MS - HOUR_MS, 1_050_000)]),
      channelRow("chan_rival", [
        snapshot(sweepMs + 3 * HOUR_MS, 3_000_000),
        snapshot(NOW_MS - HOUR_MS, 3_030_000),
      ]),
    ]);
    mocks.videoGroupBy.mockResolvedValue([
      shareRow("chan_first", true, "short", 1),
      shareRow("chan_rival", true, "short", 1),
    ]);

    const result = await request();

    expect(result.requestedStartMs).toBe(START_MS);
    expect(result.measuredFromMs).toBe(sweepMs + 3 * HOUR_MS);
    expect(result.historyBeganMs).toBe(sweepMs + 3 * HOUR_MS);
    // Both measured — the whole point of the max over the min.
    expect(result.niches[0]).toMatchObject({
      ourViewsGained: 50_000,
      competitorViewsGained: 30_000,
      measuredChannels: 2,
      totalChannels: 2,
    });
  });

  it("answers the no-history shape when no channel holds a reading yet", async () => {
    mocks.trackedFindMany.mockResolvedValue([tracked("chan_ours", "own", ["niche_gta"])]);
    mocks.channelFindMany.mockResolvedValue([channelRow("chan_ours", [])]);

    const result = await request();

    expect(result).toEqual({
      requestedStartMs: START_MS,
      endMs: END_MS,
      measuredFromMs: null,
      historyBeganMs: null,
      maxEndLagMs: null,
      niches: [],
    });
  });
});

describe("the niche scope", () => {
  it("omits a scoped reader's invisible niches from the query and the response", async () => {
    mocks.role = "short_form_editor";
    mocks.memberNicheFindMany.mockResolvedValue([{ nicheId: "niche_gta" }]);
    mocks.trackedFindMany.mockResolvedValue([tracked("chan_ours", "own", ["niche_gta", "niche_hidden"])]);
    mocks.channelFindMany.mockResolvedValue([
      channelRow("chan_ours", [snapshot(START_MS - DAY_MS, 1), snapshot(NOW_MS, 2)]),
    ]);
    mocks.videoGroupBy.mockResolvedValue([shareRow("chan_ours", true, "short", 1)]);
    mocks.nicheFindMany.mockImplementation(async (args: { where: { id?: { in: string[] } } }) => {
      // The narrowing must live in the WHERE — filtering the response after
      // loading the rows is the leak every other scoped read refuses.
      expect(args.where.id).toEqual({ in: ["niche_gta"] });
      return [{ id: "niche_gta" }];
    });

    const result = await request();

    // And a membership outside the scope is not filed under, even though the
    // channel row carried it.
    expect(result.niches.map((entry) => entry.nicheId)).toEqual(["niche_gta"]);
  });

  it("fails closed for a scoped reader with no assignments", async () => {
    mocks.role = "short_form_editor";
    mocks.memberNicheFindMany.mockResolvedValue([]);
    mocks.nicheFindMany.mockResolvedValue([]);

    const result = await request();

    expect(result.niches).toEqual([]);
    // No member read happens for an empty catalogue.
    expect(mocks.trackedFindMany).not.toHaveBeenCalled();
  });
});
