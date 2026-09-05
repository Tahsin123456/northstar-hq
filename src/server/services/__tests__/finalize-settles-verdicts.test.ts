import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * =========================================================================
 * A MONTH IS NOT FROZEN UNTIL ITS VERDICTS ARE SETTLED
 * =========================================================================
 *
 * THE BUG THIS EXISTS FOR. The evaluator writes `pending` while a Short's
 * window is still open, and it runs at the END of the hourly sweep. The
 * scheduled finalization runs at 00:00 on the 1st. Every Short whose window
 * closed between the last completed sweep and that instant therefore still
 * carried a `pending` row when payroll read it — and a pending row carries no
 * reading, because a verdict that has not been reached has nothing to record.
 *
 * The engine could then use that row for neither of its two purposes:
 * `storedVerdictFor` rejects a non-final outcome, `observationsFor` finds no
 * reading on it, and `evaluateHit` was left looking at a closed window with no
 * in-window evidence — `unknown`. The Short earned nothing, the period was
 * frozen in the same call, and the bonus could never arrive afterwards, because
 * a hit is paid in the period its window CLOSES in and that period was now a
 * document. The snapshots proving the hit sat in `video_snapshots` throughout.
 *
 * THE FIX IS AN ORDERING, WHICH IS WHY IT NEEDS A TEST. Nothing about
 * `finalizePeriodForOrganization` looks wrong at a glance either before or
 * after; the only difference is that one call now happens before another. A
 * refactor that hoists it, drops it, or wraps it in the try/catch its sweep-side
 * sibling uses would compile, pass every other test, and silently restore the
 * loss — so all four properties below are pinned as behaviour rather than left
 * to a comment.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 11).toString("base64");

const ORG_ID = "org_northstar";
const ADMIN = "user_admin";

/**
 * One ordered log for both calls under test. Asserting each was called proves
 * nothing here — the whole defect was two correct calls in the wrong order —
 * so what is recorded is the sequence.
 */
const calls: string[] = [];

const mocks = vi.hoisted(() => ({
  evaluateHits: vi.fn(),
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
    userId: ADMIN,
    sessionId: "sess_1",
    email: "admin@example.com",
    name: "Admin",
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
  getScope: async () => ({ organizationId: ORG_ID, userId: ADMIN }),
  getOrgSettings: async () => ({ baseCurrency: "USD", companyName: "Northstar Studios" }),
  getCurrentOrgSettings: async () => ({ baseCurrency: "USD" }),
}));

vi.mock("../hit-evaluation-service", () => ({
  evaluateHitsForOrganization: mocks.evaluateHits,
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

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;

  mocks.evaluateHits.mockImplementation(async () => {
    calls.push("evaluate");
    return { created: 0, updated: 0, unchanged: 0 };
  });
  mocks.loadPayrollInputs.mockImplementation(async () => {
    calls.push("loadInputs");
    return { employees: [], shorts: [], niches: [] };
  });

  // No period row yet: the ordinary path, where the run actually happens.
  mocks.findPeriod.mockResolvedValue(null);
  mocks.countRecords.mockResolvedValue(0);
  mocks.upsertPeriod.mockImplementation(async () => {
    calls.push("upsertPeriod");
    return { id: "period_1" };
  });
  mocks.findRecords.mockResolvedValue([]);
});

describe("finalizing a payroll period", () => {
  /**
   * THE FIX, STATED AS AN ORDER. Reading the inputs first is the entire defect:
   * `loadPayrollInputs` materialises each Short's stored evaluation, so a
   * verdict settled after that read is a verdict this run cannot see.
   */
  it("settles the hit verdicts BEFORE it reads the payroll inputs", async () => {
    await finalizePeriodForOrganization({ organizationId: ORG_ID, period: LAST_MONTH });

    expect(calls).toEqual(["evaluate", "loadInputs", "upsertPeriod"]);
  });

  /** On this organization, not on whichever one the caller happened to be in. */
  it("settles them for the organization being finalized", async () => {
    await finalizePeriodForOrganization({ organizationId: ORG_ID, period: LAST_MONTH });

    expect(mocks.evaluateHits).toHaveBeenCalledTimes(1);
    expect(mocks.evaluateHits.mock.calls[0][0]).toBe(ORG_ID);
  });

  /**
   * FAILING CLOSED IS THE POINT, and it is the opposite of what the sweep does
   * with the same call. `runHitEvaluationStep` swallows its failures because the
   * next hour re-decides everything it missed. Nothing re-decides a frozen
   * month, so here a failure has to stop the run: a refused finalization is
   * retried and costs a delay, a completed one freezes wrong figures and costs
   * somebody their bonus with no way back.
   *
   * The scheduled job catches this per organization and writes
   * `payroll.run_failed` where an admin can see it, so throwing is visible
   * rather than silent — see src/app/api/cron/payroll/route.ts.
   */
  it("finalizes nothing when the verdicts cannot be settled", async () => {
    mocks.evaluateHits.mockRejectedValue(new Error("video_hit_evaluations is locked"));

    await expect(
      finalizePeriodForOrganization({ organizationId: ORG_ID, period: LAST_MONTH }),
    ).rejects.toThrow();

    // Not merely "the period was not written" — nothing downstream ran at all,
    // which is what makes the retry clean.
    expect(mocks.loadPayrollInputs).not.toHaveBeenCalled();
    expect(mocks.upsertPeriod).not.toHaveBeenCalled();
    expect(mocks.upsertRecord).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  /**
   * The frozen branch returns the stored headcount and changes nothing, and
   * that must stay true: re-running the engine over an already-finalized month
   * is precisely what finalization exists to prevent. An evaluation pass here
   * would be wasted work at best, and at worst the first half of exactly that
   * recalculation.
   */
  it("does not settle anything for a period that is already frozen", async () => {
    mocks.findPeriod.mockResolvedValue({ id: "period_1", status: "finalized" });
    mocks.countRecords.mockResolvedValue(3);

    const result = await finalizePeriodForOrganization({
      organizationId: ORG_ID,
      period: LAST_MONTH,
    });

    expect(result.alreadyFinalized).toBe(true);
    expect(result.employeeCount).toBe(3);
    expect(mocks.evaluateHits).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  /**
   * A month still in progress is refused before any work happens. Same reason
   * as the frozen branch: the guard's answer does not depend on the verdicts,
   * so paying for an organization-wide pass to reach it would be spending real
   * database time to produce an error.
   */
  it("does not settle anything for a month that has not ended", async () => {
    const thisMonth = periodContaining(Date.now());

    await expect(
      finalizePeriodForOrganization({ organizationId: ORG_ID, period: thisMonth }),
    ).rejects.toThrow(/has not ended yet/);

    expect(mocks.evaluateHits).not.toHaveBeenCalled();
  });
});
