import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * =========================================================================
 * TWO FAILURES THAT LOOK ALIKE AND MUST NOT BE TREATED ALIKE
 * =========================================================================
 *
 * "Google says the grant is gone" and "we cannot decrypt what we stored" both
 * end with a connection that cannot be used, and they used to run through the
 * same function — which destroyed the stored ciphertext in both cases.
 *
 * For a revoked grant that is free: the tokens are provably worthless, and
 * clearing them shrinks the window in which a database leak yields a live
 * credential.
 *
 * For a decrypt failure it is damage. The cause is APP_ENCRYPTION_KEY having
 * changed — rotated, or an environment restored from a different backup — and
 * the tokens themselves may be perfectly good. Deleting them meant:
 *
 *   • restoring the correct key could no longer recover the connection, while
 *     the `lastError` written in the same breath told the admin to do exactly
 *     that, and
 *   • the grant stayed LIVE at Google with the only credential that could
 *     revoke it now gone — the precise outcome `disconnect`'s ordering exists
 *     to prevent.
 *
 * It is also why APP_ENCRYPTION_KEY could not be rotated safely, which matters:
 * that key currently sits in a plaintext file beside the production database
 * URL, and rotating it is the remedy.
 *
 * No network. Google's token endpoint is a stubbed `fetch`, because what is
 * under test is which columns each failure writes.
 */

// Read at import time by `auth-env` / `google-oauth-env`, so they are set before
// the dynamic import below. Test-local values; nothing here reaches Google.
process.env.SESSION_SECRET = Buffer.alloc(32, 13).toString("base64");
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
process.env.GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";

const CONNECTION_ID = "conn_1";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
    id: args.where.id,
  })),
}));

vi.mock("@/server/db", () => ({
  prisma: {
    youTubeConnection: { findUnique: mocks.findUnique, update: mocks.update },
  },
}));

type OAuthModule = typeof import("../youtube-oauth-service");
type CryptoModule = typeof import("@/server/auth/crypto");

let oauth: OAuthModule;
let crypto: CryptoModule;

beforeAll(async () => {
  oauth = await import("../youtube-oauth-service");
  crypto = await import("@/server/auth/crypto");
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockResolvedValue({ id: CONNECTION_ID });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The `data` of the single write the refresh attempt made. */
function connectionWrite(): Record<string, unknown> {
  expect(mocks.update).toHaveBeenCalledTimes(1);
  const [call] = mocks.update.mock.calls[0];
  expect(call.where.id).toBe(CONNECTION_ID);
  return call.data;
}

describe("a token that cannot be decrypted", () => {
  beforeEach(() => {
    // Well-formed envelope, wrong key: exactly what a rotated or restored
    // APP_ENCRYPTION_KEY produces.
    mocks.findUnique.mockResolvedValue({
      id: CONNECTION_ID,
      refreshTokenEnc: "v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.CCCCCCCCCCCC",
    });
  });

  it("KEEPS the ciphertext, so restoring the key recovers the connection", async () => {
    const refreshed = await oauth.refreshAccessToken(CONNECTION_ID);

    expect(refreshed).toBeNull();

    const data = connectionWrite();
    expect(data.status).toBe("needs_reauth");
    /*
     * The assertion this whole file is for. `undefined` means the columns are
     * not in the write at all; a `null` here would be the old behaviour, which
     * threw away a possibly-good credential and stranded a live grant at Google.
     */
    expect(data.accessTokenEnc).toBeUndefined();
    expect(data.refreshTokenEnc).toBeUndefined();
  });

  it("tells the admin to restore the key, which is now actually true", async () => {
    await oauth.refreshAccessToken(CONNECTION_ID);

    expect(String(connectionWrite().lastError)).toMatch(/APP_ENCRYPTION_KEY/);
    expect(String(connectionWrite().lastError)).toMatch(/restore the original key/i);
  });

  it("never asks Google anything, because there is nothing to ask with", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await oauth.refreshAccessToken(CONNECTION_ID);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("a grant Google has revoked", () => {
  beforeEach(() => {
    mocks.findUnique.mockResolvedValue({
      id: CONNECTION_ID,
      // Genuinely decryptable, so the flow reaches Google and fails there
      // instead of failing at the key.
      refreshTokenEnc: crypto.encryptSecret("1//real-refresh-token"),
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid_grant" }),
        text: async () => '{"error":"invalid_grant"}',
      })),
    );
  });

  it("DOES destroy the ciphertext, because it is provably worthless", async () => {
    const refreshed = await oauth.refreshAccessToken(CONNECTION_ID);

    expect(refreshed).toBeNull();

    const data = connectionWrite();
    expect(data.status).toBe("needs_reauth");
    expect(data.accessTokenEnc).toBeNull();
    expect(data.refreshTokenEnc).toBeNull();
    expect(data.accessTokenExpiresAt).toBeNull();
    expect(String(data.lastError)).toMatch(/revoked this authorisation/i);
  });
});
