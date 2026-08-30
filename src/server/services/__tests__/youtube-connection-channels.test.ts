import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * =========================================================================
 * WHICH CHANNELS A CONNECTION SAYS IT COVERS, ON THE ADMIN SCREEN
 * =========================================================================
 *
 * THE BUG THIS FILE EXISTS FOR: Admin → YouTube named exactly one channel per
 * connected Google account — `connection.channelTitle`, the single channel the
 * row is keyed on. One account can own several, and the grant covers all of
 * them, so an owner who had just connected an account was reading a card that
 * could not tell them what they had connected.
 *
 * The repair merges two sources that OVERLAP BY CONSTRUCTION:
 * `linkConnectionToTrackedChannel` writes the connection's `youtubeChannelId`
 * column and its first `YouTubeConnectionChannel` row in consecutive
 * statements, so the primary channel is normally in both. Concatenating them
 * renders the studio's main channel twice; dropping the column blanks every
 * connection whose coverage backfill never ran, which is every local SQLite
 * database. Both halves are pinned below.
 *
 * Prisma is a stub, as in `youtube-connection-coverage.test.ts`: nothing here is
 * a query, the decision under test is which rows the mapper keeps and what it
 * calls them, and a test that needed a database to show it would be testing
 * Prisma. The stub does honour `where.organizationId` and the presence of
 * `select.coveredChannels`, because those two are the properties the tests are
 * actually making claims about.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");

const ORG_ID = "org_northstar";
const OTHER_ORG = "org_someone_else";

/** The channel the connection row is keyed on — the account's main channel. */
const MAIN_CHANNEL = "UC_main";
/** A second channel the same grant covers, added later from the channels screen. */
const SECOND_CHANNEL = "UC_clips";
/** A third, covered but never synced, so it has no `Channel` row to enrich it. */
const UNSYNCED_CHANNEL = "UC_unsynced";

interface CoverageRow {
  youtubeChannelId: string;
  title: string | null;
  confirmedAt: Date;
}

/**
 * A row of the real `channels` table — counters included.
 *
 * The figures stay in this fixture ON PURPOSE even though no covered-channel
 * DTO carries one. They exist in the table, so a mapper that reached for them
 * would find them; a fixture that omitted them would make "the query never asks
 * for these" untestable by making them unavailable instead of unasked-for.
 */
interface ChannelRow {
  youtubeChannelId: string;
  title: string;
  handle: string | null;
  avatarUrl: string | null;
  subscriberCount: bigint | null;
  hiddenSubscriberCount: boolean;
}

const db = vi.hoisted(() => ({
  connections: [] as Record<string, unknown>[],
  channels: [] as unknown[],
  /** Every id set the `Channel` lookup was asked for, so scoping is provable. */
  channelLookups: [] as string[][],
  /**
   * Every COLUMN set the `Channel` lookup asked for, so "this card never reads
   * a figure off the globally shared row" is checkable rather than a comment.
   */
  channelSelects: [] as string[][],
}));

vi.mock("@/server/db", () => ({
  prisma: {
    youTubeConnection: {
      findMany: vi.fn(
        async ({
          where,
          select,
        }: {
          where: { organizationId: string };
          select?: Record<string, unknown>;
        }) =>
          db.connections
            // Prisma's own behaviour, and the reason it is worth emulating: an
            // absent filter returns EVERY row. A stub that answered nothing
            // there would let a query that had lost its organization scope look
            // like a query that simply found nothing.
            .filter(
              (row) =>
                where.organizationId === undefined ||
                row.organizationId === where.organizationId,
            )
            .map((row) => {
              // Emulates the one thing about `select` these tests depend on: a
              // relation the caller did not ask for is not on the row. Without
              // this the suite would pass against a mapper reading a relation
              // the real query never selects.
              const { coveredChannels, ...rest } = row;
              return select?.coveredChannels === undefined ? rest : { ...rest, coveredChannels };
            }),
      ),
    },
    channel: {
      findMany: vi.fn(
        async ({
          where,
          select,
        }: {
          where: { youtubeChannelId: { in: string[] } };
          select?: Record<string, unknown>;
        }) => {
          db.channelLookups.push([...where.youtubeChannelId.in]);
          const columns = Object.keys(select ?? {});
          db.channelSelects.push(columns);

          return (db.channels as ChannelRow[])
            .filter((row) => where.youtubeChannelId.in.includes(row.youtubeChannelId))
            // Projects to the selected columns, as Prisma does. An unselected
            // column is genuinely absent, so a mapper that started reading a
            // figure it had not asked for would get `undefined` here rather
            // than a value the real query would never have returned.
            .map((row) =>
              columns.length === 0
                ? row
                : Object.fromEntries(
                    columns
                      .filter((column) => column in row)
                      .map((column) => [column, row[column as keyof ChannelRow]]),
                  ),
            );
        },
      ),
    },
  },
}));

type OAuthModule = typeof import("../youtube-oauth-service");
let oauth: OAuthModule;

/** A healthy connection with every column the DTO mapper reads. */
function connection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "conn_1",
    organizationId: ORG_ID,
    googleAccountEmail: "studio@northstar.test",
    channelTitle: "Northstar Shorts",
    youtubeChannelId: MAIN_CHANNEL,
    scope: "https://www.googleapis.com/auth/youtube.readonly",
    status: "connected",
    lastError: null,
    lastSyncAt: null,
    channelSyncStatus: "ok",
    channelSyncError: null,
    lastChannelSyncAt: null,
    revenueScopeGranted: true,
    monetizationStatus: "unknown",
    revenueSyncStatus: "never",
    revenueSyncError: null,
    lastRevenueSyncAt: null,
    nextSyncAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    connectedBy: { name: "Tahsin", email: "tahsin@northstar.test" },
    coveredChannels: [] as CoverageRow[],
    ...overrides,
  };
}

beforeEach(async () => {
  oauth ??= await import("../youtube-oauth-service");
  db.channelLookups = [];
  db.channelSelects = [];

  db.connections = [
    connection({
      coveredChannels: [
        {
          youtubeChannelId: MAIN_CHANNEL,
          title: "Northstar Shorts",
          confirmedAt: new Date("2026-01-01T00:00:00Z"),
        },
        {
          youtubeChannelId: SECOND_CHANNEL,
          title: "Northstar Clips",
          confirmedAt: new Date("2026-02-01T00:00:00Z"),
        },
      ] satisfies CoverageRow[],
    }),
  ];

  db.channels = [
    {
      youtubeChannelId: MAIN_CHANNEL,
      title: "Northstar Shorts",
      handle: "@northstarshorts",
      avatarUrl: "https://yt3.test/main.jpg",
      subscriberCount: BigInt(412_000),
      hiddenSubscriberCount: false,
    },
    {
      youtubeChannelId: SECOND_CHANNEL,
      title: "Northstar Clips",
      handle: "@northstarclips",
      avatarUrl: null,
      subscriberCount: BigInt(9_100),
      hiddenSubscriberCount: false,
    },
  ] satisfies ChannelRow[];
});

describe("one Google account, several channels", () => {
  it("lists every channel the grant covers, not only the one the row is keyed on", async () => {
    const [connected] = await oauth.listConnections(ORG_ID);

    // The whole feature. Before this the card named "Northstar Shorts" and
    // said nothing whatever about the second channel the same grant reads.
    expect(connected.coveredChannels.map((channel) => channel.youtubeChannelId)).toEqual([
      MAIN_CHANNEL,
      SECOND_CHANNEL,
    ]);
  });

  it("names the main channel first and marks which one it is", async () => {
    db.connections = [
      connection({
        coveredChannels: [
          // Confirmed FIRST, so a list ordered by confirmation alone would put
          // this above the channel the account was actually connected as.
          {
            youtubeChannelId: SECOND_CHANNEL,
            title: "Northstar Clips",
            confirmedAt: new Date("2025-01-01T00:00:00Z"),
          },
          {
            youtubeChannelId: MAIN_CHANNEL,
            title: "Northstar Shorts",
            confirmedAt: new Date("2026-06-01T00:00:00Z"),
          },
        ] satisfies CoverageRow[],
      }),
    ];

    const [connected] = await oauth.listConnections(ORG_ID);

    expect(connected.coveredChannels[0]?.youtubeChannelId).toBe(MAIN_CHANNEL);
    expect(connected.coveredChannels.filter((channel) => channel.isPrimary)).toHaveLength(1);
    expect(connected.coveredChannels[1]?.isPrimary).toBe(false);
  });

  it("identifies each channel by its own name, avatar and link", async () => {
    const [connected] = await oauth.listConnections(ORG_ID);
    const [main, second] = connected.coveredChannels;

    expect(main?.title).toBe("Northstar Shorts");
    expect(main?.avatarUrl).toBe("https://yt3.test/main.jpg");
    // The handle is preferred in the link, exactly as everywhere else.
    expect(main?.channelUrl).toBe("https://www.youtube.com/@northstarshorts");

    // And the second channel is described as ITSELF. Naming it with the
    // connection's `channelTitle` would put the main channel's name on it.
    expect(second?.title).toBe("Northstar Clips");
    expect(second?.handle).toBe("@northstarclips");
  });

  it("still lists a covered channel that has never been synced", async () => {
    db.connections = [
      connection({
        coveredChannels: [
          {
            youtubeChannelId: UNSYNCED_CHANNEL,
            title: "Northstar Vertical",
            confirmedAt: new Date("2026-03-01T00:00:00Z"),
          },
        ] satisfies CoverageRow[],
      }),
    ];

    const [connected] = await oauth.listConnections(ORG_ID);
    const unsynced = connected.coveredChannels.find(
      (channel) => channel.youtubeChannelId === UNSYNCED_CHANNEL,
    );

    // No `Channel` row exists for it, and that is a missing enrichment rather
    // than a missing channel: the grant covers it either way, so it is listed
    // with the title the coverage row recorded and nothing invented around it.
    expect(unsynced?.title).toBe("Northstar Vertical");
    expect(unsynced?.avatarUrl).toBeNull();
    expect(unsynced?.channelUrl).toBe(`https://www.youtube.com/channel/${UNSYNCED_CHANNEL}`);
  });

  /**
   * The hard constraint on this feature, as a test.
   *
   * `Channel.youtubeChannelId` is `@unique` globally rather than per
   * organisation, so one row is shared by every workspace tracking that
   * channel, and `upsertChannel` rewrites it from whichever workspace synced
   * last — including one with no connection to this account, running on the
   * shared public API key. A subscriber count lifted off that row and rendered
   * under this card's "read with this account's own authorisation" heading
   * would be a public-key figure labelled as a connection figure. The fix is
   * not to label it: the card answers WHICH channels, and the figures stay on
   * the channels screen, where `ChannelDTO.dataSource` travels with them.
   *
   * Asserted at the query as well as at the DTO, because only the query proves
   * the value was never fetched to be tempted by.
   */
  it("never reads a figure off the globally shared Channel row", async () => {
    const [connected] = await oauth.listConnections(ORG_ID);
    const [main] = connected.coveredChannels;

    expect(db.channelSelects.length).toBeGreaterThan(0);
    for (const columns of db.channelSelects) {
      expect(columns).not.toContain("subscriberCount");
      expect(columns).not.toContain("hiddenSubscriberCount");
      expect(columns).not.toContain("viewCount");
      expect(columns).not.toContain("videoCount");
    }

    // The fixture row HAS a subscriber count; nothing carried it across.
    expect(main).not.toHaveProperty("subscriberCount");
    expect(main).not.toHaveProperty("hiddenSubscriberCount");
    expect(JSON.stringify(connected.coveredChannels)).not.toContain("412000");
  });
});

describe("the primary channel is in both sources, and must appear once", () => {
  it("does not list the connection's own channel twice", async () => {
    const [connected] = await oauth.listConnections(ORG_ID);
    const ids = connected.coveredChannels.map((channel) => channel.youtubeChannelId);

    /*
     * `linkConnectionToTrackedChannel` writes the connection column and the
     * coverage row for the SAME channel in consecutive statements, so the
     * overlap here is the normal case rather than a corruption. A concatenation
     * would render the studio's main channel twice and make one account look
     * like two.
     */
    expect(ids.filter((id) => id === MAIN_CHANNEL)).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("a connection with no coverage rows", () => {
  it("still names the channel the connection row is keyed on", async () => {
    // The state of every deployment the Postgres backfill did not reach — and
    // of every local SQLite database, where `db push` applies the schema and
    // never the migration SQL. Reading coverage alone would blank these cards.
    db.connections = [connection({ coveredChannels: [] })];

    const [connected] = await oauth.listConnections(ORG_ID);

    expect(connected.coveredChannels).toHaveLength(1);
    expect(connected.coveredChannels[0]?.youtubeChannelId).toBe(MAIN_CHANNEL);
    expect(connected.coveredChannels[0]?.title).toBe("Northstar Shorts");
    expect(connected.coveredChannels[0]?.isPrimary).toBe(true);
    // Not recorded, rather than confirmed at some invented moment.
    expect(connected.coveredChannels[0]?.confirmedAt).toBeNull();
  });

  it("reports no channels for an account that owns none, without inventing one", async () => {
    // A real state, not missing data: `linkConnectionToTrackedChannel` returns
    // before recording anything when Google says the account owns no channel,
    // and the connection is still created and still healthy.
    db.connections = [
      connection({ youtubeChannelId: null, channelTitle: null, coveredChannels: [] }),
    ];

    const [connected] = await oauth.listConnections(ORG_ID);

    expect(connected.coveredChannels).toEqual([]);
    // And nothing was asked of the channel table, because there was no id to
    // ask about — an empty `in` list is a query that scans for nothing.
    expect(db.channelLookups).toEqual([]);
  });

});

describe("a connection whose authorisation has stopped working", () => {
  it("still lists the channels it covers", async () => {
    // A broken grant is the case the live `own-channels` endpoint cannot answer
    // — it queries connections whose status is already "connected". Stored rows
    // answer it, which is why this list is not read from Google.
    db.connections = [
      connection({
        status: "needs_reauth",
        coveredChannels: [
          {
            youtubeChannelId: MAIN_CHANNEL,
            title: "Northstar Shorts",
            confirmedAt: new Date("2026-01-01T00:00:00Z"),
          },
          {
            youtubeChannelId: SECOND_CHANNEL,
            title: "Northstar Clips",
            confirmedAt: new Date("2026-02-01T00:00:00Z"),
          },
        ] satisfies CoverageRow[],
      }),
    ];

    const [connected] = await oauth.listConnections(ORG_ID);

    expect(connected.status).toBe("needs_reauth");
    expect(connected.coveredChannels.map((channel) => channel.youtubeChannelId)).toEqual([
      MAIN_CHANNEL,
      SECOND_CHANNEL,
    ]);
  });
});

describe("workspaces do not see each other's channels", () => {
  beforeEach(() => {
    db.connections = [
      ...db.connections,
      connection({
        id: "conn_other",
        organizationId: OTHER_ORG,
        googleAccountEmail: "someone@else.test",
        channelTitle: "Someone Else",
        youtubeChannelId: "UC_theirs",
        coveredChannels: [
          {
            youtubeChannelId: "UC_theirs",
            title: "Someone Else",
            confirmedAt: new Date("2026-01-01T00:00:00Z"),
          },
        ] satisfies CoverageRow[],
      }),
    ];

    db.channels = [
      ...(db.channels as ChannelRow[]),
      {
        youtubeChannelId: "UC_theirs",
        title: "Someone Else",
        handle: "@someoneelse",
        avatarUrl: null,
        subscriberCount: BigInt(1),
        hiddenSubscriberCount: false,
      },
    ] satisfies ChannelRow[];
  });

  it("returns only the asking workspace's connections and channels", async () => {
    const ours = await oauth.listConnections(ORG_ID);

    expect(ours).toHaveLength(1);
    expect(ours.flatMap((row) => row.coveredChannels.map((c) => c.youtubeChannelId))).not.toContain(
      "UC_theirs",
    );
  });

  it("never asks the shared channel table about another workspace's channel", async () => {
    await oauth.listConnections(ORG_ID);

    /*
     * `Channel` is the globally deduplicated row shared with competitor
     * tracking, so it is NOT org-scoped and the lookup cannot be. The scoping
     * is that every id fed to it came out of a connection row already filtered
     * to one workspace — this asserts exactly that, because a mapper that
     * gathered ids before filtering would leak here and nowhere else.
     */
    expect(db.channelLookups).toHaveLength(1);
    expect(db.channelLookups[0]).toEqual(expect.arrayContaining([MAIN_CHANNEL, SECOND_CHANNEL]));
    expect(db.channelLookups[0]).not.toContain("UC_theirs");
  });

  it("gives the other workspace its own channel and only that", async () => {
    const theirs = await oauth.listConnections(OTHER_ORG);

    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.coveredChannels.map((c) => c.youtubeChannelId)).toEqual(["UC_theirs"]);
  });
});
