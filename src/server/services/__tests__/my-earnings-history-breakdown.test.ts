import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `getMyEarningsHistoryBreakdown` explains ONE settled month of the caller's own
 * pay, and offers no way to ask about anybody else's.
 *
 * The sibling `my-earnings-history.test.ts` pins the list. This file exists
 * because the breakdown is the endpoint that takes a MONTH — a small, guessable,
 * enumerable key — which makes it the one an ownership slip would turn into a
 * way to walk a colleague's payroll a period at a time. It is also the endpoint
 * that reads the stored PayrollHit rows, so it is where "what was owed then"
 * could quietly become "what today's thresholds would say".
 *
 * Five things are pinned, in the order they would hurt:
 *
 *   1. OWNERSHIP — the query filters on the session's user and organization, and
 *      no argument, extra key or cast can move either.
 *   2. NO PERSON IN THE REQUEST — the parser has two numeric fields and nothing
 *      that could carry an identity.
 *   3. A MISS IS INDISTINGUISHABLE — somebody else's month, a month that does
 *      not exist, and a month still being counted all answer the same way, so
 *      the 404 cannot be read as a fact about a colleague.
 *   4. THE LINES ARE THE STORED HITS — grouped from what the run recorded, with
 *      the threshold as it stood then, and the engine never consulted.
 *   5. NO WRITE PATH — the route exports GET and nothing else.
 */

// The payroll module graph reaches the DAL, which validates SESSION_SECRET
// through auth-env at import time.
process.env.SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");

const ORG_ID = "org_northstar";
const OTHER_ORG_ID = "org_someone_else";

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
  findFirst: vi.fn(),
}));

const ORG_SETTINGS = { baseCurrency: "USD", defaultThreshold: 1_000_000 };

vi.mock("@/server/db", () => ({
  prisma: {
    payrollPeriod: { findUnique: vi.fn() },
    payrollRecord: { findFirst: mocks.findFirst, findMany: vi.fn() },
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

const { getMyEarningsHistoryBreakdown, parseMyEarningsHistoryMonth } = await import(
  "../payroll-service"
);

// ---------------------------------------------------------------------------
// A TABLE, AND A PRISMA STUB THAT ACTUALLY FILTERS IT
// ---------------------------------------------------------------------------

interface FakeHit {
  readonly nicheId: string | null;
  readonly nicheName: string;
  readonly thresholdAtRun: number;
}

/** The shape `BREAKDOWN_SELECT` asks for, plus the columns the stub filters on. */
interface FakeRecord {
  readonly userId: string;
  readonly hitPaymentMinor: number;
  readonly hitCount: number;
  readonly hitBonusMinor: number;
  readonly currency: string;
  readonly hits: readonly FakeHit[];
  readonly period: {
    readonly organizationId: string;
    readonly year: number;
    readonly month: number;
    readonly status: string;
  };
}

interface FindFirstWhere {
  readonly userId: string;
  readonly period: {
    readonly organizationId: string;
    readonly year: number;
    readonly month: number;
    readonly status: { readonly in: readonly string[] };
  };
}

/**
 * Sam's August: nine hits across three niches, one of them in a niche that has
 * since been deleted (`nicheId: null`) so the name has to carry the grouping.
 *
 * The thresholds differ per niche and are the ones recorded AT THE RUN — GTA at
 * 100,000 rather than whatever it is set to today. That is the whole point of
 * reading them back rather than recomputing.
 */
const AUGUST_HITS: readonly FakeHit[] = [
  { nicheId: "niche_gta", nicheName: "GTA", thresholdAtRun: 100_000 },
  { nicheId: "niche_gta", nicheName: "GTA", thresholdAtRun: 100_000 },
  { nicheId: "niche_gta", nicheName: "GTA", thresholdAtRun: 100_000 },
  { nicheId: "niche_gta", nicheName: "GTA", thresholdAtRun: 100_000 },
  { nicheId: "niche_rdr", nicheName: "Red Dead", thresholdAtRun: 250_000 },
  { nicheId: "niche_rdr", nicheName: "Red Dead", thresholdAtRun: 250_000 },
  // Deleted since the run. Two hits, one line, keyed by name.
  { nicheId: null, nicheName: "Retired Niche", thresholdAtRun: 50_000 },
  { nicheId: null, nicheName: "Retired Niche", thresholdAtRun: 50_000 },
  { nicheId: null, nicheName: "Retired Niche", thresholdAtRun: 50_000 },
];

function recordFor(overrides: Partial<FakeRecord> = {}): FakeRecord {
  return {
    userId: SAM,
    hitPaymentMinor: 1_000,
    hitCount: 9,
    hitBonusMinor: 9_000,
    currency: "USD",
    hits: AUGUST_HITS,
    period: { organizationId: ORG_ID, year: 2026, month: 8, status: "paid" },
    ...overrides,
  };
}

/**
 * August paid, July finalized, June still open, plus Dana's August and Sam's id
 * in another workspace entirely.
 */
const TABLE: readonly FakeRecord[] = [
  recordFor(),
  recordFor({
    period: { organizationId: ORG_ID, year: 2026, month: 7, status: "finalized" },
    hitCount: 1,
    hitBonusMinor: 1_000,
    hits: [{ nicheId: "niche_gta", nicheName: "GTA", thresholdAtRun: 90_000 }],
  }),
  // Still being counted. It has no settled breakdown at all.
  recordFor({
    period: { organizationId: ORG_ID, year: 2026, month: 6, status: "open" },
    hitCount: 400,
    hitBonusMinor: 400_000,
  }),
  // Dana's August, same organization, same month.
  recordFor({ userId: DANA, hitCount: 900, hitBonusMinor: 900_000 }),
  // Sam's id, a different workspace. Tenancy, not ownership.
  recordFor({
    period: { organizationId: OTHER_ORG_ID, year: 2026, month: 5, status: "paid" },
  }),
];

/** Applies the `where`, and nothing else. */
function fakeFindFirst(table: readonly FakeRecord[]) {
  return async (args: { where: FindFirstWhere }): Promise<FakeRecord | null> => {
    const { where } = args;
    return (
      table.find(
        (row) =>
          row.userId === where.userId &&
          row.period.organizationId === where.period.organizationId &&
          row.period.year === where.period.year &&
          row.period.month === where.period.month &&
          where.period.status.in.includes(row.period.status),
      ) ?? null
    );
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.userId = SAM;
  mocks.actor.organizationId = ORG_ID;
  mocks.actor.role = "short_form_editor";
  mocks.actor.grants = [];
  mocks.findFirst.mockImplementation(fakeFindFirst(TABLE));
});

function whereOf(call = 0): FindFirstWhere {
  return (mocks.findFirst.mock.calls[call]?.[0] as { where: FindFirstWhere }).where;
}

// ---------------------------------------------------------------------------

describe("whose month is explained", () => {
  it("filters on the session's user and organization", async () => {
    await getMyEarningsHistoryBreakdown({ year: 2026, month: 8 });

    const where = whereOf();
    expect(where.userId).toBe(SAM);
    expect(where.period.organizationId).toBe(ORG_ID);
    // Nothing anywhere in the query names the other person.
    expect(JSON.stringify(where)).not.toContain(DANA);
  });

  it("returns the caller's figures, not the colleague's in the same month", async () => {
    const breakdown = await getMyEarningsHistoryBreakdown({ year: 2026, month: 8 });

    // Dana's August row sits in the same table under the same month with a
    // wildly different bonus. Ownership is the only thing keeping it out.
    expect(breakdown.hitCount).toBe(9);
    expect(breakdown.hitBonusMinor).toBe(9_000);
  });

  it("follows the session when it changes, and never an argument", async () => {
    mocks.actor.userId = DANA;
    mocks.actor.role = "admin";

    const breakdown = await getMyEarningsHistoryBreakdown({ year: 2026, month: 8 });

    expect(whereOf().userId).toBe(DANA);
    expect(breakdown.hitCount).toBe(900);
  });

  it("scopes to the session's organization, so the same id elsewhere is invisible", async () => {
    // May 2026 exists for this user id — in another workspace. An admin here is
    // still nobody there.
    mocks.actor.role = "admin";

    await expect(getMyEarningsHistoryBreakdown({ year: 2026, month: 5 })).rejects.toThrow(
      /could not be found/i,
    );
  });

  it("ignores an identity cast onto the month object", async () => {
    // The signature has two numeric fields. A caller that smuggled a user id
    // through it must not be able to move the subject.
    const smuggled = { year: 2026, month: 8, userId: DANA } as unknown as {
      year: number;
      month: number;
    };

    await getMyEarningsHistoryBreakdown(smuggled);

    expect(whereOf().userId).toBe(SAM);
  });
});

describe("the month parser carries no identity", () => {
  it("keeps exactly the year and the month", () => {
    const parsed = parseMyEarningsHistoryMonth({ year: "2026", month: "8" });

    expect(parsed).toEqual({ year: 2026, month: 8 });
    expect(Object.keys(parsed)).toEqual(["year", "month"]);
  });

  it.each([
    ["a thirteenth month", { year: "2026", month: "13" }],
    ["a zeroth month", { year: "2026", month: "0" }],
    ["a year before payroll existed", { year: "1970", month: "8" }],
    ["words", { year: "twenty-six", month: "august" }],
    ["nothing at all", { year: null, month: null }],
  ])("refuses %s", (_label, raw) => {
    expect(() => parseMyEarningsHistoryMonth(raw)).toThrow(/not a month/i);
  });
});

describe("a month that is not the caller's settled pay", () => {
  /**
   * All three of these are the same 404, deliberately. Telling them apart would
   * make the endpoint a probe: "not settled yet" about a month Sam has no record
   * in would confirm the period exists, and a distinct "not yours" would confirm
   * somebody else was paid for it.
   */
  it("refuses an open month — it is a live calculation, not history", async () => {
    await expect(getMyEarningsHistoryBreakdown({ year: 2026, month: 6 })).rejects.toThrow(
      /could not be found/i,
    );

    // The freeze is in the query rather than a check on the result, so an open
    // row never leaves the database in the first place.
    expect(whereOf().period.status.in).toEqual(["finalized", "paid"]);
  });

  it("refuses a month with no record, in the same words", async () => {
    const missing = await getMyEarningsHistoryBreakdown({ year: 2026, month: 3 }).catch(
      (error: Error) => error.message,
    );
    const open = await getMyEarningsHistoryBreakdown({ year: 2026, month: 6 }).catch(
      (error: Error) => error.message,
    );

    expect(missing).toBe(open);
  });
});

describe("the lines are the hits the run recorded", () => {
  it("groups by niche, with the threshold as it stood at the run", async () => {
    const { byNiche } = await getMyEarningsHistoryBreakdown({ year: 2026, month: 8 });

    // Ordered by bonus, largest first — the same ordering the admin payslip and
    // the current period use, because it is the same grouping routine.
    expect(byNiche.map((line) => line.nicheName)).toEqual([
      "GTA",
      "Retired Niche",
      "Red Dead",
    ]);
    expect(byNiche.map((line) => line.hitCount)).toEqual([4, 3, 2]);
    expect(byNiche.map((line) => line.thresholdApplied)).toEqual([100_000, 50_000, 250_000]);
  });

  it("multiplies out to the bonus on the row that opened it", async () => {
    const breakdown = await getMyEarningsHistoryBreakdown({ year: 2026, month: 8 });

    // The arithmetic the screen prints — "4 hits × $10 = $40" — has to add up to
    // the figure in the list above it, or the panel disputes its own row.
    for (const line of breakdown.byNiche) {
      expect(line.bonusMinor).toBe(line.hitCount * breakdown.hitPaymentMinor);
    }
    const summed = breakdown.byNiche.reduce((total, line) => total + line.bonusMinor, 0);
    expect(summed).toBe(breakdown.hitBonusMinor);
  });

  it("keeps a deleted niche's hits on one line, keyed by the stored name", async () => {
    const { byNiche } = await getMyEarningsHistoryBreakdown({ year: 2026, month: 8 });

    const retired = byNiche.filter((line) => line.nicheId === null);
    expect(retired).toHaveLength(1);
    expect(retired[0]?.hitCount).toBe(3);
  });

  it("labels every line as finalized, so no line warns about a missing threshold", async () => {
    const { byNiche } = await getMyEarningsHistoryBreakdown({ year: 2026, month: 8 });

    // "unconfigured" is a statement about the present. On a settled record every
    // line came from a hit, so a threshold was applied by definition.
    expect(byNiche.every((line) => line.thresholdSource === "as_finalized")).toBe(true);
  });

  it("never runs the payroll engine", async () => {
    await getMyEarningsHistoryBreakdown({ year: 2026, month: 8 });

    // The whole guarantee of a settled month: today's view counts and today's
    // thresholds cannot rewrite what August was worth.
    expect(mocks.loadPayrollInputs).not.toHaveBeenCalled();
  });

  it("labels the month the same way the list row does", async () => {
    const breakdown = await getMyEarningsHistoryBreakdown({ year: 2026, month: 8 });

    expect(breakdown.label).toBe("August 2026");
    expect(breakdown.year).toBe(2026);
    expect(breakdown.month).toBe(8);
  });
});

describe("there is no write path", () => {
  const routeSource = readFileSync(
    fileURLToPath(
      new URL("../../../app/api/me/earnings/history/[year]/[month]/route.ts", import.meta.url),
    ),
    "utf8",
  );

  it("exports GET and nothing else", () => {
    // Next only routes the HTTP methods a route module exports, so this is what
    // makes a POST to this path a 405 before any of our code runs.
    const exportedHandlers = [...routeSource.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)]
      .map((match) => match[1])
      .filter((name) => name === name?.toUpperCase());

    expect(exportedHandlers).toEqual(["GET"]);
  });

  it("uses `handle`, never `handleMutation`", () => {
    expect(routeSource).not.toContain("handleMutation");
  });

  it("checks earnings.view_own, and no other permission", () => {
    const required = [...routeSource.matchAll(/requirePermission\("([^"]+)"\)/g)].map(
      (match) => match[1],
    );

    expect(required).toEqual(["earnings.view_own"]);
  });
});
