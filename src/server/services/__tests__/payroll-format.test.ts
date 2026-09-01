import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchesWhere } from "./support/prisma-where";

/**
 * PAYROLL UNDER FORMATS — THE MONEY EDIT, TESTED WITH MONEY.
 *
 * `loadShorts` now loads both formats' videos and narrows each video's
 * `nicheIds` to the channel's SAME-FORMAT niches before the engine sees them.
 * That narrowing is the one line standing between "a Long Form hit paid at the
 * Long Form rate" and "a Long Form hit judged by a Shorts rule and paid at a
 * Shorts price" — `pickGoverningRule` ranks by lowest threshold and has no
 * format concept of its own, so whatever ids arrive ARE the candidate list.
 *
 * THE FILTERS ARE APPLIED, NOT ASSERTED ON, exactly as in
 * `payroll-frozen-credits.test.ts` and for the same reason: the claim under
 * test is which rows come back and what they pay, so the fakes run the where
 * clauses against fixture rows via `matchesWhere` and the tests read money.
 *
 * TWO WORLDS, ONE FIXTURE FAMILY:
 *   • the mixed world — a shorts niche and a longform niche, one employee on
 *     both — pins that each hit pays its own niche's rate, A + B exactly;
 *   • the pre-format world — zero longform niches, today's every organization
 *     — pins the DEPLOY-B IDENTITY: long-form videos arrive with an empty
 *     nicheIds list, the engine attributes them to nobody, and every figure is
 *     the one the shorts-only run always produced.
 */

// The payroll module graph reaches the DAL, which validates SESSION_SECRET
// through auth-env at import time.
process.env.SESSION_SECRET = Buffer.alloc(32, 17).toString("base64");

const ORG_ID = "org_northstar";
const SAM = "user_sam";

const SEVEN_DAYS = 168;
/** Thirty days — a Long Form clock. */
const LONGFORM_WINDOW = 720;

/** What one Shorts hit pays (rate A) and what one Long Form hit pays (rate B). */
const SHORTS_RATE = 500;
const LONGFORM_RATE = 1_200;

const SHORTS_GTA = {
  id: "niche_gta",
  name: "GTA",
  kind: "production",
  format: "shorts",
  hitPaymentMinor: SHORTS_RATE,
  hitThreshold: 1_000_000,
  hitWindowHours: SEVEN_DAYS,
};

/**
 * The Long Form GTA: same subject, separate niche, separate rule, separate
 * price. Its threshold is HIGHER than the shorts niche's on purpose: strip the
 * format narrowing and `pickGoverningRule` hands the long-form video to the
 * shorts niche's lower bar — at which point the video is judged on a week-long
 * clock that closed in December and the January bonus vanishes. The money
 * assertions below fail loudly on exactly that mutation.
 */
const LONGFORM_GTA = {
  id: "niche_gta_longform",
  name: "GTA Long Form",
  kind: "production",
  format: "longform",
  hitPaymentMinor: LONGFORM_RATE,
  hitThreshold: 2_000_000,
  hitWindowHours: LONGFORM_WINDOW,
};

function memberRow(nicheIds: readonly string[]) {
  return {
    role: "short_form_editor",
    user: {
      id: SAM,
      name: "Sam",
      email: "sam@northstarstudios.cc",
      employeeProfile: {
        salaryMinor: 300_000,
        currency: "USD",
        joinedOn: new Date(Date.UTC(2020, 0, 1)),
        employmentEndedOn: null,
      },
    },
    niches: nicheIds.map((nicheId) => ({ nicheId })),
  };
}

/** 2 January, seven-day window: closes 9 January — January's to pay. */
const SHORT_PUBLISHED = Date.UTC(2026, 0, 2);
/** 20 December, 720-hour window: closes 19 January — ALSO January's to pay. */
const LONG_PUBLISHED = Date.UTC(2025, 11, 20);
/** 5 January. Loaded (not_short), but its 720-hour window closes in February. */
const LONG_IN_PERIOD_PUBLISHED = Date.UTC(2026, 0, 5);

const VIDEO_ROWS = [
  {
    id: "vid_short",
    channelId: "channel_1",
    title: "The Short",
    publishedAt: new Date(SHORT_PUBLISHED),
    viewCount: BigInt(3_000_000),
    isShort: true,
    classification: "short",
  },
  {
    id: "vid_long",
    channelId: "channel_1",
    title: "The Long Form hit",
    publishedAt: new Date(LONG_PUBLISHED),
    viewCount: BigInt(5_000_000),
    isShort: false,
    classification: "not_short",
  },
  {
    id: "vid_long_unresolved",
    channelId: "channel_1",
    title: "A Long Form video still in flight",
    publishedAt: new Date(LONG_IN_PERIOD_PUBLISHED),
    viewCount: BigInt(100_000),
    isShort: false,
    classification: "not_short",
  },
  // The classifier could not resolve this one. It belongs to NEITHER format,
  // and the query must never load it — `!isShort` would have, which is the
  // inflation the strict selector exists to prevent.
  {
    id: "vid_uncertain",
    channelId: "channel_1",
    title: "Unresolvable",
    publishedAt: new Date(Date.UTC(2026, 0, 5)),
    viewCount: BigInt(9_000_000),
    isShort: false,
    classification: "uncertain",
  },
];

/** Stored verdicts, shaped with the relation the evaluations filter reaches through. */
const EVALUATION_ROWS = [
  {
    organizationId: ORG_ID,
    videoId: "vid_short",
    outcome: "hit",
    nicheId: SHORTS_GTA.id,
    thresholdApplied: 1_000_000,
    windowHoursApplied: SEVEN_DAYS,
    windowClosesAt: new Date(SHORT_PUBLISHED + SEVEN_DAYS * 3_600_000),
    viewsAtWindow: BigInt(1_500_000),
    observedAtHours: 50,
    video: VIDEO_ROWS[0],
  },
  {
    organizationId: ORG_ID,
    videoId: "vid_long",
    outcome: "hit",
    nicheId: LONGFORM_GTA.id,
    thresholdApplied: 2_000_000,
    windowHoursApplied: LONGFORM_WINDOW,
    windowClosesAt: new Date(LONG_PUBLISHED + LONGFORM_WINDOW * 3_600_000),
    viewsAtWindow: BigInt(2_500_000),
    observedAtHours: 100,
    video: VIDEO_ROWS[1],
  },
];

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
const { calculatePayrollRun, periodForMonth } = await import("@/lib/payroll/payroll-engine");

const JANUARY = periodForMonth(2026, 1);
/** Well after every fixture window has shut. */
const NOW = Date.UTC(2026, 1, 10);

/** Wires the fixture world up with the given niche list and assignments. */
function setUpWorld(niches: readonly Record<string, unknown>[], memberNicheIds: string[]) {
  mocks.memberFindMany.mockResolvedValue([memberRow(memberNicheIds)]);
  mocks.nicheFindMany.mockResolvedValue(niches);
  mocks.trackedChannelFindMany.mockResolvedValue([
    {
      channelId: "channel_1",
      label: null,
      channel: { title: "Northstar GTA" },
      niches: niches.map((niche) => ({ nicheId: niche.id })),
    },
  ]);
  // Both fakes RUN the where clause. The uncertain video not coming back, and
  // the not_short arm coming back at all, are query behaviour under test.
  mocks.videoFindMany.mockImplementation(async (args: { where: unknown }) =>
    VIDEO_ROWS.filter((video) => matchesWhere(video, args.where)),
  );
  mocks.evaluationFindMany.mockImplementation(async (args: { where: unknown }) =>
    EVALUATION_ROWS.filter((row) => matchesWhere(row, args.where)),
  );
  mocks.payrollHitFindMany.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("one person, one period, a hit in each format", () => {
  beforeEach(() => {
    setUpWorld([SHORTS_GTA, LONGFORM_GTA], [SHORTS_GTA.id, LONGFORM_GTA.id]);
  });

  it("narrows each video's niches to its own format", async () => {
    const { shorts } = await loadPayrollInputs(ORG_ID, JANUARY);

    const byId = new Map(shorts.map((short) => [short.videoId, short]));
    // THE MONEY EDIT, pinned as data: the Short may only be judged by shorts
    // niches, the long-form videos only by longform ones. Hand either the
    // channel's full list and `pickGoverningRule`'s lowest-bar ranking pays
    // the wrong rate — that is the mutation this assertion exists to catch.
    expect(byId.get("vid_short")?.nicheIds).toEqual([SHORTS_GTA.id]);
    expect(byId.get("vid_long")?.nicheIds).toEqual([LONGFORM_GTA.id]);
    expect(byId.get("vid_long_unresolved")?.nicheIds).toEqual([LONGFORM_GTA.id]);
    // And the uncertain video was never loaded at all.
    expect(byId.has("vid_uncertain")).toBe(false);
    expect(shorts).toHaveLength(3);
  });

  it("pays rate A for the shorts hit and rate B for the longform hit — A + B exactly", async () => {
    const inputs = await loadPayrollInputs(ORG_ID, JANUARY);
    const run = calculatePayrollRun({ ...inputs, period: JANUARY, nowMs: NOW });

    const sam = run.calculations[0];
    expect(sam?.hitCount).toBe(2);
    // 500 + 1,200 = 1,700 minor units. Not 2 × 500, not 2 × 1,200, and not an
    // average — each hit at its own niche's price.
    expect(sam?.hitBonusMinor).toBe(SHORTS_RATE + LONGFORM_RATE);
    expect(sam?.totalMinor).toBe(300_000 + 1_700);
    // Two rates on one record means no single record-level rate — 0, never an
    // average that was never paid.
    expect(sam?.hitPaymentMinor).toBe(0);

    // Each hit credited to its own niche, at that niche's price.
    const byVideo = new Map(sam!.hits.map((hit) => [hit.videoId, hit]));
    expect(byVideo.get("vid_short")?.nicheId).toBe(SHORTS_GTA.id);
    expect(byVideo.get("vid_short")?.hitPaymentMinor).toBe(SHORTS_RATE);
    expect(byVideo.get("vid_short")?.windowHoursApplied).toBe(SEVEN_DAYS);
    expect(byVideo.get("vid_long")?.nicheId).toBe(LONGFORM_GTA.id);
    expect(byVideo.get("vid_long")?.hitPaymentMinor).toBe(LONGFORM_RATE);
    expect(byVideo.get("vid_long")?.windowHoursApplied).toBe(LONGFORM_WINDOW);

    // The per-niche lines the payslip prints: 1 × A and 1 × B.
    expect(run.calculations[0]?.byNiche).toEqual([
      {
        nicheId: LONGFORM_GTA.id,
        nicheName: "GTA Long Form",
        thresholdApplied: 2_000_000,
        windowHoursApplied: LONGFORM_WINDOW,
        hitPaymentMinor: LONGFORM_RATE,
        hitCount: 1,
        bonusMinor: LONGFORM_RATE,
      },
      {
        nicheId: SHORTS_GTA.id,
        nicheName: "GTA",
        thresholdApplied: 1_000_000,
        windowHoursApplied: SEVEN_DAYS,
        hitPaymentMinor: SHORTS_RATE,
        hitCount: 1,
        bonusMinor: SHORTS_RATE,
      },
    ]);
  });
});

describe("the Deploy-B identity: zero longform niches", () => {
  beforeEach(() => {
    // Today's world, every organization's world: nothing longform exists.
    setUpWorld([SHORTS_GTA], [SHORTS_GTA.id]);
  });

  it("hands the engine long-form videos it can attribute to nobody", async () => {
    const { shorts } = await loadPayrollInputs(ORG_ID, JANUARY);

    const byId = new Map(shorts.map((short) => [short.videoId, short]));
    // The not_short arm loads, and narrows to NOTHING: no longform niches
    // exist to match. `judgeShort` builds candidates by walking this list, so
    // an empty one means no governing rule, no verdict, no bucket anywhere —
    // the "unattributable" behaviour the engine was read to confirm.
    expect(byId.get("vid_long_unresolved")?.nicheIds).toEqual([]);
    // The Short arrives with exactly the ids it always did — the full channel
    // list, because every niche on it is a shorts niche.
    expect(byId.get("vid_short")?.nicheIds).toEqual([SHORTS_GTA.id]);
  });

  it("produces figures identical to the shorts-only run, to the minor unit", async () => {
    const inputs = await loadPayrollInputs(ORG_ID, JANUARY);
    const run = calculatePayrollRun({ ...inputs, period: JANUARY, nowMs: NOW });

    // The pre-format answer, pinned: one shorts hit at rate A, salary on top,
    // and the long-form videos moving NOTHING — not the total, not a skipped
    // niche, not an unresolved count.
    const sam = run.calculations[0];
    expect(sam?.hitCount).toBe(1);
    expect(sam?.hitBonusMinor).toBe(SHORTS_RATE);
    expect(sam?.totalMinor).toBe(300_500);
    expect(sam?.hitPaymentMinor).toBe(SHORTS_RATE);
    expect(sam?.hits.map((hit) => hit.videoId)).toEqual(["vid_short"]);
    expect(run.totalMinor).toBe(300_500);
    expect(run.skippedNiches).toEqual([]);
    expect(run.unresolved).toEqual({ pendingCount: 0, unknownCount: 0, alreadyPaidCount: 0 });
  });
});
