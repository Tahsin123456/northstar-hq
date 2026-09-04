import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who may read what a hit PAYS.
 *
 * `GET /api/niches` is gated on `analytics.view` — held by every employee role —
 * and it returns the organization's whole catalogue. So the moment `NicheDTO`
 * grew a rate, that endpoint started publishing "a Red Dead hit pays $8, a GTA
 * hit pays $5" to the entire team: pay configuration, on the one read every
 * signed-in person makes.
 *
 * Nobody outside the admin section consumes the field — the "needs
 * configuration" badge an employee sees is computed from the threshold and the
 * window — so withholding it costs nothing and is invisible to them. That is
 * precisely why it needs a test: a disclosure with no visible consumer is one
 * nobody notices coming back.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 19).toString("base64");

const ORG_ID = "org_northstar";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  can: vi.fn<(permission: string) => Promise<boolean>>(),
}));

vi.mock("@/server/db", () => ({
  prisma: {
    niche: { findMany: mocks.findMany },
  },
}));

vi.mock("@/server/auth/dal", () => ({
  actorCan: mocks.can,
  // An admin is not niche-scoped, so the whole taxonomy is listed — the case
  // every assertion in this file is about.
  requireActor: async () => ({ userId: "user_1", organizationId: ORG_ID, role: "admin" }),
}));

vi.mock("../user-service", () => ({
  getCurrentOrgId: async () => ORG_ID,
  getScope: async () => ({ organizationId: ORG_ID, userId: "user_1" }),
  getCurrentOrgSettings: async () => ({ baseCurrency: "USD", defaultPeriodDays: 30 }),
  getOrgSettings: async () => ({ baseCurrency: "USD", defaultPeriodDays: 30 }),
}));

vi.mock("@/server/audit/audit-service", () => ({ recordAudit: vi.fn() }));

const { listNiches } = await import("../niche-service");

/** One production niche with a complete, paying rule. */
function nicheRow() {
  return {
    id: "niche_gta",
    organizationId: ORG_ID,
    name: "GTA",
    slug: "gta",
    colorIndex: 0,
    kind: "production",
    hitThreshold: 1_000_000,
    hitWindowHours: 168,
    hitPaymentMinor: 500,
    sortOrder: 0,
    createdById: null,
    createdBy: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    _count: { channels: 1 },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMany.mockResolvedValue([nicheRow()]);
});

describe("the per-hit rate on the niche catalogue", () => {
  it("is withheld from somebody who cannot configure it", async () => {
    mocks.can.mockResolvedValue(false);

    const [niche] = await listNiches();

    expect(niche.hitPaymentMinor).toBeNull();
    // Everything else about the rule is theirs to see: an editor needs to know
    // what counts as a hit in the niche they work in. It is only the price that
    // is somebody else's business.
    expect(niche.hitThreshold).toBe(1_000_000);
    expect(niche.hitWindowHours).toBe(168);
  });

  it("reaches somebody who can", async () => {
    mocks.can.mockResolvedValue(true);

    const [niche] = await listNiches();

    expect(niche.hitPaymentMinor).toBe(500);
    expect(mocks.can).toHaveBeenCalledWith("settings.manage");
  });

  /**
   * The gate is `settings.manage`, not "is an admin".
   *
   * Asserted because the obvious wrong implementation — checking a role, or
   * reusing whichever permission was nearest — would pass the two tests above
   * while quietly binding pay disclosure to something that can be granted for
   * an unrelated reason.
   *
   * THE SET OF PERMISSIONS THIS READ CONSULTS IS ITSELF THE ASSERTION. It is
   * exactly one. Pinning the whole set is what would catch a second gate
   * appearing without anybody deciding what it guards — or, worse, pay
   * disclosure quietly moving onto some other key because it happened to be
   * nearby.
   */
  it("asks for the permission that sets the rate, and no wider one", async () => {
    mocks.can.mockResolvedValue(false);

    await listNiches();

    expect(mocks.can.mock.calls.map(([permission]) => permission).sort()).toEqual([
      "settings.manage",
    ]);
  });

  /**
   * A watchlist niche pays nothing by definition, so its rate is null for
   * everybody — including an admin, who would otherwise read a price for work
   * on which nobody can earn a bonus.
   */
  it("stays null on a watchlist niche even for a permitted reader", async () => {
    mocks.can.mockResolvedValue(true);
    mocks.findMany.mockResolvedValue([{ ...nicheRow(), kind: "watchlist" }]);

    const [niche] = await listNiches();

    expect(niche.hitPaymentMinor).toBeNull();
  });
});
