import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WHO MAY PUT A NICHE ON WHICH SIDE OF THE OPERATION.
 *
 * Deploy C lets a caller say `format: "longform"` when creating a niche, and
 * the WHO of that lives in `niche-service` — `requireFormat` against the
 * actor's own role — not in the route, for the file's standing reason: a
 * service function is reachable from any server caller, and a rule enforced
 * one layer up holds only for the callers that happen to exist today.
 *
 * What is pinned here, role by role, against the REAL permission and scope
 * tables:
 *
 *   • a head_of_shorts holding `niches.manage` is REFUSED a longform niche —
 *     the spec's named case — with FORBIDDEN, before anything is written;
 *   • admin and head_of_longs are allowed one, and the row lands in the
 *     longform list (`data.format`), with the dedup lookup searching the
 *     SAME list — a lookup pinned to shorts would let a Long Form "GTA"
 *     silently collide with or reuse the Shorts row;
 *   • updateNiche applies the same scope to the ROW'S OWN format: a
 *     head_of_shorts may not rename a longform niche, and update accepts no
 *     `format` field at all — a rename never moves a niche between formats.
 *
 * Prisma and the session are stubs, as in `niche-threshold-permission`; the
 * permission set and `resolveAllowedFormats`' role table are the shipped ones.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");

const ORG_ID = "org_northstar";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  nicheFindMany: vi.fn(),
  trackedFindMany: vi.fn(),
  trackedFindFirst: vi.fn(),
  joinDeleteMany: vi.fn(),
  joinCreateMany: vi.fn(),
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
      delete: mocks.delete,
      findMany: mocks.nicheFindMany,
    },
    trackedChannel: {
      findMany: mocks.trackedFindMany,
      findFirst: mocks.trackedFindFirst,
    },
    trackedChannelNiche: {
      deleteMany: mocks.joinDeleteMany,
      createMany: mocks.joinCreateMany,
    },
    // The service builds the operations and hands them over as an array; what
    // the tests pin is which operations were built, so awaiting them is enough.
    $transaction: async (operations: readonly Promise<unknown>[]) =>
      Promise.all(operations),
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
  getScope: async () => ({
    organizationId: ORG_ID,
    userId: "user_1",
    actor: { userId: "user_1" },
  }),
  getCurrentOrgId: async () => ORG_ID,
  getCurrentOrgSettings: async () => ({ baseCurrency: "USD", defaultPeriodDays: 30 }),
}));

const { createNiche, updateNiche, deleteNiche, setChannelNiches } = await import(
  "../niche-service"
);
const { effectivePermissions } = await import("@/lib/auth/permissions");

function signInAs(role: "admin" | "head_of_shorts" | "head_of_longs"): void {
  mocks.permissions = new Set(effectivePermissions(role));
  mocks.role = role;
}

function nicheRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "niche_gta",
    organizationId: ORG_ID,
    createdById: "user_1",
    name: "GTA",
    slug: "gta",
    colorIndex: 0,
    kind: "production",
    format: "shorts",
    hitThreshold: null,
    hitWindowHours: null,
    hitPaymentMinor: null,
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
  mocks.delete.mockResolvedValue(nicheRow());
  mocks.trackedFindFirst.mockResolvedValue({ id: "tracked_1" });
  mocks.joinDeleteMany.mockResolvedValue({ count: 0 });
  mocks.joinCreateMany.mockResolvedValue({ count: 0 });
});

describe("creating a niche with an explicit format", () => {
  it("refuses a head_of_shorts a longform niche, and writes nothing", async () => {
    signInAs("head_of_shorts");

    await expect(
      createNiche({ name: "Documentaries", format: "longform" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("lets an admin create one, filed in the longform list", async () => {
    signInAs("admin");

    await createNiche({ name: "Documentaries", format: "longform" });

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0][0].data.format).toBe("longform");
  });

  it("lets a head_of_longs create one too — their own side of the operation", async () => {
    signInAs("head_of_longs");

    await createNiche({ name: "Documentaries", format: "longform" });

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0][0].data.format).toBe("longform");
  });

  it("deduplicates in the SAME format list it writes into", async () => {
    signInAs("admin");

    await createNiche({ name: "GTA", format: "longform" });

    // A lookup pinned to shorts would let the Shorts "GTA" block — or worse,
    // silently stand in for — the Long Form one.
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_format_slug: {
          organizationId: ORG_ID,
          format: "longform",
          slug: "gta",
        },
      },
    });
  });

  it("defaults an absent format to the caller's own side — longform for a head_of_longs", async () => {
    signInAs("head_of_longs");

    await createNiche({ name: "Documentaries" });

    expect(mocks.create.mock.calls[0][0].data.format).toBe("longform");
  });

  it("still writes shorts for every shorts-side caller sending nothing", async () => {
    signInAs("head_of_shorts");

    await createNiche({ name: "Red Dead" });

    expect(mocks.create.mock.calls[0][0].data.format).toBe("shorts");
  });
});

describe("updating a niche across the format boundary", () => {
  it("refuses a head_of_shorts touching a longform niche at all", async () => {
    signInAs("head_of_shorts");
    mocks.findFirst.mockResolvedValue(
      nicheRow({ id: "niche_docs", name: "Documentaries", slug: "documentaries", format: "longform" }),
    );

    await expect(
      updateNiche("niche_docs", { name: "Long Documentaries" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("lets a head_of_longs rename the same row", async () => {
    signInAs("head_of_longs");
    mocks.findFirst.mockResolvedValue(
      nicheRow({ id: "niche_docs", name: "Documentaries", slug: "documentaries", format: "longform" }),
    );

    await updateNiche("niche_docs", { name: "Long Documentaries" });

    expect(mocks.update).toHaveBeenCalledTimes(1);
    // And no format key is ever written by update — a rename must not move a
    // niche between formats, so the update schema does not even carry one.
    expect(mocks.update.mock.calls[0][0].data).not.toHaveProperty("format");
  });

  it("keeps a shorts niche editable by shorts-side roles exactly as before", async () => {
    signInAs("head_of_shorts");
    mocks.findFirst.mockResolvedValue(nicheRow());

    await updateNiche("niche_gta", { name: "GTA VI" });

    expect(mocks.update).toHaveBeenCalledTimes(1);
  });
});

describe("deleting a niche across the format boundary", () => {
  /*
   * The destructive act must not be the unguarded one: a head_of_shorts the
   * service refuses a RENAME of a longform niche was, for one review round,
   * still able to DELETE the same row — unassigning every channel filed under
   * it — because deleteNiche skipped the scope check updateNiche runs.
   */
  it("refuses a head_of_shorts deleting a longform niche, before the delete", async () => {
    signInAs("head_of_shorts");
    mocks.findFirst.mockResolvedValue(
      nicheRow({ id: "niche_docs", format: "longform" }),
    );

    await expect(deleteNiche("niche_docs")).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });

    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("lets a head_of_longs delete their own side's niche", async () => {
    signInAs("head_of_longs");
    mocks.findFirst.mockResolvedValue(
      nicheRow({ id: "niche_docs", format: "longform" }),
    );

    await deleteNiche("niche_docs");

    expect(mocks.delete).toHaveBeenCalledTimes(1);
  });

  it("keeps a shorts niche deletable by shorts-side roles exactly as before", async () => {
    signInAs("head_of_shorts");
    mocks.findFirst.mockResolvedValue(nicheRow());

    await deleteNiche("niche_gta");

    expect(mocks.delete).toHaveBeenCalledTimes(1);
  });
});

describe("filing a channel under niches across the format boundary", () => {
  /*
   * Filing a channel under a niche places it in that niche's PRODUCT: a longs
   * role who could file any Shorts-only channel under a longform niche would
   * pull that channel's whole video history into their own dataset through
   * `trackedChannelFormatFilter`'s OR clause — a self-service path around the
   * 403 the dataset route answers them with.
   */
  it("refuses a head_of_longs filing a channel under a shorts niche, writing nothing", async () => {
    signInAs("head_of_longs");
    mocks.nicheFindMany.mockResolvedValue([
      { id: "niche_gta", format: "shorts" },
    ]);

    await expect(
      setChannelNiches("chan_1", ["niche_gta"]),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    expect(mocks.joinDeleteMany).not.toHaveBeenCalled();
    expect(mocks.joinCreateMany).not.toHaveBeenCalled();
  });

  it("refuses the mirror image — a head_of_shorts filing into a longform niche", async () => {
    signInAs("head_of_shorts");
    mocks.nicheFindMany.mockResolvedValue([
      { id: "niche_docs", format: "longform" },
    ]);

    await expect(
      setChannelNiches("chan_1", ["niche_docs"]),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });

    expect(mocks.joinDeleteMany).not.toHaveBeenCalled();
  });

  it("scopes a single-format caller's replace to their own side — an empty set from a longs role cannot unfile Shorts assignments", async () => {
    signInAs("head_of_longs");

    await setChannelNiches("chan_1", []);

    expect(mocks.joinDeleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.joinDeleteMany.mock.calls[0][0].where).toEqual({
      trackedChannelId: "tracked_1",
      niche: { format: "longform" },
    });
  });

  it("scopes the shorts side through the fail-closed direction — format != longform", async () => {
    signInAs("head_of_shorts");
    mocks.nicheFindMany.mockResolvedValue([
      { id: "niche_gta", format: "shorts" },
    ]);

    await setChannelNiches("chan_1", ["niche_gta"]);

    // A garbage-valued stored format reads as shorts everywhere else
    // (`toNicheFormat`), so the shorts side must be able to unfile it too.
    expect(mocks.joinDeleteMany.mock.calls[0][0].where).toEqual({
      trackedChannelId: "tracked_1",
      niche: { format: { not: "longform" } },
    });
    expect(mocks.joinCreateMany).toHaveBeenCalledWith({
      data: [{ trackedChannelId: "tracked_1", nicheId: "niche_gta" }],
    });
  });

  it("keeps an admin's replace wholesale across both formats, exactly as before", async () => {
    signInAs("admin");
    mocks.nicheFindMany.mockResolvedValue([
      { id: "niche_gta", format: "shorts" },
      { id: "niche_docs", format: "longform" },
    ]);

    await setChannelNiches("chan_1", ["niche_gta", "niche_docs"]);

    expect(mocks.joinDeleteMany.mock.calls[0][0].where).toEqual({
      trackedChannelId: "tracked_1",
    });
  });
});
