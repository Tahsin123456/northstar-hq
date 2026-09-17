import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * =========================================================================
 * "ADD" ON A CHANNEL THE TRACKER ALREADY HOLDS MEANS "FILE IT"
 * =========================================================================
 *
 * The owner created a Long Form niche and found no way to put a channel in
 * it. Every channel worth filing was already tracked on the Shorts side, and
 * `addChannel` refused a tracked channel outright — while the Long Form
 * roster does not list a channel until it is filed under a Long Form niche,
 * and the Shorts picker offers no Long Form niches. The channel could not be
 * filed from either side.
 *
 * So a tracked channel sent WITH niches is filed under them, additively, and
 * nothing else about it moves. Pinned here:
 *   • the filing goes through `addChannelNiches`, never `setChannelNiches`;
 *   • no sync runs and no tracking row is written — not even `ownershipType`,
 *     which the dialog always sends and which would otherwise demote an own
 *     channel to "competitor" because it was added from the other side;
 *   • the result says `alreadyTracked` with a null `sync`;
 *   • a tracked channel sent with NO niches is still refused, exactly as
 *     before — that request has nothing to do.
 *
 * And the RESTORE path, which the review caught one branch over: a
 * soft-removed channel keeps its join rows, and the dialog restoring it from
 * the Long Form side offers only Long Form niches — so a wholesale set there
 * would have wiped every Shorts filing the moment an admin restored it. The
 * restore files additively too, and keeps the row's own ownership when the
 * request names none.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 13).toString("base64");

const ORG_ID = "org_northstar";

const mocks = vi.hoisted(() => ({
  resolveChannel: vi.fn(),
  upsertChannel: vi.fn(),
  syncChannel: vi.fn(),
  addChannelNiches: vi.fn(),
  evaluateHitsQuietly: vi.fn(),
  setChannelNiches: vi.fn(),
  trackedFindUnique: vi.fn(),
  trackedFindUniqueOrThrow: vi.fn(),
  trackedUpdate: vi.fn(),
  trackedCreate: vi.fn(),
  channelFindUniqueOrThrow: vi.fn(),
  channelDataSources: vi.fn(),
}));

vi.mock("@/server/db", () => ({
  prisma: {
    trackedChannel: {
      findUnique: mocks.trackedFindUnique,
      findUniqueOrThrow: mocks.trackedFindUniqueOrThrow,
      update: mocks.trackedUpdate,
      create: mocks.trackedCreate,
    },
    channel: { findUniqueOrThrow: mocks.channelFindUniqueOrThrow },
  },
}));

vi.mock("../youtube", () => ({ resolveChannel: mocks.resolveChannel }));
vi.mock("../channel-sync", () => ({
  upsertChannel: mocks.upsertChannel,
  syncChannel: mocks.syncChannel,
}));
vi.mock("../sync-service", () => ({
  buildChannelSyncOptions: vi.fn(async () => ({})),
  buildSyncOptions: vi.fn(async () => ({})),
}));
vi.mock("../hit-evaluation-service", () => ({
  evaluateHitsQuietly: mocks.evaluateHitsQuietly,
}));
vi.mock("../niche-service", () => ({
  addChannelNiches: mocks.addChannelNiches,
  setChannelNiches: mocks.setChannelNiches,
}));
vi.mock("../youtube-oauth-service", () => ({
  channelDataSources: mocks.channelDataSources,
  resolveChannelCredential: vi.fn(),
}));
vi.mock("../user-service", () => ({
  getScope: async () => ({ organizationId: ORG_ID, userId: "user_1" }),
  getCurrentOrgId: async () => ORG_ID,
  getCurrentOrgSettings: async () => ({}),
}));
vi.mock("@/server/auth/niche-scope", () => ({
  getVisibleNicheIds: async () => null,
  trackedChannelNicheFilter: () => ({}),
}));
// The mapper is not under test; what matters is which rows reach it.
vi.mock("@/server/mappers", () => ({
  toChannelDTO: (
    channel: { id: string; title: string },
    tracking: { niches: { niche: { id: string; name: string } }[] },
    dataSource: string,
  ) => ({
    id: channel.id,
    displayName: channel.title,
    niches: tracking.niches.map((row) => ({ id: row.niche.id, name: row.niche.name })),
    dataSource,
  }),
  toRefreshResultDTO: (sync: unknown) => sync,
}));

const { addChannel } = await import("../channel-service");

const CHANNEL_ROW = { id: "ch_1", title: "Dawnstarz", youtubeChannelId: "UC1", label: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveChannel.mockResolvedValue({ channel: { channelId: "UC1" } });
  mocks.upsertChannel.mockResolvedValue(CHANNEL_ROW);
  // Tracked, active, and the studio's OWN channel — the case the ownership
  // pin below is about.
  mocks.trackedFindUnique.mockResolvedValue({
    id: "tc_1",
    isActive: true,
    label: null,
    ownershipType: "own",
  });
  mocks.addChannelNiches.mockResolvedValue({ filed: 1 });
  mocks.evaluateHitsQuietly.mockResolvedValue(null);
  mocks.trackedFindUniqueOrThrow.mockResolvedValue({
    id: "tc_1",
    niches: [
      { niche: { id: "niche_gta", name: "GTA" } },
      { niche: { id: "niche_docs", name: "Docs" } },
    ],
    contentTypeRules: [],
  });
  mocks.channelDataSources.mockResolvedValue(new Map([["UC1", "connection"]]));
  mocks.channelFindUniqueOrThrow.mockResolvedValue(CHANNEL_ROW);
  mocks.trackedUpdate.mockResolvedValue({ id: "tc_1" });
  mocks.trackedCreate.mockResolvedValue({ id: "tc_1" });
  mocks.syncChannel.mockResolvedValue({
    dataSource: "public",
    status: "success",
    videosUpdated: 3,
    quotaUnitsUsed: 5,
  });
});

describe("restoring a channel that was removed", () => {
  beforeEach(() => {
    // Soft-removed: the row and its join rows are still there, isActive off.
    mocks.trackedFindUnique.mockResolvedValue({
      id: "tc_1",
      isActive: false,
      label: null,
      ownershipType: "own",
    });
  });

  it("files additively, so the filings the other side cannot see survive", async () => {
    const result = await addChannel("@dawnstarz", { nicheIds: ["niche_docs"] });

    expect(mocks.addChannelNiches).toHaveBeenCalledTimes(1);
    expect(mocks.addChannelNiches.mock.calls[0]).toEqual(["ch_1", ["niche_docs"]]);
    // The blocker: a set from the Long Form dialog would have run
    // deleteMany across BOTH formats for an admin and wiped GTA.
    expect(mocks.setChannelNiches).not.toHaveBeenCalled();
    expect(result.restored).toBe(true);
    expect(result.alreadyTracked).toBe(false);
    expect(result.sync).not.toBeNull();
  });

  it("keeps the row's own ownership when the request names none", async () => {
    await addChannel("@dawnstarz", { nicheIds: ["niche_docs"] });

    expect(mocks.trackedUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.trackedUpdate.mock.calls[0][0]).toMatchObject({
      where: { id: "tc_1" },
      data: { isActive: true, removedAt: null, ownershipType: "own" },
    });
  });

  it("applies the ownership the request does name", async () => {
    await addChannel("@dawnstarz", { ownershipType: "competitor", nicheIds: ["niche_docs"] });

    expect(mocks.trackedUpdate.mock.calls[0][0]).toMatchObject({
      data: { ownershipType: "competitor" },
    });
  });

  it("does not touch the filings at all when no niches are sent", async () => {
    await addChannel("@dawnstarz", {});

    expect(mocks.addChannelNiches).not.toHaveBeenCalled();
    expect(mocks.setChannelNiches).not.toHaveBeenCalled();
    expect(mocks.trackedUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("adding a channel that is already tracked", () => {
  it("files it under the niches sent, additively, and changes nothing else", async () => {
    const result = await addChannel("@dawnstarz", {
      // What the dialog always sends. It must be ignored on this path.
      ownershipType: "competitor",
      nicheIds: ["niche_docs"],
    });

    expect(mocks.addChannelNiches).toHaveBeenCalledTimes(1);
    expect(mocks.addChannelNiches.mock.calls[0]).toEqual(["ch_1", ["niche_docs"]]);
    // Additive, never a set: a set from the Long Form side would strip GTA.
    expect(mocks.setChannelNiches).not.toHaveBeenCalled();

    // Nothing about the tracking row moves — ownership included.
    expect(mocks.trackedUpdate).not.toHaveBeenCalled();
    expect(mocks.trackedCreate).not.toHaveBeenCalled();
    // No sync: the channel already has its history.
    expect(mocks.syncChannel).not.toHaveBeenCalled();

    expect(result.alreadyTracked).toBe(true);
    expect(result.restored).toBe(false);
    expect(result.sync).toBeNull();
    // The DTO reflects the row as filed, with both sides' niches on it.
    expect(result.channel.niches.map((niche) => niche.name)).toEqual(["GTA", "Docs"]);
  });

  it("is still refused when no niches are sent — there is nothing to do", async () => {
    await expect(addChannel("@dawnstarz", { ownershipType: "competitor" })).rejects.toMatchObject(
      { code: "CHANNEL_ALREADY_TRACKED" },
    );
    await expect(addChannel("@dawnstarz", { nicheIds: [] })).rejects.toMatchObject({
      code: "CHANNEL_ALREADY_TRACKED",
    });

    expect(mocks.addChannelNiches).not.toHaveBeenCalled();
    expect(mocks.trackedUpdate).not.toHaveBeenCalled();
    expect(mocks.syncChannel).not.toHaveBeenCalled();
  });
});

/**
 * =========================================================================
 * THE VERDICTS ARE ASKED FOR AFTER THE HISTORY ARRIVES, NOT BEFORE
 * =========================================================================
 *
 * The owner filed a channel under a Long Form niche carrying a complete rule
 * and the overview answered "Not configured" over ten long-form videos.
 *
 * The filing deliberately precedes the sync, so that organising a channel
 * survives an unreachable YouTube. Filing also triggers a re-judge. On a
 * channel new to the database those two facts collide: the re-judge runs over
 * a library with no videos in it, writes nothing, and the sync then imports
 * the whole history with no verdict against any of it. Nothing else on the
 * request looks again, and every hit-rate surface renders that silence as
 * "Not configured" until the hourly sweep.
 *
 * ORDER IS THE WHOLE ASSERTION, which is why these record a sequence rather
 * than counting calls. A second judge call placed above the sync would satisfy
 * "it judges" and fix nothing.
 */
describe("judging a newly added channel", () => {
  /** Every mocked step appends its name here, in the order it actually ran. */
  function recordOrder(): string[] {
    const order: string[] = [];
    mocks.addChannelNiches.mockImplementation(async () => {
      order.push("file");
      return { filed: 1 };
    });
    mocks.syncChannel.mockImplementation(async () => {
      order.push("sync");
      return { dataSource: "public", status: "success", videosUpdated: 10, quotaUnitsUsed: 5 };
    });
    mocks.evaluateHitsQuietly.mockImplementation(async () => {
      order.push("judge");
      return null;
    });
    return order;
  }

  it("judges after the sync, not before it", async () => {
    mocks.trackedFindUnique.mockResolvedValue(null); // brand new channel
    const order = recordOrder();

    await addChannel("@dawnstarz", { nicheIds: ["niche_docs"] });

    expect(order).toEqual(["file", "sync", "judge"]);
  });

  it("asks for this channel, so both formats' passes run over it", async () => {
    mocks.trackedFindUnique.mockResolvedValue(null);

    await addChannel("@dawnstarz", { nicheIds: ["niche_docs"] });

    // Channel-scoped, never niche-scoped: a niche list decides which FORMAT
    // passes run, so filing into one shorts niche would leave this channel's
    // long-form videos unjudged — the owner's exact complaint.
    expect(mocks.evaluateHitsQuietly).toHaveBeenCalledTimes(1);
    expect(mocks.evaluateHitsQuietly.mock.calls[0][0]).toBe(ORG_ID);
    expect(mocks.evaluateHitsQuietly.mock.calls[0][1]).toEqual({ channelIds: ["ch_1"] });
  });

  it("judges a channel added under no niches at all", async () => {
    // Its Shorts still need verdicts — the shorts pass has no membership gate,
    // and an unfiled channel's rows are what make "no rule yet" honest rather
    // than indistinguishable from "not judged yet".
    mocks.trackedFindUnique.mockResolvedValue(null);

    await addChannel("@dawnstarz", {});

    expect(mocks.addChannelNiches).not.toHaveBeenCalled();
    expect(mocks.evaluateHitsQuietly).toHaveBeenCalledTimes(1);
  });

  it("leaves the judging to the filing on a channel that is already tracked", async () => {
    // That branch never syncs — the history is already there — so the filing's
    // own re-judge is the right and only one.
    await addChannel("@dawnstarz", { nicheIds: ["niche_docs"] });

    expect(mocks.syncChannel).not.toHaveBeenCalled();
    expect(mocks.evaluateHitsQuietly).not.toHaveBeenCalled();
  });
});
