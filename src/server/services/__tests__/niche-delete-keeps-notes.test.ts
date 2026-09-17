import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * =========================================================================
 * DELETING A LABEL MUST NOT DELETE THE TEAM'S RESEARCH
 * =========================================================================
 *
 * `Note.niche` cascaded. So "Delete niche" — under a dialog that says "This
 * removes the label, nothing else" and promises no Shorts, view counts or
 * history are affected — deleted every note filed on that niche, the whole
 * team's included, written by people who never saw the dialog. Notes are
 * recorded nowhere else, there is no undo, and the success toast counted
 * unfiled channels and never mentioned them.
 *
 * The note now outlives the label: it is re-filed as "general", a kind that
 * already exists for a note attached to nothing.
 *
 * WHY THE ORDER AND THE TRANSACTION ARE PINNED, not just the outcome. The
 * schema's SET NULL alone would leave a row claiming `targetType: "niche"`
 * with a null `nicheId` — a note that renders with no target and satisfies no
 * filter. The update has to happen, and it has to happen atomically with the
 * delete, or a failure between them leaves exactly that state.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 23).toString("base64");

const ORG_ID = "org_northstar";

const mocks = vi.hoisted(() => ({
  nicheFindFirst: vi.fn(),
  nicheDelete: vi.fn(),
  noteUpdateMany: vi.fn(),
  /** Every operation handed to $transaction, in order, so the order is provable. */
  transactionCalls: [] as string[][],
  role: "admin" as string,
}));

vi.mock("@/server/db", () => ({
  prisma: {
    niche: {
      findFirst: mocks.nicheFindFirst,
      findUnique: vi.fn(),
      findMany: vi.fn(),
      delete: (args: unknown) => {
        mocks.nicheDelete(args);
        return { __op: "niche.delete" };
      },
    },
    note: {
      updateMany: (args: unknown) => {
        mocks.noteUpdateMany(args);
        return { __op: "note.updateMany" };
      },
    },
    trackedChannel: { findMany: vi.fn(), findFirst: vi.fn() },
    trackedChannelNiche: { deleteMany: vi.fn(), createMany: vi.fn() },
    // Records WHICH operations were bundled and in what order, then answers in
    // the same order — the update's result first, which is what the service
    // destructures the kept-note count from.
    $transaction: async (operations: readonly { __op: string }[]) => {
      mocks.transactionCalls.push(operations.map((operation) => operation.__op));
      return operations.map((operation) =>
        operation.__op === "note.updateMany" ? { count: 3 } : { id: "niche_gta" },
      );
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

vi.mock("../hit-evaluation-service", () => ({
  evaluateHitsForOrganization: vi.fn(),
  reevaluateHitsForNiche: vi.fn(),
}));

const { deleteNiche } = await import("../niche-service");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transactionCalls.length = 0;
  mocks.role = "admin";
  mocks.nicheFindFirst.mockResolvedValue({
    id: "niche_gta",
    organizationId: ORG_ID,
    format: "shorts",
    _count: { channels: 2 },
  });
});

describe("deleting a niche", () => {
  it("re-files its notes as general instead of letting them be deleted", async () => {
    await deleteNiche("niche_gta");

    expect(mocks.noteUpdateMany).toHaveBeenCalledTimes(1);
    expect(mocks.noteUpdateMany.mock.calls[0][0]).toEqual({
      // Scoped to the organization as well as the niche: the niche id was
      // resolved inside this tenant, and the write stays inside it too.
      where: { organizationId: ORG_ID, nicheId: "niche_gta" },
      // BOTH columns. Clearing the id without re-typing the note would leave
      // it claiming a niche target it no longer has.
      data: { targetType: "general", nicheId: null },
    });
  });

  it("does the re-filing and the delete atomically, re-filing first", async () => {
    await deleteNiche("niche_gta");

    expect(mocks.transactionCalls).toEqual([["note.updateMany", "niche.delete"]]);
    // Not two separate awaits: a failure between them is what leaves a note
    // pointing at a niche that has been deleted.
    expect(mocks.nicheDelete).toHaveBeenCalledTimes(1);
  });

  it("reports how many notes it kept, so the toast can say so", async () => {
    const result = await deleteNiche("niche_gta");

    expect(result).toEqual({ unassignedChannels: 2, keptNotes: 3 });
  });

  /**
   * The format scope is unchanged by this work and is the destructive act's
   * only guard, so it is re-pinned here: a head_of_shorts must not delete a
   * Long Form niche, and must not reach the notes of one either.
   */
  it("refuses a niche outside the caller's format before touching any note", async () => {
    mocks.role = "head_of_shorts";
    mocks.nicheFindFirst.mockResolvedValue({
      id: "niche_docs",
      organizationId: ORG_ID,
      format: "longform",
      _count: { channels: 0 },
    });

    await expect(deleteNiche("niche_docs")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.noteUpdateMany).not.toHaveBeenCalled();
    expect(mocks.nicheDelete).not.toHaveBeenCalled();
  });

  it("reads a niche from another organization as not found", async () => {
    mocks.nicheFindFirst.mockResolvedValue(null);

    await expect(deleteNiche("niche_theirs")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.noteUpdateMany).not.toHaveBeenCalled();
  });
});
