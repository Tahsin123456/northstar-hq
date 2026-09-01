import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * =========================================================================
 * THE ONE HAND-OFF, PINNED
 * =========================================================================
 *
 * The engine knows, per employee, which niches earned them nothing and how many
 * of their own Shorts it cost. `writeRecords` then stores a `PayrollRecord` and
 * its `PayrollHit` rows and nothing else, because `PayrollRecord` has no column
 * for this and the schema is not ours to change — so a moment after the run the
 * fact is gone, and every later read of the period sees `skippedNiches: []`.
 *
 * `finalizePeriodForOrganization` is the last place it exists. Returning it is
 * the only route to the Telegram message that needs neither a new column nor a
 * re-derivation of a settled month from today's niche configuration.
 *
 * This file pins the return value and, just as importantly, that the FIGURES
 * written are untouched by it: the engine's refusal to price an unpriced hit is
 * correct and this work must never turn a disclosure into a payment.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");

const ORG_ID = "org_northstar";
const JOHN = "user_john";

const mocks = vi.hoisted(() => ({
  loadPayrollInputs: vi.fn(),
  loadAssignedNiches: vi.fn(),
  findPeriod: vi.fn(),
  countRecords: vi.fn(),
  upsertPeriod: vi.fn(),
  findRecords: vi.fn(),
  deleteRecords: vi.fn(),
  upsertRecord: vi.fn(),
  deleteHits: vi.fn(),
  createHits: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("@/server/db", () => {
  const tx = {
    payrollPeriod: { upsert: mocks.upsertPeriod },
    payrollRecord: {
      findMany: mocks.findRecords,
      deleteMany: mocks.deleteRecords,
      upsert: mocks.upsertRecord,
    },
    payrollHit: { deleteMany: mocks.deleteHits, createMany: mocks.createHits },
  };
  return {
    prisma: {
      payrollPeriod: { findUnique: mocks.findPeriod },
      payrollRecord: { count: mocks.countRecords, findFirst: vi.fn(), findMany: vi.fn() },
      $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
    },
  };
});

vi.mock("@/server/auth/dal", async () => {
  const { effectivePermissions } = await import("@/lib/auth/permissions");
  const actor = {
    userId: JOHN,
    sessionId: "sess_1",
    email: "john@example.com",
    name: "John",
    organizationId: ORG_ID,
    organizationName: "Northstar",
    role: "admin",
    permissions: effectivePermissions("admin", []),
  };
  return {
    getActor: async () => actor,
    requireActor: async () => actor,
    requirePermission: async () => actor,
  };
});

vi.mock("../user-service", () => ({
  getScope: async () => ({ organizationId: ORG_ID, userId: JOHN }),
  getOrgSettings: async () => ({ baseCurrency: "USD", companyName: "Northstar Studios" }),
  getCurrentOrgSettings: async () => ({ baseCurrency: "USD" }),
}));

vi.mock("../payroll-data", () => ({
  loadPayrollInputs: mocks.loadPayrollInputs,
  loadAssignedNiches: mocks.loadAssignedNiches,
}));

vi.mock("@/server/audit/audit-service", () => ({ recordAudit: mocks.recordAudit }));

const { finalizePeriodForOrganization } = await import("../payroll-service");
const { periodContaining, previousPeriod } = await import("@/lib/payroll/payroll-engine");

/** A month that has certainly ended, so finalizing needs no force. */
const LAST_MONTH = previousPeriod(periodContaining(Date.now()));

/**
 * John, on GTA, with one Short that cleared GTA's bar inside its window — and
 * GTA has no price on a hit. The owner's case exactly.
 *
 * A one-hour window published at the top of the month puts both the publication
 * and the close inside the period on every day of it.
 */
function inputs(nicheOverrides: Record<string, unknown> = {}) {
  return {
    employees: [
      {
        userId: JOHN,
        name: "John",
        email: "john@example.com",
        role: "short_form_editor",
        salaryMinor: 190_000,
        currency: "USD",
        nicheIds: ["niche_gta"],
        joinedOnMs: Date.UTC(2020, 0, 1),
        employmentEndedOnMs: null,
        alreadyPaidVideoIds: [],
      },
    ],
    shorts: [
      {
        videoId: "vid_1",
        title: "A very good Short",
        channelId: "chan_1",
        channelName: "Northstar GTA",
        views: 2_000_000,
        publishedAtMs: LAST_MONTH.startsAtMs,
        nicheIds: ["niche_gta"],
        isOwnChannel: true,
        evaluation: {
          nicheId: null,
          thresholdApplied: null,
          windowHoursApplied: null,
          viewsAtWindow: 2_000_000,
          observedAtHours: 0,
        },
      },
    ],
    niches: [
      {
        id: "niche_gta",
        name: "GTA",
        kind: "production" as const,
        // NO PRICE. The niche judges perfectly and cannot say what a hit pays.
        hitPaymentMinor: null,
        hitThreshold: 1_000_000,
        hitWindowHours: 1,
        ...nicheOverrides,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findPeriod.mockResolvedValue(null);
  mocks.countRecords.mockResolvedValue(0);
  mocks.upsertPeriod.mockResolvedValue({ id: "period_1" });
  mocks.findRecords.mockResolvedValue([]);
  mocks.deleteRecords.mockResolvedValue({ count: 0 });
  mocks.upsertRecord.mockResolvedValue({ id: "rec_1" });
  mocks.deleteHits.mockResolvedValue({ count: 0 });
  mocks.createHits.mockResolvedValue({ count: 0 });
  mocks.loadPayrollInputs.mockResolvedValue(inputs());
});

describe("finalizing hands the per-employee gap back to its caller", () => {
  it("names the person, the niche, the missing setting and the count", async () => {
    const result = await finalizePeriodForOrganization({
      organizationId: ORG_ID,
      period: LAST_MONTH,
    });

    expect(result.unpaidNicheGaps).toEqual([
      {
        userId: JOHN,
        nicheName: "GTA",
        missing: { rule: null, payment: true },
        shortCount: 1,
      },
    ]);
  });

  /**
   * THE SCOPE GUARD, at the only place that writes money. The unpriced hit is
   * reported and NOT recorded: a zero-value `PayrollHit` would enter the paid
   * ledger and make that Short unpayable forever, even after somebody sets the
   * rate. If this work ever starts paying, both assertions move.
   */
  it("pays exactly nothing for the hit it is disclosing", async () => {
    await finalizePeriodForOrganization({ organizationId: ORG_ID, period: LAST_MONTH });

    const written = mocks.upsertRecord.mock.calls[0]?.[0] as {
      create: { baseSalaryMinor: number; hitCount: number; hitBonusMinor: number; totalMinor: number };
    };
    expect(written.create.baseSalaryMinor).toBe(190_000);
    expect(written.create.hitCount).toBe(0);
    expect(written.create.hitBonusMinor).toBe(0);
    expect(written.create.totalMinor).toBe(190_000);

    // And no hit row at all, which is what keeps the Short payable later.
    expect(mocks.createHits).not.toHaveBeenCalled();
  });

  it("reports nothing when every niche is fully configured", async () => {
    mocks.loadPayrollInputs.mockResolvedValue(inputs({ hitPaymentMinor: 500 }));

    const result = await finalizePeriodForOrganization({
      organizationId: ORG_ID,
      period: LAST_MONTH,
    });

    expect(result.unpaidNicheGaps).toEqual([]);
    // The hit paid, so it was recorded — the other side of the guard above.
    expect(mocks.createHits).toHaveBeenCalledTimes(1);
  });

  /**
   * An already-frozen period is left strictly alone, so there is no run to take
   * a report from. Empty here means "this call has nothing to add", never
   * "nothing was skipped" — and it is why a re-sent old month says less.
   */
  it("returns nothing for a period it did not run", async () => {
    mocks.findPeriod.mockResolvedValue({
      id: "period_1",
      year: LAST_MONTH.year,
      month: LAST_MONTH.month,
      status: "finalized",
      finalizedAt: new Date(),
      finalizedById: null,
    });
    mocks.countRecords.mockResolvedValue(1);

    const result = await finalizePeriodForOrganization({
      organizationId: ORG_ID,
      period: LAST_MONTH,
    });

    expect(result.alreadyFinalized).toBe(true);
    expect(result.unpaidNicheGaps).toEqual([]);
    expect(mocks.loadPayrollInputs).not.toHaveBeenCalled();
  });
});
