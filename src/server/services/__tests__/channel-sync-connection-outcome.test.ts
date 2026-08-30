import { beforeEach, describe, expect, it, vi } from "vitest";
import { SNAPSHOT_GRID_MS } from "@/lib/sync/snapshot-cadence";

/**
 * =========================================================================
 * WHAT A SYNC IS OBLIGED TO WRITE BACK ONTO THE CONNECTION IT SPENT
 * =========================================================================
 *
 * "Last sync" on Admin → YouTube used to be written in exactly ONE place: a
 * successful revenue report. Nothing on the channel/video path touched the
 * connection row at all. Two consequences, and both are failures of the sentence
 * that field exists to say:
 *
 *   • A connection without the monetary Analytics scope fails revenue on every
 *     run, so its `lastSyncAt` stayed null forever. The owner read "Never
 *     synced" about a connection whose channel had been syncing correctly every
 *     hour since it was made.
 *
 *   • A sync that failed for a reason that is NOT the grant — the channel was
 *     deleted, the quota is spent, a 403 that is not a dead token — wrote
 *     nothing anywhere the connection card could see. On screen it was
 *     indistinguishable from a healthy connection.
 *
 * The third thing pinned here is the snapshot write, because it is the same
 * kind of defect one table over: duplicate suppression was an in-memory check
 * that two concurrent syncs both pass. It is now an upsert onto a shared time
 * grid, so the second writer collides with the first instead of inserting
 * beside it.
 *
 * Prisma and the YouTube client are stubs. What is under test is which rows the
 * sync writes and what it puts in them.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 11).toString("base64");

const CHANNEL_ROW_ID = "chan_row_1";
const CONNECTION_ID = "conn_1";

const mocks = vi.hoisted(() => ({
  connectionUpdate: vi.fn(
    async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: args.where.id,
    }),
  ),
  snapshotUpsert: vi.fn((args: unknown) => args),
  videoUpsert: vi.fn((args: unknown) => args),
  transaction: vi.fn(async (operations: unknown[]) => operations),
  channelUpdate: vi.fn(async () => ({ id: CHANNEL_ROW_ID })),
  /** Set per test: what the first Data API call does. */
  getChannelsByIds: vi.fn(),
}));

const channelRow = {
  id: CHANNEL_ROW_ID,
  youtubeChannelId: "UC_ours",
  uploadsPlaylistId: "UU_ours",
};

const freshChannel = {
  channelId: "UC_ours",
  title: "Northstar Shorts",
  description: "",
  handle: "@northstar",
  customUrl: null,
  avatarUrl: null,
  bannerUrl: null,
  country: null,
  subscriberCount: 1_000,
  hiddenSubscriberCount: false,
  viewCount: 10_000,
  videoCount: 12,
  uploadsPlaylistId: "UU_ours",
  publishedAt: new Date("2024-01-01T00:00:00.000Z"),
};

const video = {
  videoId: "vid_1",
  channelId: "UC_ours",
  title: "A Short",
  description: "",
  publishedAt: new Date("2026-08-20T00:00:00.000Z"),
  durationIso: "PT30S",
  durationSeconds: 30,
  thumbnailUrl: null,
  viewCount: 5_000,
  likeCount: 100,
  commentCount: 4,
  playerWidth: 405,
  playerHeight: 720,
  liveBroadcastContent: null,
};

vi.mock("@/server/db", () => ({
  prisma: {
    channel: {
      findUnique: vi.fn(async () => channelRow),
      upsert: vi.fn(async () => channelRow),
      update: mocks.channelUpdate,
    },
    channelRefreshRun: {
      create: vi.fn(async () => ({ id: "run_1" })),
      update: vi.fn(async () => ({ id: "run_1" })),
    },
    video: {
      // Called twice: once for cached classifications, once for the previous
      // snapshot state, once for the persisted rows. All three want an empty or
      // minimal answer; the third has to name the row so a snapshot can be
      // written for it.
      findMany: vi.fn(async ({ select }: { select: Record<string, unknown> }) =>
        "publishedAt" in select
          ? [
              {
                id: "video_row_1",
                youtubeVideoId: "vid_1",
                publishedAt: video.publishedAt,
                isShort: true,
              },
            ]
          : [],
      ),
      upsert: mocks.videoUpsert,
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    videoSnapshot: { upsert: mocks.snapshotUpsert },
    youTubeConnection: { update: mocks.connectionUpdate },
    $transaction: mocks.transaction,
  },
}));

class FakeLedger {
  total = 0;
  add(): void {}
}

vi.mock("../youtube", () => ({
  QuotaLedger: FakeLedger,
  MIN_SHORT_CONFIDENCE: 0.8,
  classifyVideos: vi.fn(async () => new Map()),
  youtubeClient: {
    getChannelsByIds: (...args: unknown[]) => mocks.getChannelsByIds(...args),
    listUploads: vi.fn(async () => ({
      entries: [{ videoId: "vid_1", publishedAt: video.publishedAt }],
      reachedEnd: true,
    })),
    getVideos: vi.fn(async () => [video]),
  },
}));

type SyncModule = typeof import("../channel-sync");
let sync: SyncModule;

/** The credential shape a channel covered by a connection is synced with. */
const throughConnection = {
  source: "connection" as const,
  label: "Northstar Shorts",
  credential: { accessToken: "ya29.live", connectionId: CONNECTION_ID },
};

beforeEach(async () => {
  sync ??= await import("../channel-sync");
  vi.clearAllMocks();
  mocks.connectionUpdate.mockResolvedValue({ id: CONNECTION_ID });
  mocks.channelUpdate.mockResolvedValue({ id: CHANNEL_ROW_ID });
  mocks.transaction.mockImplementation(async (operations: unknown[]) => operations);
  mocks.getChannelsByIds.mockResolvedValue([freshChannel]);
});

/** The `data` of the single write this run made to the connection row. */
function connectionWrite(): Record<string, unknown> {
  expect(mocks.connectionUpdate).toHaveBeenCalledTimes(1);
  const [call] = mocks.connectionUpdate.mock.calls[0];
  expect(call.where.id).toBe(CONNECTION_ID);
  return call.data;
}

describe("a sync through a connection records its outcome on that connection", () => {
  it("marks a successful run as the connection's last successful sync", async () => {
    const result = await sync.syncChannel(CHANNEL_ROW_ID, { credential: throughConnection });

    expect(result.status).toBe("success");

    const data = connectionWrite();
    expect(data.channelSyncStatus).toBe("ok");
    expect(data.channelSyncError).toBeNull();
    expect(data.lastChannelSyncAt).toBeInstanceOf(Date);
    /*
     * The repair, precisely: `lastSyncAt` is the column Admin → YouTube renders
     * as "Last successful sync", and until now only a revenue report wrote it.
     * A completed channel sync proves the stored grant works just as well.
     */
    expect(data.lastSyncAt).toBeInstanceOf(Date);
  });

  it("records a failure that is NOT an authorisation failure, without touching the grant", async () => {
    mocks.getChannelsByIds.mockResolvedValue([]);

    const result = await sync.syncChannel(CHANNEL_ROW_ID, { credential: throughConnection });

    expect(result.status).toBe("error");

    const data = connectionWrite();
    expect(data.channelSyncStatus).toBe("error");
    expect(String(data.channelSyncError)).toMatch(/no longer returns this channel/i);

    /*
     * `status` and `lastError` belong to the TOKEN lifecycle. The grant here is
     * perfectly good — a channel was deleted — and writing "needs_reauth" would
     * send an admin through Google's consent screen to fix something consent
     * cannot fix.
     */
    expect(data.status).toBeUndefined();
    expect(data.lastError).toBeUndefined();
    // And "last successful" is not moved by a failure: overwriting it would
    // erase the only evidence of how long this has been broken.
    expect(data.lastSyncAt).toBeUndefined();
    expect(data.lastChannelSyncAt).toBeUndefined();
  });

  it("says nothing about any connection when the shared key did the reading", async () => {
    // A competitor, or an own channel nobody has connected. This is the path
    // that must not have changed at all.
    const result = await sync.syncChannel(CHANNEL_ROW_ID, { credential: { source: "public" } });

    expect(result.status).toBe("success");
    expect(result.dataSource).toBe("public");
    expect(mocks.connectionUpdate).not.toHaveBeenCalled();
  });

  it("records nothing for a refusal, whose reason is already on the connection", async () => {
    const result = await sync.syncChannel(CHANNEL_ROW_ID, {
      credential: {
        source: "connection_unavailable",
        connectionId: CONNECTION_ID,
        label: "Northstar Shorts",
        reason: "The Google account behind Northstar Shorts needs to be reconnected.",
      },
    });

    expect(result.status).toBe("error");
    expect(result.dataSource).toBe("connection_unavailable");
    // The token lifecycle wrote that sentence; re-stamping the row with a
    // derived copy would overwrite Google's own words with ours.
    expect(mocks.connectionUpdate).not.toHaveBeenCalled();
  });
});

describe("snapshots are idempotent by construction, not by timing", () => {
  it("upserts onto the shared time grid so a concurrent run collides instead of inserting", async () => {
    await sync.syncChannel(CHANNEL_ROW_ID, { credential: { source: "public" } });

    expect(mocks.snapshotUpsert).toHaveBeenCalledTimes(1);
    const call = mocks.snapshotUpsert.mock.calls[0][0] as {
      where: { videoId_capturedAt: { videoId: string; capturedAt: Date } };
      create: { capturedAt: Date };
      update: Record<string, unknown>;
    };

    // The unique the database enforces, named explicitly.
    expect(call.where.videoId_capturedAt.videoId).toBe("video_row_1");
    // An empty update: the FIRST reading of a bucket wins, because it is the one
    // whose figure was actually fetched then. A second writer must not overwrite
    // it, and must not raise either.
    expect(call.update).toEqual({});

    const capturedAt = call.create.capturedAt.getTime();
    expect(capturedAt).toBe(call.where.videoId_capturedAt.capturedAt.getTime());
    // On the grid, which is what makes two runs seconds apart produce the same
    // key rather than two rows a few milliseconds apart.
    expect(capturedAt % SNAPSHOT_GRID_MS).toBe(0);
    expect(Date.now() - capturedAt).toBeLessThan(SNAPSHOT_GRID_MS);
  });
});

/**
 * The write itself, in isolation. `channelSyncOutcomeData` is separated from the
 * database call precisely so this can be asserted without one — and so the
 * success and failure shapes cannot drift apart while both callers keep
 * compiling.
 */
describe("channelSyncOutcomeData", () => {
  it("truncates an upstream message rather than trusting its length", async () => {
    const { channelSyncOutcomeData } = await import("../youtube-connection-health");
    const at = new Date();

    const data = channelSyncOutcomeData({ ok: false, error: "x".repeat(900), at });

    // A message from YouTube is not a field this app controls the size of, and
    // the column is 500 — the same rule `lastError` follows.
    expect(String(data.channelSyncError)).toHaveLength(500);
  });

  it("clears a stale failure the moment a run succeeds", async () => {
    const { channelSyncOutcomeData } = await import("../youtube-connection-health");
    const at = new Date();

    const data = channelSyncOutcomeData({ ok: true, at });

    expect(data.channelSyncStatus).toBe("ok");
    // Left standing, the previous failure's sentence would still be on the
    // admin card underneath a connection that is now working.
    expect(data.channelSyncError).toBeNull();
  });
});
