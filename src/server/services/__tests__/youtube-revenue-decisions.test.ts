import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WHAT THE REVENUE CONNECTOR IS ALLOWED TO CLAIM.
 *
 * The sibling file pins the arithmetic and the shape-reading — including the
 * `(1.005).toFixed(2)` half-cent trap that `toMinorUnits` exists to avoid, which
 * is covered there ("rounds the decimal Google sent, not the binary
 * approximation of it") and is deliberately not repeated here.
 *
 * What is pinned here is the other half: the branches that decide what the app
 * SAYS about a channel, and what reaches the ledger. Every one of them can be
 * reverted with the rest of the suite still green, and every one of them
 * reverts into a plausible-looking wrong answer rather than a crash — a window
 * of zeros filed as "not in the Partner Programme", a month held in two
 * currencies added into a number that is not an amount of anything, a second
 * sync run creating a duplicate month, a revised figure that appears to have
 * always been the new one. The ledger still balances afterwards. It is just no
 * longer true.
 *
 * Prisma, Google and the OAuth store are stubs, as in `finance-delete-guard`.
 * `finance-service` is pointedly NOT stubbed: the rollup's idempotency key and
 * its revision history are properties of `upsertImportedEntry`, and replacing
 * it with a double would leave those two tests asserting against the double.
 */

// The module graph reaches the DAL, which reads SESSION_SECRET through auth-env
// at import time. Set before anything is imported, as the sibling tests do.
process.env.SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");

const ORG_ID = "org_northstar";
const CONNECTION_ID = "conn_1";
const CHANNEL_ID = "chan_1";
const YT_CHANNEL_ID = "UC_northstar";
const CATEGORY_ID = "cat_youtube_ads";
const MONTH = "2026-08";
const EXTERNAL_ID = `youtube:${YT_CHANNEL_ID}:${MONTH}`;

/** Hoisted so the `vi.mock` factories below can close over them. */
const mocks = vi.hoisted(() => ({
  connectionFindUnique: vi.fn(),
  connectionUpdate: vi.fn(),
  channelFindUnique: vi.fn(),
  revenueDayFindMany: vi.fn(),
  revenueDayUpsert: vi.fn(),
  entryFindUnique: vi.fn(),
  entryFindMany: vi.fn(),
  entryCreate: vi.fn(),
  entryUpdate: vi.fn(),
  entryUpdateMany: vi.fn(),
  categoryFindUnique: vi.fn(),
  categoryCount: vi.fn(),
  categoryCreate: vi.fn(),
  exchangeRateFindUnique: vi.fn(),
  recordAudit: vi.fn<(context: unknown, payload: unknown) => Promise<void>>(),
  getValidAccessToken: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/server/db", () => ({
  prisma: {
    youTubeConnection: { findUnique: mocks.connectionFindUnique, update: mocks.connectionUpdate },
    channel: { findUnique: mocks.channelFindUnique },
    channelRevenueDay: { findMany: mocks.revenueDayFindMany, upsert: mocks.revenueDayUpsert },
    financeEntry: {
      findUnique: mocks.entryFindUnique,
      findMany: mocks.entryFindMany,
      create: mocks.entryCreate,
      update: mocks.entryUpdate,
      updateMany: mocks.entryUpdateMany,
    },
    financeCategory: {
      findUnique: mocks.categoryFindUnique,
      count: mocks.categoryCount,
      create: mocks.categoryCreate,
    },
    exchangeRate: { findUnique: mocks.exchangeRateFindUnique },
  },
}));

vi.mock("@/server/audit/audit-service", () => ({ recordAudit: mocks.recordAudit }));

// The connector has no session by construction, but finance-service imports the
// session-bound helpers too, so the mock has to carry all four.
vi.mock("../user-service", () => ({
  getScope: async () => ({ organizationId: ORG_ID, userId: null, actor: null }),
  getCurrentOrgId: async () => ORG_ID,
  getCurrentOrgSettings: async () => orgSettings(),
  getOrgSettings: async () => orgSettings(),
}));

// Stubbed whole: the real one reads cookies and the AES key, neither of which
// this file is about.
vi.mock("../youtube-oauth-service", () => ({ getValidAccessToken: mocks.getValidAccessToken }));

function orgSettings() {
  return { baseCurrency: "USD", defaultPeriodDays: 30, refreshIntervalMinutes: 360 };
}

const { fetchRevenueForConnection, syncRevenueToFinance, YOUTUBE_SOURCE } = await import(
  "../youtube-revenue-service"
);

// ---------------------------------------------------------------------------
// A FINANCE TABLE JUST REAL ENOUGH TO RE-RUN A SYNC AGAINST
// ---------------------------------------------------------------------------

/**
 * The rollup's two most important properties — that a second run updates rather
 * than duplicates, and that a changed figure is recorded as changed — are only
 * observable across two writes to the same row. A mock that answers every read
 * with a fixed object cannot show either, so the entry writes land in this map
 * and the reads come back out of it.
 */
interface StoredEntry {
  id: string;
  externalId: string;
  source: string;
  amountMinor: number;
  currency: string;
  baseCurrency: string;
  exchangeRate: number;
  revisionCount: number;
  previousAmountMinor: number | null;
  occurredOn: Date;
  categoryId: string | null;
  channelId: string | null;
  notes: string | null;
}

const entries = new Map<string, StoredEntry>();

/** Applies a Prisma `data` payload, honouring `{ increment }` on a counter. */
function applyWrite(row: StoredEntry, data: Record<string, unknown>): void {
  const target = row as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === "object" && "increment" in value) {
      target[key] = (target[key] as number) + (value as { increment: number }).increment;
      continue;
    }
    target[key] = value;
  }
}

function seedEntry(overrides: Partial<StoredEntry> = {}): StoredEntry {
  const row: StoredEntry = {
    id: "entry_aug",
    externalId: EXTERNAL_ID,
    source: YOUTUBE_SOURCE,
    amountMinor: 412_355,
    currency: "USD",
    baseCurrency: "USD",
    exchangeRate: 1,
    revisionCount: 0,
    previousAmountMinor: null,
    occurredOn: new Date("2026-08-31T00:00:00.000Z"),
    categoryId: CATEGORY_ID,
    channelId: CHANNEL_ID,
    notes: `Imported from YouTube Analytics. Estimated ${MONTH} revenue, subject to YouTube's month-end adjustment.`,
    ...overrides,
  };
  entries.set(row.externalId, row);
  return row;
}

// ---------------------------------------------------------------------------
// FIXTURES
// ---------------------------------------------------------------------------

/** The columns `fetchRevenueForConnection` selects off the connection. */
function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    organizationId: ORG_ID,
    youtubeChannelId: YT_CHANNEL_ID,
    channelTitle: "Northstar Shorts",
    googleAccountEmail: "ops@northstar.example",
    status: "connected",
    revenueScopeGranted: true,
    monetizationStatus: "unknown",
    ...overrides,
  };
}

const REPORT_HEADERS = [
  { name: "day" },
  { name: "estimatedRevenue" },
  { name: "estimatedAdRevenue" },
  { name: "estimatedRedPartnerRevenue" },
];

/** A 200 from the Analytics API carrying `rows`. */
function analyticsOk(rows: readonly (readonly unknown[])[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ columnHeaders: REPORT_HEADERS, rows }),
  };
}

const WINDOW = {
  startDate: new Date("2026-08-01T00:00:00.000Z"),
  endDate: new Date("2026-08-10T00:00:00.000Z"),
};

/** A stored daily row, shaped as the rollup's `select` reads it. */
function dailyRow(day: string, minor: number, currency = "USD") {
  return {
    channelId: CHANNEL_ID,
    day: new Date(`${day}T00:00:00.000Z`),
    estimatedRevenueMinor: minor,
    currency,
    channel: { youtubeChannelId: YT_CHANNEL_ID, title: "Northstar Shorts" },
  };
}

/** The `data` of the last write to the connection — where the claim lands. */
function lastConnectionWrite(): Record<string, unknown> {
  const call = mocks.connectionUpdate.mock.calls.at(-1)?.[0] as
    | { data: Record<string, unknown> }
    | undefined;
  return call?.data ?? {};
}

function auditActions(): string[] {
  return mocks.recordAudit.mock.calls.map(
    (call) => (call[1] as { action: string } | undefined)?.action ?? "",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  entries.clear();

  vi.stubGlobal("fetch", mocks.fetch);

  mocks.connectionFindUnique.mockResolvedValue(connectionRow());
  mocks.connectionUpdate.mockResolvedValue({ id: CONNECTION_ID });
  mocks.channelFindUnique.mockResolvedValue({ id: CHANNEL_ID });
  mocks.revenueDayFindMany.mockResolvedValue([]);
  mocks.revenueDayUpsert.mockResolvedValue({ id: "day_1" });
  mocks.getValidAccessToken.mockResolvedValue("ya29.token");
  mocks.recordAudit.mockResolvedValue(undefined);
  mocks.categoryFindUnique.mockResolvedValue({ id: CATEGORY_ID, name: "YouTube Ad Revenue" });
  mocks.exchangeRateFindUnique.mockResolvedValue(null);

  // Reads hand back a COPY, as a real query does. A live reference would let an
  // update mutate the row a caller is still holding — and `upsertImportedEntry`
  // holds the pre-update row precisely so it can say what the figure used to be.
  mocks.entryFindUnique.mockImplementation(
    async (args: { where: { organizationId_source_externalId?: { externalId: string } } }) => {
      const key = args.where.organizationId_source_externalId;
      const row = key ? entries.get(key.externalId) : undefined;
      return row ? { ...row } : null;
    },
  );

  mocks.entryFindMany.mockImplementation(
    async (args: { where: { notes?: { startsWith?: string } } }) => {
      const prefix = args.where.notes?.startsWith;
      return [...entries.values()]
        .filter((row) => (prefix ? (row.notes?.startsWith(prefix) ?? false) : true))
        .map((row) => ({ ...row }));
    },
  );

  mocks.entryCreate.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    const row = seedEntry({
      id: `entry_${entries.size + 1}`,
      revisionCount: 0,
      previousAmountMinor: null,
    });
    applyWrite(row, args.data);
    return { id: row.id };
  });

  mocks.entryUpdate.mockImplementation(
    async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = [...entries.values()].find((entry) => entry.id === args.where.id);
      if (!row) throw new Error("no such entry");
      applyWrite(row, args.data);
      return { id: row.id, revisionCount: row.revisionCount };
    },
  );

  mocks.entryUpdateMany.mockImplementation(
    async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = [...entries.values()].find((entry) => entry.id === args.where.id);
      if (!row) return { count: 0 };
      applyWrite(row, args.data);
      return { count: 1 };
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// WHAT A WINDOW OF ZEROS IS ALLOWED TO MEAN
// ---------------------------------------------------------------------------

describe("fetchRevenueForConnection — the monetisation verdict", () => {
  const ZERO_ROWS = [
    ["2026-08-01", 0, 0, 0],
    ["2026-08-02", 0, 0, 0],
    ["2026-08-03", 0, 0, 0],
  ];

  /**
   * The overreach this branch exists to prevent, in one test.
   *
   * Google answering with zeros for every day is not Google saying the channel
   * is outside the Partner Programme — a channel earning fractions of a cent a
   * day, which `toMinorUnits` correctly floors to zero, sends exactly the same
   * response, and so does one that joined the programme this morning. Recording
   * "not_monetized" here would put a finding in the admin screen that nobody
   * ever reported. What the run observed is "reported_zero"; what it knows
   * about membership is nothing, which is "unknown".
   */
  it("records a zero window as reported_zero and leaves monetisation unknown", async () => {
    mocks.fetch.mockResolvedValue(analyticsOk(ZERO_ROWS));

    const result = await fetchRevenueForConnection(CONNECTION_ID, WINDOW);

    expect(result.status).toBe("reported_zero");
    expect(result.totalMinor).toBe(0);
    expect(result.monetizationStatus).toBe("unknown");
    // Spelled out, because this is the exact value that was removed: a refusal
    // from Google is evidence, a window of zeros is not.
    expect(result.monetizationStatus).not.toBe("not_monetized");

    const written = lastConnectionWrite();
    expect(written.revenueSyncStatus).toBe("reported_zero");
    expect(written.monetizationStatus).toBe("unknown");
    expect(written.monetizationStatus).not.toBe("not_monetized");
  });

  /**
   * And the reason is offered as a reason. The status column is read by an
   * admin, so the sentence is where the overreach would actually reach a human
   * even if the enum stayed honest.
   */
  it("offers the likeliest explanation without recording it as a finding", async () => {
    mocks.fetch.mockResolvedValue(analyticsOk(ZERO_ROWS));

    const result = await fetchRevenueForConnection(CONNECTION_ID, WINDOW);

    expect(result.message).toMatch(/likeliest/i);
    expect(result.message).toMatch(/not something YouTube said/i);
  });

  /** The zeros are still stored as received; only the verdict is withheld. */
  it("writes the zero days to the daily table rather than inferring them away", async () => {
    mocks.fetch.mockResolvedValue(analyticsOk(ZERO_ROWS));

    const result = await fetchRevenueForConnection(CONNECTION_ID, WINDOW);

    expect(result.daysWritten).toBe(3);
    expect(mocks.revenueDayUpsert).toHaveBeenCalledTimes(3);
    const first = mocks.revenueDayUpsert.mock.calls[0]?.[0] as {
      create: { estimatedRevenueMinor: number };
    };
    expect(first.create.estimatedRevenueMinor).toBe(0);
  });

  /**
   * A quiet ten days is a quiet ten days, not an exit from the programme. A
   * channel that has reported revenue before keeps its verdict — demoting it on
   * a lean window would flip the column back and forth with the season.
   */
  it("never demotes a channel that has already reported revenue", async () => {
    mocks.connectionFindUnique.mockResolvedValue(connectionRow({ monetizationStatus: "monetized" }));
    mocks.fetch.mockResolvedValue(analyticsOk(ZERO_ROWS));

    const result = await fetchRevenueForConnection(CONNECTION_ID, WINDOW);

    expect(result.monetizationStatus).toBe("monetized");
    expect(lastConnectionWrite().monetizationStatus).toBe("monetized");
    // Still an observation of zero, though: the window really did report none.
    expect(result.status).toBe("reported_zero");
    expect(result.message).toMatch(/reported revenue before/i);
  });

  /**
   * The asymmetry is deliberate and worth pinning both ways. "not_monetized" is
   * only ever written from a refusal, and a refusal is exactly what did not
   * happen here — Google answered. Once it answers, the evidence behind an
   * older "not_monetized" is gone and the column has to stop claiming it.
   */
  it("lifts a stale not_monetized back to unknown once Google answers at all", async () => {
    mocks.connectionFindUnique.mockResolvedValue(
      connectionRow({ monetizationStatus: "not_monetized" }),
    );
    mocks.fetch.mockResolvedValue(analyticsOk(ZERO_ROWS));

    const result = await fetchRevenueForConnection(CONNECTION_ID, WINDOW);

    expect(result.monetizationStatus).toBe("unknown");
    expect(lastConnectionWrite().monetizationStatus).toBe("unknown");
  });

  /**
   * The other side of the branch. One reported penny is proof of membership —
   * a channel outside the programme cannot earn one — so this is the single
   * case where "monetized" is asserted rather than inferred.
   */
  it("reads a non-zero window as ok and monetized", async () => {
    mocks.fetch.mockResolvedValue(
      analyticsOk([
        ["2026-08-01", 10.5, 8.25, 2.25],
        ["2026-08-02", 0, 0, 0],
        ["2026-08-03", 4.25, 4.25, 0],
      ]),
    );

    const result = await fetchRevenueForConnection(CONNECTION_ID, WINDOW);

    expect(result.status).toBe("ok");
    expect(result.monetizationStatus).toBe("monetized");
    expect(result.totalMinor).toBe(1475);
    // Nothing to explain when the figures simply arrived.
    expect(result.message).toBeNull();

    const written = lastConnectionWrite();
    expect(written.revenueSyncStatus).toBe("ok");
    expect(written.monetizationStatus).toBe("monetized");
  });
});

// ---------------------------------------------------------------------------
// A MONTH HELD IN TWO CURRENCIES
// ---------------------------------------------------------------------------

describe("syncRevenueToFinance — a month whose currencies disagree", () => {
  /**
   * Adding 1,000 USD-minor to 2,000 EUR-minor gives 3,000 of nothing. The
   * refusal to sum is the point, and so is what happens to the entry that is
   * already there: the last total it could stand behind stays exactly as the
   * good run wrote it, and only the note changes — because deleting or zeroing
   * a real figure would swap a stale number for a wrong one.
   */
  it("refuses the sum, leaves the amount alone, and marks the month", async () => {
    const entry = seedEntry({ amountMinor: 412_355 });
    mocks.revenueDayFindMany.mockResolvedValue([
      dailyRow("2026-08-01", 1_000, "USD"),
      dailyRow("2026-08-02", 2_000, "EUR"),
    ]);

    const summary = await syncRevenueToFinance(ORG_ID);

    // The figure the last good run stood behind, untouched — and emphatically
    // not the 3,000 that adding the two rows together would have produced.
    expect(entry.amountMinor).toBe(412_355);
    expect(entry.currency).toBe("USD");
    expect(entry.revisionCount).toBe(0);
    expect(entry.previousAmountMinor).toBeNull();

    // Nothing went through the write path that owns amounts.
    expect(mocks.entryCreate).not.toHaveBeenCalled();
    expect(mocks.entryUpdate).not.toHaveBeenCalled();

    // The mark itself: one write, and it carries the note and nothing else.
    expect(mocks.entryUpdateMany).toHaveBeenCalledOnce();
    const call = mocks.entryUpdateMany.mock.calls[0]?.[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(call.where.id).toBe(entry.id);
    expect(Object.keys(call.data)).toEqual(["notes"]);
    expect(entry.notes?.startsWith("NOT BEING UPDATED")).toBe(true);
    expect(entry.notes).toContain(MONTH);

    // And the run says so out loud rather than only marking the row.
    expect(summary.entriesCreated).toBe(0);
    expect(summary.entriesRevised).toBe(0);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]?.message).toMatch(/more than one currency/i);
    expect(summary.errors[0]?.message).toContain(MONTH);

    // No ledger write happened, so no ledger audit should claim one did.
    expect(auditActions()).not.toContain("finance.entry_imported");
    expect(auditActions()).not.toContain("finance.entry_revised");
  });

  /**
   * Marking is guarded by the prefix so a standing problem does not push
   * `updatedAt` forward every hour and read as something that just happened —
   * and so the admin's own note is not buried one warning deeper per run.
   */
  it("does not re-mark a month it has already marked", async () => {
    seedEntry({ notes: "NOT BEING UPDATED — 2026-08's daily figures are stored in..." });
    mocks.revenueDayFindMany.mockResolvedValue([
      dailyRow("2026-08-01", 1_000, "USD"),
      dailyRow("2026-08-02", 2_000, "EUR"),
    ]);

    await syncRevenueToFinance(ORG_ID);

    expect(mocks.entryUpdateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// RUNNING THE ROLLUP TWICE
// ---------------------------------------------------------------------------

describe("syncRevenueToFinance — idempotency", () => {
  const AUGUST = [dailyRow("2026-08-01", 1_050), dailyRow("2026-08-02", 425)];

  /**
   * The sync re-reads a trailing window on every run, so the same month is
   * rolled up over and over. The safety is the unique key, not a check: keyed
   * on `(organizationId, source, externalId)`, a re-run finds the row it wrote
   * last time. Keyed on anything shape-derived — same channel, same total — the
   * first revision would produce a second row for the same month, which is
   * precisely when a duplicate is hardest to spot.
   */
  it("keys the month on (organizationId, source, externalId)", async () => {
    mocks.revenueDayFindMany.mockResolvedValue(AUGUST);

    await syncRevenueToFinance(ORG_ID);

    const lookup = mocks.entryFindUnique.mock.calls
      .map((call) => (call[0] as { where: Record<string, unknown> }).where)
      .find((where) => "organizationId_source_externalId" in where);

    expect(lookup?.organizationId_source_externalId).toEqual({
      organizationId: ORG_ID,
      source: YOUTUBE_SOURCE,
      externalId: EXTERNAL_ID,
    });

    // And the row is STORED under the three columns it is read back by. A
    // create that wrote a different key than the read looks for would miss its
    // own row on every subsequent run and insert the month again each time.
    const created = (mocks.entryCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> })
      .data;
    expect(created.organizationId).toBe(ORG_ID);
    expect(created.source).toBe(YOUTUBE_SOURCE);
    expect(created.externalId).toBe(EXTERNAL_ID);
  });

  it("updates on a second run over the same days instead of creating a second entry", async () => {
    mocks.revenueDayFindMany.mockResolvedValue(AUGUST);

    const first = await syncRevenueToFinance(ORG_ID);
    expect(first.entriesCreated).toBe(1);
    expect(entries.size).toBe(1);

    const created = [...entries.values()][0];
    expect(created?.amountMinor).toBe(1_475);

    mocks.entryCreate.mockClear();
    mocks.entryUpdate.mockClear();

    const second = await syncRevenueToFinance(ORG_ID);

    expect(second.entriesCreated).toBe(0);
    expect(second.entriesUnchanged).toBe(1);
    // The assertion the whole property rests on: nothing new was inserted.
    expect(mocks.entryCreate).not.toHaveBeenCalled();
    expect(entries.size).toBe(1);

    // And the update landed on the row the first run created.
    expect(mocks.entryUpdate).toHaveBeenCalledOnce();
    const update = mocks.entryUpdate.mock.calls[0]?.[0] as { where: { id: string } };
    expect(update.where.id).toBe(created?.id);
  });
});

// ---------------------------------------------------------------------------
// A FIGURE THAT MOVED
// ---------------------------------------------------------------------------

describe("syncRevenueToFinance — revisions", () => {
  /**
   * YouTube states its revenue metrics are subject to month-end adjustment, so
   * a total moving is the normal case. What must not happen is the row quietly
   * appearing to have always been the new number: `previousAmountMinor` is what
   * lets somebody reconciling a payout see that August was revised, and
   * `revisionCount` is what tells them how often.
   */
  it("records the old figure and counts the revision when the total moves", async () => {
    const entry = seedEntry({ amountMinor: 100_000, revisionCount: 0 });
    mocks.revenueDayFindMany.mockResolvedValue([
      dailyRow("2026-08-01", 1_050),
      dailyRow("2026-08-02", 425),
    ]);

    const summary = await syncRevenueToFinance(ORG_ID);

    expect(summary.entriesRevised).toBe(1);
    expect(entry.amountMinor).toBe(1_475);
    expect(entry.previousAmountMinor).toBe(100_000);
    expect(entry.revisionCount).toBe(1);

    const data = (mocks.entryUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data.previousAmountMinor).toBe(100_000);
    // A counter increment, not a computed value: two runs racing must not both
    // write the same "1".
    expect(data.revisionCount).toEqual({ increment: 1 });

    // The audit trail carries the move, because a revision to a financial
    // figure nobody typed is the one thing there is no other record of.
    expect(auditActions()).toContain("finance.entry_revised");
    const revision = mocks.recordAudit.mock.calls.find(
      (call) => (call[1] as { action: string }).action === "finance.entry_revised",
    );
    expect((revision?.[1] as { metadata: Record<string, unknown> }).metadata).toMatchObject({
      previousAmountMinor: 100_000,
      externalId: EXTERNAL_ID,
    });
  });

  /**
   * The other half, and the one that keeps the log readable: the sync runs
   * hourly over a window it has already read. If an unchanged total counted as
   * a revision, `revisionCount` would count scheduler runs, `previousAmountMinor`
   * would say a figure changed to itself, and the audit log would fill with
   * hourly notices of nothing happening.
   */
  it("moves neither column and writes no audit when the total is unchanged", async () => {
    const entry = seedEntry({ amountMinor: 1_475, revisionCount: 1, previousAmountMinor: 100_000 });
    mocks.revenueDayFindMany.mockResolvedValue([
      dailyRow("2026-08-01", 1_050),
      dailyRow("2026-08-02", 425),
    ]);

    const summary = await syncRevenueToFinance(ORG_ID);

    expect(summary.entriesRevised).toBe(0);
    expect(summary.entriesUnchanged).toBe(1);

    expect(entry.revisionCount).toBe(1);
    expect(entry.previousAmountMinor).toBe(100_000);

    const data = (mocks.entryUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(Object.keys(data)).not.toContain("previousAmountMinor");
    expect(Object.keys(data)).not.toContain("revisionCount");

    expect(auditActions()).not.toContain("finance.entry_revised");
  });
});
