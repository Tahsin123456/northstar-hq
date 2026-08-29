import { beforeEach, describe, expect, it, vi } from "vitest";

import { UNMAINTAINED_NOTE_PREFIX } from "@/lib/finance/unmaintained";

/**
 * Whether the ledger knows a figure has stopped being maintained.
 *
 * WHY THIS FILE EXISTS
 * A mutation test proved the gap it closes. `isUnmaintained` could be forced to
 * `false` in the DTO mapper and the whole suite still passed — so the one thing
 * standing between a stale figure and a row claiming "subject to month-end
 * adjustment" was untested. The note contract either side of it was pinned; the
 * value the screen actually branches on was not.
 *
 * WHAT IS AT STAKE
 * A month whose daily rows disagree on currency is deliberately NOT summed —
 * adding unlike currencies produces a number that is not an amount of anything —
 * so the connector marks it and walks away. The figure already in the ledger
 * then stops being re-checked. If the row goes on rendering the ordinary "Est"
 * chip, it tells the reader a revision is still coming for a month nothing is
 * revising, which is the precise contradiction the mark was introduced to end.
 *
 * This pins the DERIVATION, not the rendering: the mapper's job is to answer the
 * question once on the server so no screen parses prose for itself.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 11).toString("base64");

const ORG_ID = "org_northstar";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  trackedFindMany: vi.fn(),
}));

vi.mock("@/server/db", () => ({
  prisma: {
    financeEntry: { findMany: mocks.findMany },
    trackedChannel: { findMany: mocks.trackedFindMany },
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

vi.mock("@/server/audit/audit-service", () => ({ recordAudit: vi.fn() }));

const { listEntries } = await import("../finance-service");

/** One August revenue row, with only the fields under test varying. */
function row({ source, notes }: { source: string; notes: string | null }) {
  return {
    id: "entry_1",
    organizationId: ORG_ID,
    kind: "revenue",
    occurredOn: new Date("2026-08-31T00:00:00Z"),
    amountMinor: 410_000,
    currency: "USD",
    baseAmountMinor: 410_000,
    baseCurrency: "USD",
    exchangeRate: 1,
    categoryId: null,
    channelId: null,
    platform: null,
    vendor: null,
    notes,
    source,
    externalId: source === "manual" ? null : "youtube:UC123:2026-08",
    isEstimated: source !== "manual",
    previousAmountMinor: null,
    revisionCount: 0,
    lastImportedAt: null,
    category: null,
    createdBy: null,
    createdAt: new Date("2026-08-31T00:00:00Z"),
    updatedAt: new Date("2026-08-31T00:00:00Z"),
  };
}

async function readOne(input: { source: string; notes: string | null }) {
  mocks.findMany.mockResolvedValue([row(input)]);
  const entries = await listEntries({
    range: { startMs: Date.UTC(2026, 7, 1), endMs: Date.UTC(2026, 8, 1) },
  });
  return entries[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.trackedFindMany.mockResolvedValue([]);
});

describe("isUnmaintained on a finance entry", () => {
  it("is true for an imported row the connector has marked", async () => {
    const entry = await readOne({
      source: "youtube",
      notes: `${UNMAINTAINED_NOTE_PREFIX} the daily rows for this month disagree on currency.`,
    });

    expect(entry.isUnmaintained).toBe(true);
  });

  it("is false for an ordinary imported row", async () => {
    const entry = await readOne({
      source: "youtube",
      notes: "Imported from YouTube Analytics.",
    });

    // The row is still an estimate — that is a different fact, and one the
    // "Est" chip is entitled to keep making.
    expect(entry.isUnmaintained).toBe(false);
    expect(entry.isEstimated).toBe(true);
  });

  it("is false for a row with no note at all", async () => {
    const entry = await readOne({ source: "youtube", notes: null });

    expect(entry.isUnmaintained).toBe(false);
  });

  /**
   * The mark is a connector's statement about its own figure. A person who
   * happens to type the same words about a cash payment they entered by hand is
   * making an ordinary note, and the ledger must not restyle their row as a
   * broken import because of a coincidence of wording.
   */
  it("is false for a hand-typed row even when the note opens the same way", async () => {
    const entry = await readOne({
      source: "manual",
      notes: `${UNMAINTAINED_NOTE_PREFIX} waiting on the invoice.`,
    });

    expect(entry.isUnmaintained).toBe(false);
  });

  /**
   * The reader is deliberately looser than the writer. An admin who tidies the
   * note — different case, a stray leading space, a hyphen instead of the em
   * dash — has not made anybody start re-checking the figure, so the warning
   * must survive the edit. The asymmetry only ever runs this way: it can leave
   * a warning up a moment too long, never suppress one.
   */
  it("survives an admin retyping the mark loosely", async () => {
    for (const notes of [
      "  not being updated - currency changed mid-month",
      "NOT BEING UPDATED, see below",
      "Not Being Updated — mixed currencies",
    ]) {
      const entry = await readOne({ source: "youtube", notes });
      expect(entry.isUnmaintained, `note: ${notes}`).toBe(true);
    }
  });
});
