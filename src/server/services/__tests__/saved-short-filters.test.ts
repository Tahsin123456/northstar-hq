import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTHOR_ME } from "@/lib/dto";
import { matchesWhere } from "./support/prisma-where";

/**
 * Filtering and sorting the saved-Shorts board.
 *
 * The board grew three controls — who saved it, when, and in what order — and
 * they exist because an admin's Saved page is the whole team's shortlists
 * merged into one list. That is the screen those controls make usable, and it
 * is also the screen where getting them wrong is a leak rather than a
 * cosmetic bug.
 *
 * SO THE CLAIM UNDER TEST IS NOT "THE FILTER WORKS". It is that a filter can
 * only ever NARROW:
 *
 *   • the request's `savedById` is ANDed with the ownership filter, never
 *     spread over it — both are conditions on `createdById`, and one object
 *     with both keys would keep only the last one written. If that were ever
 *     the request's, an ordinary member could read a colleague's library by
 *     typing their id into the query string;
 *   • `AUTHOR_ME` resolves against the SESSION, so "mine" cannot be aimed at
 *     somebody else;
 *   • a date range narrows and nothing else moves.
 *
 * Ownership itself — whose rows arrive with no filter at all — is pinned next
 * door in `research-ownership.test.ts`. This file is only about what the query
 * string can and cannot do to that answer.
 *
 * Prisma and the session are stubs, and the Prisma stub APPLIES the `where` and
 * the `orderBy` rather than recording them, for the reason the sibling files
 * give: asserting on the shape of a `where` passes just as happily for a filter
 * that names the wrong column.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 11).toString("base64");

const ORG_ID = "org_northstar";

const ADMIN = { id: "user_admin", name: "Ada Admin", email: "ada@northstar.test" };
const HEAD = { id: "user_head", name: "Hana Head", email: "hana@northstar.test" };
const EDITOR = { id: "user_editor", name: "Bo Editor", email: "bo@northstar.test" };

const CHANNEL_ID = "chan_gta";

const mocks = vi.hoisted(() => ({
  session: { userId: "user_head", isAdmin: false },
  savedShort: { findMany: vi.fn() },
}));

vi.mock("@/server/db", () => ({ prisma: { savedShort: mocks.savedShort } }));

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

// Saved Shorts are scoped by OWNER, not by niche — there is no sharing mode on
// a save. These are stubbed only because the service module imports them for
// its note reads; nothing in this file goes through them.
vi.mock("@/server/auth/niche-scope", () => ({
  getVisibleNicheIds: async () => null,
  trackedChannelNicheFilter: () => ({}),
  nicheFilter: () => ({}),
  nicheIdFilter: () => ({}),
}));

const { listSavedShorts } = await import("../research-service");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Author {
  id: string;
  name: string | null;
  email: string | null;
}

const PUBLISHED = new Date("2026-08-01T09:00:00.000Z");

/** Three distinct days, so a range can land between them rather than on them. */
const JUNE = new Date("2026-06-10T09:00:00.000Z");
const JULY = new Date("2026-07-10T09:00:00.000Z");
const AUGUST = new Date("2026-08-10T09:00:00.000Z");

function saved(id: string, author: Author, videoId: string, savedAt: Date) {
  return {
    id,
    organizationId: ORG_ID,
    createdById: author.id,
    createdBy: author,
    videoId,
    viewsAtSave: BigInt(1_200_000),
    channelMedianAtSave: BigInt(400_000),
    outlierMultipleAtSave: 3,
    savedAt,
    collections: [],
    video: {
      id: videoId,
      youtubeVideoId: `yt_${videoId}`,
      title: `Short ${videoId}`,
      publishedAt: PUBLISHED,
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

type SavedRow = ReturnType<typeof saved>;

const SAVES: SavedRow[] = [
  saved("saved_admin_june", ADMIN, "vid_1", JUNE),
  saved("saved_head_july", HEAD, "vid_2", JULY),
  saved("saved_head_august", HEAD, "vid_3", AUGUST),
  saved("saved_editor_august", EDITOR, "vid_4", AUGUST),
];

function signedInAs(user: Author, options: { admin?: boolean } = {}): void {
  mocks.session.userId = user.id;
  mocks.session.isAdmin = options.admin ?? false;
}

/**
 * The `orderBy` as the service hands it over — applied, not inspected.
 *
 * Only the two shapes the service emits: `{ savedAt: dir }`, and the
 * saver sort's `[{ createdBy: { name: dir } }, { savedAt: "desc" }]`. Anything
 * else throws rather than silently returning fixture order, which would let a
 * broken sort pass as a passing test.
 */
type OrderBy = Record<string, unknown> | Record<string, unknown>[];

function applyOrder(rows: SavedRow[], orderBy: OrderBy | undefined): SavedRow[] {
  if (!orderBy) return rows;
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];

  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      const [key, value] = Object.entries(clause)[0] ?? [];
      if (key === "savedAt" && typeof value === "string") {
        const delta = a.savedAt.getTime() - b.savedAt.getTime();
        if (delta !== 0) return value === "asc" ? delta : -delta;
        continue;
      }
      if (key === "createdBy" && value && typeof value === "object") {
        const direction = (value as { name?: string }).name;
        const left = a.createdBy?.name ?? "";
        const right = b.createdBy?.name ?? "";
        const delta = left.localeCompare(right);
        if (delta !== 0) return direction === "asc" ? delta : -delta;
        continue;
      }
      throw new Error(`unexpected orderBy clause: ${JSON.stringify(clause)}`);
    }
    return 0;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  signedInAs(HEAD);

  mocks.savedShort.findMany.mockImplementation(
    async ({ where, orderBy }: { where: unknown; orderBy?: OrderBy }) =>
      applyOrder(
        SAVES.filter((row) => matchesWhere(row, where)),
        orderBy,
      ),
  );
});

/** The saved-Short ids that came back, in the order the service returned them. */
async function idsFor(query: Parameters<typeof listSavedShorts>[0] = {}) {
  const rows = await listSavedShorts(query);
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------

describe("filtering the board by who saved it", () => {
  it("cannot widen: a member naming a colleague gets nothing, not their library", async () => {
    signedInAs(HEAD);

    // The two conditions on `createdById` contradict — Hana's own, AND Ada's —
    // so the honest answer is the empty one. The failure this guards against is
    // a spread instead of an AND, which would answer with Ada's whole board.
    await expect(idsFor({ savedById: ADMIN.id })).resolves.toEqual([]);
  });

  it("still refuses when the colleague named is the only other saver", async () => {
    // Same rule from the other side, so the case above cannot pass merely
    // because the fixture happened to be empty.
    signedInAs(EDITOR);
    await expect(idsFor({ savedById: HEAD.id })).resolves.toEqual([]);
    // …while their own id, which agrees with the ownership filter, still works.
    await expect(idsFor({ savedById: EDITOR.id })).resolves.toEqual([
      "saved_editor_august",
    ]);
  });

  it("lets an admin narrow to one colleague", async () => {
    signedInAs(ADMIN, { admin: true });

    // The admin's ownership filter is empty, so the request's condition is the
    // only one left and it selects exactly that person's rows.
    await expect(idsFor({ savedById: HEAD.id })).resolves.toEqual([
      "saved_head_august",
      "saved_head_july",
    ]);
  });

  it("keeps the attribution on a narrowed admin read", async () => {
    signedInAs(ADMIN, { admin: true });
    const [row] = await listSavedShorts({ savedById: EDITOR.id });

    // Read off the stored column, never from the session — the admin is
    // looking, but Bo saved it.
    expect(row?.savedById).toBe(EDITOR.id);
    expect(row?.savedByName).toBe("Bo Editor");
  });

  it("resolves 'mine' against the session, not the query string", async () => {
    signedInAs(ADMIN, { admin: true });
    await expect(idsFor({ savedById: AUTHOR_ME })).resolves.toEqual(["saved_admin_june"]);

    // The same sentinel, a different session, a different answer. That is the
    // whole reason it is a sentinel rather than an id the client fills in.
    signedInAs(HEAD);
    await expect(idsFor({ savedById: AUTHOR_ME })).resolves.toEqual([
      "saved_head_august",
      "saved_head_july",
    ]);
  });
});

describe("filtering the board by when it was saved", () => {
  it("narrows to a range without disturbing ownership", async () => {
    signedInAs(HEAD);

    // July onwards: Hana's two, and still none of Ada's or Bo's — the date
    // condition is an extra clause, not a replacement for the author one.
    await expect(idsFor({ savedAfter: JULY.getTime() })).resolves.toEqual([
      "saved_head_august",
      "saved_head_july",
    ]);
  });

  it("applies both ends of the range", async () => {
    signedInAs(ADMIN, { admin: true });

    await expect(
      idsFor({ savedAfter: JULY.getTime(), savedBefore: JULY.getTime() }),
    ).resolves.toEqual(["saved_head_july"]);
  });

  it("combines a date range with a colleague", async () => {
    signedInAs(ADMIN, { admin: true });

    await expect(
      idsFor({ savedById: HEAD.id, savedAfter: AUGUST.getTime() }),
    ).resolves.toEqual(["saved_head_august"]);
  });
});

describe("ordering the board", () => {
  it("is newest first by default", async () => {
    signedInAs(ADMIN, { admin: true });
    await expect(idsFor()).resolves.toEqual([
      "saved_head_august",
      "saved_editor_august",
      "saved_head_july",
      "saved_admin_june",
    ]);
  });

  it("reverses on request", async () => {
    signedInAs(ADMIN, { admin: true });
    await expect(idsFor({ sort: "saved", direction: "asc" })).resolves.toEqual([
      "saved_admin_june",
      "saved_head_july",
      "saved_head_august",
      "saved_editor_august",
    ]);
  });

  it("groups by saver through the relation, newest first within a person", async () => {
    signedInAs(ADMIN, { admin: true });

    // Ada, Bo, Hana by name — and Hana's two in date order, which is the
    // secondary clause doing its job. Sorting in the browser could not produce
    // this, because the browser only holds the rows it was sent.
    await expect(idsFor({ sort: "saver", direction: "asc" })).resolves.toEqual([
      "saved_admin_june",
      "saved_editor_august",
      "saved_head_august",
      "saved_head_july",
    ]);
  });

  it("sorts by saver within a filtered set, not over the whole board", async () => {
    signedInAs(ADMIN, { admin: true });

    await expect(
      idsFor({ sort: "saver", direction: "asc", savedAfter: AUGUST.getTime() }),
    ).resolves.toEqual(["saved_editor_august", "saved_head_august"]);
  });
});
