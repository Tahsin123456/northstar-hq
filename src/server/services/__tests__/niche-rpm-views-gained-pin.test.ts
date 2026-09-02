import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * =========================================================================
 * THE DERIVED-RPM VIEW DELTA, PINNED ACROSS THE EXTRACTION
 * =========================================================================
 *
 * `viewsGainedByChannel` is moving out of `niche-rpm-service.ts` into a
 * service of its own so the niche money figures can price views GAINED in a
 * period. The move must not change the derived rate by a single view: the
 * rate is money somebody actually earned divided by this exact delta, and a
 * quiet off-by-one-video in the refactor would reprice every niche.
 *
 * So this file was written FIRST, run green against the code as it stood
 * BEFORE the extraction, and then run again after it. It drives the public
 * resolver end to end — mocked Prisma, real judgement — and every number
 * below is chosen so that each snapshot rule failing changes the answer:
 *
 *   • the zero-baseline rule (born inside the window) contributes 100,000 of
 *     the 250,000-view total — drop it and the channel falls below
 *     `RPM_MIN_VIEWS` and is rejected instead of accepted;
 *   • the kept negative delta subtracts 50,000 — clamp it and the rate
 *     becomes 9,333 rather than 11,200;
 *   • the dropped-uncovered-video rule turns channel B's coverage into 0.5,
 *     which must arrive as `thin_view_coverage` and not as a zero baseline;
 *   • the covered-nothing channel C must arrive as `no_view_history`, never
 *     as a measured zero.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 19).toString("base64");

const ORG_ID = "org_northstar";
const DAY_MS = 86_400_000;

/** Noon on 31 Aug 2026: today floors to the 31st, settle ends the window 28 Jul. */
const NOW_MS = Date.UTC(2026, 7, 31, 12);
const WINDOW_END_MS = Date.UTC(2026, 7, 28);
const WINDOW_START_MS = WINDOW_END_MS - 28 * DAY_MS;

const mocks = vi.hoisted(() => ({
  trackedFindMany: vi.fn(),
  connectionFindMany: vi.fn(),
  revenueFindMany: vi.fn(),
  revenueGroupBy: vi.fn(),
  videoFindMany: vi.fn(),
  rateFindMany: vi.fn(),
  memberNicheFindMany: vi.fn(),
  can: vi.fn<(permission: string) => Promise<boolean>>(),
}));

vi.mock("@/server/db", () => ({
  prisma: {
    trackedChannel: { findMany: mocks.trackedFindMany },
    youTubeConnection: { findMany: mocks.connectionFindMany },
    channelRevenueDay: { findMany: mocks.revenueFindMany, groupBy: mocks.revenueGroupBy },
    video: { findMany: mocks.videoFindMany },
    exchangeRate: { findMany: mocks.rateFindMany },
    memberNiche: { findMany: mocks.memberNicheFindMany },
  },
}));

vi.mock("@/server/auth/dal", () => ({
  actorCan: mocks.can,
  requireActor: async () => ({
    userId: "user_1",
    organizationId: ORG_ID,
    role: "admin",
  }),
}));

vi.mock("../user-service", () => ({
  getCurrentOrgId: async () => ORG_ID,
  getCurrentOrgSettings: async () => ({
    baseCurrency: "USD",
    defaultPeriodDays: 30,
    engagedViewShareBasisPoints: 5_000,
  }),
}));

const { resolveNicheRpmByNiche } = await import("../niche-rpm-service");

/** One tracked own channel filed under the GTA niche. */
function trackedRow(channelId: string) {
  return {
    channelId,
    channel: { id: channelId, title: channelId, youtubeChannelId: `yt_${channelId}` },
    niches: [{ nicheId: "niche_gta" }],
  };
}

/** 28 settled days of $1.00, one per day of the window — a steady earner. */
function fullRevenueDays(channelId: string) {
  return Array.from({ length: 28 }, (_, i) => ({
    channelId,
    day: new Date(WINDOW_START_MS + i * DAY_MS),
    estimatedRevenueMinor: 100,
    currency: "USD",
  }));
}

function snapshot(capturedAtMs: number, viewCount: number) {
  return { capturedAt: new Date(capturedAtMs), viewCount: BigInt(viewCount) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.memberNicheFindMany.mockResolvedValue([]);
  mocks.rateFindMany.mockResolvedValue([]);

  mocks.trackedFindMany.mockResolvedValue([
    trackedRow("chan_a"),
    trackedRow("chan_b"),
    trackedRow("chan_c"),
  ]);
  mocks.connectionFindMany.mockResolvedValue(
    ["chan_a", "chan_b", "chan_c"].map((id) => ({
      youtubeChannelId: `yt_${id}`,
      monetizationStatus: "monetized",
      revenueSyncStatus: "ok",
      coveredChannels: [],
    })),
  );
  mocks.revenueFindMany.mockResolvedValue([
    ...fullRevenueDays("chan_a"),
    ...fullRevenueDays("chan_b"),
    ...fullRevenueDays("chan_c"),
  ]);
  mocks.revenueGroupBy.mockResolvedValue([
    { channelId: "chan_a" },
    { channelId: "chan_b" },
    { channelId: "chan_c" },
  ]);

  mocks.videoFindMany.mockResolvedValue([
    /*
     * CHANNEL A — every snapshot rule at once, summing to exactly 250,000,
     * which is `RPM_MIN_VIEWS` to the view. Any rule drifting moves the total
     * off the floor or changes the rate.
     */
    {
      // Old video bracketed at both ends: +200,000.
      id: "vid_old",
      channelId: "chan_a",
      publishedAt: new Date(WINDOW_START_MS - 90 * DAY_MS),
      snapshots: [
        snapshot(WINDOW_START_MS - DAY_MS, 1_000_000),
        snapshot(WINDOW_END_MS - 3_600_000, 1_200_000),
      ],
    },
    {
      // Born INSIDE the window: zero baseline is a fact, +100,000.
      id: "vid_new",
      channelId: "chan_a",
      publishedAt: new Date(WINDOW_START_MS + 5 * DAY_MS),
      snapshots: [snapshot(WINDOW_END_MS - 3_600_000, 100_000)],
    },
    {
      // Views purged mid-window: the negative delta is real, -50,000.
      id: "vid_neg",
      channelId: "chan_a",
      publishedAt: new Date(WINDOW_START_MS - 90 * DAY_MS),
      snapshots: [
        snapshot(WINDOW_START_MS - DAY_MS, 500_000),
        snapshot(WINDOW_END_MS - 3_600_000, 450_000),
      ],
    },

    /*
     * CHANNEL B — one covered video, one OLD video with no reading at the
     * window's start. The uncovered one must be dropped from BOTH sides
     * (never zero-based), leaving coverage at 0.5, under the 0.9 floor.
     */
    {
      id: "vid_b_covered",
      channelId: "chan_b",
      publishedAt: new Date(WINDOW_START_MS - 90 * DAY_MS),
      snapshots: [
        snapshot(WINDOW_START_MS - DAY_MS, 100_000),
        snapshot(WINDOW_END_MS - 3_600_000, 400_000),
      ],
    },
    {
      id: "vid_b_uncovered",
      channelId: "chan_b",
      publishedAt: new Date(WINDOW_START_MS - 90 * DAY_MS),
      snapshots: [snapshot(WINDOW_END_MS - 3_600_000, 9_000_000)],
    },

    /*
     * CHANNEL C — a library with no reading bracketing the window at all.
     * Must resolve to "we cannot measure", never to a measured zero.
     */
    {
      id: "vid_c",
      channelId: "chan_c",
      publishedAt: new Date(WINDOW_START_MS - 90 * DAY_MS),
      snapshots: [],
    },
  ]);
});

const NICHES = [
  {
    id: "niche_gta",
    rpmLowMinorPerMillion: null,
    rpmHighMinorPerMillion: null,
    rpmCurrency: null,
  },
];

describe("the derived rate survives the views-gained extraction unchanged", () => {
  it("derives $0.0112 per 1,000 views from exactly 250,000 gained views", async () => {
    const resolved = await resolveNicheRpmByNiche({ niches: NICHES, nowMs: NOW_MS });

    expect(resolved).not.toBeNull();
    const rpm = resolved!.get("niche_gta");
    expect(rpm?.source).toBe("derived");
    if (rpm?.source !== "derived") return;

    // 2,800 minor units over 250,000 views: round(2800 * 1e6 / 250000).
    // 100,000 of those views exist only through the zero-baseline rule and
    // -50,000 only through the kept negative delta — either rule bending
    // changes this number or rejects the channel outright.
    expect(rpm.rpmMinorPerMillion).toBe(11_200);
    expect(rpm.evidence.viewsUsed).toBe(250_000);
    expect(rpm.evidence.revenueMinorUsed).toBe(2_800);
    expect(rpm.evidence.channels).toEqual([{ id: "chan_a", name: "chan_a" }]);
  });

  it("rejects the half-covered channel as thin coverage, not as a zero baseline", async () => {
    const resolved = await resolveNicheRpmByNiche({ niches: NICHES, nowMs: NOW_MS });

    const rpm = resolved!.get("niche_gta");
    if (rpm?.source !== "derived") throw new Error("expected a derived rate");

    expect(rpm.rejectedChannels).toContainEqual({
      channelId: "chan_b",
      channelName: "chan_b",
      accepted: false,
      reason: "thin_view_coverage",
    });
  });

  it("rejects the channel with no bracketing reading as having no view history", async () => {
    const resolved = await resolveNicheRpmByNiche({ niches: NICHES, nowMs: NOW_MS });

    const rpm = resolved!.get("niche_gta");
    if (rpm?.source !== "derived") throw new Error("expected a derived rate");

    // Absent from the delta map entirely — `viewsGained: null`, never 0 —
    // which the judge reports as the only sentence an owner can act on.
    expect(rpm.rejectedChannels).toContainEqual({
      channelId: "chan_c",
      channelName: "chan_c",
      accepted: false,
      reason: "no_view_history",
    });
  });

  it("loads snapshots over the bounded 60-day lookback, ending at the window", async () => {
    await resolveNicheRpmByNiche({ niches: NICHES, nowMs: NOW_MS });

    expect(mocks.videoFindMany).toHaveBeenCalledTimes(1);
    const args = mocks.videoFindMany.mock.calls[0][0];
    expect(args.select.snapshots.where.capturedAt).toEqual({
      gte: new Date(WINDOW_START_MS - 60 * DAY_MS),
      lt: new Date(WINDOW_END_MS),
    });
    expect(args.where.publishedAt).toEqual({ lt: new Date(WINDOW_END_MS) });
  });
});
