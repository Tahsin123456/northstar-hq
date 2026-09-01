import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * =========================================================================
 * WHICH SIDE OF THE OPERATION A DATASET DESCRIBES
 * =========================================================================
 *
 * `buildDataset({format})` narrows two things and leaves a third alone:
 *
 *   • the TRACKED CHANNELS narrow to "filed under a niche of this format, or
 *     filed under nothing at all" — so an unfiled channel appears in BOTH
 *     payloads, and a channel filed under both formats appears in both, which
 *     is pinned here as the shape of the query fragment;
 *   • the NICHE LIST narrows to the format's own list;
 *   • the VIDEO rows per channel keep shipping unfiltered — the client does
 *     its own format filtering — while `excludedCount` becomes
 *     format-relative: for shorts it is the very expression it always was
 *     (`!isShort`), for longform it is Shorts plus uncertain.
 *
 * THE COMPOSITION IS THE SECURITY-CRITICAL PART. The niche-scope filter and
 * the format filter can both speak about the `niches` relation, and a naive
 * `{...a, ...b}` spread would silently drop whichever came first — for a
 * niche-scoped editor that deletes their entitlement narrowing, not a label.
 * The tests pin that both fragments arrive intact under `AND`.
 *
 * Prisma is a stub that records the query; `trackedChannelNicheFilter`,
 * `nicheFormatWhere`, and `isVideoOfFormat` are the real ones. The mappers
 * are identity stubs so the fixture can stay small — what is under test is
 * the narrowing, not the DTO shapes, which have their own tests.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");

const ORG_ID = "org_northstar";

const mocks = vi.hoisted(() => ({
  trackedFindMany: vi.fn(),
  trackedFindFirst: vi.fn(),
  videoFindMany: vi.fn(),
  snapshotCount: vi.fn(),
  snapshotFindFirst: vi.fn(),
  visibleNiches: null as unknown,
  listNiches: vi.fn(),
}));

vi.mock("@/server/db", () => ({
  prisma: {
    trackedChannel: {
      findMany: mocks.trackedFindMany,
      findFirst: mocks.trackedFindFirst,
    },
    video: { findMany: mocks.videoFindMany },
    videoSnapshot: {
      count: mocks.snapshotCount,
      findFirst: mocks.snapshotFindFirst,
    },
  },
}));

vi.mock("../user-service", () => ({
  getCurrentOrgId: async () => ORG_ID,
  getCurrentOrgSettings: async () => ({
    baseCurrency: "USD",
    defaultPeriodDays: 30,
    lookbackDays: 90,
  }),
}));

// The visible-niche RESOLUTION is stubbed (it reads the session); the FILTER
// it feeds stays real, because the filter's composition with the format
// fragment is the thing under test.
vi.mock("@/server/auth/niche-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/niche-scope")>();
  return {
    ...actual,
    getVisibleNicheIds: async () => mocks.visibleNiches,
  };
});

// `listNiches` reads the session for pay disclosure; what matters here is the
// formats argument it receives, so it is a recorder.
vi.mock("../niche-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../niche-service")>();
  return { ...actual, listNiches: mocks.listNiches };
});

vi.mock("../content-type-service", () => ({
  listContentTypes: async () => [],
}));
vi.mock("../research-service", () => ({
  getNoteCounts: async () => ({}),
  listCollections: async () => [],
  listSavedShorts: async () => [],
}));
vi.mock("../youtube-oauth-service", () => ({
  channelDataSources: async () => new Map(),
}));
// Identity mappers: the narrowing under test happens before and after them,
// and their own contracts are pinned in the mapper tests.
vi.mock("@/server/mappers", () => ({
  toChannelDTO: (channel: { id: string }) => ({
    id: channel.id,
    lastFetchedAt: null,
  }),
  toVideoDTO: (video: unknown) => video,
  toExcludedVideoDTO: (video: unknown) => video,
}));

const { buildDataset, getExcludedVideos } = await import("../dataset-service");
const { nicheFormatWhere } = await import("../niche-service");

/** A stored video row, already DTO-shaped thanks to the identity mapper. */
function video(kind: "short" | "longform" | "uncertain") {
  return {
    isShort: kind === "short",
    classification:
      kind === "short" ? "short" : kind === "longform" ? "not_short" : "uncertain",
    publishedAt: Date.UTC(2026, 7, 1),
  };
}

function trackedRow(id: string, videos: unknown[]) {
  return { channel: { id, youtubeChannelId: `yt_${id}`, videos } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.visibleNiches = null;
  mocks.trackedFindMany.mockResolvedValue([]);
  mocks.listNiches.mockResolvedValue([]);
  mocks.snapshotCount.mockResolvedValue(0);
  mocks.snapshotFindFirst.mockResolvedValue(null);
  mocks.videoFindMany.mockResolvedValue([]);
  mocks.trackedFindFirst.mockResolvedValue({ id: "row_1" });
});

describe("the tracked-channel narrowing", () => {
  it("asks for this format's channels PLUS unfiled ones, composed under AND", async () => {
    await buildDataset({ format: "longform" });

    const where = mocks.trackedFindMany.mock.calls[0][0].where;
    expect(where.organizationId).toBe(ORG_ID);
    expect(where.isActive).toBe(true);
    // Both narrowings, intact, side by side — never spread into one another.
    expect(where.AND).toEqual([
      {}, // trackedChannelNicheFilter(null): no entitlement narrowing
      {
        OR: [
          { niches: { none: {} } },
          { niches: { some: { niche: { format: "longform" } } } },
        ],
      },
    ]);
  });

  it("keeps a niche-scoped member's entitlement narrowing beside the format one", async () => {
    // The regression this composition exists to prevent: both fragments key
    // on `niches`, and a spread would have silently dropped this one.
    mocks.visibleNiches = ["niche_a", "niche_b"];

    await buildDataset({ format: "shorts" });

    const where = mocks.trackedFindMany.mock.calls[0][0].where;
    expect(where.AND[0]).toEqual({
      niches: { some: { nicheId: { in: ["niche_a", "niche_b"] } } },
    });
    expect(where.AND[1]).toEqual({
      OR: [
        { niches: { none: {} } },
        { niches: { some: { niche: { format: { not: "longform" } } } } },
      ],
    });
  });

  it("reads the shorts side as format != longform — the fail-closed direction", () => {
    // A garbage-valued row must show up in the Shorts list (where
    // `toNicheFormat` will also read it as shorts), never vanish from both.
    expect(nicheFormatWhere("shorts")).toEqual({ format: { not: "longform" } });
    expect(nicheFormatWhere("longform")).toEqual({ format: "longform" });
  });
});

describe("the niche list narrowing", () => {
  it("ships only this format's niche list", async () => {
    await buildDataset({ format: "longform" });
    expect(mocks.listNiches).toHaveBeenCalledWith({ formats: ["longform"] });

    await buildDataset({});
    expect(mocks.listNiches).toHaveBeenLastCalledWith({ formats: ["shorts"] });
  });
});

describe("excludedCount is format-relative; the video rows are not filtered", () => {
  const FIXTURE = [
    trackedRow("chan_1", [video("short"), video("short"), video("longform"), video("uncertain")]),
  ];

  it("counts the complement of shorts exactly as it always did", async () => {
    mocks.trackedFindMany.mockResolvedValue(FIXTURE);

    const dataset = await buildDataset({ format: "shorts" });

    // 1 long-form + 1 uncertain — the pre-format `!isShort` answer.
    expect(dataset.channels[0].excludedCount).toBe(2);
    // Every stored row still ships; the client does its own format filtering.
    expect(dataset.channels[0].videos).toHaveLength(4);
  });

  it("counts Shorts plus uncertain as the longform complement", async () => {
    mocks.trackedFindMany.mockResolvedValue(FIXTURE);

    const dataset = await buildDataset({ format: "longform" });

    expect(dataset.channels[0].excludedCount).toBe(3);
    expect(dataset.channels[0].videos).toHaveLength(4);
  });
});

describe("getExcludedVideos' channel reachability", () => {
  /*
   * The access check must refuse the channels the format-narrowed DATASET
   * refuses to ship. For format=longform, "excluded" IS a channel's Shorts
   * catalogue — so a Shorts-only channel reachable here by id would hand a
   * longs role the very rows `/api/dataset?format=shorts` 403s them.
   */
  it("composes the format filter into the tracking lookup, under AND with the niche scope", async () => {
    mocks.visibleNiches = ["niche_a"];

    await getExcludedVideos("chan_1", { format: "longform" });

    const where = mocks.trackedFindFirst.mock.calls[0][0].where;
    expect(where.organizationId).toBe(ORG_ID);
    expect(where.channelId).toBe("chan_1");
    expect(where.AND).toEqual([
      { niches: { some: { nicheId: { in: ["niche_a"] } } } },
      {
        OR: [
          { niches: { none: {} } },
          { niches: { some: { niche: { format: "longform" } } } },
        ],
      },
    ]);
  });

  it("404s a channel outside the requested format's product before reading a row", async () => {
    mocks.trackedFindFirst.mockResolvedValue(null);

    await expect(
      getExcludedVideos("chan_1", { format: "longform" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });

    expect(mocks.videoFindMany).not.toHaveBeenCalled();
  });
});

describe("getExcludedVideos' per-format predicate", () => {
  it("keeps the shorts exclusion exactly as it always was", async () => {
    await getExcludedVideos("chan_1", {});

    const where = mocks.videoFindMany.mock.calls[0][0].where;
    expect(where.isShort).toBe(false);
    expect(where).not.toHaveProperty("classification");
  });

  it("excludes everything not positively long-form for the longform read", async () => {
    await getExcludedVideos("chan_1", { format: "longform" });

    const where = mocks.videoFindMany.mock.calls[0][0].where;
    // Shorts AND uncertain — and an unreadable stored value lands in the
    // excluded list too, the conservative direction.
    expect(where.classification).toEqual({ not: "not_short" });
    expect(where).not.toHaveProperty("isShort");
  });
});
