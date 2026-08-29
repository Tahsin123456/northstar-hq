import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchesWhere } from "./support/prisma-where";

/**
 * Who owns a note, and whose saved Shorts you get to see.
 *
 * The reported bug was blunt: a brand-new Head of Shorts signed in and the
 * Saved page was full of the admin's Shorts, the Notes page full of the
 * admin's notes. Nothing was leaking across organizations — the filter was
 * `organizationId`, and every colleague passes it. The question it never asked
 * was "whose row is this?".
 *
 * This file pins the ownership rule rather than the plumbing:
 *
 *   • an ordinary member reads their own notes and their own saves, and
 *     nobody else's;
 *   • an admin holding `users.manage` reads the whole team's, and every row
 *     they did not write arrives carrying its author's name — never
 *     anonymously, because an unlabelled note is one an admin edits believing
 *     it is theirs;
 *   • a colleague cannot update or delete a note they did not write, and the
 *     refusal happens *before* the write, not after.
 *
 * Prisma and the session are stubs. The Prisma stub is a small fake that
 * actually applies the `where` rather than recording it, which is deliberate:
 * the claim under test is "the row does not come back", and asserting on the
 * shape of a `where` object would pass just as happily for a filter that named
 * the wrong column.
 */

// research-service reaches the errors module and, through the DAL mock below,
// the auth env validation. Set the secret before anything is imported, as the
// sibling finance and revenue tests do.
process.env.SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");

const ORG_ID = "org_northstar";

const ADMIN = { id: "user_admin", name: "Ada Admin", email: "ada@northstar.test" };
const HEAD = { id: "user_head", name: "Hana Head", email: "hana@northstar.test" };

const CHANNEL_ID = "chan_gta";

/**
 * Hoisted so the `vi.mock` factories — which vitest lifts above the imports —
 * can close over them. `session` is rewritten per test: it is the only thing
 * that changes between "the new Head is looking" and "the admin is looking".
 */
const mocks = vi.hoisted(() => ({
  session: { userId: "user_head", isAdmin: false },
  note: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  savedShort: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock("@/server/db", () => ({
  prisma: { note: mocks.note, savedShort: mocks.savedShort },
}));

vi.mock("../user-service", () => ({
  getScope: async () => ({
    organizationId: ORG_ID,
    userId: mocks.session.userId,
    actor: { userId: mocks.session.userId },
  }),
  getCurrentOrgId: async () => ORG_ID,
}));

// The one permission that decides whether personal rows widen to the whole
// team. Everything else the DAL exports is untouched by this service.
vi.mock("@/server/auth/dal", () => ({
  actorCan: async (permission: string) =>
    permission === "users.manage" && mocks.session.isAdmin,
}));

/**
 * Not niche-scoped here. This file is about OWNERSHIP — whose row is this —
 * and the sharing rule that layers niche scoping on top of it is pinned
 * separately in `note-visibility.test.ts`. Mixing the two would let a failure
 * in either look like a failure in the other.
 *
 * `null` is "sees every niche", so the shared-note clause admits any shared
 * note and the fixtures below, which are all personal, are unaffected.
 */
vi.mock("@/server/auth/niche-scope", () => ({
  getVisibleNicheIds: async () => null,
  trackedChannelNicheFilter: () => ({}),
  nicheFilter: () => ({}),
  nicheIdFilter: () => ({}),
}));

const {
  deleteNote,
  getNoteCounts,
  listNotes,
  listSavedShorts,
  removeOrphanedSavedShort,
  updateNote,
} = await import("../research-service");

// ---------------------------------------------------------------------------
// A Prisma stand-in small enough to read, faithful on the one axis under test
// ---------------------------------------------------------------------------

/**
 * The `where` as the service hands it over — interpreted, not inspected.
 *
 * `unknown` rather than a field list because the note predicate is no longer a
 * bag of equalities: it carries an `OR` over "mine" and "shared and in scope".
 * `matchesWhere` applies whatever arrives; see the note at the top of
 * `support/prisma-where.ts` for why that is the only assertion worth making.
 */
type FakeWhere = unknown;

interface Author {
  id: string;
  name: string | null;
  email: string | null;
}

interface NoteRow {
  id: string;
  organizationId: string;
  createdById: string | null;
  createdBy: Author | null;
  targetType: string;
  channelId: string | null;
  nicheId: string | null;
  videoId: string | null;
  body: string;
  visibility: string;
  createdAt: Date;
  updatedAt: Date;
}

const T0 = new Date("2026-08-20T09:00:00.000Z");
const T1 = new Date("2026-08-21T09:00:00.000Z");

function note(
  id: string,
  author: Author,
  body: string,
  overrides: Partial<NoteRow> = {},
): NoteRow {
  return {
    id,
    organizationId: ORG_ID,
    createdById: author.id,
    createdBy: author,
    targetType: "channel",
    channelId: CHANNEL_ID,
    nicheId: null,
    videoId: null,
    body,
    // Personal throughout this file: ownership is the question here, and a
    // shared note is a different one. `note-visibility.test.ts` takes it up.
    visibility: "personal",
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

const NOTES: NoteRow[] = [
  note("note_admin", ADMIN, "Hook lands at 0:02 on this one."),
  note("note_head", HEAD, "Worth testing the same cold open on ours."),
  // A second target, so the per-target list is proved to narrow on both
  // conditions rather than on the author alone.
  note("note_head_video", HEAD, "Cut is two beats too long.", {
    id: "note_head_video",
    targetType: "video",
    channelId: null,
    videoId: "vid_1",
  }),
];

interface SavedRow {
  id: string;
  organizationId: string;
  createdById: string | null;
  createdBy: Author | null;
  videoId: string;
  viewsAtSave: bigint;
  channelMedianAtSave: bigint | null;
  outlierMultipleAtSave: number | null;
  savedAt: Date;
  collections: { collectionId: string }[];
  video: {
    id: string;
    youtubeVideoId: string;
    title: string;
    publishedAt: Date;
    durationSeconds: number;
    viewCount: bigint;
    channelId: string;
    channel: {
      id: string;
      title: string;
      handle: string | null;
      avatarUrl: string | null;
      trackedBy: {
        label: string | null;
        ownershipType: string;
        niches: { niche: { id: string; name: string; colorIndex: number } }[];
      }[];
    };
  };
}

function saved(id: string, author: Author, videoId: string): SavedRow {
  return {
    id,
    organizationId: ORG_ID,
    createdById: author.id,
    createdBy: author,
    videoId,
    viewsAtSave: BigInt(1_200_000),
    channelMedianAtSave: BigInt(400_000),
    outlierMultipleAtSave: 3,
    savedAt: T1,
    collections: [],
    video: {
      id: videoId,
      youtubeVideoId: `yt_${videoId}`,
      title: `Short ${videoId}`,
      publishedAt: T0,
      durationSeconds: 41,
      viewCount: BigInt(4_800_000),
      channelId: CHANNEL_ID,
      channel: {
        id: CHANNEL_ID,
        title: "GTA Clips Daily",
        handle: "@gtaclips",
        avatarUrl: null,
        trackedBy: [{ label: null, ownershipType: "competitor", niches: [] }],
      },
    },
  };
}

const SAVES: SavedRow[] = [
  saved("saved_admin", ADMIN, "vid_1"),
  saved("saved_head", HEAD, "vid_2"),
  // The same Short, saved by both. Impossible under the old
  // `[organizationId, videoId]` key and the ordinary case under the new one.
  saved("saved_admin_shared", ADMIN, "vid_3"),
  saved("saved_head_shared", HEAD, "vid_3"),
];

/** Signs in as somebody, with or without `users.manage`. */
function signedInAs(user: Author, options: { admin?: boolean } = {}): void {
  mocks.session.userId = user.id;
  mocks.session.isAdmin = options.admin ?? false;
}

beforeEach(() => {
  vi.clearAllMocks();
  signedInAs(HEAD);

  mocks.note.findMany.mockImplementation(async ({ where }: { where: FakeWhere }) =>
    NOTES.filter((row) => matchesWhere(row, where)),
  );
  mocks.note.findFirst.mockImplementation(
    async ({ where }: { where: FakeWhere }) =>
      NOTES.find((row) => matchesWhere(row, where)) ?? null,
  );
  mocks.note.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: { body: string } }) => {
      const row = NOTES.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error(`no such note: ${where.id}`);
      return { ...row, body: data.body, updatedAt: T1 };
    },
  );
  mocks.note.delete.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
  }));
  mocks.savedShort.findMany.mockImplementation(async ({ where }: { where: FakeWhere }) =>
    SAVES.filter((row) => matchesWhere(row, where)),
  );
});

// ---------------------------------------------------------------------------

describe("notes belong to the person who wrote them", () => {
  it("gives an employee their own notes and none of the admin's", async () => {
    const notes = await listNotes("channel", CHANNEL_ID);

    expect(notes.map((n) => n.id)).toEqual(["note_head"]);
    // Stated separately, because "the list is short" and "the admin's note is
    // absent" are different assertions and it is the second one that was broken.
    expect(notes.some((n) => n.createdById === ADMIN.id)).toBe(false);
  });

  it("gives an admin the whole team's, each note under its author's name", async () => {
    signedInAs(ADMIN, { admin: true });

    const notes = await listNotes("channel", CHANNEL_ID);

    expect(notes.map((n) => n.id).sort()).toEqual(["note_admin", "note_head"]);

    const colleagues = notes.find((n) => n.id === "note_head");
    expect(colleagues?.createdById).toBe(HEAD.id);
    expect(colleagues?.createdByName).toBe("Hana Head");
  });

  it("still narrows to the target, not only to the author", async () => {
    // Both of these are Hana's; only one is a note on this channel.
    const notes = await listNotes("channel", CHANNEL_ID);
    expect(notes.map((n) => n.id)).not.toContain("note_head_video");
  });

  it("counts only the notes the caller can open", async () => {
    // The badge and the panel read through the same filter. A count of 2 over
    // a panel that renders one note advertises a colleague's private note and
    // sends the reader hunting for something they will never be shown.
    const counts = await getNoteCounts();
    expect(counts.channels[CHANNEL_ID]).toBe(1);

    signedInAs(ADMIN, { admin: true });
    expect((await getNoteCounts()).channels[CHANNEL_ID]).toBe(2);
  });
});

describe("editing a note somebody else wrote", () => {
  it("refuses to update it, and never reaches the write", async () => {
    // Hana is signed in; note_admin is Ada's.
    await expect(updateNote("note_admin", { body: "rewritten" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    // The guard is the `where`, not a check after the fact. A refusal thrown
    // once the row had already been rewritten would be no guard at all.
    expect(mocks.note.update).not.toHaveBeenCalled();
  });

  it("refuses to delete it, and never reaches the delete", async () => {
    await expect(deleteNote("note_admin")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.note.delete).not.toHaveBeenCalled();
  });

  /**
   * NOT_FOUND rather than FORBIDDEN, on purpose. Hana cannot see this note at
   * all, so "could not be found" is the truthful answer from where she stands
   * — and a 403 would confirm that the id names a real note a colleague wrote,
   * turning the endpoint into an oracle for enumerating other people's
   * research.
   */
  it("does not confirm the note exists", async () => {
    const error = await updateNote("note_admin", { body: "rewritten" }).catch(
      (caught: unknown) => caught,
    );
    expect((error as { status: number }).status).toBe(404);
  });

  it("lets the author edit their own", async () => {
    await expect(updateNote("note_head", { body: "sharper wording" })).resolves.toMatchObject({
      id: "note_head",
      body: "sharper wording",
      createdById: HEAD.id,
    });
    expect(mocks.note.update).toHaveBeenCalledOnce();
  });

  it("lets an admin correct a colleague's, without adopting it", async () => {
    signedInAs(ADMIN, { admin: true });

    const updated = await updateNote("note_head", { body: "typo fixed" });

    expect(updated.body).toBe("typo fixed");
    // The edit is not a change of authorship. Hana still wrote this note, and
    // the byline has to keep saying so.
    expect(updated.createdById).toBe(HEAD.id);
    expect(updated.createdByName).toBe("Hana Head");
    expect(mocks.note.update.mock.calls[0]?.[0]).toMatchObject({
      data: { body: "typo fixed" },
    });
    expect(mocks.note.update.mock.calls[0]?.[0]?.data).not.toHaveProperty("createdById");
  });
});

describe("saved Shorts belong to the person who saved them", () => {
  it("gives an employee their own shortlist and none of the admin's", async () => {
    const board = await listSavedShorts();

    expect(board.map((s) => s.id).sort()).toEqual(["saved_head", "saved_head_shared"]);
    expect(board.some((s) => s.savedById === ADMIN.id)).toBe(false);
  });

  it("gives an admin the whole team's, each save attributed", async () => {
    signedInAs(ADMIN, { admin: true });

    const board = await listSavedShorts();

    expect(board.map((s) => s.id).sort()).toEqual([
      "saved_admin",
      "saved_admin_shared",
      "saved_head",
      "saved_head_shared",
    ]);

    const colleagues = board.find((s) => s.id === "saved_head");
    expect(colleagues?.savedById).toBe(HEAD.id);
    expect(colleagues?.savedByName).toBe("Hana Head");
  });

  /**
   * Two people saving the same Short is the normal case now — it is what the
   * new `[organizationId, createdById, videoId]` key exists to allow. Both
   * rows survive, and each keeps its own capture, so neither person's record
   * of when they spotted it is overwritten by the other's.
   */
  it("keeps both saves when two people saved the same Short", async () => {
    signedInAs(ADMIN, { admin: true });

    const forVideo = (await listSavedShorts()).filter((s) => s.videoId === "vid_3");

    expect(forVideo).toHaveLength(2);
    expect(forVideo.map((s) => s.savedById).sort()).toEqual([ADMIN.id, HEAD.id]);
  });
});

/**
 * The row nobody owns.
 *
 * `createdById` is `SetNull`, so a departed colleague's shortlist stays on the
 * board with no author to name and no author to un-save it: `unsaveShort`
 * deletes `createdById = <caller>` and matches nothing. Before this the row was
 * simply permanent — unlabelled on screen and unreachable from every endpoint.
 *
 * These tests pin the two halves that make it safe: an admin can clear it, and
 * the same call cannot be pointed at a live save.
 */
describe("a save whose owner's account is gone", () => {
  const ORPHAN_ID = "saved_orphan";

  /** Its own table, so the fixtures the read tests count are left alone. */
  let rows: SavedRow[];

  beforeEach(() => {
    rows = [
      { ...saved(ORPHAN_ID, HEAD, "vid_4"), createdById: null, createdBy: null },
      saved("saved_head", HEAD, "vid_2"),
    ];

    mocks.savedShort.deleteMany.mockImplementation(
      async ({ where }: { where: FakeWhere }) => {
        const kept = rows.filter((row) => !matchesWhere(row, where));
        const count = rows.length - kept.length;
        rows = kept;
        return { count };
      },
    );
  });

  it("lets an admin clear it", async () => {
    signedInAs(ADMIN, { admin: true });

    await expect(removeOrphanedSavedShort(ORPHAN_ID)).resolves.toBeUndefined();
    expect(rows.map((row) => row.id)).toEqual(["saved_head"]);
  });

  it("is addressed by row id and by the missing owner, in the where", async () => {
    signedInAs(ADMIN, { admin: true });
    await removeOrphanedSavedShort(ORPHAN_ID);

    // `createdById: null` is a condition on the delete, not a check on a row
    // already fetched. That is what stops this endpoint from ever becoming
    // "delete a colleague's save" when handed a live row's id.
    expect(mocks.savedShort.deleteMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: ORPHAN_ID, organizationId: ORG_ID, createdById: null },
    });
  });

  it("refuses a live save, and the row survives", async () => {
    signedInAs(ADMIN, { admin: true });

    await expect(removeOrphanedSavedShort("saved_head")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(rows.map((row) => row.id)).toContain("saved_head");
  });

  it("refuses an ordinary member, and never reaches the delete", async () => {
    // Hana cannot see an orphan in the first place — her author filter names
    // herself — so she is told the row is not there, which from where she
    // stands is true.
    await expect(removeOrphanedSavedShort(ORPHAN_ID)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(mocks.savedShort.deleteMany).not.toHaveBeenCalled();
  });
});
