import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * =========================================================================
 * WHO MAY SET WHAT A NICHE PAYS PER 1,000 VIEWS
 * =========================================================================
 *
 * A THIRD PERMISSION, NOT THE SECOND ONE. Renaming a niche is `niches.manage`.
 * Defining a hit is `settings.manage`. Pricing a niche needs `settings.manage`
 * AND `finance.view` together, and the second half is the interesting one:
 *
 *   • The range is READ behind `finance.view`, because where Northstar owns a
 *     monetized channel in the niche the rate shown is that channel's reported
 *     revenue over its views, and both travel with it.
 *   • So `settings.manage` WITHOUT `finance.view` is a real combination — both
 *     keys are individually grantable — and it produces the worst possible
 *     writer: the dialog opens with two empty boxes over a stored range,
 *     because the DTO withheld it, and saving writes that emptiness over a
 *     number an admin chose. That is the `hitPaymentMinor` incident exactly.
 *
 * WHY THIS FILE EXISTS AT ALL. Every other permission decision on `NicheDTO` is
 * pinned — `niche-pay-disclosure` for the pay read, `niche-rpm-disclosure` for
 * the economics read, `niche-threshold-permission` for the hit-rule write. The
 * RPM WRITE gate was the one guard with no test: deleting its body entirely
 * left the whole suite green, which made it the guard most likely to be removed
 * by a refactor nobody would notice. The mutation is now caught here.
 *
 * The check under test lives in `niche-service`, not in the route, and is
 * tested there for the same reason its sibling is: a service function is
 * reachable from any server caller, and a rule enforced one layer up holds only
 * for the callers that happen to exist today.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 23).toString("base64");

const ORG_ID = "org_northstar";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  nicheFindMany: vi.fn(),
  trackedFindMany: vi.fn(),
  exchangeRateFindMany: vi.fn(),
  /** Exactly the permissions this test's caller holds. */
  permissions: new Set<string>(),
  role: "admin" as string,
}));

vi.mock("@/server/db", () => ({
  prisma: {
    niche: {
      findUnique: mocks.findUnique,
      findFirst: mocks.findFirst,
      count: mocks.count,
      create: mocks.create,
      update: mocks.update,
      findMany: mocks.nicheFindMany,
    },
    trackedChannel: { findMany: mocks.trackedFindMany },
    exchangeRate: { findMany: mocks.exchangeRateFindMany },
  },
}));

vi.mock("@/server/auth/dal", () => ({
  requireActor: async () => ({
    userId: "user_1",
    organizationId: ORG_ID,
    role: mocks.role,
    permissions: mocks.permissions,
  }),
  actorCan: async (permission: string) => mocks.permissions.has(permission),
}));

vi.mock("../user-service", () => ({
  getScope: async () => ({ organizationId: ORG_ID, userId: "user_1" }),
  getCurrentOrgId: async () => ORG_ID,
  getCurrentOrgSettings: async () => ({ baseCurrency: "USD", defaultPeriodDays: 30 }),
}));

const { updateNiche, updateNicheSchema } = await import("../niche-service");

/**
 * A permission set assembled BY HAND rather than from a role.
 *
 * The two-of-three combinations under test are not any shipped role — no
 * default role holds `settings.manage` without `finance.view` — and that is the
 * point: `finance.view` is individually grantable, the RPM service's own
 * docstring argues it should be granted on its own, and the gate has to hold
 * for a permission set nobody has assembled yet.
 */
function holding(...permissions: readonly string[]): void {
  mocks.permissions = new Set(permissions);
}

const CAN_WRITE_RPM = ["niches.manage", "settings.manage", "finance.view"] as const;

function nicheRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "niche_gta",
    organizationId: ORG_ID,
    createdById: "user_1",
    name: "GTA",
    slug: "gta",
    colorIndex: 0,
    kind: "production",
    hitThreshold: null,
    hitWindowHours: null,
    hitPaymentMinor: null,
    rpmLowMinorPerMillion: 3_000,
    rpmHighMinorPerMillion: 6_000,
    rpmCurrency: "USD",
    sortOrder: 0,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    createdBy: { id: "user_1", name: "John Smith", email: "john@example.com" },
    _count: { channels: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = "admin";
  mocks.findUnique.mockResolvedValue(null);
  mocks.count.mockResolvedValue(0);
  mocks.nicheFindMany.mockResolvedValue([]);
  mocks.trackedFindMany.mockResolvedValue([]);
  mocks.exchangeRateFindMany.mockResolvedValue([]);
  mocks.findFirst.mockResolvedValue(nicheRow());
  mocks.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    nicheRow(data),
  );
});

describe("setting a niche's RPM range", () => {
  it("refuses somebody who may configure settings but may not see finance", async () => {
    // The dangerous combination: the dialog would have opened with empty boxes
    // over a stored range, because the DTO withholds it without `finance.view`.
    holding("niches.manage", "settings.manage");

    await expect(
      updateNiche("niche_gta", {
        rpmLowMinorPerMillion: 3_000,
        rpmHighMinorPerMillion: 6_000,
        rpmCurrency: "USD",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    // The refusal lands before the write. A guard that threw afterwards would
    // leave the row at the number it refused.
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses somebody who may see finance but may not configure settings", async () => {
    // A rate is organization-wide analysis configuration, exactly like the hit
    // rule. Being allowed to READ money is not being allowed to define it.
    holding("niches.manage", "finance.view");

    await expect(
      updateNiche("niche_gta", {
        rpmLowMinorPerMillion: 3_000,
        rpmHighMinorPerMillion: 6_000,
        rpmCurrency: "USD",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses an explicit clear too — unpricing a niche is still pricing it", async () => {
    holding("niches.manage", "settings.manage");

    await expect(
      updateNiche("niche_gta", {
        rpmLowMinorPerMillion: null,
        rpmHighMinorPerMillion: null,
        rpmCurrency: null,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("accepts somebody holding both, and stores exactly the three columns sent", async () => {
    holding(...CAN_WRITE_RPM);

    await updateNiche("niche_gta", {
      rpmLowMinorPerMillion: 4_500,
      rpmHighMinorPerMillion: 9_000,
      rpmCurrency: "USD",
    });

    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0][0].data).toMatchObject({
      rpmLowMinorPerMillion: 4_500,
      rpmHighMinorPerMillion: 9_000,
      rpmCurrency: "USD",
    });
  });

  /**
   * THE GATE IS ON THE FIELDS, NOT ON THE REQUEST.
   *
   * A niche-manager who renames a niche must not trip an RPM permission they do
   * not need — and the rename must not smuggle an RPM write through with it.
   */
  it("lets somebody without either key rename the same niche, writing no RPM column", async () => {
    holding("niches.manage");

    await updateNiche("niche_gta", { name: "Grand Theft Auto" });

    expect(mocks.update).toHaveBeenCalledTimes(1);
    const { data } = mocks.update.mock.calls[0][0];
    expect(data).toMatchObject({ name: "Grand Theft Auto" });
    expect(data).not.toHaveProperty("rpmLowMinorPerMillion");
    expect(data).not.toHaveProperty("rpmHighMinorPerMillion");
    expect(data).not.toHaveProperty("rpmCurrency");
  });

  /**
   * The hit rule and the RPM are separately gated, in one request.
   *
   * They ride in the same PATCH only because they are the same table. Somebody
   * who may set the threshold and may not price the niche is refused for the
   * whole request rather than having the RPM quietly dropped — a stripped field
   * would return 200 and leave them believing they had priced it.
   */
  it("refuses the whole request when only one of the two acts is permitted", async () => {
    holding("niches.manage", "settings.manage");

    await expect(
      updateNiche("niche_gta", {
        hitThreshold: 500_000,
        rpmLowMinorPerMillion: 3_000,
        rpmHighMinorPerMillion: 6_000,
        rpmCurrency: "USD",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.update).not.toHaveBeenCalled();
  });
});

/**
 * WHAT THE SCHEMA ACCEPTS AS A CURRENCY.
 *
 * `minorUnitsFor` is what turns the stored integer back into an amount, and it
 * answers 2 for a code it has never heard of. A range of 3,000 stored under
 * "ZZZ" would therefore be re-read at a scale nobody chose. The dialog can only
 * send the organization's base currency, so this is unreachable through the app
 * — which is exactly why it is asserted against the schema every other caller
 * arrives through, matching `finance-service`'s own currency field.
 */
describe("the currency an RPM range is stored in", () => {
  it("refuses three letters that are not a currency this app handles", () => {
    const parsed = updateNicheSchema.safeParse({
      rpmLowMinorPerMillion: 3_000,
      rpmHighMinorPerMillion: 6_000,
      rpmCurrency: "ZZZ",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a supported code, case-insensitively", () => {
    const parsed = updateNicheSchema.safeParse({
      rpmLowMinorPerMillion: 3_000,
      rpmHighMinorPerMillion: 6_000,
      rpmCurrency: "usd",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.rpmCurrency).toBe("USD");
  });

  it("still accepts an explicit null, which is how a range is cleared", () => {
    const parsed = updateNicheSchema.safeParse({
      rpmLowMinorPerMillion: null,
      rpmHighMinorPerMillion: null,
      rpmCurrency: null,
    });
    expect(parsed.success).toBe(true);
  });
});
