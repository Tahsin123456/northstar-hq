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
 *     effective(short) = (rules covering its publish date − exclusions) ∪ manual
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
  findTrackedChannelById: vi.fn(),
  findContentTypes: vi.fn(),
  findContentType: vi.fn(),
  findVideoAssignments: vi.fn(),
  deleteVideoAssignments: vi.fn(),
  updateVideoAssignments: vi.fn(),
  createVideoAssignments: vi.fn(),
  findRules: vi.fn(),
  findRule: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  findChannel: vi.fn(),
  findEarliestVideo: vi.fn(),
  transaction: vi.fn(),
  recordAudit: vi.fn<(context: unknown, payload: unknown) => Promise<void>>(),
}));

vi.mock("@/server/db", () => ({
  prisma: {
    video: { findMany: mocks.findVideos, findFirst: mocks.findEarliestVideo },
    trackedChannel: {
      findFirst: mocks.findTrackedChannel,
      findUnique: mocks.findTrackedChannelById,
    },
    contentType: { findMany: mocks.findContentTypes, findFirst: mocks.findContentType },
    videoContentType: {
      findMany: mocks.findVideoAssignments,
      deleteMany: mocks.deleteVideoAssignments,
      updateMany: mocks.updateVideoAssignments,
      createMany: mocks.createVideoAssignments,
    },
    channelContentTypeRule: {
      findMany: mocks.findRules,
      findFirst: mocks.findRule,
      create: mocks.createRule,
      update: mocks.updateRule,
    },
    channel: { findUnique: mocks.findChannel },
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
  applyContentTypeToChannel,
  setChannelContentTypeRuleWindow,
  setVideoContentTypes,
} = await import("../content-type-service");

const DAY = 86_400_000;
/** When the channel itself was created, and its oldest stored upload. */
const CHANNEL_CREATED = Date.UTC(2020, 0, 1);
const FIRST_UPLOAD = Date.UTC(2021, 0, 1);
/** When every Short below was published, unless it says otherwise. */
const PUBLISHED = Date.UTC(2025, 5, 1);

/** The tag the bulk path files under, restated where the streak cases need it. */
const BULK_TAG = { id: "ct_ranking", name: "Ranking", isActive: true };

/**
 * One rule as `loadTaggableVideos` reads it back, with its streak state.
 *
 * Open-ended and epoch-dated by default — which is what the migration wrote for
 * the two channels that already carried tags, and what "Apply to this channel"
 * writes. So a caller that only says "this channel gives Rankings" gets exactly
 * the old flat behaviour, and every case in this file that predates rules goes
 * on asserting what it always asserted.
 */
function ruleRow(
  contentTypeId: string,
  overrides: {
    id?: string;
    effectiveFrom?: number;
    effectiveUntil?: number | null;
    consecutiveOverrides?: number;
    overrideStreakFrom?: number | null;
  } = {},
) {
  return {
    id: overrides.id ?? `rule_${contentTypeId}`,
    contentTypeId,
    effectiveFrom: new Date(overrides.effectiveFrom ?? 0),
    effectiveUntil:
      overrides.effectiveUntil === undefined || overrides.effectiveUntil === null
        ? null
        : new Date(overrides.effectiveUntil),
    consecutiveOverrides: overrides.consecutiveOverrides ?? 0,
    overrideStreakFrom:
      overrides.overrideStreakFrom === undefined || overrides.overrideStreakFrom === null
        ? null
        : new Date(overrides.overrideStreakFrom),
  };
}

/**
 * The projection `loadTaggableVideos` selects, for one Short.
 *
 * THE CHANNEL'S RULES COME WITH IT, and that is the interesting part of the
 * shape: no decision this service makes can be reached without knowing what the
 * channel's rules give THIS Short — which depends on when it was published — so
 * the tracking row and its rules ride along inside the same query. The nested
 * `trackedBy` array is the organization-filtered relation, one row at most,
 * because a rule hangs off OUR tracking row and not off the globally shared
 * channel.
 */
function videoRow(
  id: string,
  title: string,
  channelTypeIds: readonly (string | ReturnType<typeof ruleRow>)[] = [],
  publishedAt: number = PUBLISHED,
) {
  return {
    id,
    title,
    channelId: "channel_1",
    publishedAt: new Date(publishedAt),
    channel: {
      trackedBy: [
        {
          id: "tracked_1",
          contentTypeRules: channelTypeIds.map((entry) =>
            typeof entry === "string" ? ruleRow(entry) : entry,
          ),
        },
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
  mocks.findRules.mockResolvedValue([]);
  // The name a closure notice puts in front of the person. Looked up only when a
  // rule actually retires, so most tests never reach it.
  mocks.findTrackedChannelById.mockResolvedValue({
    label: null,
    channel: { title: "GTA Moments" },
  });
  mocks.findRule.mockResolvedValue(null);
  mocks.updateRule.mockResolvedValue(undefined);
  // The channel a rule would be applied to, and the oldest thing it published.
  // Both feed `earliestPossiblePublish`, which is what decides how far back a
  // new rule reaches.
  mocks.findChannel.mockResolvedValue({ channelPublishedAt: new Date(CHANNEL_CREATED) });
  mocks.findEarliestVideo.mockResolvedValue({ publishedAt: new Date(FIRST_UPLOAD) });
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

/**
 * ==========================================================================
 * APPLYING A TAG TO A CHANNEL — AND THE WINDOW IT WRITES
 * ==========================================================================
 *
 * `setChannelContentTypes` is gone; there is no whole-set channel write left to
 * test. What replaces it writes ONE rule, and the property worth pinning is
 * where that rule STARTS — because "the whole back catalogue" has to keep being
 * true after the next sync, not only on the day it was written.
 */
describe("applyContentTypeToChannel", () => {
  it("starts the rule before anything the channel could ever have published", async () => {
    mocks.findTrackedChannel.mockResolvedValue(CHANNEL_ROW);
    mocks.findContentTypes.mockResolvedValue([contentTypeRow("ct_memes", "Funny Memes")]);
    mocks.findRules.mockResolvedValue([]);
    mocks.createRule.mockResolvedValue(ruleRow("ct_memes"));

    await applyContentTypeToChannel("channel_1", "ct_memes");

    /*
     * THE CHANNEL'S CREATION DATE, not the oldest Short currently stored.
     *
     * The library grows BACKWARDS as well as forwards — the lookback window is a
     * setting, and a sync can import Shorts older than anything held today. A
     * rule dated to today's earliest upload would silently fail to cover them,
     * and nobody would connect the missing labels to a rule written months
     * before. A video cannot predate its channel, so this bound stays true
     * permanently.
     */
    expect(mocks.createRule).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: ORG_ID,
        trackedChannelId: "tracked_1",
        contentTypeId: "ct_memes",
        effectiveFrom: new Date(CHANNEL_CREATED),
        createdById: USER_ID,
      }),
    });
  });

  it("takes the older of the channel's creation date and its oldest upload", async () => {
    // YouTube's channel creation date is occasionally later than a video it
    // hosts. Ours is not, so the stored upload wins when it is older.
    const ANCIENT = Date.UTC(2015, 0, 1);
    mocks.findTrackedChannel.mockResolvedValue(CHANNEL_ROW);
    mocks.findContentTypes.mockResolvedValue([contentTypeRow("ct_memes", "Funny Memes")]);
    mocks.findEarliestVideo.mockResolvedValue({ publishedAt: new Date(ANCIENT) });
    mocks.createRule.mockResolvedValue(ruleRow("ct_memes"));

    await applyContentTypeToChannel("channel_1", "ct_memes");

    expect(mocks.createRule).toHaveBeenCalledWith({
      data: expect.objectContaining({ effectiveFrom: new Date(ANCIENT) }),
    });
  });

  it("writes nothing when an open rule already covers the whole history", async () => {
    // The double-click, and the second person to have the same thought. Both
    // must be one rule and no audit entry claiming a channel was characterised
    // twice.
    mocks.findTrackedChannel.mockResolvedValue(CHANNEL_ROW);
    mocks.findContentTypes.mockResolvedValue([contentTypeRow("ct_memes", "Funny Memes")]);
    mocks.findRules.mockResolvedValue([ruleRow("ct_memes")]);

    await applyContentTypeToChannel("channel_1", "ct_memes");

    expect(mocks.createRule).not.toHaveBeenCalled();
    expect(mocks.updateRule).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("re-opens a closed rule rather than writing a second one at the same date", async () => {
    // The schema is unique on (channel, type, start), so a duplicate would be a
    // constraint violation surfacing as a 500 — and, more to the point, would be
    // the same claim written twice.
    mocks.findTrackedChannel.mockResolvedValue(CHANNEL_ROW);
    mocks.findContentTypes.mockResolvedValue([contentTypeRow("ct_memes", "Funny Memes")]);
    mocks.findRules.mockResolvedValue([
      ruleRow("ct_memes", {
        effectiveFrom: CHANNEL_CREATED,
        effectiveUntil: Date.UTC(2025, 2, 4),
        consecutiveOverrides: 3,
        overrideStreakFrom: Date.UTC(2025, 2, 4),
      }),
    ]);
    mocks.updateRule.mockResolvedValue(ruleRow("ct_memes"));

    await applyContentTypeToChannel("channel_1", "ct_memes");

    expect(mocks.createRule).not.toHaveBeenCalled();
    // AND THE STREAK GOES WITH IT. Leaving it at three would arm the rule to
    // retire itself again on the very next removal, for evidence a person has
    // just overruled — a re-open that lasts one click is not an undo.
    expect(mocks.updateRule).toHaveBeenCalledWith({
      where: { id: "rule_ct_memes" },
      data: {
        effectiveUntil: null,
        autoClosedAt: null,
        consecutiveOverrides: 0,
        overrideStreakFrom: null,
      },
    });
  });

  it("404s a channel this caller cannot reach", async () => {
    mocks.findTrackedChannel.mockResolvedValue(null);

    await expect(
      applyContentTypeToChannel("channel_elsewhere", "ct_memes"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(mocks.createRule).not.toHaveBeenCalled();
  });
});

/**
 * THE MANUAL LEVER.
 *
 * The automatic path is a safety net, not the only door. Somebody who knows a
 * channel switched in March must be able to say so without removing the tag from
 * three Shorts, and somebody who thinks the streak got it wrong must be able to
 * undo it in one action.
 */
describe("setChannelContentTypeRuleWindow", () => {
  const MARCH = Date.UTC(2025, 2, 4);

  it("closes a rule at the date given, without claiming the app decided it", async () => {
    mocks.findTrackedChannel.mockResolvedValue(CHANNEL_ROW);
    mocks.findRule.mockResolvedValue(ruleRow("ct_memes"));
    mocks.findContentType.mockResolvedValue({ name: "Funny Memes" });
    mocks.updateRule.mockResolvedValue(ruleRow("ct_memes", { effectiveUntil: MARCH }));

    await setChannelContentTypeRuleWindow("channel_1", "rule_ct_memes", MARCH);

    // `autoClosedAt` STAYS NULL. That column is the difference between "the app
    // retired this" and "Ada closed it", and the UI reads it to decide which
    // sentence to print.
    expect(mocks.updateRule).toHaveBeenCalledWith({
      where: { id: "rule_ct_memes" },
      data: {
        effectiveUntil: new Date(MARCH),
        autoClosedAt: null,
        consecutiveOverrides: 0,
        overrideStreakFrom: null,
      },
    });
  });

  it("re-opens with null, clearing the retirement and its evidence", async () => {
    mocks.findTrackedChannel.mockResolvedValue(CHANNEL_ROW);
    mocks.findRule.mockResolvedValue(
      ruleRow("ct_memes", {
        effectiveUntil: MARCH,
        consecutiveOverrides: 3,
        overrideStreakFrom: MARCH,
      }),
    );
    mocks.findContentType.mockResolvedValue({ name: "Funny Memes" });
    mocks.updateRule.mockResolvedValue(ruleRow("ct_memes"));

    await setChannelContentTypeRuleWindow("channel_1", "rule_ct_memes", null);

    expect(mocks.updateRule).toHaveBeenCalledWith({
      where: { id: "rule_ct_memes" },
      data: {
        effectiveUntil: null,
        autoClosedAt: null,
        consecutiveOverrides: 0,
        overrideStreakFrom: null,
      },
    });
  });

  it("refuses a close before the rule starts", async () => {
    // A window that ends before it starts covers nothing — a delete wearing a
    // close's clothes. It would strip the tag off the whole back catalogue while
    // the UI went on describing the rule as "closed on the 4th".
    mocks.findTrackedChannel.mockResolvedValue(CHANNEL_ROW);
    mocks.findRule.mockResolvedValue(ruleRow("ct_memes", { effectiveFrom: MARCH }));
    mocks.findContentType.mockResolvedValue({ name: "Funny Memes" });

    await expect(
      setChannelContentTypeRuleWindow("channel_1", "rule_ct_memes", MARCH - DAY),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(mocks.updateRule).not.toHaveBeenCalled();
  });

  it("writes nothing when the window is already exactly that", async () => {
    mocks.findTrackedChannel.mockResolvedValue(CHANNEL_ROW);
    mocks.findRule.mockResolvedValue(ruleRow("ct_memes"));
    mocks.findContentType.mockResolvedValue({ name: "Funny Memes" });

    await setChannelContentTypeRuleWindow("channel_1", "rule_ct_memes", null);

    expect(mocks.updateRule).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("404s a rule that belongs to another team's channel", async () => {
    // Both ids are in the `where`, so somebody else's rule id misses exactly as
    // a made-up one does — the endpoint never confirms it is real.
    mocks.findTrackedChannel.mockResolvedValue(CHANNEL_ROW);
    mocks.findRule.mockResolvedValue(null);

    await expect(
      setChannelContentTypeRuleWindow("channel_1", "rule_elsewhere", null),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(mocks.updateRule).not.toHaveBeenCalled();
  });
});

/**
 * ==========================================================================
 * THE RULE NOTICING THE CHANNEL CHANGED — AS THE SERVICE WIRES IT
 * ==========================================================================
 *
 * The state machine itself is driven directly in
 * `src/lib/__tests__/channel-content-type-rules.test.ts`, where a streak can be
 * run without inventing five Prisma stubs per step. What is pinned HERE is the
 * thing that file cannot see: which gestures the service feeds into it, and what
 * it writes when one completes.
 */
describe("removals feed the streak", () => {
  const MARCH = Date.UTC(2025, 2, 4);

  /** A Short published in March, on a channel whose Memes rule is still open. */
  function marchShort(rule: ReturnType<typeof ruleRow>) {
    return videoRow("video_1", "Trevor loses it", [rule], MARCH);
  }

  it("grows the streak on the first removal without closing anything", async () => {
    mocks.findVideos.mockResolvedValue([marchShort(ruleRow("ct_memes"))]);
    mocks.findContentTypes.mockResolvedValue([contentTypeRow("ct_memes", "Funny Memes")]);

    await excludeContentTypeFromVideo("video_1", "ct_memes");

    expect(mocks.transaction).toHaveBeenCalled();
    const streakWrite = mocks.updateRule.mock.calls.at(-1)?.[0];
    expect(streakWrite).toMatchObject({
      where: { id: "rule_ct_memes" },
      data: { consecutiveOverrides: 1, overrideStreakFrom: new Date(MARCH) },
    });
    // One removal is noise — a collab, an experiment, a repost. Retiring a
    // year-old rule for it would make the feature dangerous to use.
    expect(streakWrite?.data).not.toHaveProperty("effectiveUntil");
  });

  it("closes the rule on the third, dated to where the streak began", async () => {
    const APRIL = Date.UTC(2025, 3, 10);
    mocks.findVideos.mockResolvedValue([
      videoRow(
        "video_1",
        "Franklin's ranking",
        [ruleRow("ct_memes", { consecutiveOverrides: 2, overrideStreakFrom: MARCH })],
        APRIL,
      ),
    ]);
    mocks.findContentTypes.mockResolvedValue([contentTypeRow("ct_memes", "Funny Memes")]);
    mocks.findChannel.mockResolvedValue({ channelPublishedAt: new Date(CHANNEL_CREATED) });

    const result = await excludeContentTypeFromVideo("video_1", "ct_memes");

    /*
     * THE DATE IS MARCH, NOT APRIL, and that is the whole point of storing
     * `overrideStreakFrom` rather than counting to three and stamping `now`.
     * The channel changed in March; April is when somebody worked it out. Dating
     * the close to April would leave every upload in between falsely tagged
     * forever, which is the exact failure this round exists to remove.
     */
    expect(mocks.updateRule).toHaveBeenCalledWith({
      where: { id: "rule_ct_memes" },
      data: expect.objectContaining({
        consecutiveOverrides: 3,
        effectiveUntil: new Date(MARCH),
        autoClosedAt: expect.any(Date),
      }),
    });

    // AND THE PERSON IS TOLD, in the response to the click that caused it. A
    // rule that retires silently is indistinguishable from a bug.
    expect(result.closedRules).toEqual([
      expect.objectContaining({
        ruleId: "rule_ct_memes",
        contentTypeName: "Funny Memes",
        channelId: "channel_1",
        effectiveUntil: MARCH,
        automatic: true,
      }),
    ]);
  });

  it("a removal on a Short older than the rule counts for nothing", async () => {
    // Correcting the label on an old upload is tidying the back catalogue. It
    // says nothing whatever about what the channel is publishing now, and under
    // the flat model there was no way to tell the two apart.
    mocks.findVideos.mockResolvedValue([
      videoRow(
        "video_1",
        "An old one",
        [ruleRow("ct_memes", { effectiveFrom: MARCH })],
        MARCH - DAY,
      ),
    ]);
    mocks.findContentTypes.mockResolvedValue([contentTypeRow("ct_memes", "Funny Memes")]);

    const result = await excludeContentTypeFromVideo("video_1", "ct_memes");

    expect(mocks.updateRule).not.toHaveBeenCalled();
    expect(result.closedRules).toEqual([]);
  });

  it("putting the tag back on a newer Short clears the streak", async () => {
    const APRIL = Date.UTC(2025, 3, 10);
    mocks.findVideos.mockResolvedValue([
      videoRow(
        "video_1",
        "Still a meme",
        [ruleRow("ct_memes", { consecutiveOverrides: 2, overrideStreakFrom: MARCH })],
        APRIL,
      ),
    ]);
    mocks.findVideoAssignments.mockResolvedValue([
      deviation("video_1", "ct_memes", "excluded"),
    ]);
    mocks.findContentTypes.mockResolvedValue([contentTypeRow("ct_memes", "Funny Memes")]);

    await restoreInheritedContentType("video_1", "ct_memes");

    expect(mocks.updateRule).toHaveBeenCalledWith({
      where: { id: "rule_ct_memes" },
      data: { consecutiveOverrides: 0, overrideStreakFrom: null },
    });
  });

  it("a bulk run never feeds the streak, however many tags it strips", async () => {
    /*
     * THE DECISION THIS TEST EXISTS TO PIN, because it looks like an omission.
     *
     * A bulk replace over a back catalogue is a mass removal, and feeding it in
     * would satisfy the threshold instantly — then date the retirement to the
     * OLDEST Short in the selection, retiring the rule across the very history
     * the person was tidying. The streak is evidence that a channel changed at a
     * point in time; one statement about a hand-assembled selection is not that.
     * Somebody who means "this stopped in March" has the manual lever.
     */
    mocks.findVideos.mockResolvedValue([
      videoRow("video_1", "One", [ruleRow("ct_memes")]),
      videoRow("video_2", "Two", [ruleRow("ct_memes")]),
      videoRow("video_3", "Three", [ruleRow("ct_memes")]),
    ]);
    mocks.findContentType.mockResolvedValue(BULK_TAG);

    await assignContentTypeToVideos({
      videoIds: ["video_1", "video_2", "video_3"],
      contentTypeId: BULK_TAG.id,
      mode: "replace",
    });

    expect(mocks.updateRule).not.toHaveBeenCalled();
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
