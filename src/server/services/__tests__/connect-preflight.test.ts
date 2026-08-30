import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The check that runs BEFORE anybody is sent to Google's consent screens.
 *
 * A stale client secret is invisible until the last step — Google builds consent
 * from the client id alone, so the warning, the account chooser, the second
 * warning, the permission list and Continue all succeed, and only the exchange
 * behind them fails. Every retry costs all five screens and learns nothing. This
 * probe spends one request to replace that with a sentence.
 *
 * THE DANGEROUS HALF IS FAILING CLOSED. A probe that treats a timeout or an
 * outage as "credentials bad" would block connections that would have worked
 * perfectly — turning a diagnostic into an outage of its own, and one that looks
 * exactly like the bug it was written to explain. So most of these tests are
 * about the ways it must NOT block.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 13).toString("base64");
process.env.APP_URL = "https://www.northstarstudios.cc";
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
process.env.GOOGLE_CLIENT_ID = ["000000000000", "-", "preflight.apps", ".googleusercontent", ".com"].join("");
process.env.GOOGLE_CLIENT_SECRET = ["GOCSPX", "-", "preflightTestValue"].join("");

vi.mock("@/server/db", () => ({ prisma: {} }));

const { clientCredentialsAccepted } = await import("../youtube-oauth-service");

/** A Google token-endpoint response, as `fetch` would deliver it. */
function googleReplies(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

const realFetch = globalThis.fetch;
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the pre-flight credential probe", () => {
  it("blocks the trip when Google says the client is invalid", async () => {
    globalThis.fetch = googleReplies(401, { error: "invalid_client" }) as never;

    expect(await clientCredentialsAccepted()).toBe(false);
  });

  it("allows the trip when only the fake code was refused", async () => {
    // `invalid_grant` is the SUCCESS signal here: Google got past authenticating
    // the client and rejected the deliberately bogus code, which is exactly what
    // a healthy pair does.
    globalThis.fetch = googleReplies(400, { error: "invalid_grant" }) as never;

    expect(await clientCredentialsAccepted()).toBe(true);
  });

  it("allows the trip when Google is down", async () => {
    globalThis.fetch = googleReplies(503, {}) as never;

    expect(await clientCredentialsAccepted()).toBe(true);
  });

  it("allows the trip when the request throws", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network unreachable")) as never;

    expect(await clientCredentialsAccepted()).toBe(true);
  });

  it("allows the trip on an error code it has never seen", async () => {
    // Google may add codes. An unknown one must not be read as "credentials
    // bad" — the real exchange remains the authority, and guessing here would
    // block working setups on Google's schedule rather than ours.
    globalThis.fetch = googleReplies(400, { error: "some_future_google_error" }) as never;

    expect(await clientCredentialsAccepted()).toBe(true);
  });

  it("sends a code that cannot possibly grant anything", async () => {
    const fetchMock = googleReplies(400, { error: "invalid_grant" });
    globalThis.fetch = fetchMock as never;

    await clientCredentialsAccepted();

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    const sent = new URLSearchParams(init.body);
    expect(sent.get("grant_type")).toBe("authorization_code");
    // The whole safety argument for running this on every connect click: the
    // code is nonsense, so the probe can consume nothing and change nothing.
    expect(sent.get("code")).toBe("preflight-probe-not-a-real-code");
  });

  it("probes with the same redirect URI the real exchange will use", async () => {
    const fetchMock = googleReplies(400, { error: "invalid_grant" });
    globalThis.fetch = fetchMock as never;

    await clientCredentialsAccepted();

    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    // A probe that differed from the real request could pass while the real one
    // fails, which is worse than no probe at all.
    expect(new URLSearchParams(init.body).get("redirect_uri")).toBe(
      "https://www.northstarstudios.cc/api/youtube/callback",
    );
  });
});
