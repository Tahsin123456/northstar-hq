import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * =========================================================================
 * WHICH CREDENTIAL READS A CHANNEL, WHEN ONE GRANT COVERS SEVERAL
 * =========================================================================
 *
 * THE BUG THIS FILE EXISTS FOR, IN ONE SENTENCE: a connection row is keyed on
 * exactly ONE `youtubeChannelId`, but discovery and tracking are one-to-many —
 * `channels?mine=true` is read with `maxResults=50` deliberately, and
 * `trackOwnChannel` will add any channel the token reports owning. Channels two
 * through N of a single grant therefore had no connection the credential lookup
 * could find. They were marked `ownershipType: "own"`, and then read with the
 * SHARED PUBLIC API KEY.
 *
 * It failed closed nowhere, which is what makes it worth a test rather than a
 * fix: a public read SUCCEEDS. The dashboard fills with plausible numbers from a
 * source the owner asked not to use for their own channels, subtly different
 * from the private ones, with nothing on screen to say the ground had moved.
 *
 * `YouTubeConnectionChannel` is the repair, and these tests pin the three
 * properties that matter: a covered channel resolves to its grant, a covered
 * channel whose grant is broken REFUSES rather than falling back to the key, and
 * a channel nobody has connected is still read exactly as it always was — which
 * is the competitor pipeline, and it must not move an inch.
 *
 * Prisma is a stub. Nothing here is a query; the decision is which row the
 * lookup consults, and a test that needed a database to show it would be
 * testing Prisma.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 5).toString("base64");

const ORG_ID = "org_northstar";
const OTHER_ORG = "org_someone_else";

/** The channel the connection row is keyed on. */
const KEYED_CHANNEL = "UC_keyed";
/** A second channel the same grant covers — the case that used to leak. */
const SECOND_CHANNEL = "UC_second";
/** A competitor: no connection, no coverage row, never had either. */
const COMPETITOR_CHANNEL = "UC_competitor";

interface ConnectionRow {
  id: string;
  status: string;
  youtubeChannelId: string | null;
  channelTitle: string | null;
  googleAccountEmail: string | null;
}

interface CoverageRow {
  organizationId: string;
  youtubeChannelId: string;
  title: string | null;
  connection: { id: string; status: string; googleAccountEmail: string | null };
}

const db = vi.hoisted(() => ({
  connections: [] as unknown[],
  coverage: [] as unknown[],
  /** Set by a test that wants to prove no token was ever minted. */
  tokenReads: 0,
}));

vi.mock("@/server/db", () => ({
  prisma: {
    youTubeConnection: {
      findMany: vi.fn(async ({ where }: { where: { organizationId: string } }) =>
        (db.connections as ConnectionRow[]).filter(
          () => where.organizationId === ORG_ID || where.organizationId === OTHER_ORG,
        ),
      ),
      // Reached only by `getValidAccessToken`. Counted rather than answered, so
      // a test can assert that the refusal path never asked Google for anything.
      findUnique: vi.fn(async () => {
        db.tokenReads += 1;
        return null;
      }),
    },
    youTubeConnectionChannel: {
      findMany: vi.fn(async ({ where }: { where: { organizationId: string } }) =>
        (db.coverage as CoverageRow[]).filter(
          (row) => row.organizationId === where.organizationId,
        ),
      ),
    },
  },
}));

type OAuthModule = typeof import("../youtube-oauth-service");
let oauth: OAuthModule;

beforeEach(async () => {
  oauth ??= await import("../youtube-oauth-service");
  db.tokenReads = 0;

  db.connections = [
    {
      id: "conn_1",
      status: "connected",
      youtubeChannelId: KEYED_CHANNEL,
      channelTitle: "Northstar Shorts",
      googleAccountEmail: "studio@northstar.test",
    } satisfies ConnectionRow,
  ];

  db.coverage = [
    {
      organizationId: ORG_ID,
      youtubeChannelId: KEYED_CHANNEL,
      title: "Northstar Shorts",
      connection: { id: "conn_1", status: "connected", googleAccountEmail: "studio@northstar.test" },
    } satisfies CoverageRow,
    {
      organizationId: ORG_ID,
      youtubeChannelId: SECOND_CHANNEL,
      title: "Northstar Clips",
      connection: { id: "conn_1", status: "connected", googleAccountEmail: "studio@northstar.test" },
    } satisfies CoverageRow,
  ];
});

describe("a second channel from one grant is read with that grant", () => {
  it("reports the second channel's source as the connection, not the public API", async () => {
    const sources = await oauth.channelDataSources(ORG_ID, [KEYED_CHANNEL, SECOND_CHANNEL]);

    expect(sources.get(KEYED_CHANNEL)).toBe("connection");
    // The whole repair. Before the coverage table this was "public", and the
    // channel was quietly read with the shared key while labelled as ours.
    expect(sources.get(SECOND_CHANNEL)).toBe("connection");
  });

  it("resolves a real credential decision for it rather than falling through", async () => {
    db.coverage = (db.coverage as CoverageRow[]).map((row) => ({
      ...row,
      connection: { ...row.connection, status: "needs_reauth" },
    }));

    const credential = await oauth.resolveChannelCredential(ORG_ID, SECOND_CHANNEL);

    /*
     * "connection_unavailable", NOT "public". The distinction is the entire
     * point of the OAuth path: a channel whose grant has stopped working must
     * stop updating visibly rather than reverting to a weaker source that
     * succeeds. `syncChannel` turns this into a recorded failure.
     */
    expect(credential.source).toBe("connection_unavailable");
    if (credential.source === "connection_unavailable") {
      expect(credential.connectionId).toBe("conn_1");
      expect(credential.reason).toMatch(/reconnected/i);
    }
    // And it decided that without asking Google for a token, because the stored
    // status already answers it.
    expect(db.tokenReads).toBe(0);
  });

  it("names the covered channel, never the connection's other channel", async () => {
    db.coverage = (db.coverage as CoverageRow[]).map((row) => ({
      ...row,
      connection: { ...row.connection, status: "revoked" },
    }));

    const credential = await oauth.resolveChannelCredential(ORG_ID, SECOND_CHANNEL);

    if (credential.source === "connection_unavailable") {
      // "Northstar Clips" is this channel; "Northstar Shorts" is the one the
      // connection row happens to be keyed on, and naming it here would tell
      // somebody to go and look at the wrong channel.
      expect(credential.label).toBe("Northstar Clips");
    }
  });
});

describe("what must not change", () => {
  it("leaves a channel nobody has connected on the public API", async () => {
    const sources = await oauth.channelDataSources(ORG_ID, [COMPETITOR_CHANNEL]);
    const credential = await oauth.resolveChannelCredential(ORG_ID, COMPETITOR_CHANNEL);

    expect(sources.get(COMPETITOR_CHANNEL)).toBe("public");
    // Not a fallback: for a competitor the public API is the only source that
    // was ever in play, and this is the competitor pipeline reading exactly as
    // it did before any of this existed.
    expect(credential.source).toBe("public");
    expect(db.tokenReads).toBe(0);
  });

  it("does not lend one workspace's coverage to another", async () => {
    const sources = await oauth.channelDataSources(OTHER_ORG, [SECOND_CHANNEL]);

    expect(sources.get(SECOND_CHANNEL)).toBe("public");
  });

  it("still resolves a connection that has no coverage row yet", async () => {
    // The state of every deployment between the migration's backfill and its
    // first reconnect — and of any row the backfill did not reach.
    db.coverage = [];

    const sources = await oauth.channelDataSources(ORG_ID, [KEYED_CHANNEL, SECOND_CHANNEL]);

    expect(sources.get(KEYED_CHANNEL)).toBe("connection");
    expect(sources.get(SECOND_CHANNEL)).toBe("public");
  });
});
