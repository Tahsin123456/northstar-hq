import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * =========================================================================
 * FILING A TRACKED CHANNEL UNDER MORE NICHES TOUCHES NOTHING ELSE
 * =========================================================================
 *
 * `addChannelNiches` exists because `setChannelNiches` cannot do this job. A
 * set replaces the channel's list within the caller's own side of the
 * operation — and the Long Form side never ships a channel's Shorts filings,
 * so a Long Form caller sending "these niches" would send the Shorts ones
 * back short and strip them. Additive filing has no unfiling power at all.
 *
 * What is pinned, against the real role table:
 *   • only the MISSING join rows are written, and nothing is ever deleted;
 *   • a niche the caller's role may not file into is refused before any write
 *     (`requireFormat`, the same gate a set meets);
 *   • a niche from another organization reads as "no longer exists";
 *   • a niche the channel already carries is a no-op, not an error.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 9).toString("base64");

const ORG_ID = "org_northstar";

const mocks = vi.hoisted(() => ({
  trackedFindFirst: vi.fn(),
  nicheFindMany: vi.fn(),
  joinCreateMany: vi.fn(),
  joinDeleteMany: vi.fn(),
  role: "admin" as string,
}));

vi.mock("@/server/db", () => ({
  prisma: {
    trackedChannel: { findFirst: mocks.trackedFindFirst },
    niche: { findMany: mocks.nicheFindMany },
    trackedChannelNiche: {
      createMany: mocks.joinCreateMany,
      deleteMany: mocks.joinDeleteMany,
    },
  },
}));

vi.mock("@/server/auth/dal", () => ({
  requireActor: async () => ({
    userId: "user_1",
    organizationId: ORG_ID,
    role: mocks.role,
    permissions: new Set<string>(),
  }),
  actorCan: async () => false,
}));

vi.mock("../user-service", () => ({
  getCurrentOrgId: async () => ORG_ID,
  getScope: async () => ({ organizationId: ORG_ID, userId: "user_1" }),
  getCurrentOrgSettings: async () => ({ baseCurrency: "USD", defaultPeriodDays: 30 }),
}));

const { addChannelNiches } = await import("../niche-service");

/** A channel the Shorts side filed under GTA; the Long Form side wants it in Docs. */
const TRACKING = { id: "tc_1", niches: [{ nicheId: "niche_gta" }] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = "admin";
  mocks.trackedFindFirst.mockResolvedValue(TRACKING);
  mocks.joinCreateMany.mockResolvedValue({ count: 1 });
});

describe("addChannelNiches", () => {
  it("writes only the join rows that are missing, and deletes nothing", async () => {
    mocks.nicheFindMany.mockResolvedValue([
      { id: "niche_gta", format: "shorts" },
      { id: "niche_docs", format: "longform" },
    ]);

    const result = await addChannelNiches("ch_1", ["niche_gta", "niche_docs"]);

    expect(result).toEqual({ filed: 1 });
    expect(mocks.joinCreateMany).toHaveBeenCalledTimes(1);
    expect(mocks.joinCreateMany.mock.calls[0][0]).toEqual({
      data: [{ trackedChannelId: "tc_1", nicheId: "niche_docs" }],
    });
    // The whole point. A set would have reconciled; this must not even try.
    expect(mocks.joinDeleteMany).not.toHaveBeenCalled();
  });

  it("is a no-op for a niche the channel already carries", async () => {
    mocks.nicheFindMany.mockResolvedValue([{ id: "niche_gta", format: "shorts" }]);

    const result = await addChannelNiches("ch_1", ["niche_gta", "niche_gta"]);

    expect(result).toEqual({ filed: 0 });
    expect(mocks.joinCreateMany).not.toHaveBeenCalled();
    expect(mocks.joinDeleteMany).not.toHaveBeenCalled();
  });

  /**
   * A Head of Shorts holds `channels.manage`, so the route lets them in; the
   * FORMAT is what stops them filing into the other product. Same gate as a
   * set, met before anything is written.
   */
  it("refuses a niche outside the caller's format, before any write", async () => {
    mocks.role = "head_of_shorts";
    mocks.nicheFindMany.mockResolvedValue([{ id: "niche_docs", format: "longform" }]);

    await expect(addChannelNiches("ch_1", ["niche_docs"])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.joinCreateMany).not.toHaveBeenCalled();
  });

  it("reads a niche from another organization as one that no longer exists", async () => {
    // The org-scoped lookup returns fewer rows than were asked for.
    mocks.nicheFindMany.mockResolvedValue([]);

    await expect(addChannelNiches("ch_1", ["niche_theirs"])).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(mocks.joinCreateMany).not.toHaveBeenCalled();
  });

  it("scopes the channel lookup to the organization", async () => {
    mocks.trackedFindFirst.mockResolvedValue(null);

    await expect(addChannelNiches("ch_elsewhere", ["niche_docs"])).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(mocks.trackedFindFirst.mock.calls[0][0]).toMatchObject({
      where: { organizationId: ORG_ID, channelId: "ch_elsewhere" },
    });
    expect(mocks.nicheFindMany).not.toHaveBeenCalled();
  });
});
