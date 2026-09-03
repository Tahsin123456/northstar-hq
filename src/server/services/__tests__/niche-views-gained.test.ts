import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * =========================================================================
 * VIEWS GAINED, GROUPED PER NICHE — SCOPE, SPLIT AND THE HONEST SPAN
 * =========================================================================
 *
 * Three rules carry this endpoint, each the kind that fails silently:
 *
 *   • the SPLIT: own versus competitor gains decide whose money the earnings
 *     panel claims, and a swapped split renders a competitor's views as
 *     Northstar's revenue;
 *   • the SPAN: the measurement runs over `[max(start, earliest snapshot),
 *     end)` uniformly, and where nothing is measurable the service says so
 *     instead of computing zeros that read as "gained nothing";
 *   • the SCOPE: a niche-scoped reader's invisible niches are omitted from
 *     the response, because even a view total is a statement about a niche
 *     they were not assigned.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 19).toString("base64");

const ORG_ID = "org_northstar";
const DAY_MS = 86_400_000;
const START_MS = Date.UTC(2026, 7, 1);
const END_MS = Date.UTC(2026, 7, 31);

const mocks = vi.hoisted(() => ({
  nicheFindMany: vi.fn(),
  trackedFindMany: vi.fn(),
  snapshotFindFirst: vi.fn(),
  videoFindMany: vi.fn(),
  memberNicheFindMany: vi.fn(),
  role: "admin" as string,
}));

vi.mock("@/server/db", () => ({
  prisma: {
    niche: { findMany: mocks.nicheFindMany },
    trackedChannel: { findMany: mocks.trackedFindMany },
    videoSnapshot: { findFirst: mocks.snapshotFindFirst },
    video: { findMany: mocks.videoFindMany },
    memberNiche: { findMany: mocks.memberNicheFindMany },
  },
}));

vi.mock("@/server/auth/dal", () => ({
  requireActor: async () => ({
    userId: "user_1",
    organizationId: ORG_ID,
    role: mocks.role,
  }),
}));

vi.mock("../user-service", () => ({
  getCurrentOrgId: async () => ORG_ID,
}));

const { getNicheViewsGained } = await import("../niche-views-gained-service");
const { hasUsableGainsHistory, measuredSpanNoteFrom } = await import(
  "@/lib/analytics/niche-earnings"
);

const HOUR_MS = 3_600_000;

function snapshot(capturedAtMs: number, viewCount: number) {
  return { capturedAt: new Date(capturedAtMs), viewCount: BigInt(viewCount) };
}

/** A fully covered Short: bracketed at both ends of any span inside August. */
function coveredShort(id: string, channelId: string, gained: number) {
  return {
    id,
    channelId,
    publishedAt: new Date(START_MS - 90 * DAY_MS),
    isShort: true,
    classification: "short",
    snapshots: [
      snapshot(START_MS - DAY_MS, 1_000_000),
      snapshot(END_MS - DAY_MS, 1_000_000 + gained),
    ],
  };
}

function tracked(channelId: string, ownershipType: string, nicheIds: readonly string[]) {
  return {
    channelId,
    ownershipType,
    niches: nicheIds.map((nicheId) => ({ nicheId })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = "admin";
  mocks.memberNicheFindMany.mockResolvedValue([]);
  mocks.nicheFindMany.mockResolvedValue([{ id: "niche_gta" }, { id: "niche_football" }]);
  // History reaches back well before the requested period by default.
  mocks.snapshotFindFirst.mockResolvedValue({
    capturedAt: new Date(START_MS - 30 * DAY_MS),
  });
  mocks.trackedFindMany.mockResolvedValue([]);
  mocks.videoFindMany.mockResolvedValue([]);
});

const request = () =>
  getNicheViewsGained({ format: "shorts", startMs: START_MS, endMs: END_MS });

describe("grouping and the own/competitor split", () => {
  it("counts a channel filed under two niches in both, and splits by ownership", async () => {
    mocks.trackedFindMany.mockResolvedValue([
      tracked("chan_ours", "own", ["niche_gta", "niche_football"]),
      tracked("chan_rival", "competitor", ["niche_gta"]),
    ]);
    mocks.videoFindMany.mockResolvedValue([
      coveredShort("vid_ours", "chan_ours", 100_000),
      coveredShort("vid_rival", "chan_rival", 40_000),
    ]);

    const result = await request();

    expect(result.measuredFromMs).toBe(START_MS);
    expect(result.niches).toEqual([
      {
        nicheId: "niche_gta",
        ourViewsGained: 100_000,
        competitorViewsGained: 40_000,
        coveredVideos: 2,
        totalVideos: 2,
        ownChannelIds: ["chan_ours"],
      },
      // The shared channel counts here TOO — correct per niche, and exactly
      // why the earnings builder refuses to SUM niches sharing a channel.
      {
        nicheId: "niche_football",
        ourViewsGained: 100_000,
        competitorViewsGained: 0,
        coveredVideos: 1,
        totalVideos: 1,
        ownChannelIds: ["chan_ours"],
      },
    ]);
  });

  it("counts an unmeasured channel toward coverage and toward nothing else", async () => {
    mocks.trackedFindMany.mockResolvedValue([
      tracked("chan_ours", "own", ["niche_gta"]),
      tracked("chan_dark", "own", ["niche_gta"]),
    ]);
    mocks.videoFindMany.mockResolvedValue([
      coveredShort("vid_ours", "chan_ours", 100_000),
      // A library with no usable readings: its zero is "could not measure",
      // never "gained nothing", so it may not join the sum — but its videos
      // MUST depress coverage, or a thin history would price a whole niche.
      {
        id: "vid_dark",
        channelId: "chan_dark",
        publishedAt: new Date(START_MS - 90 * DAY_MS),
        isShort: true,
        classification: "short",
        snapshots: [],
      },
    ]);

    const result = await request();

    expect(result.niches[0]).toEqual({
      nicheId: "niche_gta",
      ourViewsGained: 100_000,
      competitorViewsGained: 0,
      coveredVideos: 1,
      totalVideos: 2,
      // The dark channel measured nothing, so it is not an id the total's
      // double-count check needs to see.
      ownChannelIds: ["chan_ours"],
    });
  });
});

describe("the measured span", () => {
  it("clamps the measurement to where the history begins, uniformly", async () => {
    const earliestMs = START_MS + 21 * DAY_MS;
    mocks.snapshotFindFirst.mockResolvedValue({ capturedAt: new Date(earliestMs) });
    mocks.trackedFindMany.mockResolvedValue([tracked("chan_ours", "own", ["niche_gta"])]);

    const result = await request();

    expect(result.requestedStartMs).toBe(START_MS);
    expect(result.measuredFromMs).toBe(earliestMs);
    expect(result.earliestSnapshotMs).toBe(earliestMs);
    // The clamped start is what the measurement was actually asked about —
    // one span for every channel, or the sums describe no span at all.
    const args = mocks.videoFindMany.mock.calls[0][0];
    expect(args.select.snapshots.where.capturedAt.gte).toEqual(
      new Date(earliestMs - 60 * DAY_MS),
    );
  });

  it("answers the no-history shape when the organization has no snapshots at all", async () => {
    mocks.snapshotFindFirst.mockResolvedValue(null);

    const result = await request();

    expect(result).toEqual({
      requestedStartMs: START_MS,
      endMs: END_MS,
      measuredFromMs: null,
      earliestSnapshotMs: null,
      // Nothing was measured, so there is no raggedness to report — `null`,
      // never a 0 that would read as "measured, and perfectly uniform".
      maxBaselineLagMs: null,
      niches: [],
    });
    // Said, not computed: no measurement ran, so nothing could be dressed as
    // a zero.
    expect(mocks.videoFindMany).not.toHaveBeenCalled();
    expect(mocks.trackedFindMany).not.toHaveBeenCalled();
  });

  it("answers the no-history shape for a period that ends before the history begins", async () => {
    mocks.snapshotFindFirst.mockResolvedValue({ capturedAt: new Date(END_MS + DAY_MS) });

    const result = await request();

    expect(result.measuredFromMs).toBeNull();
    expect(result.earliestSnapshotMs).toBe(END_MS + DAY_MS);
    expect(result.niches).toEqual([]);
    expect(mocks.videoFindMany).not.toHaveBeenCalled();
  });
});

/**
 * =========================================================================
 * THE 1 SEPTEMBER BLACKOUT — THE REGRESSION ITSELF, PINNED BOTH WAYS
 * =========================================================================
 *
 * Automatic refresh takes at most 25 channels an hour and sweeps them
 * sequentially, so an organization's first-ever snapshots are staggered across
 * channels by minutes to hours. `measuredFromMs` is the org-wide MINIMUM
 * `capturedAt`, which makes it the single instant at which the fewest videos
 * hold a reading — and a video with no reading at-or-before the window's start
 * was dropped from the sum AND from `coveredVideos`.
 *
 * The result was not cosmetic and did not self-heal: coverage sat far below the
 * 0.9 dollar floor, every niche rendered "Not enough view history yet" while
 * the owner had rates entered, and a 30-day period would have stayed that way
 * until October — re-firing for a month every time a channel was added.
 */
describe("staggered first snapshots across channels", () => {
  /** The sweep's first capture. The window reaches back well before it. */
  const SWEEP_MS = START_MS + 21 * DAY_MS;

  /** A video whose own history starts at `firstMs` and gains `gained` after. */
  function stagger(id: string, channelId: string, firstMs: number, gained: number) {
    return {
      id,
      channelId,
      publishedAt: new Date(START_MS - 90 * DAY_MS),
      isShort: true,
      classification: "short",
      snapshots: [
        snapshot(firstMs, 1_000_000),
        snapshot(END_MS - DAY_MS, 1_000_000 + gained),
      ],
    };
  }

  beforeEach(() => {
    mocks.snapshotFindFirst.mockResolvedValue({ capturedAt: new Date(SWEEP_MS) });
    mocks.trackedFindMany.mockResolvedValue([
      tracked("chan_ours", "own", ["niche_gta"]),
      tracked("chan_rival", "competitor", ["niche_gta"]),
    ]);
    mocks.videoFindMany.mockResolvedValue([
      // Swept first — the only video the old rule could bracket.
      stagger("vid_first", "chan_ours", SWEEP_MS, 50_000),
      // Same channel, next page of the sweep: ninety minutes later.
      stagger("vid_later", "chan_ours", SWEEP_MS + 90 * 60_000, 20_000),
      // A different channel entirely, three hours into the run.
      stagger("vid_rival", "chan_rival", SWEEP_MS + 3 * HOUR_MS, 30_000),
    ]);
  });

  it("prices the niche instead of blacking it out, and reports what it measured", async () => {
    const result = await request();
    const entry = result.niches[0]!;

    // WHAT THE OLD RULE PRODUCED: one of three videos bracketed, because only
    // the first-swept one held a reading at the org-wide minimum. 33% against
    // a 0.9 floor is words, not money — for every niche, permanently.
    expect(hasUsableGainsHistory({ coveredVideos: 1, totalVideos: 3 })).toBe(false);

    // WHAT IT PRODUCES NOW: every video measured from its own first reading,
    // the split intact, and a figure that can actually be priced.
    expect(entry).toEqual({
      nicheId: "niche_gta",
      ourViewsGained: 70_000,
      competitorViewsGained: 30_000,
      coveredVideos: 3,
      totalVideos: 3,
      ownChannelIds: ["chan_ours"],
    });
    expect(hasUsableGainsHistory(entry)).toBe(true);

    // The span stays honest: the clamp is unmoved, and the three hours the
    // raggedest video is missing are reported rather than assumed away.
    expect(result.measuredFromMs).toBe(SWEEP_MS);
    expect(result.maxBaselineLagMs).toBe(3 * HOUR_MS);
    expect(measuredSpanNoteFrom(result)).toBe(
      "Measured over the last 9 of 30 days — view history begins there. " +
        "The app started recording some of these videos up to 3 hours into that " +
        "span, so their first views are missing and this figure is a little low.",
    );
  });

  it("still refuses a niche whose videos genuinely have no usable readings", async () => {
    mocks.videoFindMany.mockResolvedValue([
      stagger("vid_first", "chan_ours", SWEEP_MS, 50_000),
      // Onboarded five days into a nine-day span — far outside the grace.
      // Measuring its last four days and calling that the period would be a
      // distortion, so it is dropped and it depresses coverage, which is
      // exactly what the floor exists to catch.
      stagger("vid_new_channel", "chan_rival", SWEEP_MS + 5 * DAY_MS, 900_000),
      {
        id: "vid_dark",
        channelId: "chan_rival",
        publishedAt: new Date(START_MS - 90 * DAY_MS),
        isShort: true,
        classification: "short",
        // Not one reading. Genuinely unmeasurable, in every rule.
        snapshots: [],
      },
    ]);

    const result = await request();
    const entry = result.niches[0]!;

    expect(entry.coveredVideos).toBe(1);
    expect(entry.totalVideos).toBe(3);
    expect(hasUsableGainsHistory(entry)).toBe(false);
    // Nothing was baselined late, so the label makes no claim about raggedness.
    expect(result.maxBaselineLagMs).toBe(0);
  });
});

describe("the niche scope", () => {
  it("omits a scoped reader's invisible niches from the query and the response", async () => {
    mocks.role = "short_form_editor";
    mocks.memberNicheFindMany.mockResolvedValue([{ nicheId: "niche_gta" }]);
    mocks.nicheFindMany.mockImplementation(async (args: { where: { id?: { in: string[] } } }) => {
      // The narrowing must live in the WHERE — filtering the response after
      // loading the rows is the leak every other scoped read refuses.
      expect(args.where.id).toEqual({ in: ["niche_gta"] });
      return [{ id: "niche_gta" }];
    });

    const result = await request();

    expect(result.niches.map((entry) => entry.nicheId)).toEqual(["niche_gta"]);
  });

  it("fails closed for a scoped reader with no assignments", async () => {
    mocks.role = "short_form_editor";
    mocks.memberNicheFindMany.mockResolvedValue([]);
    mocks.nicheFindMany.mockResolvedValue([]);

    const result = await request();

    expect(result.niches).toEqual([]);
    // No member read happens for an empty catalogue.
    expect(mocks.trackedFindMany).not.toHaveBeenCalled();
  });
});
