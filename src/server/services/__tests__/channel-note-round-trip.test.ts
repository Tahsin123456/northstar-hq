import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchesWhere } from "./support/prisma-where";

/**
 * A note written from a channel page, followed all the way back out again.
 *
 * ==========================================================================
 * WHY THIS FILE EXISTS AS A ROUND TRIP RATHER THAN THREE UNIT TESTS
 * ==========================================================================
 * The reported symptom was "channel notes don't work" — the note saves, and
 * then it is nowhere. Nothing about that is visible from either end on its own:
 * the write succeeds, the reads are correct, and every one of them passes its
 * own test. It breaks in the JOIN between them, and there is exactly one way
 * for it to break — the four places below disagreeing about WHICH ID a channel
 * note is keyed by.
 *
 * A channel has two ids in this system. `Channel.id` is the global,
 * deduplicated row shared between organizations; `TrackedChannel.id` is one
 * organization's tracking of it. `ChannelDTO.id` — what the channel page holds,
 * what its URL contains, and therefore what `NotesPanel` sends as `targetId` —
 * is the FORMER. So `Note.channelId`, the existence check, the panel read, the
 * badge count and the log must all be the former too. Any single one of them
 * drifting to the tracking id produces precisely the reported bug: a note that
 * writes without complaint and is then invisible to every surface that would
 * show it.
 *
 * The fixtures below therefore give the tracking row a DIFFERENT id from the
 * channel it tracks, so a regression to the wrong one cannot coincidentally
 * pass. The Prisma stub applies the `where` rather than recording it, for the
 * reason the sibling research tests give.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 13).toString("base64");

const ORG_ID = "org_northstar";
const OTHER_ORG_ID = "org_rival";

const HEAD = { id: "user_head", name: "Hana Head", email: "hana@northstar.test" };

/** The global row — this is `ChannelDTO.id`, and what the channel URL carries. */
const CHANNEL_ID = "chan_gta";
/** This organization's tracking of it. Deliberately NOT the id above. */
const TRACKED_ID = "tracked_gta_northstar";

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

// Unscoped by niche: this file is about the id, not about who may see it.
// `note-visibility.test.ts` owns the scoping rule.
vi.mock("@/server/auth/niche-scope", () => ({
  getVisibleNicheIds: async () => null,
  trackedChannelNicheFilter: () => ({}),
  nicheFilter: () => ({}),
  nicheIdFilter: () => ({}),
}));

const { createNote, getNoteCounts, listAllNotes, listNotes } = await import(
  "../research-service"
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The channel as the database holds it, with its tracking rows.
 *
 * Two organizations track the same global channel, which is the situation
 * `Channel` being shared exists for — and the reason the existence check has to
 * reach tenancy through `trackedBy` rather than through a column.
 */
const CHANNEL_ROW = {
  id: CHANNEL_ID,
  title: "GTA Clips Daily",
  avatarUrl: null,
  trackedBy: [
    {
      id: TRACKED_ID,
      organizationId: ORG_ID,
      label: "GTA Daily",
      niches: [{ niche: { id: "niche_gta", name: "GTA", colorIndex: 2 } }],
    },
    {
      id: "tracked_gta_rival",
      organizationId: OTHER_ORG_ID,
      label: "Their label",
      niches: [],
    },
  ],
};

interface NoteRow {
  id: string;
  organizationId: string;
  createdById: string | null;
  createdBy: typeof HEAD | null;
  targetType: string;
  channelId: string | null;
  nicheId: string | null;
  videoId: string | null;
  body: string;
  visibility: string;
  createdAt: Date;
  updatedAt: Date;
  /** The joins `listAllNotes` resolves context from. */
  channel: typeof CHANNEL_ROW | null;
  niche: null;
  video: null;
}

const NOW = new Date("2026-08-29T10:00:00.000Z");

/** Everything written so far, in insertion order. Reset per test. */
let table: NoteRow[] = [];
let nextId = 0;

beforeEach(() => {
  vi.clearAllMocks();
  table = [];
  nextId = 0;
  mocks.session.userId = HEAD.id;
  mocks.session.isAdmin = false;

  // The existence check, applied for real: only a channel this organization
  // actually tracks comes back.
  mocks.channel.findFirst.mockImplementation(async ({ where }: { where: unknown }) =>
    matchesWhere(CHANNEL_ROW, where) ? { id: CHANNEL_ROW.id } : null,
  );

  mocks.note.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => {
      const row: NoteRow = {
        id: `note_${(nextId += 1)}`,
        organizationId: String(data.organizationId),
        createdById: (data.createdById as string | null) ?? null,
        createdBy: HEAD,
        targetType: String(data.targetType),
        // Read off whatever the service actually wrote. If it ever stops
        // writing `channelId`, every read below goes quiet — which is the bug.
        channelId: (data.channelId as string | undefined) ?? null,
        nicheId: (data.nicheId as string | undefined) ?? null,
        videoId: (data.videoId as string | undefined) ?? null,
        body: String(data.body),
        visibility: String(data.visibility),
        createdAt: NOW,
        updatedAt: NOW,
        // The relation the database would resolve from the key just written,
        // rather than one handed over by the caller.
        channel:
          (data.channelId as string | undefined) === CHANNEL_ID ? CHANNEL_ROW : null,
        niche: null,
        video: null,
      };
      table.push(row);
      return row;
    },
  );

  mocks.note.findMany.mockImplementation(async ({ where }: { where: unknown }) =>
    table.filter((row) => matchesWhere(row, where)),
  );
});

/** What the channel page does when somebody presses Add note. */
function addChannelNote(body: string, targetId: string = CHANNEL_ID) {
  return createNote({ targetType: "channel", targetId, body });
}

// ---------------------------------------------------------------------------

describe("a note added from a channel page", () => {
  it("is keyed by the channel id the page holds, not by the tracking row", async () => {
    await addChannelNote("Payoff lands at 6 seconds.");

    const [row] = table;
    expect(row?.targetType).toBe("channel");
    expect(row?.channelId).toBe(CHANNEL_ID);
    // The whole bug, stated as an assertion. A note keyed by the tracking row
    // writes cleanly and is then unreachable from every surface below.
    expect(row?.channelId).not.toBe(TRACKED_ID);
    // A channel note carries no other association.
    expect(row?.nicheId).toBeNull();
    expect(row?.videoId).toBeNull();
  });

  it("comes back from the panel on that same channel", async () => {
    await addChannelNote("Payoff lands at 6 seconds.");

    // Exactly the call `NotesPanel` makes: the target type it is mounted with,
    // and `ChannelDTO.id`.
    const notes = await listNotes("channel", CHANNEL_ID);
    expect(notes.map((note) => note.body)).toEqual(["Payoff lands at 6 seconds."]);
    expect(notes[0]?.targetId).toBe(CHANNEL_ID);
  });

  it("is counted by the badge over that panel", async () => {
    await addChannelNote("One.");
    await addChannelNote("Two.");

    const counts = await getNoteCounts();
    expect(counts.channels[CHANNEL_ID]).toBe(2);
  });

  it("appears in the central log, carrying the channel it is about", async () => {
    await addChannelNote("Payoff lands at 6 seconds.");

    const [note] = await listAllNotes();
    expect(note?.targetType).toBe("channel");
    expect(note?.channelId).toBe(CHANNEL_ID);
    // Labelled from OUR tracking row's label, not the rival organization's —
    // the context join is filtered to this organization.
    expect(note?.channelName).toBe("GTA Daily");
    expect(note?.targetLabel).toBe("GTA Daily");
    expect(note?.niches.map((niche) => niche.name)).toEqual(["GTA"]);
  });

  it("is attributed to its author, on every one of those surfaces", async () => {
    await addChannelNote("Payoff lands at 6 seconds.");

    const [fromPanel] = await listNotes("channel", CHANNEL_ID);
    const [fromLog] = await listAllNotes();

    // Read off the stored column on both paths — the same note, the same
    // author, whichever screen it is being looked at from.
    expect(fromPanel?.createdById).toBe(HEAD.id);
    expect(fromPanel?.createdByName).toBe("Hana Head");
    expect(fromLog?.createdById).toBe(HEAD.id);
    expect(fromLog?.createdByName).toBe("Hana Head");
  });

  it("is personal unless the author said otherwise", async () => {
    await addChannelNote("Payoff lands at 6 seconds.");
    expect(table[0]?.visibility).toBe("personal");

    const [note] = await listNotes("channel", CHANNEL_ID);
    expect(note?.visibility).toBe("personal");
  });

  it("filters the log down to that channel by the same id", async () => {
    await addChannelNote("On the channel.");

    // What the log's Channel menu sends — `ChannelDTO.id` again, so the filter
    // and the stored key cannot disagree.
    const matching = await listAllNotes({ channelId: CHANNEL_ID });
    expect(matching).toHaveLength(1);

    const other = await listAllNotes({ channelId: "chan_rdr" });
    expect(other).toEqual([]);
  });
});

describe("the target check behind that write", () => {
  it("refuses a channel this organization does not track, and writes nothing", async () => {
    await expect(addChannelNote("Nice try.", "chan_untracked")).rejects.toThrow();
    expect(mocks.note.create).not.toHaveBeenCalled();
    expect(table).toEqual([]);
  });

  it("refuses the TRACKING row's id, which is not what a note is keyed by", async () => {
    // Belt and braces on the identity above: if the check ever started
    // accepting a `TrackedChannel.id`, a note keyed by it would pass validation
    // here and then be invisible to every read. It must not resolve.
    await expect(addChannelNote("Wrong id.", TRACKED_ID)).rejects.toThrow();
    expect(mocks.note.create).not.toHaveBeenCalled();
  });

  it("checks existence before writing, never after", async () => {
    await addChannelNote("Fine.");

    // The lookup is what proves the target is real AND in scope. A write that
    // happened first would leave a dangling note behind a later refusal.
    const lookupOrder = mocks.channel.findFirst.mock.invocationCallOrder[0] ?? 0;
    const writeOrder = mocks.note.create.mock.invocationCallOrder[0] ?? 0;
    expect(lookupOrder).toBeLessThan(writeOrder);
  });
});
