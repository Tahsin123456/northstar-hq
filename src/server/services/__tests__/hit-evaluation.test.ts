import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MATERIALISING THE VERDICTS.
 *
 * The rule itself is pinned in `src/lib/analytics/__tests__/hit-rate.test.ts`.
 * What is under test here is everything around it: which niche judges a Short,
 * which snapshots are allowed to decide, what gets written, and — the part that
 * matters most on a table this product will keep forever — what gets left
 * alone.
 *
 * Prisma is a small in-memory stand-in rather than a pile of `vi.fn()`s
 * returning fixtures, because half of these tests are about the SECOND run
 * seeing what the first one wrote. What is being tested is the decision, not
 * Prisma's ability to filter, so the fake honours exactly the two clauses the
 * service depends on: the channel filter and the snapshot age bound.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");

const ORG_ID = "org_northstar";
const OTHER_ORG = "org_someone_else";
const HOUR_MS = 3_600_000;

/** 2026-01-01T12:00:00Z, the moment every fixture Short is published. */
const PUBLISHED = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
const at = (hours: number): number => PUBLISHED.getTime() + hours * HOUR_MS;

interface NicheRow {
  id: string;
  hitThreshold: number | null;
  hitWindowHours: number | null;
}

interface TrackedRow {
  channelId: string;
  nicheIds: string[];
}

interface SnapshotRow {
  viewCount: bigint;
  videoAgeHours: number;
}

interface VideoRow {
  id: string;
  channelId: string;
  publishedAt: Date;
  viewCount: bigint;
  snapshots: SnapshotRow[];
}

interface EvaluationRow {
  organizationId: string;
  videoId: string;
  outcome: string;
  nicheId: string | null;
  thresholdApplied: number | null;
  windowHoursApplied: number | null;
  viewsAtWindow: bigint | null;
  observedAtHours: number | null;
  windowClosesAt: Date | null;
  evaluatedAt: Date;
}

interface VideoFindManyArgs {
  where: { channelId: string; isShort: boolean; id?: { in: string[] } };
  select: { snapshots: { where: { videoAgeHours: { lte: number } } } };
}

interface EvaluationFindManyArgs {
  where: { organizationId: string; videoId: { in: string[] } };
}

interface UpsertArgs {
  where: { organizationId_videoId: { organizationId: string; videoId: string } };
  create: EvaluationRow;
  update: Partial<EvaluationRow>;
}

const mocks = vi.hoisted(() => {
  const store = {
    niches: [] as NicheRow[],
    tracked: [] as TrackedRow[],
    videos: [] as VideoRow[],
    evaluations: new Map<string, EvaluationRow>(),
  };

  const key = (organizationId: string, videoId: string) => `${organizationId}:${videoId}`;

  const upsert = vi.fn(async (args: UpsertArgs) => {
    const { organizationId, videoId } = args.where.organizationId_videoId;
    const existing = store.evaluations.get(key(organizationId, videoId));
    store.evaluations.set(
      key(organizationId, videoId),
      existing ? { ...existing, ...args.update } : { ...args.create },
    );
    return args.create;
  });

  return { store, upsert, key };
});

vi.mock("@/server/db", () => ({
  prisma: {
    niche: {
      findMany: async () => mocks.store.niches,
    },
    trackedChannel: {
      findMany: async () =>
        mocks.store.tracked.map((row) => ({
          channelId: row.channelId,
          niches: row.nicheIds.map((nicheId) => ({ nicheId })),
        })),
    },
    video: {
      findMany: async (args: VideoFindManyArgs) => {
        const maxAgeHours = args.select.snapshots.where.videoAgeHours.lte;
        return mocks.store.videos
          .filter((video) => video.channelId === args.where.channelId)
          .filter((video) => !args.where.id || args.where.id.in.includes(video.id))
          .map((video) => ({
            id: video.id,
            publishedAt: video.publishedAt,
            viewCount: video.viewCount,
            // The age bound is honoured because it is load-bearing: a reading
            // taken after the window shut must never reach the rule.
            snapshots: video.snapshots.filter(
              (snapshot) => snapshot.videoAgeHours <= maxAgeHours,
            ),
          }));
      },
    },
    videoHitEvaluation: {
      findMany: async (args: EvaluationFindManyArgs) =>
        [...mocks.store.evaluations.values()].filter(
          (row) =>
            row.organizationId === args.where.organizationId &&
            args.where.videoId.in.includes(row.videoId),
        ),
      upsert: mocks.upsert,
    },
    $transaction: async (operations: readonly unknown[]) => Promise.all(operations),
  },
}));

const { evaluateHitsForOrganization, decideWrite, resolveChannelRule } = await import(
  "../hit-evaluation-service"
);

/** A million views within a week — the canonical rule. */
const GTA: NicheRow = { id: "niche_gta", hitThreshold: 1_000_000, hitWindowHours: 168 };
/** A lower bar on a tighter clock, for the two-niches case. */
const TLOU: NicheRow = { id: "niche_tlou", hitThreshold: 500_000, hitWindowHours: 48 };

function video(overrides: Partial<VideoRow> & { id: string }): VideoRow {
  return {
    channelId: "chan_1",
    publishedAt: PUBLISHED,
    viewCount: BigInt(0),
    snapshots: [],
    ...overrides,
  };
}

function stored(videoId: string): EvaluationRow | undefined {
  return mocks.store.evaluations.get(mocks.key(ORG_ID, videoId));
}

/** A year after publication: every fixture window has long since shut. */
const LONG_AFTER = at(8_760);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.niches = [GTA];
  mocks.store.tracked = [{ channelId: "chan_1", nicheIds: [GTA.id] }];
  mocks.store.videos = [];
  mocks.store.evaluations.clear();
});

describe("the four outcomes, materialised", () => {
  beforeEach(() => {
    mocks.store.videos = [
      // Seen over the bar at hour 2 of a 168-hour window.
      video({
        id: "vid_hit",
        viewCount: BigInt(9_000_000),
        snapshots: [{ viewCount: BigInt(1_050_000), videoAgeHours: 2 }],
      }),
      // No history at all, and still under the bar today.
      video({ id: "vid_miss", viewCount: BigInt(40_000) }),
      // No history, over the bar today — nobody can say when it got there.
      video({ id: "vid_unknown", viewCount: BigInt(3_000_000) }),
      // Published an hour ago: its window is still open.
      video({
        id: "vid_pending",
        publishedAt: new Date(LONG_AFTER - HOUR_MS),
        viewCount: BigInt(12_000),
      }),
    ];
  });

  it("writes one verdict per Short and pins all four", async () => {
    const summary = await evaluateHitsForOrganization(ORG_ID, { nowMs: LONG_AFTER });

    expect(summary.shortsConsidered).toBe(4);
    expect(summary.created).toBe(4);
    expect(summary.byOutcome).toEqual({ hit: 1, miss: 1, pending: 1, unknown: 1 });

    expect(stored("vid_hit")?.outcome).toBe("hit");
    expect(stored("vid_miss")?.outcome).toBe("miss");
    expect(stored("vid_unknown")?.outcome).toBe("unknown");
    expect(stored("vid_pending")?.outcome).toBe("pending");
  });

  it("records the rule that judged each one, and what was seen", async () => {
    await evaluateHitsForOrganization(ORG_ID, { nowMs: LONG_AFTER });

    const hit = stored("vid_hit");
    expect(hit?.nicheId).toBe(GTA.id);
    expect(hit?.thresholdApplied).toBe(1_000_000);
    expect(hit?.windowHoursApplied).toBe(168);
    expect(hit?.viewsAtWindow).toBe(BigInt(1_050_000));
    // The honesty column: this verdict rests on a reading taken at hour 2, and
    // the row says so rather than implying somebody watched until the close.
    expect(hit?.observedAtHours).toBe(2);
    expect(hit?.windowClosesAt?.getTime()).toBe(at(168));
  });

  it("says nothing was seen when a verdict came from an inference", async () => {
    await evaluateHitsForOrganization(ORG_ID, { nowMs: LONG_AFTER });

    // The confident miss is confident about the OUTCOME, not about having
    // watched. Writing today's total into `viewsAtWindow` would dress an
    // inference up as a measurement taken at day seven.
    expect(stored("vid_miss")?.viewsAtWindow).toBeNull();
    expect(stored("vid_miss")?.observedAtHours).toBeNull();
  });

  it("never turns an over-the-bar Short with no history into a hit", async () => {
    await evaluateHitsForOrganization(ORG_ID, { nowMs: LONG_AFTER });

    // 374 Shorts on this account are in exactly this state, and they are
    // disproportionately the winners. Calling them hits would be inventing the
    // one number the whole product is judged on.
    expect(stored("vid_unknown")?.outcome).toBe("unknown");
    expect(stored("vid_unknown")?.viewsAtWindow).toBeNull();
  });

  it("ignores a snapshot taken after the window shut", async () => {
    mocks.store.videos = [
      video({
        id: "vid_late",
        viewCount: BigInt(2_000_000),
        snapshots: [{ viewCount: BigInt(2_000_000), videoAgeHours: 700 }],
      }),
    ];

    await evaluateHitsForOrganization(ORG_ID, { nowMs: LONG_AFTER });

    expect(stored("vid_late")?.outcome).toBe("unknown");
  });
});

describe("a niche missing either half scores nothing", () => {
  it("records a threshold with no window as unscoreable, not as a miss", async () => {
    mocks.store.niches = [{ id: "niche_gta", hitThreshold: 1_000_000, hitWindowHours: null }];
    mocks.store.videos = [video({ id: "vid_1", viewCount: BigInt(40_000) })];

    const summary = await evaluateHitsForOrganization(ORG_ID, { nowMs: LONG_AFTER });

    expect(summary.unscoreable).toBe(1);
    expect(summary.byOutcome).toEqual({ hit: 0, miss: 0, pending: 0, unknown: 0 });

    const row = stored("vid_1");
    // A Short cannot fail a bar nobody set. The null niche and the null rule
    // are what separate this from an ordinary unknown, and calling it a miss
    // would let an unfinished configuration drag a hit rate down while looking
    // like a measurement.
    expect(row?.outcome).toBe("unknown");
    expect(row?.nicheId).toBeNull();
    expect(row?.thresholdApplied).toBeNull();
    expect(row?.windowHoursApplied).toBeNull();
  });

  it("records a window with no threshold the same way", async () => {
    mocks.store.niches = [{ id: "niche_gta", hitThreshold: null, hitWindowHours: 168 }];
    mocks.store.videos = [video({ id: "vid_1", viewCount: BigInt(9_000_000) })];

    const summary = await evaluateHitsForOrganization(ORG_ID, { nowMs: LONG_AFTER });

    expect(summary.unscoreable).toBe(1);
    expect(stored("vid_1")?.nicheId).toBeNull();
  });

  it("does the same for a channel filed under no niche at all", async () => {
    mocks.store.tracked = [{ channelId: "chan_1", nicheIds: [] }];
    mocks.store.videos = [video({ id: "vid_1", viewCount: BigInt(9_000_000) })];

    const summary = await evaluateHitsForOrganization(ORG_ID, { nowMs: LONG_AFTER });

    expect(summary.unscoreable).toBe(1);
    expect(stored("vid_1")?.thresholdApplied).toBeNull();
  });
});

describe("which niche judges a Short", () => {
  it("takes the lowest threshold, exactly as payroll credits it", async () => {
    mocks.store.niches = [GTA, TLOU];
    mocks.store.tracked = [{ channelId: "chan_1", nicheIds: [GTA.id, TLOU.id] }];
    mocks.store.videos = [
      video({
        id: "vid_1",
        viewCount: BigInt(600_000),
        snapshots: [{ viewCount: BigInt(600_000), videoAgeHours: 24 }],
      }),
    ];

    await evaluateHitsForOrganization(ORG_ID, { nowMs: LONG_AFTER });

    // 600,000 views clears The Last of Us and not GTA. Judging it by the higher
    // bar because the channel happens to also be filed under GTA would lose a
    // genuine hit, which is the same reasoning `attributeShort` has always used.
    const row = stored("vid_1");
    expect(row?.nicheId).toBe(TLOU.id);
    expect(row?.thresholdApplied).toBe(500_000);
    // And the tighter clock comes with it: the 48-hour window, not GTA's week.
    expect(row?.windowHoursApplied).toBe(48);
    expect(row?.outcome).toBe("hit");
  });

  it("returns no rule when a channel's niches are all half-written", () => {
    expect(resolveChannelRule(["niche_a"], new Map())).toBeNull();
  });
});

describe("idempotence, and what must never be recomputed", () => {
  beforeEach(() => {
    mocks.store.videos = [
      video({
        id: "vid_hit",
        viewCount: BigInt(9_000_000),
        snapshots: [{ viewCount: BigInt(1_050_000), videoAgeHours: 2 }],
      }),
      video({ id: "vid_miss", viewCount: BigInt(40_000) }),
    ];
  });

  it("writes nothing on a second run", async () => {
    await evaluateHitsForOrganization(ORG_ID, { nowMs: LONG_AFTER });
    mocks.upsert.mockClear();

    const second = await evaluateHitsForOrganization(ORG_ID, { nowMs: LONG_AFTER });

    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.frozen).toBe(2);
    // The verdicts still report, because a run that changes nothing still has
    // to be able to say what the library looks like.
    expect(second.byOutcome.hit).toBe(1);
  });

  it("keeps a confident miss a miss after the Short later crosses the bar", async () => {
    await evaluateHitsForOrganization(ORG_ID, { nowMs: LONG_AFTER });
    expect(stored("vid_miss")?.outcome).toBe("miss");

    // A year later it has crept past a million. The window shut long ago, so
    // the miss was and remains correct — but re-deriving it from today's total
    // would produce "unknown" and quietly turn a certain verdict into a shrug.
    mocks.store.videos = [video({ id: "vid_miss", viewCount: BigInt(4_000_000) })];
    await evaluateHitsForOrganization(ORG_ID, { nowMs: LONG_AFTER + 8_760 * HOUR_MS });

    expect(stored("vid_miss")?.outcome).toBe("miss");
  });

  it("settles a pending Short once its window shuts", async () => {
    mocks.store.videos = [
      video({
        id: "vid_open",
        publishedAt: new Date(LONG_AFTER - HOUR_MS),
        viewCount: BigInt(2_000_000),
        snapshots: [{ viewCount: BigInt(2_000_000), videoAgeHours: 1 }],
      }),
    ];

    await evaluateHitsForOrganization(ORG_ID, { nowMs: LONG_AFTER });
    expect(stored("vid_open")?.outcome).toBe("pending");

    // Seven days on, the same evidence now decides it. "pending" is the one
    // verdict that exists to be replaced.
    await evaluateHitsForOrganization(ORG_ID, { nowMs: LONG_AFTER + 200 * HOUR_MS });
    expect(stored("vid_open")?.outcome).toBe("hit");
    expect(stored("vid_open")?.observedAtHours).toBe(1);
  });

  it("re-decides everything when the rule itself changes", async () => {
    await evaluateHitsForOrganization(ORG_ID, { nowMs: LONG_AFTER });
    expect(stored("vid_miss")?.outcome).toBe("miss");

    // An admin drops the bar under what this Short actually did. The stored
    // verdict answers a question nobody is asking any more, so a changed rule
    // is the one thing that thaws a settled verdict.
    mocks.store.niches = [{ id: GTA.id, hitThreshold: 20_000, hitWindowHours: 168 }];
    mocks.store.videos = [
      video({
        id: "vid_miss",
        viewCount: BigInt(40_000),
        snapshots: [{ viewCount: BigInt(30_000), videoAgeHours: 10 }],
      }),
    ];

    const summary = await evaluateHitsForOrganization(ORG_ID, { nowMs: LONG_AFTER });

    expect(summary.updated).toBe(1);
    expect(stored("vid_miss")?.outcome).toBe("hit");
    expect(stored("vid_miss")?.thresholdApplied).toBe(20_000);
  });
});

describe("scope", () => {
  it("never reads another organization's verdict for the same video", async () => {
    // `Video` is a globally deduplicated row: two teams can track the same
    // channel and judge it by completely different rules. Reading the wrong
    // team's evaluation would apply somebody else's bar.
    mocks.store.videos = [video({ id: "vid_1", viewCount: BigInt(40_000) })];
    mocks.store.evaluations.set(mocks.key(OTHER_ORG, "vid_1"), {
      organizationId: OTHER_ORG,
      videoId: "vid_1",
      outcome: "hit",
      nicheId: "their_niche",
      thresholdApplied: 10,
      windowHoursApplied: 168,
      viewsAtWindow: BigInt(40_000),
      observedAtHours: 5,
      windowClosesAt: new Date(at(168)),
      evaluatedAt: new Date(),
    });

    const summary = await evaluateHitsForOrganization(ORG_ID, { nowMs: LONG_AFTER });

    expect(summary.created).toBe(1);
    expect(stored("vid_1")?.outcome).toBe("miss");
    // Theirs is untouched, which is the other half of the same guarantee.
    expect(mocks.store.evaluations.get(mocks.key(OTHER_ORG, "vid_1"))?.outcome).toBe("hit");
  });
});

describe("decideWrite", () => {
  const settled = {
    outcome: "miss" as const,
    nicheId: "niche_gta",
    thresholdApplied: 1_000_000,
    windowHoursApplied: 168,
    viewsAtWindow: null,
    observedAtHours: null,
    windowClosesAt: new Date(at(168)),
  };

  it("creates when there is nothing stored", () => {
    expect(decideWrite(null, settled)).toBe("create");
  });

  it("freezes a settled verdict under an unchanged rule", () => {
    expect(decideWrite(settled, { ...settled, outcome: "unknown" })).toBe("frozen");
  });

  it("leaves an unchanged pending verdict alone without freezing it", () => {
    const pending = { ...settled, outcome: "pending" as const };
    expect(decideWrite(pending, pending)).toBe("unchanged");
  });

  it("updates a pending verdict that moved", () => {
    const pending = { ...settled, outcome: "pending" as const };
    expect(decideWrite(pending, { ...pending, outcome: "hit" })).toBe("update");
  });

  it("updates whenever the rule moved, settled or not", () => {
    expect(decideWrite(settled, { ...settled, thresholdApplied: 500_000 })).toBe("update");
    expect(decideWrite(settled, { ...settled, windowHoursApplied: 48 })).toBe("update");
  });
});
