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
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 13).toString("base64");

const ORG_ID = "org_northstar";

const mocks = vi.hoisted(() => ({
  resolveChannel: vi.fn(),
  upsertChannel: vi.fn(),
  syncChannel: vi.fn(),
  addChannelNiches: vi.fn(),
  setChannelNiches: vi.fn(),
  trackedFindUnique: vi.fn(),
  trackedFindUniqueOrThrow: vi.fn(),
  trackedUpdate: vi.fn(),
  trackedCreate: vi.fn(),
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
    channel: { findUniqueOrThrow: vi.fn() },
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
  mocks.trackedFindUniqueOrThrow.mockResolvedValue({
    id: "tc_1",
    niches: [
      { niche: { id: "niche_gta", name: "GTA" } },
      { niche: { id: "niche_docs", name: "Docs" } },
    ],
    contentTypeRules: [],
  });
  mocks.channelDataSources.mockResolvedValue(new Map([["UC1", "connection"]]));
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
