import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who is allowed to delete a finance entry.
 *
 * `updateEntry` has refused to edit an imported amount for as long as the
 * import has existed, and the reason is mechanical: the connector rewrites the
 * row on every sync, so a hand correction and the sync fight. `deleteEntry` did
 * not read `source` at all, which left the same door open beside the locked
 * one — and deleting is the worse of the two. The row does not stay deleted
 * (`upsertImportedEntry` misses on the unique key and takes its CREATE branch),
 * and what comes back is a row at `previousAmountMinor: null`,
 * `revisionCount: 0`, so every revision the source had already made to that
 * month is gone and cannot be reconstructed from anywhere.
 *
 * This file pins the decision, not the plumbing. Prisma, the session and the
 * audit writer are all stubs; what is under test is that the guard reads
 * `source`, refuses everything that is not "manual", and still lets a typed
 * entry through — plus that a refusal never reaches `delete()`, because a guard
 * that throws after the row is gone would be no guard at all.
 */

// finance-service pulls in the errors module and the money helpers, which are
// pure — but the module graph still touches auth-env, as the sibling revenue
// and niche-scope tests do. Set the secret before anything is imported.
process.env.SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");

const ORG_ID = "org_northstar";

/**
 * Hoisted so the `vi.mock` factories below — which vitest lifts above the
 * imports — can close over these without reading a binding that has not been
 * initialised yet.
 */
const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  deleteRow: vi.fn(),
  // Typed rather than bare, so the recorded call keeps its shape: the audit
  // payload is the second argument, and it is what the delete assertion reads.
  recordAudit: vi.fn<(context: unknown, payload: unknown) => Promise<void>>(),
}));

vi.mock("@/server/db", () => ({
  prisma: {
    financeEntry: {
      findFirst: mocks.findFirst,
      delete: mocks.deleteRow,
    },
  },
}));

vi.mock("../user-service", () => ({
  getScope: async () => ({
    organizationId: ORG_ID,
    userId: "user_admin",
    actor: { userId: "user_admin", name: "Ada", email: "ada@example.com" },
  }),
  getCurrentOrgId: async () => ORG_ID,
  getCurrentOrgSettings: async () => ({ baseCurrency: "USD", defaultPeriodDays: 30 }),
  getOrgSettings: async () => ({ baseCurrency: "USD", defaultPeriodDays: 30 }),
}));

vi.mock("@/server/audit/audit-service", () => ({ recordAudit: mocks.recordAudit }));

const { deleteEntry } = await import("../finance-service");

/** The columns `deleteEntry` selects, filled in with one plausible August row. */
function entryRow(source: string) {
  return {
    id: "entry_1",
    kind: "revenue",
    occurredOn: new Date("2026-08-01T00:00:00.000Z"),
    amountMinor: 412_355,
    currency: "USD",
    baseAmountMinor: 412_355,
    baseCurrency: "USD",
    exchangeRate: 1,
    categoryId: "cat_youtube_ads",
    channelId: "chan_1",
    source,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deleteRow.mockResolvedValue({ id: "entry_1" });
  mocks.recordAudit.mockResolvedValue(undefined);
});

describe("deleteEntry", () => {
  it("refuses to delete an entry imported from YouTube", async () => {
    mocks.findFirst.mockResolvedValue(entryRow("youtube"));

    await expect(deleteEntry("entry_1")).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { source: "youtube" },
    });

    // The whole point of the guard: the row is still there. A refusal raised
    // after the delete would leave the sync to re-create the month anyway.
    expect(mocks.deleteRow).not.toHaveBeenCalled();
    // And nothing was written to the audit log, because nothing happened. A
    // "deleted a $4,123.55 revenue entry" record for a delete that was refused
    // is a false entry in the one log that is supposed to be reliable.
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  /**
   * The refusal has to be actionable, because the admin's need is real: they
   * are looking at a figure they believe does not belong in their ledger. So
   * the message names the mechanism and the two things that actually work —
   * offsetting it, or disconnecting the account — rather than only saying no.
   */
  it("explains why, and what to do instead", async () => {
    mocks.findFirst.mockResolvedValue(entryRow("youtube"));

    const error = await deleteEntry("entry_1").catch((caught: unknown) => caught);
    const message = (error as { userMessage: string }).userMessage;

    expect(message).toContain("YouTube");
    expect(message).toMatch(/next sync/i);
    expect(message).toMatch(/revised/i);
    expect(message).toMatch(/manual entry/i);
    expect(message).toMatch(/disconnect/i);
  });

  /**
   * `source` is free text on the schema and "youtube" is only today's
   * connector. The guard keys off "not manual" rather than off a list, and the
   * message names whatever wrote the row — telling somebody their Stripe entry
   * came from YouTube would be worse than saying nothing.
   */
  it("refuses any connector-owned row, not just YouTube's", async () => {
    mocks.findFirst.mockResolvedValue(entryRow("stripe"));

    const error = await deleteEntry("entry_1").catch((caught: unknown) => caught);

    expect((error as { code: string }).code).toBe("INVALID_INPUT");
    expect((error as { userMessage: string }).userMessage).toContain("stripe");
    expect((error as { userMessage: string }).userMessage).not.toContain("YouTube");
    expect(mocks.deleteRow).not.toHaveBeenCalled();
  });

  it("still deletes a manually typed entry", async () => {
    mocks.findFirst.mockResolvedValue(entryRow("manual"));

    await expect(deleteEntry("entry_1")).resolves.toEqual({ id: "entry_1" });

    expect(mocks.deleteRow).toHaveBeenCalledExactlyOnceWith({ where: { id: "entry_1" } });
    // Written after the row is gone, carrying the amount, because there is
    // nothing left to look up afterwards.
    expect(mocks.recordAudit).toHaveBeenCalledOnce();
    expect(mocks.recordAudit.mock.calls[0]?.[1]).toMatchObject({
      action: "finance.entry_deleted",
      targetType: "finance_entry",
      targetId: "entry_1",
    });
  });

  /**
   * The original bug in one assertion. The guard cannot fire on a column the
   * query never asked for, and dropping `source` from this select would make
   * every test above pass against a `source` of `undefined` — which is not
   * "manual", so they would pass for the wrong reason while production deleted
   * imported rows again. Pinning the select is what makes the rest of the file
   * mean something.
   */
  it("selects source, which is the column the guard depends on", async () => {
    mocks.findFirst.mockResolvedValue(entryRow("manual"));

    await deleteEntry("entry_1");

    expect(mocks.findFirst).toHaveBeenCalledOnce();
    const args = mocks.findFirst.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    expect(args.select.source).toBe(true);
    // Scoped read before write, unchanged: an id from another organization has
    // to read as "not found", never as somebody else's row.
    expect(args.where).toEqual({ id: "entry_1", organizationId: ORG_ID });
  });

  it("reports a missing entry as not found rather than as a refusal", async () => {
    mocks.findFirst.mockResolvedValue(null);

    await expect(deleteEntry("entry_missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.deleteRow).not.toHaveBeenCalled();
  });
});
