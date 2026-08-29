import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WHAT AN ASSIGNMENT IS ALLOWED TO WRITE.
 *
 * Content types are flat, org-wide tags: any channel and any Short may carry
 * any of the organization's types. The cross-niche refusal this file used to
 * pin is GONE, deliberately and at the owner's instruction — a test asserting
 * it would now be asserting a bug.
 *
 * ==========================================================================
 * AND A SHORT'S TAGS ARE MOSTLY ITS CHANNEL'S
 * ==========================================================================
 *
 *     effective(short) = (channel's tags − exclusions) ∪ manual tags
 *
 * The RULE itself is pinned in `src/lib/__tests__/content-type-inheritance.test.ts`,
 * against the pure function both sides share. What is pinned HERE is the thing
 * that file cannot see: which rows this service actually puts in the table. The
 * two failure modes worth a test are opposite and equally bad —
 *
 *   • writing a row for a tag the channel already gives, which is the stale-copy
 *     problem the whole design exists to avoid, and
 *   • deleting a row where a refusal was needed, which would leave an inherited
 *     tag showing after somebody removed it.
 *
 * On top of that, the tenancy rules that cannot be recovered by hand once broken:
 *   • a tag from another organization is refused, in one message that does not
 *     reveal whether the id exists,
 *   • a Short outside the caller's tracker is a 404,
 *   • NEITHER refusal reaches the write,
 *   • and every path reconciles rather than rewriting, so re-saving an unchanged
 *     selection writes nothing and reassigns nobody's attribution.
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
  updateVideoAssignments: vi.fn(),
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
      updateMany: mocks.updateVideoAssignments,
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

const {
  assignContentTypeToVideos,
  excludeContentTypeFromVideo,
  restoreInheritedContentType,
  setChannelContentTypes,
  setVideoContentTypes,
} = await import("../content-type-service");

/**
 * The projection `loadTaggableVideos` selects, for one Short.
 *
 * THE CHANNEL COMES WITH IT, and that is the interesting part of the shape: no
 * decision this service makes can be reached without knowing what the channel
 * already gives, so the tracking row rides along inside the same query. The
 * nested `trackedBy` array is the organization-filtered relation — one row at
 * most, because the tag hangs off OUR tracking row and not off the globally
 * shared channel.
 */
function videoRow(id: string, title: string, channelTypeIds: readonly string[] = []) {
  return {
    id,
    title,
    channelId: "channel_1",
    channel: {
      trackedBy: [
        { contentTypes: channelTypeIds.map((contentTypeId) => ({ contentTypeId })) },
      ],
    },
  };
}

/** One stored DEVIATION, as the reconciler reads it back. */
function deviation(videoId: string, contentTypeId: string, state: "manual" | "excluded") {
  return { id: `row_${videoId}_${contentTypeId}`, videoId, contentTypeId, state };
}

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

/** Every row `createMany` was asked to write, flattened. */
function written(): Array<Record<string, unknown>> {
  return mocks.createVideoAssignments.mock.calls.flatMap(
    (call) => call[0].data as Array<Record<string, unknown>>,
  );
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
   * The channel here carries no tags at all, so every requested tag is a genuine
   * deviation and every one of them gets a row.
   */
  it("files a Short under any of the organization's tags", async () => {
    mocks.findVideos.mockResolvedValue([videoRow("video_1", "Trevor loses it")]);
    mocks.findContentTypes.mockResolvedValue([
      contentTypeRow("ct_moments", "Character Moments"),
      contentTypeRow("ct_ranking", "Ranking"),
    ]);

    const result = await setVideoContentTypes("video_1", ["ct_moments", "ct_ranking"]);

    expect(result.effectiveContentTypeIds).toEqual(["ct_moments", "ct_ranking"]);
    expect(result.manualContentTypeIds).toEqual(["ct_moments", "ct_ranking"]);
    expect(result.excludedContentTypeIds).toEqual([]);

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(written()).toEqual([
      {
        organizationId: ORG_ID,
        videoId: "video_1",
        contentTypeId: "ct_moments",
        state: "manual",
        assignedById: USER_ID,
      },
      {
        organizationId: ORG_ID,
        videoId: "video_1",
        contentTypeId: "ct_ranking",
        state: "manual",
        assignedById: USER_ID,
      },
    ]);
  });

  /**
   * THE ROW THAT MUST NEVER BE WRITTEN.
   *
   * The channel already says this Short is a Ranking, and the caller has asked
   * for exactly that. Storing a row here would be a per-Short copy of the
   * channel's decision — the thing that goes stale the moment the channel
   * changes its mind, and that would leave 400 orphans behind on a channel with
   * 400 Shorts.
   */
  it("stores NOTHING for a tag the Short already inherits", async () => {
    mocks.findVideos.mockResolvedValue([
      videoRow("video_1", "Trevor loses it", ["ct_ranking"]),
    ]);
    mocks.findContentTypes.mockResolvedValue([contentTypeRow("ct_ranking", "Ranking")]);

    const result = await setVideoContentTypes("video_1", ["ct_ranking"]);

    // It carries the tag — from the channel, with no row anywhere.
    expect(result.effectiveContentTypeIds).toEqual(["ct_ranking"]);
    expect(result.manualContentTypeIds).toEqual([]);
    expect(result.excludedContentTypeIds).toEqual([]);

    expect(mocks.transaction).not.toHaveBeenCalled();
    // And no audit entry describing work that did not happen.
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  /**
   * The opposite mistake, and the reason `[]` could not stay a plain delete.
   *
   * On a Short whose channel is tagged, "carry nothing" is a set of REFUSALS.
   * Deleting rows would have left both inherited chips on screen immediately
   * after somebody cleared the field.
   */
  it("turns clearing a Short on a tagged channel into refusals, not deletions", async () => {
    mocks.findVideos.mockResolvedValue([
      videoRow("video_1", "Trevor loses it", ["ct_ranking", "ct_funny"]),
    ]);

    const result = await setVideoContentTypes("video_1", []);

    expect(result.effectiveContentTypeIds).toEqual([]);
    expect(result.excludedContentTypeIds).toEqual(["ct_funny", "ct_ranking"]);

    expect(written()).toEqual([
      expect.objectContaining({ contentTypeId: "ct_funny", state: "excluded" }),
      expect.objectContaining({ contentTypeId: "ct_ranking", state: "excluded" }),
    ]);
    // An empty set is a removal, and there is nothing about it to validate
    // against the catalogue.
    expect(mocks.findContentTypes).not.toHaveBeenCalled();
  });

  /**
   * Reconciled, not rewritten — the attribution rule.
   *
   * A delete-everything-then-recreate would store the same final state and stamp
   * `assignedById` on the survivor with whoever pressed Save, quietly reassigning
   * a colleague's decision to somebody who only looked at it.
   */
  it("leaves an unchanged deviation completely alone", async () => {
    mocks.findVideos.mockResolvedValue([videoRow("video_1", "Trevor loses it")]);
    mocks.findContentTypes.mockResolvedValue([contentTypeRow("ct_moments", "Moments")]);
    mocks.findVideoAssignments.mockResolvedValue([
      deviation("video_1", "ct_moments", "manual"),
    ]);

    await setVideoContentTypes("video_1", ["ct_moments"]);

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.updateVideoAssignments).not.toHaveBeenCalled();
    expect(mocks.deleteVideoAssignments).not.toHaveBeenCalled();
  });

  it("refuses a tag this organization does not own, and writes nothing", async () => {
    mocks.findVideos.mockResolvedValue([videoRow("video_1", "Trevor loses it")]);
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

    // Nothing was written. This path can now create refusals as well as remove
    // rows, so a throw partway through would leave a Short refusing tags to
    // satisfy a set that was rejected.
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("refuses the whole request when only one of several tags is unknown", async () => {
    mocks.findVideos.mockResolvedValue([videoRow("video_1", "Trevor loses it")]);
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
});

/**
 * THE SINGLE-TAG OVERRIDE.
 *
 * Two cases that store opposite things, which is the whole reason this is a
 * service function and not a client that sends a shorter list: only the server
 * knows whether the tag being removed comes from the channel, and therefore
 * whether removing it means writing a refusal or deleting a row.
 */
describe("excludeContentTypeFromVideo", () => {
  it("writes a TOMBSTONE when the channel provides the tag", async () => {
    mocks.findVideos.mockResolvedValue([
      videoRow("video_1", "Trevor loses it", ["ct_ranking", "ct_funny"]),
    ]);
    mocks.findContentTypes.mockResolvedValue([contentTypeRow("ct_ranking", "Ranking")]);

    const result = await excludeContentTypeFromVideo("video_1", "ct_ranking");

    // The other inherited tag is untouched — this request named one tag and may
    // only affect one tag.
    expect(result.effectiveContentTypeIds).toEqual(["ct_funny"]);
    expect(result.excludedContentTypeIds).toEqual(["ct_ranking"]);

    expect(written()).toEqual([
      expect.objectContaining({
        videoId: "video_1",
        contentTypeId: "ct_ranking",
        state: "excluded",
        assignedById: USER_ID,
      }),
    ]);
  });

  /**
   * The other case, and it deliberately leaves NO row behind.
   *
   * The person is taking back their own earlier "yes", not refusing the channel.
   * No row means "agrees with the channel", which is exactly true again — and a
   * tombstone here would assert something nobody said: that if this channel ever
   * picks the tag up, this Short is to be exempt.
   */
  it("deletes the manual row instead when the channel does not provide the tag", async () => {
    mocks.findVideos.mockResolvedValue([videoRow("video_1", "Trevor loses it")]);
    mocks.findContentTypes.mockResolvedValue([contentTypeRow("ct_moments", "Moments")]);
    mocks.findVideoAssignments.mockResolvedValue([
      deviation("video_1", "ct_moments", "manual"),
    ]);

    const result = await excludeContentTypeFromVideo("video_1", "ct_moments");

    expect(result.effectiveContentTypeIds).toEqual([]);
    expect(result.excludedContentTypeIds).toEqual([]);

    expect(mocks.deleteVideoAssignments).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, id: { in: ["row_video_1_ct_moments"] } },
    });
    expect(mocks.createVideoAssignments).not.toHaveBeenCalled();
  });

  /**
   * The one case that RE-STATES a row instead of writing or removing one.
   *
   * This Short was tagged "Ranking" by hand before its channel was; the manual
   * row is kept alive through the channel picking the tag up, so that dropping
   * it later does not silently take the Short's own classification with it.
   * Refusing the tag now has to turn that row into a tombstone rather than
   * delete it — deleting would leave the channel's tag flowing straight back
   * through, which is the opposite of what was asked.
   *
   * Attribution IS re-stamped here, unlike everywhere else in this file, and
   * deliberately: flipping "manual" to "excluded" is not an edit of the old
   * judgement, it is the opposite judgement, and whoever made it is its author.
   */
  it("turns a redundant manual row into a tombstone rather than deleting it", async () => {
    mocks.findVideos.mockResolvedValue([
      videoRow("video_1", "Trevor loses it", ["ct_ranking"]),
    ]);
    mocks.findContentTypes.mockResolvedValue([contentTypeRow("ct_ranking", "Ranking")]);
    mocks.findVideoAssignments.mockResolvedValue([
      deviation("video_1", "ct_ranking", "manual"),
    ]);

    const result = await excludeContentTypeFromVideo("video_1", "ct_ranking");

    expect(result.effectiveContentTypeIds).toEqual([]);
    expect(result.excludedContentTypeIds).toEqual(["ct_ranking"]);

    expect(mocks.updateVideoAssignments).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, id: { in: ["row_video_1_ct_ranking"] } },
      data: expect.objectContaining({ state: "excluded", assignedById: USER_ID }),
    });
    expect(mocks.deleteVideoAssignments).not.toHaveBeenCalled();
    expect(mocks.createVideoAssignments).not.toHaveBeenCalled();
  });

  it("is a no-op when the Short already refuses the tag", async () => {
    mocks.findVideos.mockResolvedValue([
      videoRow("video_1", "Trevor loses it", ["ct_ranking"]),
    ]);
    mocks.findContentTypes.mockResolvedValue([contentTypeRow("ct_ranking", "Ranking")]);
    mocks.findVideoAssignments.mockResolvedValue([
      deviation("video_1", "ct_ranking", "excluded"),
    ]);

    await excludeContentTypeFromVideo("video_1", "ct_ranking");

    // Idempotency matters on a control people double-click, and a second audit
    // entry would claim a refusal happened twice.
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });
});

describe("restoreInheritedContentType", () => {
  it("deletes the tombstone so the channel's tag flows through again", async () => {
    mocks.findVideos.mockResolvedValue([
      videoRow("video_1", "Trevor loses it", ["ct_ranking"]),
    ]);
    mocks.findContentTypes.mockResolvedValue([contentTypeRow("ct_ranking", "Ranking")]);
    mocks.findVideoAssignments.mockResolvedValue([
      deviation("video_1", "ct_ranking", "excluded"),
    ]);

    const result = await restoreInheritedContentType("video_1", "ct_ranking");

    expect(result.effectiveContentTypeIds).toEqual(["ct_ranking"]);
    expect(result.excludedContentTypeIds).toEqual([]);
    expect(mocks.deleteVideoAssignments).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, id: { in: ["row_video_1_ct_ranking"] } },
    });
  });

  it("is a no-op when there is no refusal to undo", async () => {
    mocks.findVideos.mockResolvedValue([
      videoRow("video_1", "Trevor loses it", ["ct_ranking"]),
    ]);
    mocks.findContentTypes.mockResolvedValue([contentTypeRow("ct_ranking", "Ranking")]);

    await restoreInheritedContentType("video_1", "ct_ranking");

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
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

    /*
     * NOTHING IS WRITTEN TO THE VIDEO TABLE, and that is the property worth
     * pinning here. Dropping "ct_drop" from the channel removes it from every
     * Short beneath it, and adding "ct_add" gives it to every one of them —
     * including Shorts imported after this edit. A design that copied tags down
     * would have had to touch every video row on both counts, and would have
     * left the ones it missed asserting something the channel no longer says.
     */
    expect(mocks.createVideoAssignments).not.toHaveBeenCalled();
    expect(mocks.deleteVideoAssignments).not.toHaveBeenCalled();
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
 * The one that touches the most rows: a single request may relabel hundreds of
 * Shorts, so every rule it enforces is enforced hundreds of times over and every
 * rule it drops is dropped the same way.
 *
 * The properties that matter are not visible from the return value alone, which
 * is why the assertions reach for what was WRITTEN:
 *   • it is all-or-nothing across the id list,
 *   • re-running it writes nothing rather than duplicating,
 *   • a tag the channel already gives is a no-op and NOT a new manual row,
 *   • an existing refusal is lifted and reported, because that overrides a
 *     decision somebody made,
 *   • and "add" leaves other labels alone while "replace" clears them — through
 *     refusals, where the other labels came from the channel.
 */
describe("assignContentTypeToVideos", () => {
  const ACTIVE_TAG = { id: "ct_ranking", name: "Ranking", isActive: true };

  function threeVideos(channelTypeIds: readonly string[] = []) {
    return [
      videoRow("video_1", "Trevor loses it", channelTypeIds),
      videoRow("video_2", "Michael remembers", channelTypeIds),
      videoRow("video_3", "Franklin's ranking", channelTypeIds),
    ];
  }

  const bulk = (mode: "add" | "replace", videoIds: string[] = ["video_1", "video_2", "video_3"]) =>
    assignContentTypeToVideos({ videoIds, contentTypeId: ACTIVE_TAG.id, mode });

  it("files every selected Short under the tag", async () => {
    mocks.findVideos.mockResolvedValue(threeVideos());

    const result = await bulk("add");

    expect(result.assigned).toBe(3);
    expect(result.alreadyAssigned).toBe(0);
    expect(result.restored).toBe(0);

    // Attribution on every row, so a 400-Short relabelling stays traceable long
    // after the audit entry has scrolled away.
    const rows = written();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.organizationId).toBe(ORG_ID);
      expect(row.assignedById).toBe(USER_ID);
      expect(row.state).toBe("manual");
    }
  });

  /**
   * The idempotency the bulk control depends on.
   *
   * Filing the same selection twice is a normal gesture — the control is fast
   * and repeatable by design — and the second run must be a no-op rather than a
   * duplicate.
   */
  it("writes nothing on a re-run", async () => {
    mocks.findVideos.mockResolvedValue(threeVideos());
    mocks.findVideoAssignments.mockResolvedValue([
      deviation("video_1", ACTIVE_TAG.id, "manual"),
      deviation("video_2", ACTIVE_TAG.id, "manual"),
      deviation("video_3", ACTIVE_TAG.id, "manual"),
    ]);

    const result = await bulk("add");

    expect(result.assigned).toBe(0);
    expect(result.alreadyAssigned).toBe(3);
    expect(mocks.createVideoAssignments).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  /**
   * ASSIGNING A TAG THE CHANNEL ALREADY GIVES IS A NO-OP.
   *
   * The most likely way to fill this table with junk: select every Short on a
   * channel tagged "Ranking" and file them under "Ranking". Each of them already
   * carries it. Writing 400 manual rows here would produce exactly the stale
   * copies the design exists to avoid, and they would outlive the channel tag
   * that justified them.
   */
  it("is a no-op for Shorts that already inherit the tag", async () => {
    mocks.findVideos.mockResolvedValue(threeVideos([ACTIVE_TAG.id]));

    const result = await bulk("add");

    expect(result.assigned).toBe(0);
    expect(result.alreadyAssigned).toBe(3);
    expect(mocks.createVideoAssignments).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  /**
   * LIFTING A REFUSAL, and reporting it separately.
   *
   * Somebody is explicitly asking for this tag on this selection, so skipping the
   * Shorts that carry a tombstone would be a bulk run that quietly did not do
   * what it said. But it OVERRIDES an earlier decision, so it is counted apart
   * from the ordinary assignments rather than folded in: "38 filed, 2 refusals
   * lifted" is something a director can go and ask about, and "40 filed" is not.
   */
  it("lifts an existing refusal and counts it apart", async () => {
    mocks.findVideos.mockResolvedValue(threeVideos([ACTIVE_TAG.id]));
    mocks.findVideoAssignments.mockResolvedValue([
      deviation("video_2", ACTIVE_TAG.id, "excluded"),
    ]);

    const result = await bulk("add");

    expect(result.restored).toBe(1);
    expect(result.assigned).toBe(1);
    expect(result.alreadyAssigned).toBe(2);

    expect(mocks.deleteVideoAssignments).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, id: { in: ["row_video_2_ct_ranking"] } },
    });
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
      bulk("add", ["video_1", "video_2", "video_elsewhere"]),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.createVideoAssignments).not.toHaveBeenCalled();
  });

  it("refuses a tag from another organization without confirming it exists", async () => {
    mocks.findContentType.mockResolvedValue(null);

    await expect(bulk("add", ["video_1"])).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(mocks.findVideos).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  /**
   * Archiving has to mean something. The per-Short path accepts an archived tag —
   * it receives a complete desired set and refusing would silently strip a
   * Short's historical label — but bulk filing is unambiguously new work.
   */
  it("refuses to bulk-file under an archived tag", async () => {
    mocks.findContentType.mockResolvedValue({ ...ACTIVE_TAG, isActive: false });

    await expect(bulk("add", ["video_1"])).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("leaves other labels alone in add mode", async () => {
    mocks.findVideos.mockResolvedValue([videoRow("video_1", "Trevor loses it")]);
    mocks.findVideoAssignments.mockResolvedValue([
      deviation("video_1", "ct_moments", "manual"),
    ]);

    const result = await bulk("add", ["video_1"]);

    expect(result.removed).toBe(0);
    expect(mocks.deleteVideoAssignments).not.toHaveBeenCalled();
    expect(written()).toEqual([
      expect.objectContaining({ contentTypeId: ACTIVE_TAG.id, state: "manual" }),
    ]);
  });

  /**
   * "Replace" has to reach the INHERITED labels too, or it is the one mode in
   * the product whose name does not describe it. The channel's other tag becomes
   * a refusal; the Short's own manual row is simply removed.
   */
  it("clears inherited and manual labels alike in replace mode", async () => {
    mocks.findVideos.mockResolvedValue([
      videoRow("video_1", "Trevor loses it", ["ct_funny"]),
    ]);
    mocks.findVideoAssignments.mockResolvedValue([
      deviation("video_1", "ct_moments", "manual"),
    ]);

    const result = await bulk("replace", ["video_1"]);

    // Two labels went: one inherited, one the Short carried itself.
    expect(result.removed).toBe(2);
    expect(result.assigned).toBe(1);

    expect(mocks.deleteVideoAssignments).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, id: { in: ["row_video_1_ct_moments"] } },
    });
    // Manual rows are planned before refusals, so they are written in that
    // order. Asserted as a whole array rather than with `arrayContaining` so
    // that a stray extra row — the failure mode this whole file is about —
    // cannot slip past.
    expect(written()).toEqual([
      expect.objectContaining({ contentTypeId: ACTIVE_TAG.id, state: "manual" }),
      expect.objectContaining({ contentTypeId: "ct_funny", state: "excluded" }),
    ]);
  });
});
