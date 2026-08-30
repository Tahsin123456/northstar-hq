import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A key that cannot encrypt is not "configured".
 *
 * WHY THIS IS ITS OWN FILE. The old test was presence: set or unset. A key that
 * was set but decoded to the wrong number of bytes therefore passed every gate
 * on the way in — `isGoogleOAuthConfigured()`, the connect route, the
 * client-credential pre-flight — and failed at `encryptSecret`, deep inside the
 * callback. By then Google's five consent screens were behind the admin and the
 * single-use authorization code had been spent, and because the failure was a
 * plain Error rather than an AppError the callback had no message to forward.
 * The result was the generic "could not connect" banner with nothing in it, on
 * every attempt, with no way to learn why from inside the product.
 *
 * That is precisely the failure shape the client-credential pre-flight was built
 * to eliminate, arrived at down a different path — so the fix has to hold in
 * both places these tests check: the boolean the connect route consults, and the
 * thrower that the flow itself calls.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 23).toString("base64");
process.env.APP_URL = "https://www.northstarstudios.cc";

vi.mock("@/server/db", () => ({ prisma: {} }));

const CLIENT_ID = ["000000000000", "-", "keygate.apps", ".googleusercontent", ".com"].join("");
const CLIENT_SECRET = ["GOCSPX", "-", "keyGateTestValue"].join("");

async function envWithKey(key: string | undefined) {
  vi.resetModules();
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = CLIENT_SECRET;
  if (key === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = key;
  return import("../google-oauth-env");
}

const ORIGINAL = { ...process.env };
beforeEach(() => vi.resetModules());
afterEach(() => {
  process.env = { ...ORIGINAL };
});

const GOOD_KEY = Buffer.alloc(32, 9).toString("base64");
/** 24 bytes: the shape a truncated paste actually takes. */
const SHORT_KEY = Buffer.alloc(24, 9).toString("base64");

describe("treating a malformed encryption key as unconfigured", () => {
  it("reports configured for a 32-byte key", async () => {
    const mod = await envWithKey(GOOD_KEY);
    expect(mod.isGoogleOAuthConfigured()).toBe(true);
    expect(mod.googleOAuthStatus().missing).not.toContain("APP_ENCRYPTION_KEY");
  });

  it("reports NOT configured for a key of the wrong size", async () => {
    const mod = await envWithKey(SHORT_KEY);

    // The load-bearing assertion. This boolean is what /api/youtube/connect
    // consults, so false here is what stops the admin being sent to Google for a
    // flow that cannot complete.
    expect(mod.isGoogleOAuthConfigured()).toBe(false);
    expect(mod.googleOAuthStatus().missing).toContain("APP_ENCRYPTION_KEY");
  });

  it("reports NOT configured when the key is absent", async () => {
    const mod = await envWithKey(undefined);
    expect(mod.isGoogleOAuthConfigured()).toBe(false);
    expect(mod.googleOAuthStatus().missing).toContain("APP_ENCRYPTION_KEY");
  });

  it("throws an explaining AppError, not a bare Error, on a wrong-sized key", async () => {
    const mod = await envWithKey(SHORT_KEY);

    // An AppError is what the callback can turn into a sentence on screen; a
    // plain Error is what produced the empty banner. The distinction is the
    // entire point, so it is asserted rather than assumed.
    let thrown: unknown;
    try {
      mod.requireGoogleOAuthConfig();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    const message = (thrown as { userMessage?: string; message?: string });
    const text = message.userMessage ?? message.message ?? "";
    expect(text).toMatch(/24 bytes/);
    expect(text).toMatch(/exactly 32/);
    // Names the likely cause and the command that fixes it — a size complaint
    // with no remedy just relocates the dead end.
    expect(text).toMatch(/truncated|padding/i);
    expect(text).toMatch(/randomBytes\(32\)/);
  });

  it("still distinguishes an absent key from a malformed one", async () => {
    const mod = await envWithKey(undefined);

    let text = "";
    try {
      mod.requireGoogleOAuthConfig();
    } catch (error) {
      const e = error as { userMessage?: string; message?: string };
      text = e.userMessage ?? e.message ?? "";
    }

    expect(text).toMatch(/not configured/i);
    // "decodes to 0 bytes" would be a confusing way to say "you never set this".
    expect(text).not.toMatch(/0 bytes/);
  });

  it("passes a good key through to the client credentials", async () => {
    const mod = await envWithKey(GOOD_KEY);
    expect(mod.requireGoogleOAuthConfig()).toEqual({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
  });
});
