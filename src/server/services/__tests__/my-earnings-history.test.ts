import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `getMyEarningsHistory` returns the caller's own settled months, and offers no
 * way to ask for anybody else's.
 *
 * The sibling file `my-earnings-ownership.test.ts` makes this argument for the
 * single-period endpoint. History needs its own because it is the endpoint that
 * returns a LIST, and a list is the shape a missing ownership filter disappears
 * into: one row too many reads as a longer page, not as a breach. It is also
 * the endpoint that makes a CLAIM ABOUT MONEY HAVING MOVED — "Paid on 1
 * September" — which is the one sentence on the earnings screen that cannot be
 * walked back once somebody has read it.
 *
 * Four things are pinned here, in the order they would hurt:
 *
 *   1. OWNERSHIP — the query filters on the session's user and the session's
 *      organization, and no argument, key or cast can move either.
 *   2. NO PERSON IN THE QUERY STRING — the page parser has two numeric fields
 *      and nothing that could carry an identity.
 *   3. AN OPEN MONTH IS NOT HISTORY — a period still being counted has no
 *      settled figure, so it must not appear beside ones that do.
 *   4. "PAID" MEANS PAID — a record with no recorded payment is never labelled
 *      as one, whatever its status flag says.
 *
 * Prisma is a stub, but not an inert one: `findMany` below actually applies the
 * `where`, the ordering and the paging to a small table containing Dana's rows
 * and an open period. So the assertions are about what comes back, not only
 * about what was asked for.
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
  findMany: vi.fn(),
}));

const ORG_SETTINGS = { baseCurrency: "USD", defaultThreshold: 1_000_000 };

vi.mock("@/server/db", () => ({
  prisma: {
    payrollPeriod: { findUnique: vi.fn() },
    payrollRecord: { findFirst: vi.fn(), findMany: mocks.findMany },
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

const { getMyEarningsHistory, parseMyEarningsHistoryPage } = await import("../payroll-service");
type HistoryPage = Awaited<ReturnType<typeof parseMyEarningsHistoryPage>>;

// ---------------------------------------------------------------------------
// A TABLE, AND A PRISMA STUB THAT ACTUALLY FILTERS IT
// ---------------------------------------------------------------------------

/** The shape `HISTORY_SELECT` asks for, plus the two columns the stub filters on. */
interface FakeRecord {
  readonly userId: string;
  readonly baseSalaryMinor: number;
  readonly hitPaymentMinor: number;
  readonly hitCount: number;
  readonly hitBonusMinor: number;
  readonly adjustmentMinor: number;
  readonly adjustmentReason: string | null;
  readonly totalMinor: number;
  readonly currency: string;
  readonly paymentStatus: string;
  readonly paidAt: Date | null;
  readonly period: {
    readonly organizationId: string;
    readonly year: number;
    readonly month: number;
    readonly status: string;
    readonly payOn: Date;
  };
}

interface FindManyWhere {
  readonly userId: string;
  readonly period: {
    readonly organizationId: string;
    readonly status: { readonly in: readonly string[] };
  };
}

interface FindManyArgs {
  readonly where: FindManyWhere;
  readonly skip?: number;
  readonly take?: number;
}

type RecordOverrides = Omit<Partial<FakeRecord>, "period"> & {
  readonly period?: Partial<FakeRecord["period"]>;
};

function recordFor(overrides: RecordOverrides = {}) {
  const base = { organizationId: ORG_ID, year: 2026, month: 8, status: "paid" };
  const merged = { ...base, ...(overrides.period ?? {}) };
  const period = {
    ...merged,
    // Payroll is paid on the first of the FOLLOWING month, so the schedule is
    // derived from the period rather than restated per fixture — a payOn that
    // did not match its own month would make the "due on" assertions vacuous.
    payOn:
      overrides.period?.payOn ??
      new Date(
        Date.UTC(
          merged.month === 12 ? merged.year + 1 : merged.year,
          merged.month === 12 ? 0 : merged.month,
          1,
        ),
      ),
  };

  return {
    userId: SAM,
    baseSalaryMinor: 400_000,
    hitPaymentMinor: 1_000,
    hitCount: 124,
    hitBonusMinor: 124_000,
    adjustmentMinor: 0,
    adjustmentReason: null,
    totalMinor: 524_000,
    currency: "USD",
    paymentStatus: "paid",
    paidAt: new Date(Date.UTC(2026, 8, 1, 9, 30)),
    ...overrides,
    period,
  } satisfies FakeRecord;
}

/**
 * August paid, July finalized-but-unpaid, June open, plus two of Dana's rows
 * and one from another workspace entirely.
 *
 * Deliberately out of order in the array, so "newest first" has to be the
 * query's doing rather than the fixture's.
 */
const TABLE: readonly FakeRecord[] = [
  recordFor({ period: { year: 2026, month: 7, status: "finalized" }, paymentStatus: "pending", paidAt: null, totalMinor: 500_000 }),
  recordFor({ period: { year: 2026, month: 8, status: "paid" } }),
  // Still being counted. It has no settled figure at all.
  recordFor({ period: { year: 2026, month: 6, status: "open" }, totalMinor: 999_999 }),
  // Dana's pay, in the same organization and the same months.
  recordFor({ userId: DANA, totalMinor: 1_200_000 }),
  recordFor({ userId: DANA, period: { year: 2026, month: 7, status: "finalized" } }),
  // Sam's id, a different workspace. Tenancy, not ownership.
  recordFor({ period: { organizationId: OTHER_ORG_ID, year: 2026, month: 5, status: "paid" } }),
];

/** Applies the `where`, the newest-first ordering and the paging, and nothing else. */
function fakeFindMany(table: readonly FakeRecord[]) {
  return async (args: FindManyArgs): Promise<FakeRecord[]> => {
    const { where } = args;
    const matched = table.filter(
      (row) =>
        row.userId === where.userId &&
        row.period.organizationId === where.period.organizationId &&
        where.period.status.in.includes(row.period.status),
    );

    matched.sort((a, b) =>
      a.period.year !== b.period.year
        ? b.period.year - a.period.year
        : b.period.month - a.period.month,
    );

    const skip = args.skip ?? 0;
    return matched.slice(skip, args.take === undefined ? undefined : skip + args.take);
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.userId = SAM;
  mocks.actor.organizationId = ORG_ID;
  mocks.actor.role = "short_form_editor";
  mocks.actor.grants = [];
  mocks.findMany.mockImplementation(fakeFindMany(TABLE));
});

function whereOf(call = 0): FindManyWhere {
  return (mocks.findMany.mock.calls[call]?.[0] as FindManyArgs).where;
}

// ---------------------------------------------------------------------------

describe("whose history is returned", () => {
  it("returns only the caller's records, and none of the admin's", async () => {
    const { rows } = await getMyEarningsHistory();

    // Two of Sam's periods are finalized; Dana has rows in both of the same
    // months, and neither may appear.
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.totalMinor)).toEqual([524_000, 500_000]);
    expect(rows.map((row) => row.totalMinor)).not.toContain(1_200_000);

    const where = whereOf();
    expect(where.userId).toBe(SAM);
    expect(where.period.organizationId).toBe(ORG_ID);
    expect(JSON.stringify(where)).not.toContain(DANA);
  });

  it("follows the session when it changes, and never a caller's argument", async () => {
    // The only thing that can move the subject is who is signed in.
    mocks.actor.userId = DANA;
    mocks.actor.role = "head_of_shorts";

    const { rows } = await getMyEarningsHistory();

    expect(whereOf().userId).toBe(DANA);
    expect(rows.map((row) => row.totalMinor)).toContain(1_200_000);
  });

  it("scopes to the session's organization, so the same id elsewhere is invisible", async () => {
    // Sam's own userId, on a record belonging to another workspace. PayrollRecord
    // has no organizationId of its own, so the filter on the period relation is
    // the entire tenancy check — if it were dropped, this row would come back.
    const { rows } = await getMyEarningsHistory();

    expect(rows.map((row) => row.month)).toEqual([8, 7]);
    expect(rows.map((row) => row.month)).not.toContain(5);
    expect(whereOf().period.organizationId).toBe(ORG_ID);
  });

  it("ignores a userId smuggled onto the page object", async () => {
    // There is no such field on `MyEarningsHistoryPage`, so this is what a
    // future edit that widened the signature — or a body forwarded whole into
    // it — would actually do. The subject must not move.
    await getMyEarningsHistory({
      limit: 10,
      offset: 0,
      userId: DANA,
    } as unknown as HistoryPage);

    expect(whereOf().userId).toBe(SAM);
    expect(JSON.stringify(whereOf())).not.toContain(DANA);
  });

  it("narrows to the caller, whichever employee is asking", async () => {
    // The whole-company view is `payroll.view`, on another endpoint entirely.
    mocks.actor.role = "short_form_clip_producer";

    await getMyEarningsHistory();

    expect(whereOf().userId).toBe(SAM);
  });

  /**
   * An admin cannot reach this path at all, and that is deliberate.
   *
   * They read Admin → Payroll, which is every row including their own, so a
   * personal earnings screen would be a narrower answer to a question they can
   * already ask better. `earnings.view_own` is withheld from the Admin role for
   * exactly that reason — see `WITHHELD_FROM_ADMIN`.
   */
  it("refuses an admin outright rather than narrowing them to their own row", async () => {
    mocks.actor.role = "admin";

    await expect(getMyEarningsHistory()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

});

describe("the page parser refuses to carry a person", () => {
  /** Exactly what the route does with an incoming URL. */
  function pageFromUrl(url: string): HistoryPage {
    const params = new URL(url, "https://hq.example.com").searchParams;
    return parseMyEarningsHistoryPage({
      limit: params.get("limit"),
      offset: params.get("offset"),
    });
  }

  it("ignores a userId in the query string", () => {
    const page = pageFromUrl(`/api/me/earnings/history?userId=${DANA}&limit=5`);

    expect(Object.keys(page).sort()).toEqual(["limit", "offset"]);
    expect(JSON.stringify(page)).not.toContain(DANA);
  });

  it("ignores every other name an identity might travel under", () => {
    const page = pageFromUrl(
      `/api/me/earnings/history?user=${DANA}&employeeId=${DANA}&id=${DANA}&email=dana@example.com`,
    );

    expect(page).toEqual({ limit: 24, offset: 0 });
  });

  it("defaults to a full page rather than to zero rows", () => {
    // `Number(null)` is 0. Without the null-to-undefined normalisation, a
    // request with no parameters would ask for a limit of nothing.
    expect(parseMyEarningsHistoryPage({ limit: null, offset: null })).toEqual({
      limit: 24,
      offset: 0,
    });
  });

  it("rejects a page size outside the range it will serve", () => {
    expect(() => parseMyEarningsHistoryPage({ limit: "0" })).toThrowError();
    expect(() => parseMyEarningsHistoryPage({ limit: "500" })).toThrowError();
    expect(() => parseMyEarningsHistoryPage({ offset: "-1" })).toThrowError();
    expect(() => parseMyEarningsHistoryPage({ limit: "not a number" })).toThrowError();
  });
});

describe("what counts as history", () => {
  it("leaves out a period that has not been finalized", async () => {
    const { rows } = await getMyEarningsHistory();

    // June is open: its figures are still moving, so it has no settled total to
    // list. The 999,999 in the fixture is what would leak if `status` were
    // dropped from the filter.
    expect(rows.map((row) => row.month)).toEqual([8, 7]);
    expect(rows.map((row) => row.totalMinor)).not.toContain(999_999);

    expect(whereOf().period.status.in).toEqual(["finalized", "paid"]);
    expect(whereOf().period.status.in).not.toContain("open");
  });

  it("orders by the period's own month, newest first", async () => {
    const { rows } = await getMyEarningsHistory();
    expect(rows.map((row) => row.label)).toEqual(["August 2026", "July 2026"]);
  });

  it("never re-runs the payroll engine over a settled month", async () => {
    await getMyEarningsHistory();

    // A finalized figure is a document. Recomputing it against today's view
    // counts would let this month quietly rewrite what August cost.
    expect(mocks.loadPayrollInputs).not.toHaveBeenCalled();
  });

  it("returns the stored figures verbatim, down to the adjustment and its reason", async () => {
    mocks.findMany.mockImplementation(
      fakeFindMany([
        recordFor({
          baseSalaryMinor: 400_000,
          hitCount: 124,
          hitBonusMinor: 124_000,
          adjustmentMinor: -2_500,
          adjustmentReason: "Corrected a duplicate hit",
          totalMinor: 521_500,
        }),
      ]),
    );

    const [row] = (await getMyEarningsHistory()).rows;

    expect(row?.baseSalaryMinor).toBe(400_000);
    expect(row?.hitBonusMinor).toBe(124_000);
    expect(row?.hitCount).toBe(124);
    expect(row?.adjustmentMinor).toBe(-2_500);
    expect(row?.adjustmentReason).toBe("Corrected a duplicate hit");
    expect(row?.totalMinor).toBe(521_500);
    // Base + bonus + adjustment accounts for the total, so nothing on the row is
    // a figure the employee has to take on trust.
    expect(
      (row?.baseSalaryMinor ?? 0) + (row?.hitBonusMinor ?? 0) + (row?.adjustmentMinor ?? 0),
    ).toBe(row?.totalMinor);
  });

  it("pages without ever paging past somebody else", async () => {
    const { rows, hasMore, nextOffset } = await getMyEarningsHistory({ limit: 1, offset: 0 });

    expect(rows.map((row) => row.label)).toEqual(["August 2026"]);
    expect(hasMore).toBe(true);
    expect(nextOffset).toBe(1);
    // One more row than asked for is fetched to learn there is a next page; the
    // extra must be dropped rather than returned.
    expect((mocks.findMany.mock.calls[0]?.[0] as FindManyArgs).take).toBe(2);

    const second = await getMyEarningsHistory({ limit: 1, offset: 1 });
    expect(second.rows.map((row) => row.label)).toEqual(["July 2026"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextOffset).toBeNull();
    expect(whereOf(1).userId).toBe(SAM);
  });

  it("returns an empty list rather than failing when nothing is settled yet", async () => {
    mocks.findMany.mockImplementation(fakeFindMany([]));

    await expect(getMyEarningsHistory()).resolves.toEqual({
      rows: [],
      hasMore: false,
      nextOffset: null,
    });
  });
});

describe("'Paid' is a claim about money, not a label", () => {
  it("reports the recorded payment date, taken from the record", async () => {
    const paidAt = Date.UTC(2026, 8, 1, 9, 30);
    mocks.findMany.mockImplementation(
      fakeFindMany([recordFor({ paymentStatus: "paid", paidAt: new Date(paidAt) })]),
    );

    const [row] = (await getMyEarningsHistory()).rows;

    expect(row?.paymentStatus).toBe("paid");
    expect(row?.paidAt).toBe(paidAt);
    // And the scheduled date stays its own field. It is when the money was due,
    // which is a different fact from when it moved.
    expect(row?.scheduledPayOn).toBe(Date.UTC(2026, 8, 1));
  });

  it("does not label a finalized-but-unpaid record as paid", async () => {
    mocks.findMany.mockImplementation(
      fakeFindMany([
        recordFor({
          period: { year: 2026, month: 7, status: "finalized" },
          paymentStatus: "pending",
          paidAt: null,
        }),
      ]),
    );

    const [row] = (await getMyEarningsHistory()).rows;

    expect(row?.periodStatus).toBe("finalized");
    expect(row?.paymentStatus).toBe("pending");
    expect(row?.paidAt).toBeNull();
    // The due date is present and is NOT copied into `paidAt`. A date payroll
    // was owed on is not evidence that anybody paid it.
    expect(row?.scheduledPayOn).toBe(Date.UTC(2026, 7, 1));
  });

  it("does not label a record paid when no payment date was ever recorded", async () => {
    // The flag and the timestamp are written together, so this row should not
    // exist — a hand-edited row or a restored backup is how it would. The list
    // takes the quieter reading: no recorded payment, no claim that one happened.
    mocks.findMany.mockImplementation(
      fakeFindMany([recordFor({ paymentStatus: "paid", paidAt: null })]),
    );

    const [row] = (await getMyEarningsHistory()).rows;

    expect(row?.paidAt).toBeNull();
    expect(row?.paymentStatus).toBe("pending");
  });

  it("reports this record's payment state, not the surrounding period's", async () => {
    // `markRecordPaid` settles one person at a time and only flips the period
    // once nobody is pending. A period reading "finalized" can therefore hold a
    // record that really was paid, and saying otherwise would tell that person
    // their money is still coming.
    const paidAt = Date.UTC(2026, 7, 14);
    mocks.findMany.mockImplementation(
      fakeFindMany([
        recordFor({
          period: { year: 2026, month: 7, status: "finalized" },
          paymentStatus: "paid",
          paidAt: new Date(paidAt),
        }),
      ]),
    );

    const [row] = (await getMyEarningsHistory()).rows;

    expect(row?.periodStatus).toBe("finalized");
    expect(row?.paymentStatus).toBe("paid");
    expect(row?.paidAt).toBe(paidAt);
  });
});

describe("there is no write path", () => {
  const routeSource = readFileSync(
    fileURLToPath(new URL("../../../app/api/me/earnings/history/route.ts", import.meta.url)),
    "utf8",
  );

  it("exports GET and nothing else", () => {
    // Next only routes the HTTP methods a route module exports, so this is what
    // makes a POST to this path a 405 before any of our code runs. An added
    // handler would have to add an export, which this test would fail.
    const exportedHandlers = [...routeSource.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)]
      .map((match) => match[1])
      .filter((name) => name === name?.toUpperCase());

    expect(exportedHandlers).toEqual(["GET"]);
  });

  it("uses `handle`, never `handleMutation`", () => {
    // `handleMutation` is the wrapper for state-changing routes. Its presence
    // here would mean somebody had added one.
    expect(routeSource).not.toContain("handleMutation");
  });

  it("checks earnings.view_own, and no other permission", () => {
    // Every permission this route actually asks for, prose in the comments
    // excluded — the doc block names `payroll.manage` to say what does NOT
    // happen here, and a plain substring search would read that as the code.
    const required = [...routeSource.matchAll(/requirePermission\("([^"]+)"\)/g)].map(
      (match) => match[1],
    );

    expect(required).toEqual(["earnings.view_own"]);
  });
});
