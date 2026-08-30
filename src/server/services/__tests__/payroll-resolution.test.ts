import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Payroll under the windowed definition of a hit, at the service boundary.
 *
 * The engine's own tests prove the arithmetic. What is under test here is the
 * part that only exists once a database is involved:
 *
 *   • a Short resolving inside the period is paid there even though it was
 *     published before it, and the response says when its window closed so the
 *     screen can explain the December date on the January run;
 *   • pending and unknown Shorts pay nothing and are reported APART, because
 *     one is a wait and the other is a loss;
 *   • a niche with a threshold and no window is skipped, named, and labelled
 *     with the half it is missing;
 *   • A FINALIZED PERIOD DOES NOT MOVE. Not when the rule changes, not when
 *     views climb, not when finalize is called again. That is the guarantee the
 *     whole service is built around and the one this file is most concerned
 *     with.
 */

// The payroll module graph reaches the DAL, which validates SESSION_SECRET
// through auth-env at import time.
process.env.SESSION_SECRET = Buffer.alloc(32, 11).toString("base64");

const ORG_ID = "org_northstar";
const ADMIN = "user_dana";

const mocks = vi.hoisted(() => ({
  loadPayrollInputs: vi.fn(),
  findPeriod: vi.fn(),
  periodUpsert: vi.fn(),
  recordCount: vi.fn(),
  recordFindMany: vi.fn(),
  memberFindMany: vi.fn(),
  evaluationFindMany: vi.fn(),
  recordAudit: vi.fn(),
}));

vi.mock("@/server/db", () => ({
  prisma: {
    payrollPeriod: { findUnique: mocks.findPeriod, upsert: mocks.periodUpsert },
    payrollRecord: { count: mocks.recordCount, findMany: mocks.recordFindMany },
    organizationMember: { findMany: mocks.memberFindMany },
    videoHitEvaluation: { findMany: mocks.evaluationFindMany },
    $transaction: vi.fn(),
  },
}));

vi.mock("../user-service", () => ({
  getScope: async () => ({ organizationId: ORG_ID, userId: ADMIN, actor: { userId: ADMIN } }),
  getOrgSettings: async () => ({ baseCurrency: "USD", defaultThreshold: 1_000_000 }),
  getCurrentOrgId: async () => ORG_ID,
  getCurrentOrgSettings: async () => ({ baseCurrency: "USD", defaultThreshold: 1_000_000 }),
}));

vi.mock("../payroll-data", () => ({ loadPayrollInputs: mocks.loadPayrollInputs }));
vi.mock("@/server/audit/audit-service", () => ({ recordAudit: mocks.recordAudit }));

const { getPeriodForOrganization, finalizePeriodForOrganization } = await import(
  "../payroll-service"
);
const { periodForMonth } = await import("@/lib/payroll/payroll-engine");

const JANUARY = periodForMonth(2026, 1);
const SEVEN_DAYS = 168;

const EDITOR = {
  userId: "user_sam",
  name: "Sam",
  email: "sam@example.com",
  role: "short_form_editor",
  salaryMinor: 300_000,
  // No per-employee rate: the price of a hit is on the niche now.
  currency: "USD",
  nicheIds: ["niche_gta"],
  joinedOnMs: Date.UTC(2020, 0, 1),
  employmentEndedOnMs: null,
  // Nothing frozen behind them. `loadPayrollInputs` is what fills this in from
  // the PayrollHit rows under finalized periods, and it is mocked here.
  alreadyPaidVideoIds: [] as string[],
};

const GTA = {
  id: "niche_gta",
  name: "GTA",
  kind: "production" as const,
  // What one GTA hit pays. The rate lives here rather than on the employee.
  hitPaymentMinor: 1_000,
  hitThreshold: 1_000_000,
  hitWindowHours: SEVEN_DAYS,
};

/** A Short with a reading that proves it cleared the bar inside the window. */
function shortResolving(publishedAtMs: number, overrides: Record<string, unknown> = {}) {
  return {
    videoId: "vid_boxing_day",
    title: "Boxing Day upload",
    channelId: "chan_1",
    channelName: "Northstar GTA",
    views: 3_000_000,
    publishedAtMs,
    nicheIds: ["niche_gta"],
    isOwnChannel: true,
    evaluation: {
      // No rule recorded on the row, so there is no stored verdict for the
      // engine to read and the reading below is what decides. `outcome` is the
      // "unknown" such a row genuinely carries, and is inert here.
      outcome: "unknown",
      nicheId: null,
      thresholdApplied: null,
      windowHoursApplied: null,
      windowClosesAtMs: null,
      viewsAtWindow: 1_400_000,
      observedAtHours: 24,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findPeriod.mockResolvedValue(null);
  mocks.memberFindMany.mockResolvedValue([]);
  mocks.recordFindMany.mockResolvedValue([]);
  mocks.evaluationFindMany.mockResolvedValue([]);
  mocks.loadPayrollInputs.mockResolvedValue({
    employees: [EDITOR],
    shorts: [],
    niches: [GTA],
  });
});

describe("a hit is paid in the period it resolves", () => {
  it("pays a December Short on January's run, and says when it resolved", async () => {
    // Published 28 December, seven-day window, resolves 4 January. Under the
    // old publish-date rule this bonus could never be earned: the window was
    // still open when December was frozen.
    mocks.loadPayrollInputs.mockResolvedValue({
      employees: [EDITOR],
      shorts: [shortResolving(Date.UTC(2025, 11, 28))],
      niches: [GTA],
    });

    const period = await getPeriodForOrganization(ORG_ID, JANUARY);
    const hit = period.records[0]?.hits[0];

    expect(period.records[0]?.hitCount).toBe(1);
    expect(period.records[0]?.hitBonusMinor).toBe(1_000);

    // Both dates on the payload. A December publication date on a January run
    // reads as an error unless the resolution date is next to it.
    expect(new Date(hit!.publishedAt).toISOString()).toBe("2025-12-28T00:00:00.000Z");
    expect(new Date(hit!.windowClosesAt!).toISOString()).toBe("2026-01-04T00:00:00.000Z");
    // The whole rule, not half of it: "1,000,000 views" is not a standard.
    expect(hit!.thresholdAtRun).toBe(1_000_000);
    expect(hit!.windowHoursApplied).toBe(SEVEN_DAYS);
  });

  it("reports a niche with a threshold and no window as skipped, naming the half", async () => {
    mocks.loadPayrollInputs.mockResolvedValue({
      employees: [EDITOR],
      shorts: [shortResolving(Date.UTC(2026, 0, 5))],
      // A bar with no clock. Judging it on lifetime views would be the
      // age-biased comparison this whole change removes, so it scores nothing.
      niches: [{ ...GTA, hitWindowHours: null }],
    });

    const period = await getPeriodForOrganization(ORG_ID, JANUARY);

    expect(period.records[0]?.hitCount).toBe(0);
    expect(period.skippedNiches).toEqual([
      { nicheId: "niche_gta", nicheName: "GTA", missing: { rule: "window", payment: false }, shortCount: 1 },
    ]);
  });

  it("reports a niche with a complete rule and no payment, before anybody finalizes", async () => {
    // THE THIRD WAY TO BE HALF-CONFIGURED, through the same channel as the
    // other two. This niche scores perfectly — the Short IS a hit — and pays
    // nothing, which is invisible everywhere except a payroll run. The draft
    // names it while the fix is still cheap; once the month is frozen, setting
    // the rate changes nothing about it.
    mocks.loadPayrollInputs.mockResolvedValue({
      employees: [EDITOR],
      shorts: [shortResolving(Date.UTC(2026, 0, 5))],
      niches: [{ ...GTA, hitPaymentMinor: null }],
    });

    const period = await getPeriodForOrganization(ORG_ID, JANUARY);

    // Not credited, and not written as a zero-value hit either — a stored
    // credit would enter the paid ledger and make the Short unpayable forever.
    expect(period.records[0]?.hitCount).toBe(0);
    expect(period.records[0]?.hitBonusMinor).toBe(0);
    expect(period.skippedNiches).toEqual([
      {
        nicheId: "niche_gta",
        nicheName: "GTA",
        missing: { rule: null, payment: true },
        shortCount: 1,
      },
    ]);
  });

  it("pays a watchlist niche's hits nothing, and reports no gap for it", async () => {
    // Nobody is paid for a niche Northstar follows rather than publishes into.
    // The distinction from the test above is the point: both are a zero, and
    // only one of them is somebody's job to fix.
    mocks.loadPayrollInputs.mockResolvedValue({
      employees: [EDITOR],
      shorts: [shortResolving(Date.UTC(2026, 0, 5))],
      niches: [{ ...GTA, kind: "watchlist" as const }],
    });

    const period = await getPeriodForOrganization(ORG_ID, JANUARY);

    expect(period.records[0]?.hitCount).toBe(0);
    expect(period.records[0]?.hitBonusMinor).toBe(0);
    expect(period.skippedNiches).toEqual([]);
  });

  it("pays the niche's own rate on the draft's per-niche line", async () => {
    mocks.loadPayrollInputs.mockResolvedValue({
      employees: [EDITOR],
      shorts: [shortResolving(Date.UTC(2026, 0, 5))],
      niches: [{ ...GTA, hitPaymentMinor: 2_500 }],
    });

    const period = await getPeriodForOrganization(ORG_ID, JANUARY);
    const line = period.records[0]?.byNiche[0];

    // "1 hit × $25 = $25" — the $25 comes from the niche, and the employee's
    // own historical rate plays no part in it.
    expect(line?.hitPaymentMinor).toBe(2_500);
    expect(line?.bonusMinor).toBe(2_500);
    expect(period.records[0]?.hitBonusMinor).toBe(2_500);
  });
});

describe("what has not resolved yet", () => {
  it("pays nothing for a pending Short and reports it as a wait", async () => {
    const now = Date.UTC(2026, 0, 20);
    vi.setSystemTime(now);

    mocks.loadPayrollInputs.mockResolvedValue({
      employees: [EDITOR],
      // Published on the 18th: the window shuts on the 25th, inside January but
      // still in the future. Already over the bar and still not counted.
      shorts: [shortResolving(Date.UTC(2026, 0, 18))],
      niches: [GTA],
    });

    const period = await getPeriodForOrganization(ORG_ID, JANUARY);

    expect(period.records[0]?.hitCount).toBe(0);
    expect(period.unresolved).toEqual({ pendingCount: 1, unknownCount: 0, alreadyPaidCount: 0 });

    vi.useRealTimers();
  });

  it("pays nothing for an unknown, and never calls it the same thing as a wait", async () => {
    const now = Date.UTC(2026, 1, 20);
    vi.setSystemTime(now);

    mocks.loadPayrollInputs.mockResolvedValue({
      employees: [EDITOR],
      shorts: [
        // Window shut on 12 January with nobody recording, and it is over the
        // bar today. It got there; nothing can say whether it got there in
        // time, and nothing ever will.
        shortResolving(Date.UTC(2026, 0, 5), { evaluation: null }),
      ],
      niches: [GTA],
    });

    const period = await getPeriodForOrganization(ORG_ID, JANUARY);

    expect(period.records[0]?.hitCount).toBe(0);
    // The distinction the payroll screen is built on: a pending Short is worth
    // waiting for and an unknown one is a bonus that is simply gone.
    expect(period.unresolved).toEqual({ pendingCount: 0, unknownCount: 1, alreadyPaidCount: 0 });

    vi.useRealTimers();
  });
});

describe("re-running a period", () => {
  it("credits each Short exactly once when the same period is read twice", async () => {
    mocks.loadPayrollInputs.mockResolvedValue({
      employees: [EDITOR],
      shorts: [shortResolving(Date.UTC(2025, 11, 28))],
      niches: [GTA],
    });

    const first = await getPeriodForOrganization(ORG_ID, JANUARY);
    const second = await getPeriodForOrganization(ORG_ID, JANUARY);

    expect(second.records[0]?.hitCount).toBe(first.records[0]?.hitCount);
    expect(second.totals.totalMinor).toBe(first.totals.totalMinor);
    // One row per Short. The (record, video) unique constraint is the backstop;
    // the calculation must not be relying on it.
    const videoIds = second.records[0]!.hits.map((hit) => hit.videoId);
    expect(new Set(videoIds).size).toBe(videoIds.length);
  });

  it("leaves a finalized period completely untouched", async () => {
    mocks.findPeriod.mockResolvedValue({
      id: "period_jan",
      year: 2026,
      month: 1,
      status: "finalized",
      finalizedAt: new Date(Date.UTC(2026, 1, 1)),
      finalizedById: ADMIN,
    });
    mocks.recordCount.mockResolvedValue(3);

    const result = await finalizePeriodForOrganization({
      organizationId: ORG_ID,
      period: JANUARY,
      actorUserId: ADMIN,
    });

    expect(result.alreadyFinalized).toBe(true);
    expect(result.employeeCount).toBe(3);

    // Nothing was recomputed and nothing was written. Re-running the engine
    // over a frozen month under a rule that did not exist when it was frozen
    // would silently rewrite what was actually paid — and would discard any
    // adjustment an admin has made since.
    expect(mocks.loadPayrollInputs).not.toHaveBeenCalled();
    expect(mocks.periodUpsert).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("reads a finalized period back rather than judging it again", async () => {
    mocks.findPeriod.mockResolvedValue({
      id: "period_jan",
      year: 2026,
      month: 1,
      status: "paid",
      finalizedAt: new Date(Date.UTC(2026, 1, 1)),
      finalizedById: ADMIN,
    });
    mocks.recordFindMany.mockResolvedValue([
      {
        id: "rec_1",
        periodId: "period_jan",
        userId: EDITOR.userId,
        employeeName: "Sam",
        employeeEmail: "sam@example.com",
        roleAtRun: "short_form_editor",
        baseSalaryMinor: 300_000,
        hitPaymentMinor: 1_000,
        hitCount: 2,
        hitBonusMinor: 2_000,
        adjustmentMinor: 0,
        adjustmentReason: null,
        totalMinor: 302_000,
        currency: "USD",
        paymentStatus: "paid",
        paidAt: new Date(Date.UTC(2026, 1, 1)),
        hits: [],
        period: { year: 2026, month: 1 },
      },
    ]);

    const period = await getPeriodForOrganization(ORG_ID, JANUARY);

    expect(period.isDraft).toBe(false);
    expect(period.totals.totalMinor).toBe(302_000);
    expect(mocks.loadPayrollInputs).not.toHaveBeenCalled();

    // A frozen period reports neither, and not by omission: both describe what
    // TODAY's configuration would do, and hanging either on a settled document
    // is the retroactive reading this service refuses.
    expect(period.skippedNiches).toEqual([]);
    expect(period.unresolved).toEqual({ pendingCount: 0, unknownCount: 0, alreadyPaidCount: 0 });
  });
});
