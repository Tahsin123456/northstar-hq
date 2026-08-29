import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchesWhere } from "./support/prisma-where";

/**
 * WHO A SHARED NOTE REACHES.
 *
 * The ownership round made every note personal, which fixed the leak and left
 * the team unable to tell each other anything. Sharing puts that back — and the
 * whole risk of it is in one word. If "shared" meant "everybody", then sharing
 * a note about a Red Dead channel would show a GTA editor the name, the label
 * and the niche chips of a channel they were never assigned, and the niche
 * scoping in `niche-scope.ts` would be one checkbox away from decorative.
 *
 * So the rule is "shared AND its subject is in your scope", and this file pins
 * it from both ends:
 *
 *   • a niche-scoped member reads a shared note on a niche they hold, and NOT
 *     one on a niche they do not;
 *   • no version of sharing reaches somebody else's PERSONAL note, not even on
 *     a channel they can see;
 *   • an admin reads all of it, always with the author's name attached;
 *   • a colleague who can now READ a shared note still cannot re-share it,
 *     un-share it, or rewrite it — reading and writing are different
 *     authorities and sharing only ever widens the first;
 *   • the badge counts and the panel agree, because they are the same
 *     predicate.
 *
 * The niche scoping is the REAL one: `trackedChannelNicheFilter` and
 * `nicheIdFilter` are imported unmocked and only `getVisibleNicheIds` — the
 * session lookup — is stubbed. A test that reimplemented the filters would pass
 * whatever they did.
 *
 * Prisma is a fake that APPLIES the `where` rather than recording it; see
 * `support/prisma-where.ts` for why that is the only assertion worth making.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 9).toString("base64");

const ORG_ID = "org_northstar";

const ADMIN = { id: "user_admin", name: "Ada Admin", email: "ada@northstar.test" };
/** Niche-scoped to GTA. The person the rule exists to protect and to serve. */
const EDITOR = { id: "user_editor", name: "Eli Editor", email: "eli@northstar.test" };

const GTA = { id: "niche_gta", name: "GTA", colorIndex: 0 };
const RED_DEAD = { id: "niche_rdr", name: "Red Dead", colorIndex: 1 };

const GTA_CHANNEL = "chan_gta";
const RDR_CHANNEL = "chan_rdr";

const mocks = vi.hoisted(() => ({
  session: {
    userId: "user_editor",
    isAdmin: false,
    /** `null` is "not niche-scoped"; an array is exactly those niches. */
    visibleNiches: ["niche_gta"] as readonly string[] | null,
  },
  note: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
}));

vi.mock("@/server/db", () => ({ prisma: { note: mocks.note } }));

vi.mock("../user-service", () => ({
  getScope: async () => ({
    organizationId: ORG_ID,
    userId: mocks.session.userId,
    actor: { userId: mocks.session.userId },
  }),
  getCurrentOrgId: async () => ORG_ID,
}));

vi.mock("@/server/auth/dal", () => ({
  actorCan: async (permission: string) =>
    permission === "users.manage" && mocks.session.isAdmin,
}));

/**
 * Only the session lookup is stubbed. The filters below it are the real ones,
 * so a change to how a niche narrows a channel query changes what this file
 * asserts — which is the point: shared notes must move with niche scoping and
 * never drift into a second, softer copy of it.
 */
vi.mock("@/server/auth/niche-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/niche-scope")>();
  return { ...actual, getVisibleNicheIds: async () => mocks.session.visibleNiches };
});

const { getNoteCounts, listAllNotes, listNotes, updateNote } = await import(
  "../research-service"
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Author = { id: string; name: string | null; email: string | null };
type NicheRef = { id: string; name: string; colorIndex: number };

const T0 = new Date("2026-08-20T09:00:00.000Z");
const T1 = new Date("2026-08-22T09:00:00.000Z");

/**
 * A channel row shaped as both the filter and the DTO mapper see it.
 *
 * `trackedBy` carries `organizationId` and its niche join because that is what
 * the predicate walks — a channel is a global, deduplicated row, so "ours" and
 * "in your niches" are both questions about the tracking row, not the channel.
 */
function channelRow(id: string, title: string, niches: NicheRef[]) {
  return {
    id,
    title,
    handle: null,
    avatarUrl: null,
    trackedBy: [
      {
        organizationId: ORG_ID,
        label: null,
        ownershipType: "competitor",
        niches: niches.map((niche) => ({ nicheId: niche.id, niche })),
      },
    ],
  };
}

const GTA_ROW = channelRow(GTA_CHANNEL, "GTA Clips Daily", [GTA]);
const RDR_ROW = channelRow(RDR_CHANNEL, "Red Dead Moments", [RED_DEAD]);

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
  channel: ReturnType<typeof channelRow> | null;
  niche: NicheRef | null;
  video: {
    id: string;
    youtubeVideoId: string;
    title: string;
    channelId: string;
    channel: ReturnType<typeof channelRow>;
  } | null;
}

function baseNote(id: string, author: Author, visibility: string): NoteRow {
  return {
    id,
    organizationId: ORG_ID,
    createdById: author.id,
    createdBy: author,
    targetType: "general",
    channelId: null,
    nicheId: null,
    videoId: null,
    body: `body of ${id}`,
    visibility,
    createdAt: T0,
    updatedAt: T0,
    channel: null,
    niche: null,
    video: null,
  };
}

function channelNote(
  id: string,
  author: Author,
  visibility: string,
  channel: ReturnType<typeof channelRow>,
): NoteRow {
  return {
    ...baseNote(id, author, visibility),
    targetType: "channel",
    channelId: channel.id,
    channel,
  };
}

function nicheNote(
  id: string,
  author: Author,
  visibility: string,
  niche: NicheRef,
): NoteRow {
  return { ...baseNote(id, author, visibility), targetType: "niche", nicheId: niche.id, niche };
}

function videoNote(
  id: string,
  author: Author,
  visibility: string,
  channel: ReturnType<typeof channelRow>,
): NoteRow {
  const video = {
    id: `vid_${channel.id}`,
    youtubeVideoId: `yt_${channel.id}`,
    title: `A Short on ${channel.title}`,
    channelId: channel.id,
    channel,
  };
  return { ...baseNote(id, author, visibility), targetType: "video", videoId: video.id, video };
}

/**
 * One note for every combination that matters: both niches, both visibilities,
 * all four kinds of subject, and one the editor wrote themselves.
 */
const NOTES: NoteRow[] = [
  // Shared, on the niche the editor holds. The one that must arrive.
  channelNote("gta_shared", ADMIN, "shared", GTA_ROW),
  // Shared, on a niche they do not. The one that must not.
  channelNote("rdr_shared", ADMIN, "shared", RDR_ROW),
  // Personal, on a channel they CAN see. Being able to see the subject is not
  // being able to read somebody's private note about it.
  channelNote("gta_personal", ADMIN, "personal", GTA_ROW),
  // Their own, and personal. Always theirs to read.
  channelNote("gta_editor_own", EDITOR, "personal", GTA_ROW),
  nicheNote("niche_gta_shared", ADMIN, "shared", GTA),
  nicheNote("niche_rdr_shared", ADMIN, "shared", RED_DEAD),
  videoNote("video_gta_shared", ADMIN, "shared", GTA_ROW),
  videoNote("video_rdr_shared", ADMIN, "shared", RDR_ROW),
  // Attached to nothing: the deliberate exception, org-wide when shared.
  { ...baseNote("general_shared", ADMIN, "shared") },
  { ...baseNote("general_personal", ADMIN, "personal") },
];

function signedInAs(
  user: Author,
  options: { admin?: boolean; niches?: readonly string[] | null } = {},
): void {
  mocks.session.userId = user.id;
  mocks.session.isAdmin = options.admin ?? false;
  // Default: the editor's own assignment. An admin is not niche-scoped.
  mocks.session.visibleNiches =
    options.niches !== undefined ? options.niches : options.admin ? null : [GTA.id];
}

beforeEach(() => {
  vi.clearAllMocks();
  signedInAs(EDITOR);

  mocks.note.findMany.mockImplementation(async ({ where }: { where: unknown }) =>
    NOTES.filter((row) => matchesWhere(row, where)),
  );
  mocks.note.findFirst.mockImplementation(
    async ({ where }: { where: unknown }) =>
      NOTES.find((row) => matchesWhere(row, where)) ?? null,
  );
  mocks.note.update.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = NOTES.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error(`no such note: ${where.id}`);
      return { ...row, ...data, updatedAt: T1 };
    },
  );
});

/** The ids in the log, for the reader currently signed in. */
async function logIds(): Promise<string[]> {
  return (await listAllNotes()).map((note) => note.id).sort();
}

// ---------------------------------------------------------------------------

describe("a shared note reaches the niche it is about, and stops there", () => {
  it("gives a niche-scoped member a shared note on a niche they hold", async () => {
    expect(await logIds()).toContain("gta_shared");
  });

  it("withholds a shared note on a niche they do not hold", async () => {
    const ids = await logIds();

    // Stated one subject at a time. A channel, a niche and a Short are three
    // different joins in the predicate, and any one of them could be the hole.
    expect(ids).not.toContain("rdr_shared");
    expect(ids).not.toContain("niche_rdr_shared");
    expect(ids).not.toContain("video_rdr_shared");
  });

  it("gives them the shared notes on their own niche, whatever the subject", async () => {
    const ids = await logIds();

    expect(ids).toContain("niche_gta_shared");
    expect(ids).toContain("video_gta_shared");
  });

  /**
   * The exception, deliberately. A general note is attached to nothing, so
   * "shared AND in your scope" has no second half to evaluate — there is no
   * subject to scope it by. It carries no channel, no niche and no Short with
   * it, which is what makes org-wide the right answer rather than a leak.
   */
  it("shares a general note across the organization, and only when shared", async () => {
    const ids = await logIds();

    expect(ids).toContain("general_shared");
    expect(ids).not.toContain("general_personal");
  });
});

describe("sharing never reaches somebody else's personal note", () => {
  it("withholds a colleague's personal note on a channel they can see", async () => {
    // The subject is in scope. The note still is not: being able to see a
    // channel is not being able to read what a colleague privately wrote
    // about it, and this is the assertion that separates the two.
    expect(await logIds()).not.toContain("gta_personal");
  });

  it("still gives them their own personal notes", async () => {
    expect(await logIds()).toContain("gta_editor_own");
  });

  it("fails closed when they hold no niches at all", async () => {
    // The case that turns a scoping bug into an outage the other way round: an
    // empty assignment list must mean "no niches", never "no restriction".
    signedInAs(EDITOR, { niches: [] });

    const ids = await logIds();

    // Their own writing is theirs regardless, and a shared GENERAL note is
    // still org-wide — it is attached to nothing, so there is no niche it could
    // be leaking. Every shared note that names a channel, a niche or a Short is
    // gone, including the ones on GTA they could read a moment ago.
    expect(ids).toEqual(["general_shared", "gta_editor_own"]);
    expect(ids).not.toContain("gta_shared");
    expect(ids).not.toContain("niche_gta_shared");
    expect(ids).not.toContain("video_gta_shared");
  });

  it("does not let an author filter widen the answer", async () => {
    // Asking for the admin's notes returns the admin's SHARED, in-scope ones —
    // never the personal one. A filter can only ever narrow: it is ANDed with
    // the visibility predicate, not spread over it.
    const notes = await listAllNotes({ authorId: ADMIN.id });
    const ids = notes.map((note) => note.id);

    expect(ids).toContain("gta_shared");
    expect(ids).not.toContain("gta_personal");
    expect(ids).not.toContain("rdr_shared");
  });
});

describe("the admin's view", () => {
  it("reads everything, shared and personal, on every niche", async () => {
    signedInAs(ADMIN, { admin: true });

    const ids = await logIds();

    expect(ids).toContain("gta_personal");
    expect(ids).toContain("rdr_shared");
    expect(ids).toContain("general_personal");
    expect(ids).toHaveLength(NOTES.length);
  });

  it("attributes every row it did not write", async () => {
    signedInAs(ADMIN, { admin: true });

    const own = (await listAllNotes()).find((note) => note.id === "gta_editor_own");

    // Off the stored column, never from the session. An admin's log is mostly
    // other people's notes, and one that arrives unlabelled is one they edit
    // believing it is theirs.
    expect(own?.createdById).toBe(EDITOR.id);
    expect(own?.createdByName).toBe("Eli Editor");
  });

  it("carries the visibility and the created date on every note", async () => {
    signedInAs(ADMIN, { admin: true });

    const notes = await listAllNotes();
    const shared = notes.find((note) => note.id === "gta_shared");

    // The owner asked for the created date on screen, and a reader cannot judge
    // a note without knowing whether the team can already read it.
    expect(shared?.visibility).toBe("shared");
    expect(shared?.createdAt).toBe(T0.getTime());
    expect(notes.find((note) => note.id === "gta_personal")?.visibility).toBe("personal");
  });

  it("filters by author, in the query", async () => {
    signedInAs(ADMIN, { admin: true });

    const ids = (await listAllNotes({ authorId: EDITOR.id })).map((note) => note.id);

    expect(ids).toEqual(["gta_editor_own"]);
    // In the `where`, not in a `.filter()` afterwards — the rows the admin did
    // not ask for are never loaded.
    expect(mocks.note.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      AND: [{ createdById: EDITOR.id }],
    });
  });

  it("sorts by author name through the relation", async () => {
    signedInAs(ADMIN, { admin: true });

    await listAllNotes({ sort: "author", direction: "asc" });

    expect(mocks.note.findMany.mock.calls[0]?.[0]?.orderBy).toEqual([
      { createdBy: { name: "asc" } },
      { createdAt: "desc" },
    ]);
  });
});

describe("re-sharing somebody else's note", () => {
  it("refuses a colleague who can read it, and never reaches the write", async () => {
    // Eli can see `gta_shared` — it is shared and on their niche. Being shown
    // a note is not being handed control of who else sees it.
    await expect(
      updateNote("gta_shared", { visibility: "personal" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(mocks.note.update).not.toHaveBeenCalled();
  });

  it("refuses them sharing a colleague's personal note", async () => {
    await expect(
      updateNote("gta_personal", { visibility: "shared" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(mocks.note.update).not.toHaveBeenCalled();
  });

  it("lets the author share their own", async () => {
    const updated = await updateNote("gta_editor_own", { visibility: "shared" });

    expect(updated.visibility).toBe("shared");
    // A visibility change is not an edit of the text, and not a change of
    // authorship either.
    expect(mocks.note.update.mock.calls[0]?.[0]?.data).toEqual({ visibility: "shared" });
    expect(updated.createdById).toBe(EDITOR.id);
  });

  it("lets an admin change a colleague's, without adopting it", async () => {
    signedInAs(ADMIN, { admin: true });

    const updated = await updateNote("gta_editor_own", { visibility: "shared" });

    expect(updated.visibility).toBe("shared");
    expect(updated.createdById).toBe(EDITOR.id);
    expect(updated.createdByName).toBe("Eli Editor");
  });
});

describe("the badge and the panel are the same predicate", () => {
  it("counts the notes on a channel exactly as the panel lists them", async () => {
    const listed = await listNotes("channel", GTA_CHANNEL);
    const counts = await getNoteCounts();

    // Eli's own note plus the admin's shared one; not the admin's personal one.
    expect(listed.map((note) => note.id).sort()).toEqual(["gta_editor_own", "gta_shared"]);
    expect(counts.channels[GTA_CHANNEL]).toBe(listed.length);
  });

  it("does not badge a channel whose only note is out of scope", async () => {
    const counts = await getNoteCounts();

    // A count over a panel that will render empty advertises a note the reader
    // cannot open — here, one about a niche they were never assigned.
    expect(counts.channels[RDR_CHANNEL]).toBeUndefined();
  });

  it("badges the whole team's for an admin", async () => {
    signedInAs(ADMIN, { admin: true });

    const counts = await getNoteCounts();

    expect(counts.channels[GTA_CHANNEL]).toBe(3);
    expect(counts.channels[RDR_CHANNEL]).toBe(1);
  });
});
