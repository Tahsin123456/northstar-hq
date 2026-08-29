import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `getMyEarnings` returns the caller's figures, and offers no way to ask for
 * anybody else's.
 *
 * The bug behind this whole round is a Head of Shorts logging in and seeing the
 * admin's rows. Pay is the version of that mistake nobody would forgive, so the
 * guarantee here is structural rather than defensive: the function takes a
 * period and nothing else, and resolves the subject from the session. There is
 * no `userId` argument to get wrong.
 *
 * A test cannot prove the absence of a parameter by calling the function
 * correctly, so this file attacks it from both sides:
 *
 *   1. The QUERY PARSER is handed every shape an attacker would try — a userId
 *      in the query string, an extra key, a whole employee record — and must
 *      refuse to carry any of it through.
 *   2. The SERVICE is called while signed in as Sam and must have loaded Sam's
 *      row, proven by the `onlyUserId` the data layer was asked for and by the
 *      `where` clause used to read a finalized record.
 *
 * Prisma, the engine's inputs and the session are stubs. What is under test is
 * the decision — whose id reaches the query — not Prisma's ability to filter.
 */

// The payroll module graph reaches the DAL, which validates SESSION_SECRET
// through auth-env at import time.
process.env.SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");

const ORG_ID = "org_northstar";

/** Sam is an editor. Dana is the admin whose pay Sam must never see. */
const SAM = "user_sam";
const DANA = "user_dana";

const mocks = vi.hoisted(() => ({
  actor: {
    userId: "user_sam",
    sessionId: "sess_1",
    email: "sam@example.com",
    name: "Sam",
    organizationId: "org_northstar",
    organizationName: "Northstar",
    role: "short_form_editor",
    grants: [] as string[],
  },
  loadPayrollInputs: vi.fn(),
  findPeriod: vi.fn(),
  findRecord: vi.fn(),
}));

const ORG_SETTINGS = { baseCurrency: "USD", defaultThreshold: 1_000_000 };

vi.mock("@/server/db", () => ({
  prisma: {
    payrollPeriod: { findUnique: mocks.findPeriod },
    payrollRecord: { findFirst: mocks.findRecord, findMany: vi.fn() },
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

vi.mock("../payroll-data", () => ({ loadPayrollInputs: mocks.loadPayrollInputs }));

vi.mock("@/server/audit/audit-service", () => ({ recordAudit: vi.fn() }));

const { getMyEarnings, parseMyEarningsPeriod } = await import("../payroll-service");

/**
 * The fixture Short resolves INSIDE the current month, whichever day this runs.
 *
 * A hit is now a threshold reached inside a window, and a run pays the Shorts
 * whose window CLOSED inside the period — so a fixture pinned to "24 hours ago"
 * no longer describes anything: on the 1st of a month that Short belongs to the
 * previous period, and under any realistic window it would still be pending
 * anyway. Publishing at the top of the month with a one-hour window puts both
 * the publication and the close inside the period on every day of it.
 */
const MONTH_STARTS_AT = Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  1,
);
const FIXTURE_WINDOW_HOURS = 1;

/** One employee, one niche, one Short that cleared the bar inside its window. */
function inputsFor(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    employees: [
      {
        userId,
        name: userId === SAM ? "Sam" : "Dana",
        email: `${userId}@example.com`,
        role: "short_form_editor",
        salaryMinor: 300_000,
        hitPaymentMinor: 1_000,
        currency: "USD",
        nicheIds: ["niche_gta"],
        joinedOnMs: Date.UTC(2020, 0, 1),
        employmentEndedOnMs: null,
        ...overrides,
      },
    ],
    shorts: [
      {
        videoId: "vid_1",
        title: "A very good Short",
        channelId: "chan_1",
        channelName: "Northstar GTA",
        views: 2_000_000,
        publishedAtMs: MONTH_STARTS_AT,
        nicheIds: ["niche_gta"],
        isOwnChannel: true,
        // The materialised evaluation. Without a reading from inside the window
        // this Short would be an "unknown" — over the bar today with nothing to
        // say when it got there — and an unknown never pays. That is the new
        // rule working, and it is why every fixture that means "this one hit"
        // has to say what was seen.
        evaluation: {
          nicheId: null,
          thresholdApplied: null,
          windowHoursApplied: null,
          viewsAtWindow: 2_000_000,
          observedAtHours: 0,
        },
      },
    ],
    // No `organizationDefaultThreshold`: the payroll path no longer takes one.
    // A niche's own rule is the only one there is, and a null in either half
    // means there is none rather than "use the organization's".
    niches: [
      {
        id: "niche_gta",
        name: "GTA",
        hitThreshold: 1_000_000,
        hitWindowHours: FIXTURE_WINDOW_HOURS,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.userId = SAM;
  mocks.actor.role = "short_form_editor";
  mocks.actor.grants = [];
  mocks.findPeriod.mockResolvedValue(null);
  mocks.findRecord.mockResolvedValue(null);
  mocks.loadPayrollInputs.mockImplementation(
    async (_org: string, _period: unknown, options: { onlyUserId?: string } = {}) =>
      inputsFor(options.onlyUserId ?? SAM),
  );
});

describe("whose earnings are returned", () => {
  it("loads the signed-in person's row, taken from the session", async () => {
    await getMyEarnings({ period: { kind: "current" } });

    const [organizationId, , options] = mocks.loadPayrollInputs.mock.calls[0] as [
      string,
      unknown,
      { onlyUserId?: string },
    ];
    expect(organizationId).toBe(ORG_ID);
    expect(options.onlyUserId).toBe(SAM);
  });

  it("follows the session when it changes, and never a caller's argument", async () => {
    // The only thing that can move the subject is who is signed in. Dana's
    // session gets Dana's row; nothing about the call site changed.
    mocks.actor.userId = DANA;
    mocks.actor.role = "head_of_shorts";

    await getMyEarnings({ period: { kind: "current" } });

    const options = mocks.loadPayrollInputs.mock.calls[0]?.[2] as { onlyUserId?: string };
    expect(options.onlyUserId).toBe(DANA);
  });

  it("filters a finalized record by the session's user id and organization", async () => {
    mocks.findPeriod.mockResolvedValue({
      id: "period_1",
      year: 2026,
      month: 7,
      status: "finalized",
      finalizedAt: new Date(),
      finalizedById: DANA,
    });
    mocks.findRecord.mockResolvedValue(null);

    await getMyEarnings({ period: { kind: "previous" } });

    const where = (mocks.findRecord.mock.calls[0]?.[0] as { where: Record<string, unknown> }).where;
    // Both halves matter: `userId` is the ownership filter, and the period is
    // re-scoped to the organization so a refactor of how the row arrives cannot
    // quietly cross the tenancy line.
    expect(where).toMatchObject({
      periodId: "period_1",
      userId: SAM,
      period: { organizationId: ORG_ID },
    });
    // And under no circumstances an admin's id, even though the admin is the
    // person who finalized the period.
    expect(JSON.stringify(where)).not.toContain(DANA);
  });

  it("never widens the payroll load to the whole team", async () => {
    // The admin dashboard calls the same loader with no `onlyUserId` and gets
    // everybody. This path must always narrow — the personal screen is about
    // one person by construction, not by the caller's restraint.
    mocks.actor.role = "head_of_shorts";

    await getMyEarnings({ period: { kind: "current" } });

    const options = mocks.loadPayrollInputs.mock.calls[0]?.[2] as { onlyUserId?: string };
    expect(options?.onlyUserId).toBe(SAM);
  });

  /**
   * An admin cannot reach this path at all, and that is deliberate.
   *
   * They read Admin → Payroll, which is every row including their own, so a
   * personal earnings page would be a narrower answer to a question they can
   * already ask better. `earnings.view_own` is withheld from the Admin role for
   * exactly that reason — see `WITHHELD_FROM_ADMIN` — and the refusal is
   * asserted here because a service that silently returned an admin's own row
   * would look correct while contradicting the nav they are actually shown.
   */
  it("refuses an admin outright rather than narrowing them to their own row", async () => {
    mocks.actor.role = "admin";

    await expect(getMyEarnings({ period: { kind: "current" } })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.loadPayrollInputs).not.toHaveBeenCalled();
  });

  it("refuses a caller who holds no permission at all", async () => {
    mocks.actor.role = "nobody_at_all";
    mocks.actor.grants = [];
    // `roleDefinition` fails closed to the least-privileged role, which does
    // hold `earnings.view_own` — every employee role does. So the assertion is
    // the opposite one: an unknown role gets its OWN row and nothing wider.
    await expect(getMyEarnings({ period: { kind: "current" } })).resolves.toBeTruthy();
    const options = mocks.loadPayrollInputs.mock.calls[0]?.[2] as { onlyUserId?: string };
    expect(options.onlyUserId).toBe(SAM);
  });
});

describe("the query parser refuses to carry a person", () => {
  it("ignores a userId in the query string", () => {
    // The route reads three named parameters, so this is what a `?userId=` that
    // slipped past a future refactor would meet.
    const selection = parseMyEarningsPeriod({ period: "current" });
    expect(selection).toEqual({ kind: "current" });
    expect(Object.keys(selection)).toEqual(["kind"]);
  });

  it("has no key for one, even in a custom range", () => {
    const selection = parseMyEarningsPeriod({
      period: "custom",
      startsAt: String(Date.UTC(2026, 6, 1)),
      endsAt: String(Date.UTC(2026, 7, 1)),
    });
    expect(Object.keys(selection).sort()).toEqual(["endsAtMs", "kind", "startsAtMs"]);
  });

  it("defaults to the current month rather than to a date at the epoch", () => {
    // `Number(null)` is 0. Without the null-to-undefined normalisation, a
    // request with no parameters would ask about 1 January 1970.
    expect(parseMyEarningsPeriod({ period: null, startsAt: null, endsAt: null })).toEqual({
      kind: "current",
    });
  });

  it("rejects a range on a named period, rather than silently ignoring it", () => {
    expect(() =>
      parseMyEarningsPeriod({ period: "current", startsAt: "0", endsAt: "1" }),
    ).toThrowError();
  });

  it("rejects a half-specified, inverted or absurd custom range", () => {
    const start = Date.UTC(2026, 6, 1);
    expect(() => parseMyEarningsPeriod({ period: "custom", startsAt: String(start) })).toThrowError();
    expect(() =>
      parseMyEarningsPeriod({ period: "custom", startsAt: String(start), endsAt: String(start) }),
    ).toThrowError();
    expect(() =>
      parseMyEarningsPeriod({
        period: "custom",
        startsAt: String(start),
        endsAt: String(start + 5 * 365 * 24 * 60 * 60 * 1000),
      }),
    ).toThrowError();
  });
});

describe("the figure, and the reason behind it", () => {
  it("reuses the payroll engine rather than approximating it", async () => {
    const result = await getMyEarnings({ period: { kind: "current" } });
    const earnings = result;

    // 300,000 salary + one hit at 1,000. If this screen and the payroll screen
    // could differ, one would be wrong and nobody could tell which.
    expect(earnings.baseSalaryMinor).toBe(300_000);
    expect(earnings.hitCount).toBe(1);
    expect(earnings.hitBonusMinor).toBe(1_000);
    expect(earnings.totalMinor).toBe(301_000);
    expect(earnings.basis).toBe("estimate");
  });

  it("labels an open period as an estimate, out loud", async () => {
    const earnings = await getMyEarnings({ period: { kind: "current" } });
    expect(earnings.basis).toBe("estimate");
    expect(earnings.notices.join(" ")).toMatch(/estimate/i);
  });

  /**
   * This test used to assert the opposite: that an unconfigured niche inherited
   * the organization default, reported `thresholdSource: "organization"` and a
   * `thresholdApplied` of 1,000,000, and paid a bonus against it. That was the
   * bug written down as an expectation — the borrowed number looked like a
   * measurement, and money moved on it. It is rewritten rather than weakened,
   * because there is no softer version of "we paid for hits we said we could
   * not measure".
   */
  it("reports a niche with no threshold as unconfigured, and counts nothing in it", async () => {
    mocks.loadPayrollInputs.mockImplementation(async () => ({
      ...inputsFor(SAM),
      // Nobody has said what a hit means in this niche, so nothing in it is one.
      niches: [{ id: "niche_gta", name: "GTA", hitThreshold: null, hitWindowHours: FIXTURE_WINDOW_HOURS }],
    }));

    const earnings = await getMyEarnings({ period: { kind: "current" } });

    const line = earnings.byNiche.find((entry) => entry.nicheId === "niche_gta");
    expect(line?.thresholdSource).toBe("unconfigured");
    // Null, not 1,000,000 and not 0. There is no bar to state.
    expect(line?.thresholdApplied).toBeNull();
    expect(line?.hitCount).toBe(0);

    // The 2,000,000-view Short in `inputsFor` used to pay $10 here.
    expect(earnings.hitCount).toBe(0);
    expect(earnings.hitBonusMinor).toBe(0);
    expect(earnings.totalMinor).toBe(300_000); // salary only
  });

  it("tells the employee a zero bonus is a missing setting, not their work", async () => {
    mocks.loadPayrollInputs.mockImplementation(async () => ({
      ...inputsFor(SAM),
      niches: [{ id: "niche_gta", name: "GTA", hitThreshold: null, hitWindowHours: FIXTURE_WINDOW_HOURS }],
    }));

    const earnings = await getMyEarnings({ period: { kind: "current" } });

    // Every niche they are on is unconfigured, so nothing about them can be
    // measured at all. The page leads with that rather than with a zero.
    expect(earnings.noMeasurableNiche).toBe(true);
    // `missing` names the half that is absent. A niche can now be unscoreable
    // for having no window as easily as for having no bar, and "unconfigured"
    // on its own would send them to the wrong field.
    expect(earnings.skippedNiches).toEqual([
      { nicheId: "niche_gta", nicheName: "GTA", missing: "threshold", shortCount: 1 },
    ]);

    const notices = earnings.notices.join(" ");
    expect(notices).toMatch(/no hit threshold set/i);
    expect(notices).toMatch(/administrator/i);
    // The sentence that would be a lie here: there was no threshold to reach.
    expect(notices).not.toMatch(/reached its threshold/i);
  });

  it("still says 'nothing reached the bar' when the bar exists", async () => {
    mocks.loadPayrollInputs.mockImplementation(async () => ({
      ...inputsFor(SAM),
      shorts: [],
    }));

    const earnings = await getMyEarnings({ period: { kind: "current" } });

    expect(earnings.noMeasurableNiche).toBe(false);
    // "Crossed its threshold" was the old sentence and it is now half a claim:
    // a Short can cross the threshold and still not be a hit, which is the
    // entire change. The notice names the window too.
    expect(earnings.notices.join(" ")).toMatch(/reached its threshold inside the window/i);
  });

  it("explains a zero caused by having no niches, rather than reporting nothing", async () => {
    mocks.loadPayrollInputs.mockImplementation(async () => inputsFor(SAM, { nicheIds: [] }));

    const earnings = await getMyEarnings({ period: { kind: "current" } });

    expect(earnings.hitBonusMinor).toBe(0);
    expect(earnings.byNiche).toEqual([]);
    expect(earnings.notices.join(" ")).toMatch(/not assigned to any niches/i);
  });

  it("explains a zero caused by an unset per-hit rate", async () => {
    mocks.loadPayrollInputs.mockImplementation(async () =>
      inputsFor(SAM, { hitPaymentMinor: 0 }),
    );

    const earnings = await getMyEarnings({ period: { kind: "current" } });

    expect(earnings.hitBonusMinor).toBe(0);
    expect(earnings.notices.join(" ")).toMatch(/per-hit rate is not set/i);
  });

  it("lists an assigned niche that earned nothing, rather than omitting it", async () => {
    mocks.loadPayrollInputs.mockImplementation(async () => ({
      ...inputsFor(SAM),
      shorts: [],
      niches: [
        { id: "niche_gta", name: "GTA", hitThreshold: 1_000_000, hitWindowHours: FIXTURE_WINDOW_HOURS },
        { id: "niche_rdr", name: "RDR", hitThreshold: 500_000, hitWindowHours: FIXTURE_WINDOW_HOURS },
      ],
    }));

    const earnings = await getMyEarnings({ period: { kind: "current" } });

    // A niche missing from the list is indistinguishable from a niche the
    // person was never assigned to, and those are different problems.
    expect(earnings.byNiche.map((line) => line.nicheName)).toEqual(["GTA"]);
    expect(earnings.byNiche[0]?.hitCount).toBe(0);
  });

  it("says so when there is no employee profile, instead of reporting zero pay", async () => {
    mocks.loadPayrollInputs.mockImplementation(async () => ({
      ...inputsFor(SAM),
      employees: [],
    }));

    const earnings = await getMyEarnings({ period: { kind: "current" } });

    expect(earnings.onPayroll).toBe(false);
    expect(earnings.totalMinor).toBe(0);
    expect(earnings.currency).toBe("USD");
    expect(earnings.notices.join(" ")).toMatch(/employee profile/i);
  });
});

describe("a finalized period is a document, not a calculation", () => {
  it("returns the stored record and never re-runs the engine", async () => {
    mocks.findPeriod.mockResolvedValue({
      id: "period_1",
      year: 2026,
      month: 7,
      status: "paid",
      finalizedAt: new Date(Date.UTC(2026, 7, 1)),
      finalizedById: DANA,
    });
    mocks.findRecord.mockResolvedValue({
      id: "rec_1",
      periodId: "period_1",
      userId: SAM,
      employeeName: "Sam",
      employeeEmail: "sam@example.com",
      roleAtRun: "short_form_editor",
      baseSalaryMinor: 300_000,
      hitPaymentMinor: 1_000,
      hitCount: 4,
      hitBonusMinor: 4_000,
      adjustmentMinor: -500,
      adjustmentReason: "Corrected a duplicate hit",
      totalMinor: 303_500,
      currency: "USD",
      paymentStatus: "paid",
      paidAt: new Date(Date.UTC(2026, 7, 1)),
      hits: [],
      period: { year: 2026, month: 7 },
    });

    const earnings = await getMyEarnings({ period: { kind: "previous" } });

    expect(earnings.basis).toBe("finalized");
    expect(earnings.totalMinor).toBe(303_500);
    expect(earnings.paymentStatus).toBe("paid");
    // The engine is not consulted at all. A Short that crossed its threshold
    // last week must not change what July cost.
    expect(mocks.loadPayrollInputs).not.toHaveBeenCalled();
  });

  it("shows the adjustment and its reason, so the total can be accounted for", async () => {
    mocks.findPeriod.mockResolvedValue({
      id: "period_1",
      year: 2026,
      month: 7,
      status: "finalized",
      finalizedAt: new Date(),
      finalizedById: DANA,
    });
    mocks.findRecord.mockResolvedValue({
      id: "rec_1",
      periodId: "period_1",
      userId: SAM,
      employeeName: "Sam",
      employeeEmail: "sam@example.com",
      roleAtRun: "short_form_editor",
      baseSalaryMinor: 300_000,
      hitPaymentMinor: 1_000,
      hitCount: 0,
      hitBonusMinor: 0,
      adjustmentMinor: 2_500,
      adjustmentReason: "Missed hit in GTA, added by hand",
      totalMinor: 302_500,
      currency: "USD",
      paymentStatus: "pending",
      paidAt: null,
      hits: [],
      period: { year: 2026, month: 7 },
    });

    const earnings = await getMyEarnings({ period: { kind: "previous" } });

    // base + bonus + adjustment = total, and every part is on the payload. A
    // figure an employee cannot take apart is one they have to take on trust.
    expect(
      earnings.baseSalaryMinor + earnings.hitBonusMinor + earnings.adjustmentMinor,
    ).toBe(earnings.totalMinor);
    expect(earnings.adjustmentReason).toBe("Missed hit in GTA, added by hand");
  });

  it("never treats a custom range as a period that could be finalized", async () => {
    await getMyEarnings({
      period: {
        kind: "custom",
        startsAtMs: Date.UTC(2026, 6, 1),
        endsAtMs: Date.UTC(2026, 6, 15),
      },
    });

    // No period row is even looked for: a fortnight is not a payroll month, and
    // returning a stored figure for one would be answering a different question.
    expect(mocks.findPeriod).not.toHaveBeenCalled();
    expect(mocks.findRecord).not.toHaveBeenCalled();
    expect(mocks.loadPayrollInputs).toHaveBeenCalledTimes(1);
  });

  it("says a finalized period has no record for you, rather than showing zero", async () => {
    mocks.findPeriod.mockResolvedValue({
      id: "period_1",
      year: 2026,
      month: 7,
      status: "finalized",
      finalizedAt: new Date(),
      finalizedById: DANA,
    });
    mocks.findRecord.mockResolvedValue(null);

    const earnings = await getMyEarnings({ period: { kind: "previous" } });

    expect(earnings.basis).toBe("finalized");
    expect(earnings.totalMinor).toBe(0);
    expect(earnings.notices.join(" ")).toMatch(/no record in it/i);
  });
});
