import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WHAT AN ASSIGNMENT IS STILL ALLOWED TO DO.
 *
 * Content types are flat, org-wide tags: any channel and any Short may carry
 * any of the organization's types. The cross-niche refusal this file used to
 * pin is GONE, deliberately and at the owner's instruction — a test asserting
 * it would now be asserting a bug.
 *
 * What is left is the part that cannot be recovered by hand once broken, and it
 * is a tenancy rule rather than a taxonomy one:
 *   • a tag from another organization is refused, in one message that does not
 *     reveal whether the id exists,
 *   • a Short outside the caller's tracker is a 404,
 *   • and NEITHER refusal reaches the write — this is a replace, so a throw
 *     after the delete would strip a Short's labels to apply a set that was
 *     rejected,
 *   • the channel path reconciles rather than rewriting, so re-saving an
 *     unchanged selection writes nothing and reassigns nobody's attribution.
 *
 * Prisma, the session, the niche scope and the audit writer are all stubs;
 * what is under test is the decision, not the plumbing.
 */

// The module graph reaches auth-env, as the sibling service tests do. Set the
// secret before anything is imported.
process.env.SESSION_SECRET = Buffer.alloc(32, 3).toString("base64");

const ORG_ID = "org_northstar";
const USER_ID = "user_head";

/** Hoisted so the `vi.mock` factories lifted above the imports can close over them. */
const mocks = vi.hoisted(() => ({
  findVideos: vi.fn(),
  findTrackedChannel: vi.fn(),
  findContentTypes: vi.fn(),
  findContentType: vi.fn(),
  findVideoAssignments: vi.fn(),
  deleteVideoAssignments: vi.fn(),
  createVideoAssignments: vi.fn(),
  findChannelAssignments: vi.fn(),
  deleteChannelAssignments: vi.fn(),
  createChannelAssignments: vi.fn(),
  transaction: vi.fn(),
  recordAudit: vi.fn<(context: unknown, payload: unknown) => Promise<void>>(),
}));

vi.mock("@/server/db", () => ({
  prisma: {
    video: { findMany: mocks.findVideos },
    trackedChannel: { findFirst: mocks.findTrackedChannel },
    contentType: { findMany: mocks.findContentTypes, findFirst: mocks.findContentType },
    videoContentType: {
      findMany: mocks.findVideoAssignments,
      deleteMany: mocks.deleteVideoAssignments,
      createMany: mocks.createVideoAssignments,
    },
    channelContentType: {
      findMany: mocks.findChannelAssignments,
      deleteMany: mocks.deleteChannelAssignments,
      createMany: mocks.createChannelAssignments,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("../user-service", () => ({
  getScope: async () => ({
    organizationId: ORG_ID,
    userId: USER_ID,
    actor: { userId: USER_ID, name: "Ada", email: "ada@example.com" },
  }),
  getCurrentOrgId: async () => ORG_ID,
}));

// Not niche-scoped: these paths apply to everyone. Niche SCOPING — who may see
// which channel — is pinned separately in
// `src/server/__tests__/niche-scope.test.ts`, and mixing the two would let a
// failure in either look like a failure in the other.
vi.mock("@/server/auth/niche-scope", () => ({
  getVisibleNicheIds: async () => null,
  trackedChannelNicheFilter: () => ({}),
  nicheFilter: () => ({}),
  nicheIdFilter: () => ({}),
}));

vi.mock("@/server/audit/audit-service", () => ({ recordAudit: mocks.recordAudit }));

const { assignContentTypeToVideos, setChannelContentTypes, setVideoContentTypes } =
  await import("../content-type-service");

/** The projection `loadTaggableVideos` selects, for one Short. */
const VIDEO_ROW = { id: "video_1", title: "Trevor loses it" };

/** The projection `requireVisibleTrackedChannel` selects. */
const CHANNEL_ROW = {
  id: "tracked_1",
  channelId: "channel_1",
  label: null,
  channel: { title: "GTA Moments" },
};

/** The projection `requireOwnContentTypes` selects. */
function contentTypeRow(id: string, name: string) {
  return { id, name };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findVideoAssignments.mockResolvedValue([]);
  mocks.findChannelAssignments.mockResolvedValue([]);
  mocks.transaction.mockResolvedValue([]);
  mocks.recordAudit.mockResolvedValue(undefined);
  // The bulk path resolves its tag through `findFirst`; default to an active
  // one so each test overrides only what it is actually about.
  mocks.findContentType.mockResolvedValue({ id: "ct_ranking", name: "Ranking", isActive: true });
});

describe("setVideoContentTypes", () => {
  /**
   * The whole point of the flat catalogue, stated as a test.
   *
   * There is no channel niche in the fixture at all, and there does not need to
   * be: the Short's channel plays no part in deciding which tags it may carry.
   */
  it("files a Short under any of the organization's tags", async () => {
    mocks.findVideos.mockResolvedValue([VIDEO_ROW]);
    mocks.findContentTypes.mockResolvedValue([
      contentTypeRow("ct_moments", "Character Moments"),
      contentTypeRow("ct_ranking", "Ranking"),
    ]);

    await expect(
      setVideoContentTypes("video_1", ["ct_moments", "ct_ranking"]),
    ).resolves.toBeUndefined();

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.createVideoAssignments).toHaveBeenCalledWith({
      data: [
        {
          organizationId: ORG_ID,
          videoId: "video_1",
          contentTypeId: "ct_moments",
          assignedById: USER_ID,
        },
        {
          organizationId: ORG_ID,
          videoId: "video_1",
          contentTypeId: "ct_ranking",
          assignedById: USER_ID,
        },
      ],
    });
  });

  it("refuses a tag this organization does not own, and writes nothing", async () => {
    mocks.findVideos.mockResolvedValue([VIDEO_ROW]);
    // The id resolved to no row for this organization — deleted, or somebody
    // else's. The query cannot tell the two apart and neither may the message.
    mocks.findContentTypes.mockResolvedValue([]);

    const error = await setVideoContentTypes("video_1", ["ct_theirs"]).catch(
      (caught: unknown) => caught,
    );

    expect((error as { code: string }).code).toBe("INVALID_INPUT");
    // Says "no longer exists" for both cases on purpose: naming the real reason
    // would confirm that an id belongs to somebody.
    expect((error as { userMessage: string }).userMessage).toMatch(/no longer exists/i);

    // Nothing was written. This is a replace, so a throw after the delete would
    // have stripped the Short's existing labels to apply a set that was refused.
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("refuses the whole request when only one of several tags is unknown", async () => {
    mocks.findVideos.mockResolvedValue([VIDEO_ROW]);
    mocks.findContentTypes.mockResolvedValue([contentTypeRow("ct_moments", "Moments")]);

    await expect(
      setVideoContentTypes("video_1", ["ct_moments", "ct_theirs"]),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    // All or nothing. Writing the valid half would report success for a request
    // that was partly a probe of another organization's catalogue.
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("404s a Short outside the caller's tracker before looking at the tags", async () => {
    mocks.findVideos.mockResolvedValue([]);

    await expect(
      setVideoContentTypes("video_elsewhere", ["ct_moments"]),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(mocks.findContentTypes).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("clears a Short's tags without consulting the catalogue at all", async () => {
    mocks.findVideos.mockResolvedValue([VIDEO_ROW]);

    // An empty set is a removal, and there is nothing to validate about it.
    await expect(setVideoContentTypes("video_1", [])).resolves.toBeUndefined();

    expect(mocks.findContentTypes).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });
});

describe("setChannelContentTypes", () => {
  it("adds and removes only what actually changed", async () => {
    mocks.findTrackedChannel.mockResolvedValue(CHANNEL_ROW);
    mocks.findChannelAssignments.mockResolvedValue([
      { contentTypeId: "ct_keep" },
      { contentTypeId: "ct_drop" },
    ]);
    mocks.findContentTypes.mockResolvedValue([
      contentTypeRow("ct_keep", "Rankings"),
      contentTypeRow("ct_add", "Cutscenes"),
    ]);

    await expect(
      setChannelContentTypes("channel_1", ["ct_keep", "ct_add"]),
    ).resolves.toBeUndefined();

    expect(mocks.deleteChannelAssignments).toHaveBeenCalledWith({
      where: { trackedChannelId: "tracked_1", contentTypeId: { in: ["ct_drop"] } },
    });
    expect(mocks.createChannelAssignments).toHaveBeenCalledWith({
      data: [
        { trackedChannelId: "tracked_1", contentTypeId: "ct_add", assignedById: USER_ID },
      ],
    });
  });

  /**
   * The reason the path reconciles instead of rewriting.
   *
   * A delete-all-then-recreate would store the same final set and quietly stamp
   * every surviving row with whoever pressed Save — reassigning a colleague's
   * decision to somebody who only looked at it.
   */
  it("writes nothing when the selection is unchanged", async () => {
    mocks.findTrackedChannel.mockResolvedValue(CHANNEL_ROW);
    mocks.findChannelAssignments.mockResolvedValue([{ contentTypeId: "ct_keep" }]);
    mocks.findContentTypes.mockResolvedValue([contentTypeRow("ct_keep", "Rankings")]);

    await expect(
      setChannelContentTypes("channel_1", ["ct_keep"]),
    ).resolves.toBeUndefined();

    expect(mocks.transaction).not.toHaveBeenCalled();
    // And no audit entry describing work that did not happen.
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("404s a channel this caller cannot reach", async () => {
    mocks.findTrackedChannel.mockResolvedValue(null);

    await expect(
      setChannelContentTypes("channel_elsewhere", ["ct_keep"]),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

/**
 * THE BULK PATH.
 *
 * Untested until now, and it is the one that touches the most rows: a single
 * request may relabel hundreds of Shorts, so every rule it enforces is enforced
 * hundreds of times over and every rule it drops is dropped the same way.
 *
 * Three properties matter here and none of them are visible from the return
 * value alone, which is why the assertions reach for what was WRITTEN:
 *   • it is all-or-nothing across the id list,
 *   • re-running it writes nothing rather than duplicating,
 *   • and "add" leaves other labels alone while "replace" clears them.
 */
describe("assignContentTypeToVideos", () => {
  const ACTIVE_TAG = { id: "ct_ranking", name: "Ranking", isActive: true };

  function threeVideos() {
    return [
      { id: "video_1", title: "Trevor loses it" },
      { id: "video_2", title: "Michael remembers" },
      { id: "video_3", title: "Franklin's ranking" },
    ];
  }

  it("files every selected Short under the tag", async () => {
    mocks.findContentTypes.mockResolvedValue([]);
    mocks.findVideos.mockResolvedValue(threeVideos());

    const result = await assignContentTypeToVideos({
      videoIds: ["video_1", "video_2", "video_3"],
      contentTypeId: ACTIVE_TAG.id,
      mode: "add",
    });

    expect(result.assigned).toBe(3);
    expect(result.alreadyAssigned).toBe(0);
    expect(mocks.createVideoAssignments).toHaveBeenCalledTimes(1);
    // Attribution on every row, so a 400-Short relabelling stays traceable long
    // after the audit entry has scrolled away.
    const written = mocks.createVideoAssignments.mock.calls[0][0].data;
    expect(written).toHaveLength(3);
    for (const row of written) {
      expect(row.organizationId).toBe(ORG_ID);
      expect(row.assignedById).toBe(USER_ID);
    }
  });

  /**
   * The idempotency the bulk control depends on.
   *
   * Filing the same selection twice is a normal gesture — the control is fast
   * and repeatable by design — and the second run must be a no-op rather than a
   * duplicate. `createMany({ skipDuplicates })` is unavailable on SQLite, which
   * this schema's portability contract still requires, so the dedupe is done by
   * reading the existing rows and subtracting. That is the thing under test.
   */
  it("writes nothing on a re-run", async () => {
    mocks.findVideos.mockResolvedValue(threeVideos());
    mocks.findVideoAssignments.mockResolvedValue([
      { videoId: "video_1" },
      { videoId: "video_2" },
      { videoId: "video_3" },
    ]);

    const result = await assignContentTypeToVideos({
      videoIds: ["video_1", "video_2", "video_3"],
      contentTypeId: ACTIVE_TAG.id,
      mode: "add",
    });

    expect(result.assigned).toBe(0);
    expect(result.alreadyAssigned).toBe(3);
    expect(mocks.createVideoAssignments).not.toHaveBeenCalled();
  });

  /**
   * All-or-nothing, and for a specific reason: a bulk request containing one id
   * from another team's tracker is partly a probe. Writing the valid ones and
   * dropping the rest would answer that probe with a success.
   */
  it("refuses the whole request when one Short is out of reach", async () => {
    // Two of the three come back — the third belongs to somebody else.
    mocks.findVideos.mockResolvedValue(threeVideos().slice(0, 2));

    await expect(
      assignContentTypeToVideos({
        videoIds: ["video_1", "video_2", "video_elsewhere"],
        contentTypeId: ACTIVE_TAG.id,
        mode: "add",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.createVideoAssignments).not.toHaveBeenCalled();
  });

  it("refuses a tag from another organization without confirming it exists", async () => {
    mocks.findContentType.mockResolvedValue(null);

    await expect(
      assignContentTypeToVideos({
        videoIds: ["video_1"],
        contentTypeId: "ct_other_org",
        mode: "add",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(mocks.findVideos).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  /**
   * Archiving has to mean something. The replace path accepts an archived tag —
   * it receives a complete desired set and refusing would silently strip a
   * Short's historical label — but bulk filing is unambiguously new work.
   */
  it("refuses to bulk-file under an archived tag", async () => {
    mocks.findContentType.mockResolvedValue({ ...ACTIVE_TAG, isActive: false });

    await expect(
      assignContentTypeToVideos({
        videoIds: ["video_1"],
        contentTypeId: ACTIVE_TAG.id,
        mode: "add",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("leaves other labels alone in add mode, and clears them in replace", async () => {
    mocks.findVideos.mockResolvedValue([threeVideos()[0]]);

    await assignContentTypeToVideos({
      videoIds: ["video_1"],
      contentTypeId: ACTIVE_TAG.id,
      mode: "add",
    });
    expect(mocks.deleteVideoAssignments).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.findVideoAssignments.mockResolvedValue([]);
    mocks.transaction.mockResolvedValue([{ count: 2 }]);
    mocks.findVideos.mockResolvedValue([threeVideos()[0]]);

    await assignContentTypeToVideos({
      videoIds: ["video_1"],
      contentTypeId: ACTIVE_TAG.id,
      mode: "replace",
    });

    expect(mocks.deleteVideoAssignments).toHaveBeenCalledTimes(1);
    const where = mocks.deleteVideoAssignments.mock.calls[0][0].where;
    expect(where.organizationId).toBe(ORG_ID);
    // The tag being applied is excluded from the sweep, so a re-run does not
    // delete and rewrite the row it just made — which would churn `assignedAt`
    // and lose the original attribution.
    expect(where.contentTypeId).toEqual({ not: ACTIVE_TAG.id });
  });
});
