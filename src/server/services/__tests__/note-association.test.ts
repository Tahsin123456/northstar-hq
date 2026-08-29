import { beforeEach, describe, expect, it, vi } from "vitest";
import { GENERAL_NOTE_LABEL } from "@/lib/dto";
import { matchesWhere } from "./support/prisma-where";

/**
 * What a note is attached to — including the case of "nothing".
 *
 * The Notes page can now create a note of its own, and the note it creates
 * does not have to be about a channel, a niche or a Short. That is a fourth
 * value of the existing `Note.targetType` column with all three foreign keys
 * left null, not a second note system, and this file pins the three things
 * that makes true:
 *
 *   • the parse enforces the PAIRING. A target and its id travel together or
 *     not at all — there is no request that names a channel and omits which
 *     channel, because that request has no correct handling;
 *   • a general note writes NO foreign key and performs NO target lookup. The
 *     lookup is what proves a target is real and in scope; skipping it for a
 *     kind that has a target would be the hole, and running it for a kind that
 *     has none would be a lookup with nothing to look up;
 *   • the ownership rule is unchanged by any of it. A general note is still a
 *     personal row, so a colleague does not see it.
 *
 * Prisma and the session are stubs. The note stub applies the `where` rather
 * than recording it, for the reason the sibling ownership test gives: asserting
 * on the shape of a `where` passes just as happily for a filter naming the
 * wrong column.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 5).toString("base64");

const ORG_ID = "org_northstar";

const ADMIN = { id: "user_admin", name: "Ada Admin", email: "ada@northstar.test" };
const HEAD = { id: "user_head", name: "Hana Head", email: "hana@northstar.test" };

const CHANNEL_ID = "chan_gta";

const mocks = vi.hoisted(() => ({
  session: { userId: "user_head", isAdmin: false },
  note: { create: vi.fn(), findMany: vi.fn() },
  channel: { findFirst: vi.fn() },
  niche: { findFirst: vi.fn() },
  video: { findFirst: vi.fn() },
}));

vi.mock("@/server/db", () => ({
  prisma: {
    note: mocks.note,
    channel: mocks.channel,
    niche: mocks.niche,
    video: mocks.video,
  },
}));

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

// Not niche-scoped: this file is about what a note is ATTACHED TO. Who may read
// a shared one is `note-visibility.test.ts`, and `null` here means "sees every
// niche", so that dimension cannot quietly explain a result in this file.
vi.mock("@/server/auth/niche-scope", () => ({
  getVisibleNicheIds: async () => null,
  trackedChannelNicheFilter: () => ({}),
  nicheFilter: () => ({}),
  nicheIdFilter: () => ({}),
}));

const { createNote, createNoteSchema, listAllNotes } = await import("../research-service");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Author = { id: string; name: string | null; email: string | null };

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
  channel: null;
  niche: null;
  video: null;
}

const T0 = new Date("2026-08-20T09:00:00.000Z");

function generalNote(id: string, author: Author, body: string): NoteRow {
  return {
    id,
    organizationId: ORG_ID,
    createdById: author.id,
    createdBy: author,
    targetType: "general",
    channelId: null,
    nicheId: null,
    videoId: null,
    body,
    // Personal — the default, and the state in which "a colleague does not see
    // it" is the claim this file makes about a general note.
    visibility: "personal",
    createdAt: T0,
    updatedAt: T0,
    // Every relation comes back null, which is exactly the shape a broken row
    // would have too — the service is required to tell them apart by the
    // recorded kind rather than by the joins.
    channel: null,
    niche: null,
    video: null,
  };
}

const NOTES: NoteRow[] = [
  generalNote("note_head_general", HEAD, "Stop opening on the logo."),
  generalNote("note_admin_general", ADMIN, "Ask about the Q4 budget."),
];

function signedInAs(user: Author, options: { admin?: boolean } = {}): void {
  mocks.session.userId = user.id;
  mocks.session.isAdmin = options.admin ?? false;
}

beforeEach(() => {
  vi.clearAllMocks();
  signedInAs(HEAD);

  mocks.note.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    NOTES.filter((row) => matchesWhere(row, where)),
  );
  // The note that comes back from a create is the data that went in, so an
  // assertion on the returned DTO is an assertion on what was written.
  mocks.note.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: "note_new",
      channelId: null,
      nicheId: null,
      videoId: null,
      createdAt: T0,
      updatedAt: T0,
      createdBy: mocks.session.userId === HEAD.id ? HEAD : ADMIN,
      ...data,
    }),
  );
  mocks.channel.findFirst.mockResolvedValue({ id: CHANNEL_ID });
  mocks.niche.findFirst.mockResolvedValue(null);
  mocks.video.findFirst.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------

describe("createNoteSchema — a target and its id travel together", () => {
  it("accepts a general note carrying only a body", () => {
    const parsed = createNoteSchema.safeParse({
      targetType: "general",
      body: "Stop opening on the logo.",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({
      targetType: "general",
      body: "Stop opening on the logo.",
    });
  });

  it("rejects a targeted note with no target id", () => {
    // The shape an optional `targetId` would have let through, leaving
    // `createNote` to invent a meaning for a channel note with no channel.
    expect(createNoteSchema.safeParse({ targetType: "channel", body: "x" }).success).toBe(
      false,
    );
  });

  it("drops a stray target id from a general note rather than carrying it", () => {
    // A picker opened and backed out of can leave an id in a client's state.
    // It must not reach the row: a note recorded as general with a channelId
    // set would read as general in the log and as a channel note to any query
    // that filters on the column.
    const parsed = createNoteSchema.safeParse({
      targetType: "general",
      targetId: CHANNEL_ID,
      body: "x",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).not.toHaveProperty("targetId");
  });

  it("still rejects an unknown kind and an empty body", () => {
    expect(createNoteSchema.safeParse({ targetType: "team", body: "x" }).success).toBe(false);
    expect(
      createNoteSchema.safeParse({ targetType: "general", body: "   " }).success,
    ).toBe(false);
  });
});

describe("createNote — a general note writes no foreign key and looks nothing up", () => {
  it("records the kind, the author and no association", async () => {
    const note = await createNote({
      targetType: "general",
      body: "  Stop opening on the logo.  ",
    });

    const { data } = mocks.note.create.mock.calls[0][0];
    expect(data.targetType).toBe("general");
    expect(data.organizationId).toBe(ORG_ID);
    // Ownership is written on the way in — it is what every later read filters
    // on, and a general note is no less personal for having no subject.
    expect(data.createdById).toBe(HEAD.id);
    expect(data.channelId).toBeUndefined();
    expect(data.nicheId).toBeUndefined();
    expect(data.videoId).toBeUndefined();
    expect(data.body).toBe("Stop opening on the logo.");

    expect(note.targetType).toBe("general");
    expect(note.targetId).toBe("");
  });

  it("performs no existence check, because there is nothing to check", async () => {
    await createNote({ targetType: "general", body: "Ask about the Q4 budget." });

    expect(mocks.channel.findFirst).not.toHaveBeenCalled();
    expect(mocks.niche.findFirst).not.toHaveBeenCalled();
    expect(mocks.video.findFirst).not.toHaveBeenCalled();
  });

  it("still verifies a real target, and scopes that check to the organization", async () => {
    await createNote({ targetType: "channel", targetId: CHANNEL_ID, body: "Shifted format." });

    expect(mocks.channel.findFirst).toHaveBeenCalledTimes(1);
    const { where } = mocks.channel.findFirst.mock.calls[0][0];
    expect(where.id).toBe(CHANNEL_ID);
    // Scoped through the tracking join, not by id alone — otherwise the 404 /
    // 201 split tells a caller whether another tenant tracks that channel.
    expect(where.trackedBy).toEqual({ some: { organizationId: ORG_ID } });

    const { data } = mocks.note.create.mock.calls[0][0];
    expect(data.channelId).toBe(CHANNEL_ID);
    expect(data.targetType).toBe("channel");
  });

  it("refuses a target outside the organization without writing anything", async () => {
    mocks.channel.findFirst.mockResolvedValue(null);

    await expect(
      createNote({ targetType: "channel", targetId: "chan_someone_elses", body: "x" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // The refusal has to land before the insert, or the check is decoration.
    expect(mocks.note.create).not.toHaveBeenCalled();
  });
});

describe("listAllNotes — a general note in the log", () => {
  it("is labelled from its recorded kind, with no borrowed context", async () => {
    const notes = await listAllNotes();
    const own = notes.find((row) => row.id === "note_head_general");

    expect(own).toBeDefined();
    expect(own?.targetType).toBe("general");
    expect(own?.targetLabel).toBe(GENERAL_NOTE_LABEL);
    // "Unknown" was the old fall-through for a note matching no relation, and
    // it is still the right answer for a broken row — just not for this one.
    expect(own?.targetLabel).not.toBe("Unknown");
    expect(own?.channelId).toBeNull();
    expect(own?.channelName).toBeNull();
    expect(own?.videoId).toBeNull();
    expect(own?.youtubeVideoId).toBeNull();
    expect(own?.niches).toEqual([]);
  });

  it("is personal like every other note — a colleague's does not come back", async () => {
    const notes = await listAllNotes();

    expect(notes.map((row) => row.id)).toEqual(["note_head_general"]);
    expect(notes.some((row) => row.createdById === ADMIN.id)).toBe(false);
  });

  it("reaches an admin holding users.manage, attributed", async () => {
    signedInAs(ADMIN, { admin: true });

    const notes = await listAllNotes();
    const colleagues = notes.find((row) => row.id === "note_head_general");

    expect(notes).toHaveLength(2);
    // Never anonymously: the admin has to be able to tell a general note of
    // their own from one of Hana's, and a general note carries no context to
    // give the answer away.
    expect(colleagues?.createdById).toBe(HEAD.id);
    expect(colleagues?.createdByName).toBe("Hana Head");
  });
});
