import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * =========================================================================
 * WHAT A SETTLED PAYSLIP SAYS ABOUT A HIT THAT EARNED NOTHING
 * =========================================================================
 *
 * THE SILENCE. A hit pays only when its niche carries a threshold, a window AND
 * a price. Miss the price and the engine pays nothing — which is correct and
 * must stay correct — and it reports the fact, per employee, to four admin
 * screens. It reported it to the employee on the ESTIMATE path only.
 *
 * The finalized path is the one the money is on, and it disclosed nothing. A
 * frozen record is rebuilt from stored `PayrollHit` rows, and the engine writes
 * no hit row for a hit it could not price (a zero-value row would enter the
 * paid ledger and make that Short unpayable forever). So the niche vanished
 * from the payslip entirely and the page fell through to its empty state: "You
 * are not on any niche yet." He was on a niche. He had won a hit. The screen
 * told him the opposite of the reason and sent him to the wrong field.
 *
 * WHAT THIS FILE PINS
 *   1. The explanation is there, on the FINALIZED path, naming the niche and
 *      the missing setting.
 *   2. Every figure is byte-for-byte the stored record's. This work discloses;
 *      it must never pay, and a scope slip has to fail loudly here.
 *   3. The RATE never appears — the disclosure is that a price is absent, never
 *      what any price is. See `niche-pay-disclosure.test.ts` for the endpoint
 *      that leaked one.
 *   4. Nothing outside the caller's own assignment reaches the payload.
 *   5. The permission set consulted is pinned exactly, not merely the outcome —
 *      a third gate appearing without anybody deciding what it guards is what
 *      that catches.
 *
 * Prisma, the niche read and the session are stubs. What is under test is the
 * decision — which sentences a settled month may say — not Prisma's filtering.
 */

// The payroll module graph reaches the DAL, which validates SESSION_SECRET
// through auth-env at import time.
process.env.SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");

const ORG_ID = "org_northstar";
const JOHN = "user_john";
const OTHER = "user_someone_else";

const mocks = vi.hoisted(() => ({
  actor: {
    userId: "user_john",
    sessionId: "sess_1",
    email: "john@example.com",
    name: "John",
    organizationId: "org_northstar",
    organizationName: "Northstar",
    role: "short_form_editor",
    grants: [] as string[],
  },
  requirePermission: vi.fn<(permission: string) => Promise<unknown>>(),
  loadPayrollInputs: vi.fn(),
  loadAssignedNiches: vi.fn(),
  findPeriod: vi.fn(),
  findRecord: vi.fn(),
  findEvaluations: vi.fn(),
  findNiches: vi.fn(),
}));

const ORG_SETTINGS = { baseCurrency: "USD", defaultThreshold: 1_000_000, companyName: "Northstar" };

vi.mock("@/server/db", () => ({
  prisma: {
    payrollPeriod: { findUnique: mocks.findPeriod },
    payrollRecord: { findFirst: mocks.findRecord, findMany: vi.fn() },
    videoHitEvaluation: { findMany: mocks.findEvaluations },
    niche: { findMany: mocks.findNiches },
  },
}));

vi.mock("@/server/auth/dal", async () => {
  const { effectivePermissions } = await import("@/lib/auth/permissions");
  const { errors } = await import("@/server/errors");

  const resolve = () => ({
    ...mocks.actor,
    permissions: effectivePermissions(mocks.actor.role, mocks.actor.grants),
  });

  return {
    getActor: async () => resolve(),
    requireActor: async () => resolve(),
    requirePermission: async (permission: string) => {
      await mocks.requirePermission(permission);
      const actor = resolve();
      if (!actor.permissions.has(permission as never)) throw errors.forbidden("do that");
      return actor;
    },
  };
});

vi.mock("../user-service", () => ({
  getScope: async () => ({
    organizationId: mocks.actor.organizationId,
    userId: mocks.actor.userId,
    actor: mocks.actor,
  }),
  getCurrentOrgId: async () => ORG_ID,
  getCurrentOrgSettings: async () => ORG_SETTINGS,
  getOrgSettings: async () => ORG_SETTINGS,
}));

vi.mock("../payroll-data", () => ({
  loadPayrollInputs: mocks.loadPayrollInputs,
  loadAssignedNiches: mocks.loadAssignedNiches,
}));

vi.mock("@/server/audit/audit-service", () => ({ recordAudit: vi.fn() }));

const { getMyEarnings } = await import("../payroll-service");
const { periodContaining, periodLabel, previousPeriod } = await import(
  "@/lib/payroll/payroll-engine"
);

/** The month the owner's employee was looking at: last month, finalized. */
const LAST_MONTH = previousPeriod(periodContaining(Date.now()));
const LABEL = periodLabel(LAST_MONTH);

/** $733.37 a hit — a figure that appears nowhere else, so a leak is unmistakable. */
const GTA_RATE_IF_IT_HAD_ONE = 73_337;

/** GTA judges perfectly and has no price on a hit. The owner's actual case. */
const UNPRICED_GTA = {
  id: "niche_gta",
  name: "GTA",
  kind: "production" as const,
  hitPaymentMinor: null,
  hitThreshold: 1_000_000,
  hitWindowHours: 168,
};

/** John's August: $1,900 salary, no bonus, and no PayrollHit rows at all. */
function storedRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "rec_1",
    periodId: "period_1",
    userId: JOHN,
    employeeName: "John",
    employeeEmail: "john@example.com",
    roleAtRun: "short_form_editor",
    baseSalaryMinor: 190_000,
    hitPaymentMinor: 0,
    hitCount: 0,
    hitBonusMinor: 0,
    adjustmentMinor: 0,
    adjustmentReason: null,
    totalMinor: 190_000,
    currency: "USD",
    paymentStatus: "pending",
    paidAt: null,
    hits: [] as unknown[],
    period: { year: LAST_MONTH.year, month: LAST_MONTH.month },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.userId = JOHN;
  mocks.actor.role = "short_form_editor";
  mocks.actor.grants = [];
  mocks.findPeriod.mockResolvedValue({
    id: "period_1",
    year: LAST_MONTH.year,
    month: LAST_MONTH.month,
    status: "finalized",
    finalizedAt: new Date(),
    finalizedById: null,
  });
  mocks.findRecord.mockResolvedValue(storedRecord());
  mocks.findEvaluations.mockResolvedValue([]);
  mocks.findNiches.mockResolvedValue([]);
  mocks.loadAssignedNiches.mockResolvedValue([UNPRICED_GTA]);
  mocks.loadPayrollInputs.mockResolvedValue({ employees: [], shorts: [], niches: [] });
});

describe("the settled month explains a hit that could not be paid", () => {
  it("names the niche and the missing setting instead of saying nothing", async () => {
    const earnings = await getMyEarnings({ period: { kind: "previous" } });

    const notices = earnings.notices.join(" ");
    expect(notices).toContain("GTA has no hit payment set");
    expect(notices).toContain("a hit in it earns nothing");
    expect(notices).toContain(`${LABEL} is settled and its figures do not change`);
    expect(notices).toContain("An administrator sets what a hit in this niche is worth");
  });

  /**
   * The employee is on a niche and there is no hit line to draw, which used to
   * render "You are not on any niche yet ... An administrator adds you to one
   * on your employee page." The count is what tells the page the difference.
   */
  it("carries their own assignment count, so the page cannot claim they have none", async () => {
    const earnings = await getMyEarnings({ period: { kind: "previous" } });

    expect(earnings.byNiche).toEqual([]);
    expect(earnings.assignedNicheCount).toBe(1);
  });

  /**
   * THE ROW UNDER THE TOTAL, WHICH IS WHERE SOMEBODY STOPS READING.
   *
   * `hitCount` is the number of hits that were PAID — the engine writes no
   * `PayrollHit` for one it could not price — so John reaches the page as a
   * zero, and the note beside "Extra money from hits" rendered the bare words
   * "no hits" off it. He had a hit, by the page's own definition of the word
   * three cards lower, and the notice directly beneath said so. This count is
   * what lets that row say "no hit bonus — see below" instead of contradicting
   * the paragraph under it, and it is the notices' own length rather than a
   * second derivation that could disagree with them.
   */
  it("counts the disclosures it just made, for the row under the total", async () => {
    const earnings = await getMyEarnings({ period: { kind: "previous" } });

    expect(earnings.hitCount).toBe(0);
    expect(earnings.unpaidNicheCount).toBe(1);
    expect(earnings.notices.filter((notice) => notice.includes("GTA"))).toHaveLength(1);
  });

  /** No gap, no pointer: the row must not promise an explanation that is absent. */
  it("counts nothing when every niche of theirs is fully configured", async () => {
    mocks.loadAssignedNiches.mockResolvedValue([
      { ...UNPRICED_GTA, hitPaymentMinor: 500 },
    ]);

    const earnings = await getMyEarnings({ period: { kind: "previous" } });

    expect(earnings.unpaidNicheCount).toBe(0);
    expect(earnings.notices.join(" ")).not.toContain("GTA");
  });

  it("never promises the settled figure will change", async () => {
    const earnings = await getMyEarnings({ period: { kind: "previous" } });

    for (const notice of earnings.notices) {
      expect(notice).not.toMatch(/waiting/i);
    }
    // "yet" would say the number is still coming. It is not.
    const gapNotice = earnings.notices.find((notice) => notice.includes("GTA")) ?? "";
    expect(gapNotice).not.toMatch(/\byet\b/i);
  });

  /**
   * A rule gap and a payment gap are different losses. One says the Shorts were
   * never measured; the other says they were measured, they won, and there was
   * no number to multiply by — and telling somebody their hits "could not be
   * counted" when they were counted understates what happened to them.
   */
  it("says something different about a niche that cannot judge at all", async () => {
    mocks.loadAssignedNiches.mockResolvedValue([
      { ...UNPRICED_GTA, hitThreshold: null, hitPaymentMinor: 500 },
    ]);

    const notices = (await getMyEarnings({ period: { kind: "previous" } })).notices.join(" ");
    expect(notices).toContain("GTA has no hit threshold set");
    expect(notices).toContain("nothing in it can count as a hit");
    expect(notices).not.toContain("what a hit in this niche is worth");
  });
});

describe("nothing about this disclosure moves a figure", () => {
  /**
   * THE SCOPE GUARD. The engine's refusal to price an unpriced hit is correct
   * and is not what this work changes. If an edit ever lets a gap contribute to
   * a total, this fails — which is why the same record is read with the
   * disclosure on and off and every money field compared.
   */
  it("returns the stored figures byte for byte, disclosure or not", async () => {
    const disclosed = await getMyEarnings({ period: { kind: "previous" } });

    mocks.loadAssignedNiches.mockResolvedValue([]);
    const silent = await getMyEarnings({ period: { kind: "previous" } });

    for (const earnings of [disclosed, silent]) {
      expect(earnings.baseSalaryMinor).toBe(190_000);
      expect(earnings.hitBonusMinor).toBe(0);
      expect(earnings.hitCount).toBe(0);
      expect(earnings.adjustmentMinor).toBe(0);
      expect(earnings.totalMinor).toBe(190_000);
      expect(earnings.basis).toBe("finalized");
    }

    // And the disclosure really was the only difference.
    expect(disclosed.notices.length).toBeGreaterThan(silent.notices.length);
  });

  it("never re-runs the engine over a month that is already settled", async () => {
    await getMyEarnings({ period: { kind: "previous" } });
    expect(mocks.loadPayrollInputs).not.toHaveBeenCalled();
  });
});

describe("what the disclosure may not reveal", () => {
  /**
   * The gap is an EXISTENCE claim — "nobody has set a price" — never a value.
   * A rate on this payload would be the leak `niche-pay-disclosure.test.ts` was
   * written after, arriving through a different door.
   */
  it("states that a price is absent and never what any price is", async () => {
    // A second assigned niche that DOES have a rate, so there is a real number
    // in the loader's output for a careless mapping to pick up.
    mocks.loadAssignedNiches.mockResolvedValue([
      UNPRICED_GTA,
      {
        id: "niche_rdr",
        name: "RDR",
        kind: "production" as const,
        hitPaymentMinor: GTA_RATE_IF_IT_HAD_ONE,
        hitThreshold: 500_000,
        hitWindowHours: 48,
      },
    ]);

    const earnings = await getMyEarnings({ period: { kind: "previous" } });
    const payload = JSON.stringify(earnings);

    expect(payload).not.toContain(String(GTA_RATE_IF_IT_HAD_ONE));
    expect(payload).not.toContain("733.37");
    // A fully configured niche is not a gap and gets no sentence at all.
    expect(earnings.notices.join(" ")).not.toContain("RDR");
  });

  it("says nothing about a niche this person is not on", async () => {
    const earnings = await getMyEarnings({ period: { kind: "previous" } });
    const payload = JSON.stringify(earnings);

    // `loadAssignedNiches` is asked for THIS caller and nothing wider.
    expect(mocks.loadAssignedNiches).toHaveBeenCalledWith(ORG_ID, JOHN);
    expect(payload).not.toContain(OTHER);
    expect(payload).not.toContain("Minecraft");
  });

  /**
   * A niche that PAID a line on this record is excluded whatever it is missing
   * today. Without the guard, an admin removing GTA's price in November would
   * stamp "GTA has no hit payment set" onto every settled payslip back to
   * January, beside lines showing GTA hits paid in full.
   */
  it("stays quiet about a niche that actually paid on this record", async () => {
    mocks.findRecord.mockResolvedValue(
      storedRecord({
        hitPaymentMinor: 500,
        hitCount: 1,
        hitBonusMinor: 500,
        totalMinor: 190_500,
        hits: [
          {
            videoId: "vid_1",
            videoTitle: "A very good Short",
            channelId: "chan_1",
            channelName: "Northstar GTA",
            nicheId: "niche_gta",
            nicheName: "GTA",
            thresholdAtRun: 1_000_000,
            viewCountAtRun: BigInt(2_000_000),
            publishedAt: new Date(LAST_MONTH.startsAtMs),
          },
        ],
      }),
    );

    const earnings = await getMyEarnings({ period: { kind: "previous" } });

    expect(earnings.notices.join(" ")).not.toContain("GTA has no hit payment set");
    // The paid line is still there, and still says what it was worth.
    expect(earnings.byNiche).toHaveLength(1);
    expect(earnings.totalMinor).toBe(190_500);
  });

  /**
   * A watchlist niche is not a gap. Nobody is paid for one and there is no
   * setting to fill in, so a sentence about it would send somebody after a
   * number that should not exist.
   */
  it("does not report a watchlist niche as a missing setting", async () => {
    mocks.loadAssignedNiches.mockResolvedValue([
      { ...UNPRICED_GTA, id: "niche_watch", name: "Fortnite", kind: "watchlist" as const },
    ]);

    const earnings = await getMyEarnings({ period: { kind: "previous" } });
    expect(earnings.notices.join(" ")).not.toContain("Fortnite");
    // Still counted as an assignment, because they really are on it.
    expect(earnings.assignedNicheCount).toBe(1);
  });
});

describe("the gate this path is behind", () => {
  /**
   * The SET, not merely the outcome. Pinning the whole set is what would catch
   * a third gate appearing without anybody deciding what it guards — and, on
   * this path specifically, a `payroll.view` or `finance.view` creeping in
   * would turn the employee's own screen into one only an admin can open.
   */
  it("consults exactly one permission, and it is the self-service one", async () => {
    await getMyEarnings({ period: { kind: "previous" } });

    expect(
      mocks.requirePermission.mock.calls.map(([permission]) => permission).sort(),
    ).toEqual(["earnings.view_own"]);
  });

  it("refuses before reading a niche, not after", async () => {
    mocks.actor.role = "admin";

    await expect(getMyEarnings({ period: { kind: "previous" } })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.loadAssignedNiches).not.toHaveBeenCalled();
    expect(mocks.findRecord).not.toHaveBeenCalled();
  });
});
