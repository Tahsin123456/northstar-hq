import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WHO MAY SET WHAT A HIT IS.
 *
 * `niches.manage` lets somebody organise the taxonomy. `settings.manage` lets
 * them define a hit for the whole organization. Both live on a Head of Shorts'
 * job description in plain English, which is exactly why the split has to be
 * pinned in code: the two read as one capability right up until an employee's
 * "GTA = 250K" quietly rewrites every chart, every PDF and the payroll run.
 *
 * The refusal is the interesting half. Silently dropping a threshold an
 * employee sent would create the niche, return 200, and leave them believing a
 * number exists that does not — so what is pinned here is that the request
 * FAILS, and that it fails before anything is written.
 *
 * The check under test lives in `niche-service`, not in the route. That is the
 * point of testing it here: a service function is reachable from any server
 * caller, and a rule enforced one layer up holds only for the callers that
 * happen to exist today.
 *
 * Prisma and the session are stubs, as in `finance-delete-guard`. What is real
 * is the permission table — `effectivePermissions` is the actual one the app
 * ships, so a role gaining `settings.manage` in `permissions.ts` would change
 * this test's answer rather than being papered over by a hand-written set.
 */

// The module graph reaches the DAL, which reads SESSION_SECRET through auth-env
// at import time. Set before anything is imported, as the sibling tests do.
process.env.SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");

const ORG_ID = "org_northstar";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  /** Every niche in the organization, as the re-evaluation step reads them. */
  nicheFindMany: vi.fn(),
  /**
   * The tracked channels the re-evaluation would walk. Returning none keeps
   * this file about permissions — what is asserted below is that the
   * re-evaluation was ASKED FOR, not what it decided, which
   * `hit-evaluation.test.ts` covers in full.
   */
  trackedFindMany: vi.fn(),
  /** The permission set `requireActor` reports for this test's caller. */
  permissions: new Set<string>(),
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
  },
}));

vi.mock("@/server/auth/dal", () => ({
  requireActor: async () => ({
    userId: "user_1",
    organizationId: ORG_ID,
    permissions: mocks.permissions,
  }),
  /*
   * Answered from the same permission set the actor carries, rather than
   * stubbed to a constant.
   *
   * `listNiches` and `updateNiche` now ask this before deciding whether the DTO
   * may carry the per-hit rate. A stub returning true would make every case in
   * this file run as somebody who may read pay, which is the opposite of what a
   * permission file should assume — and the threshold cases below deliberately
   * run as somebody who may not.
   */
  actorCan: async (permission: string) => mocks.permissions.has(permission),
}));

vi.mock("../user-service", () => ({
  getScope: async () => ({
    organizationId: ORG_ID,
    userId: "user_1",
    actor: { userId: "user_1" },
  }),
  getCurrentOrgId: async () => ORG_ID,
}));

const { createNiche, updateNiche } = await import("../niche-service");

// The real table, not a hand-written set — see the note at the top.
const { effectivePermissions } = await import("@/lib/auth/permissions");

/** Signs the test in as somebody holding exactly this role's permissions. */
function signInAs(role: "admin" | "head_of_shorts"): void {
  mocks.permissions = new Set(effectivePermissions(role));
}

function nicheRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "niche_gta",
    organizationId: ORG_ID,
    createdById: "user_1",
    name: "GTA",
    slug: "gta",
    colorIndex: 0,
    hitThreshold: null,
    hitWindowHours: null,
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
  mocks.findUnique.mockResolvedValue(null); // no slug clash
  mocks.count.mockResolvedValue(0);
  mocks.nicheFindMany.mockResolvedValue([]);
  mocks.trackedFindMany.mockResolvedValue([]);
  mocks.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    nicheRow(data),
  );
  mocks.findFirst.mockResolvedValue(nicheRow());
  mocks.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    nicheRow(data),
  );
});

describe("creating a niche with a hit threshold", () => {
  it("refuses an employee who sends one, and writes nothing", async () => {
    // Head of Shorts: holds `niches.manage`, does not hold `settings.manage`.
    signInAs("head_of_shorts");

    await expect(
      createNiche({ name: "Red Dead", hitThreshold: 250_000 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    // The refusal has to land before the insert. A guard that threw after the
    // row was created would leave the niche in place at the number it refused.
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses an explicit null too — clearing a threshold is still setting it", async () => {
    signInAs("head_of_shorts");

    await expect(
      createNiche({ name: "Red Dead", hitThreshold: null }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("lets the same employee create a niche without one", async () => {
    signInAs("head_of_shorts");

    const niche = await createNiche({ name: "Red Dead" });

    // The point of the whole split: they can do their job, and the niche is
    // created unconfigured rather than borrowing the organization default.
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0][0].data.hitThreshold).toBeNull();
    expect(niche.hitThreshold).toBeNull();
  });

  it("accepts an admin's threshold and stores exactly the number sent", async () => {
    signInAs("admin");

    const niche = await createNiche({ name: "GTA", hitThreshold: 1_000_000 });

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0][0].data.hitThreshold).toBe(1_000_000);
    expect(niche.hitThreshold).toBe(1_000_000);
  });

  it("carries the creator's name back, so an admin knows whose niche it is", async () => {
    signInAs("admin");

    const niche = await createNiche({ name: "GTA" });

    expect(niche.createdByName).toBe("John Smith");
  });
});

describe("changing a threshold later", () => {
  it("refuses an employee, even though they may rename the same niche", async () => {
    signInAs("head_of_shorts");

    await expect(
      updateNiche("niche_gta", { hitThreshold: 250_000 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("still lets that employee rename it", async () => {
    signInAs("head_of_shorts");

    await updateNiche("niche_gta", { name: "Grand Theft Auto" });

    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update.mock.calls[0][0].data).toMatchObject({
      name: "Grand Theft Auto",
    });
    // The rename must not smuggle a threshold write in with it.
    expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty("hitThreshold");
  });

  it("lets an admin set one, and lets an admin clear it back to unconfigured", async () => {
    signInAs("admin");

    await updateNiche("niche_gta", { hitThreshold: 750_000 });
    expect(mocks.update.mock.calls[0][0].data.hitThreshold).toBe(750_000);

    await updateNiche("niche_gta", { hitThreshold: null });
    expect(mocks.update.mock.calls[1][0].data.hitThreshold).toBeNull();
  });
});

/**
 * THE WINDOW IS THE SAME DECISION AS THE THRESHOLD.
 *
 * "1M views ever" and "1M views in 48 hours" are different definitions of a
 * hit, and the second is the bigger claim. Guarding the number and leaving the
 * clock open would let somebody redefine every chart and every bonus by editing
 * the half nobody thought to protect.
 */
describe("the hit window is guarded exactly as the threshold is", () => {
  it("refuses an employee who sends a window", async () => {
    signInAs("head_of_shorts");

    await expect(
      updateNiche("niche_gta", { hitWindowHours: 168 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses an employee creating a niche with one", async () => {
    signInAs("head_of_shorts");

    await expect(
      createNiche({ name: "Red Dead", hitWindowHours: 48 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("lets an admin set both halves at once, which is how a rule is made", async () => {
    signInAs("admin");

    await updateNiche("niche_gta", { hitThreshold: 500_000, hitWindowHours: 48 });

    expect(mocks.update.mock.calls[0][0].data).toMatchObject({
      hitThreshold: 500_000,
      hitWindowHours: 48,
    });
  });

  it("creates a niche unconfigured on BOTH halves when nobody sets them", async () => {
    signInAs("head_of_shorts");

    await createNiche({ name: "Red Dead" });

    // Not "inherit the default window" — there is no default window, because
    // nobody has ever chosen one. Half a rule is not a rule.
    expect(mocks.create.mock.calls[0][0].data.hitWindowHours).toBeNull();
  });
});

/**
 * CHANGING THE RULE RE-DECIDES WHAT IT JUDGED.
 *
 * Stored verdicts are answers to the question the old rule asked. Leaving them
 * after an admin moves the bar would mean a dashboard showing one definition
 * and a payslip quoting another.
 */
describe("re-evaluation after a rule change", () => {
  it("re-decides the niche's Shorts when the threshold moves", async () => {
    signInAs("admin");

    await updateNiche("niche_gta", { hitThreshold: 750_000 });

    expect(mocks.trackedFindMany).toHaveBeenCalledTimes(1);
  });

  it("re-decides them when the window moves", async () => {
    signInAs("admin");

    await updateNiche("niche_gta", { hitWindowHours: 168 });

    expect(mocks.trackedFindMany).toHaveBeenCalledTimes(1);
  });

  it("does not re-decide anything for a rename", async () => {
    signInAs("head_of_shorts");

    await updateNiche("niche_gta", { name: "Grand Theft Auto" });

    // Renaming a label cannot change a verdict, and re-judging a library on
    // every edit would make a rename an expensive operation for no reason.
    expect(mocks.trackedFindMany).not.toHaveBeenCalled();
  });

  it("does not re-decide when the number sent is the one already stored", async () => {
    signInAs("admin");
    mocks.findFirst.mockResolvedValue(nicheRow({ hitThreshold: 750_000 }));

    await updateNiche("niche_gta", { hitThreshold: 750_000 });

    expect(mocks.trackedFindMany).not.toHaveBeenCalled();
  });
});
