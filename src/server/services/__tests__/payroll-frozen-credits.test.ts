import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchesWhere } from "./support/prisma-where";

/**
 * The ledger of what payroll has actually paid.
 *
 * A hit is credited in the period its window CLOSED in, and that date moves:
 * editing a niche rewrites the recorded rule on every evaluation under it, so a
 * Short that closed on 4 February under GTA's seven-day rule closes on 6 March
 * once GTA is 900 hours. February is finalized and its `PayrollHit` row
 * correctly survives — and March's open run would credit the same videoId to
 * the same person again, with `@@unique([recordId, videoId])` powerless to
 * notice because those are two different records.
 *
 * The engine's own tests prove it refuses to pay a Short on that list. What is
 * under test HERE is the query that builds the list, because every way of
 * getting it wrong is invisible from the engine's side:
 *
 *   • including DRAFT periods would freeze a Short into whichever open month
 *     happened to be read first, which is the opposite of the design — a draft
 *     recalculates on every read and has paid nobody;
 *   • dropping the per-user scoping would cancel the second person's bonus
 *     entirely, since one hit legitimately pays a Head of Shorts AND an editor;
 *   • losing the organization filter would read another tenant's payroll.
 *
 * THE FILTER IS APPLIED, NOT ASSERTED ON. Asserting on the shape of a `where`
 * would pass just as happily for a clause naming the wrong relation or dropping
 * the organization out of it. So the fake runs the filter against fixture rows
 * and the test reads what comes back — the same thing the database will do.
 */

// The payroll module graph reaches the DAL, which validates SESSION_SECRET
// through auth-env at import time.
process.env.SESSION_SECRET = Buffer.alloc(32, 13).toString("base64");

const ORG_ID = "org_northstar";
const OTHER_ORG = "org_rival";

const SAM = "user_sam";
const ALEX = "user_alex";
/** On the roster, never credited for anything. */
const NEW_HIRE = "user_robin";

const SEVEN_DAYS = 168;
const NINE_HUNDRED_HOURS = 900;

/**
 * One `PayrollHit`, with the two relations the filter reaches through.
 *
 * Nested rather than flattened because that is the shape the query navigates:
 * the hit hangs off a record, which hangs off the period that carries both the
 * status and the organization. `PayrollRecord` has no organizationId of its
 * own, so that relation IS the tenancy check.
 */
function hitRow(options: {
  videoId: string;
  userId: string;
  status: string;
  organizationId?: string;
  publishedAt: number;
}) {
  return {
    videoId: options.videoId,
    publishedAt: new Date(options.publishedAt),
    record: {
      userId: options.userId,
      period: {
        organizationId: options.organizationId ?? ORG_ID,
        status: options.status,
      },
    },
  };
}

const PUBLISHED_28_JANUARY = Date.UTC(2026, 0, 28);
/** Well outside the widest window's reach back from 1 March. */
const PUBLISHED_2_JANUARY = Date.UTC(2026, 0, 2);

const HIT_ROWS = [
  // Frozen, Sam's, in range. The one the guard exists for.
  hitRow({
    videoId: "v_paid_in_february",
    userId: SAM,
    status: "finalized",
    publishedAt: PUBLISHED_28_JANUARY,
  }),
  // "paid" is a finalized period that has also been paid out — the stronger
  // case of the same fact, never a weaker one.
  hitRow({
    videoId: "v_paid_in_january",
    userId: SAM,
    status: "paid",
    publishedAt: PUBLISHED_28_JANUARY,
  }),
  // An OPEN period has paid nobody. A Short may legitimately move between two
  // drafts as its rule changes, so this must not enter the ledger.
  hitRow({
    videoId: "v_in_a_draft",
    userId: SAM,
    status: "open",
    publishedAt: PUBLISHED_28_JANUARY,
  }),
  // Alex's credit, not Sam's.
  hitRow({
    videoId: "v_paid_to_alex",
    userId: ALEX,
    status: "finalized",
    publishedAt: PUBLISHED_28_JANUARY,
  }),
  // Another tenant's payroll entirely.
  hitRow({
    videoId: "v_other_org",
    userId: SAM,
    status: "finalized",
    organizationId: OTHER_ORG,
    publishedAt: PUBLISHED_28_JANUARY,
  }),
  // Published too early to collide with anything March can credit, so it is
  // outside the range the Shorts query itself reaches back over.
  hitRow({
    videoId: "v_long_ago",
    userId: SAM,
    status: "finalized",
    publishedAt: PUBLISHED_2_JANUARY,
  }),
];

const NICHES = [
  // The widened rule. 900 hours is what decides how far before the period the
  // two queries reach, so it is what puts 28 January in range and 2 January out.
  { id: "niche_gta", name: "GTA", hitThreshold: 1_000_000, hitWindowHours: NINE_HUNDRED_HOURS },
  { id: "niche_rdr", name: "Red Dead", hitThreshold: 750_000, hitWindowHours: SEVEN_DAYS },
];

function memberRow(userId: string, name: string) {
  return {
    role: "short_form_editor",
    user: {
      id: userId,
      name,
      email: `${name.toLowerCase()}@northstarstudios.cc`,
      employeeProfile: {
        salaryMinor: 300_000,
        hitPaymentMinor: 1_000,
        currency: "USD",
        joinedOn: new Date(Date.UTC(2020, 0, 1)),
        employmentEndedOn: null,
      },
    },
    niches: [{ nicheId: "niche_gta" }],
  };
}

const mocks = vi.hoisted(() => ({
  memberFindMany: vi.fn(),
  nicheFindMany: vi.fn(),
  trackedChannelFindMany: vi.fn(),
  videoFindMany: vi.fn(),
  evaluationFindMany: vi.fn(),
  payrollHitFindMany: vi.fn(),
}));

vi.mock("@/server/db", () => ({
  prisma: {
    organizationMember: { findMany: mocks.memberFindMany },
    niche: { findMany: mocks.nicheFindMany },
    trackedChannel: { findMany: mocks.trackedChannelFindMany },
    video: { findMany: mocks.videoFindMany },
    videoHitEvaluation: { findMany: mocks.evaluationFindMany },
    payrollHit: { findMany: mocks.payrollHitFindMany },
  },
}));

const { loadPayrollInputs } = await import("../payroll-data");
const { periodForMonth } = await import("@/lib/payroll/payroll-engine");

const MARCH = periodForMonth(2026, 3);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memberFindMany.mockResolvedValue([
    memberRow(SAM, "Sam"),
    memberRow(ALEX, "Alex"),
    memberRow(NEW_HIRE, "Robin"),
  ]);
  mocks.nicheFindMany.mockResolvedValue(NICHES);

  /*
   * The run has to LOAD these Shorts for the ledger to be asked about them.
   *
   * It did not used to. The ledger was bounded by `publishedAt` and this file
   * ran with no owned channels at all, on the reasoning that it was about the
   * query and not the corpus. That reasoning went stale with the query: the
   * ledger is now keyed on the exact video ids this run could credit, because
   * `PayrollHit.publishedAt` is frozen at finalize while `Video.publishedAt` is
   * rewritten on every sync, and a guard that stops matching when those two
   * drift is not a guard.
   *
   * So the fixture supplies a channel and the Shorts the credits refer to. That
   * coupling is the thing under test now, not an inconvenience around it.
   */
  mocks.trackedChannelFindMany.mockResolvedValue([
    {
      channelId: "channel_1",
      label: null,
      channel: { title: "Owned channel" },
      niches: NICHES.map((niche) => ({ nicheId: niche.id })),
    },
  ]);
  // No stored verdicts: this file is about the ledger, and a Short with no
  // evaluation simply resolves to nothing payable — which is fine, because the
  // guard under test fires before the outcome is consulted.
  mocks.evaluationFindMany.mockResolvedValue([]);
  /*
   * The video mock HONOURS its where clause, via the same interpreter the
   * PayrollHit mock uses.
   *
   * That matters for one row. `v_long_ago` is published outside the window this
   * run reaches back over, and the range filter that excludes it used to live in
   * the ledger query. It now lives in `loadShorts` — the ledger asks about the
   * ids this run actually loaded, so anything `loadShorts` declines to load is
   * excluded by construction rather than by a second, duplicate date bound.
   *
   * A mock that returned every row regardless would hide exactly that move, and
   * the test would pass while proving nothing about where the boundary went.
   */
  mocks.videoFindMany.mockImplementation(async (args: { where: unknown }) =>
    HIT_ROWS.map((row) => ({
      id: row.videoId,
      channelId: "channel_1",
      title: row.videoId,
      publishedAt: row.publishedAt,
      viewCount: BigInt(0),
      isShort: true,
      hitEvaluations: [],
      snapshots: [],
    })).filter((video) => matchesWhere(video, args.where)),
  );
  mocks.payrollHitFindMany.mockImplementation(async (args: { where: unknown }) =>
    HIT_ROWS.filter((row) => matchesWhere(row, args.where)),
  );
});

function creditsFor(
  employees: readonly { userId: string; alreadyPaidVideoIds: readonly string[] }[],
  userId: string,
): readonly string[] {
  return employees.find((employee) => employee.userId === userId)?.alreadyPaidVideoIds ?? [];
}

describe("the frozen-credit ledger", () => {
  it("carries only credits from finalized and paid periods", async () => {
    const { employees } = await loadPayrollInputs(ORG_ID, MARCH);

    expect([...creditsFor(employees, SAM)].sort()).toEqual([
      "v_paid_in_february",
      "v_paid_in_january",
    ]);
  });

  it("leaves a credit sitting in an open period out of it", async () => {
    // The distinction the whole design rests on. A draft is recalculated on
    // every read and has paid nobody, so the same Short moving between two
    // drafts as its rule changes is correct rather than a double payment.
    const { employees } = await loadPayrollInputs(ORG_ID, MARCH);

    expect(creditsFor(employees, SAM)).not.toContain("v_in_a_draft");
  });

  it("keeps one person's credits off another person's list", async () => {
    // One GTA hit pays a Head of Shorts and an editor their own bonus each, so
    // a global set of paid videoIds would silently cancel the second one.
    const { employees } = await loadPayrollInputs(ORG_ID, MARCH);

    expect(creditsFor(employees, SAM)).not.toContain("v_paid_to_alex");
    expect(creditsFor(employees, ALEX)).toEqual(["v_paid_to_alex"]);
  });

  it("never reads another organization's payroll", async () => {
    const { employees } = await loadPayrollInputs(ORG_ID, MARCH);

    expect(creditsFor(employees, SAM)).not.toContain("v_other_org");
  });

  it("reaches back exactly as far as the Shorts query does", async () => {
    // Bounded by the widest configured window, which is what keeps this from
    // growing without limit as years of finalized payroll accumulate. A credit
    // for a Short published outside that range cannot collide with anything
    // this run can credit, because no such Short was loaded.
    const { employees } = await loadPayrollInputs(ORG_ID, MARCH);

    expect(creditsFor(employees, SAM)).not.toContain("v_long_ago");
  });

  it("gives somebody with no history an empty list rather than nothing", async () => {
    // The engine reads this field unconditionally; a missing one would throw
    // mid-run for the newest hire on the roster.
    const { employees } = await loadPayrollInputs(ORG_ID, MARCH);

    expect(creditsFor(employees, NEW_HIRE)).toEqual([]);
  });

  it("does not go looking when there is nobody to look up", async () => {
    mocks.memberFindMany.mockResolvedValue([]);

    const { employees } = await loadPayrollInputs(ORG_ID, MARCH);

    expect(employees).toEqual([]);
    expect(mocks.payrollHitFindMany).not.toHaveBeenCalled();
  });
});
