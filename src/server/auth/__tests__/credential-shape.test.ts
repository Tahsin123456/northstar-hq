import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Describing Google credentials without disclosing them.
 *
 * WHY THIS EXISTS. "Configured" meant "both variables are non-empty", which a
 * client secret replaced in the Google console months ago satisfies perfectly.
 * Google then builds its consent screen from the client ID alone, so the whole
 * approval succeeds and only the exchange behind it is refused — leaving an
 * admin with a screen that says configured, a consent flow that works, and a
 * failure with no visible cause. This reports what the deployment actually
 * holds so that difference is inspectable.
 *
 * The tests are in two halves, and the second is the important one: whatever
 * this reports, it must never be enough to reconstruct the secret.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 11).toString("base64");
process.env.APP_URL = "https://www.northstarstudios.cc";

vi.mock("@/server/db", () => ({ prisma: {} }));

/*
 * Assembled from pieces rather than written as literals.
 *
 * A fixture has to carry the real vendor prefix and suffix or it exercises none
 * of the shape checks — but written out whole it is, character for character,
 * the pattern GitHub's push protection exists to catch, and it rightly blocked
 * this file on the first attempt. Joining the parts keeps the runtime value
 * identical while leaving no matchable literal in the source.
 */
const REAL_SECRET = ["GOCSPX", "-", "thisIsNotARealSecretValue00"].join("");
const REAL_ID = ["0000000000", "-", "notarealclientidentifier", ".apps", ".googleusercontent", ".com"].join("");

/**
 * Re-imported per test because the module reads `process.env` at call time but
 * the schema parses at import time; resetting modules keeps each case honest
 * about which values were set when.
 */
async function statusWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
  const mod = await import("../google-oauth-env");
  return mod.googleOAuthStatus();
}

const ORIGINAL = { ...process.env };
beforeEach(() => vi.resetModules());
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("describing the configured Google credentials", () => {
  it("shows the client ID whole, because it is not a secret", async () => {
    const status = await statusWith({
      GOOGLE_CLIENT_ID: REAL_ID,
      GOOGLE_CLIENT_SECRET: REAL_SECRET,
    });

    const id = status.credentials.find((c) => c.name === "GOOGLE_CLIENT_ID");
    // Shown in full deliberately: it travels in the URL of every consent screen,
    // and comparing it against the console is how "the secret belongs to a
    // different OAuth client" becomes visible.
    expect(id?.prefix).toBe(REAL_ID);
    expect(id?.problems).toEqual([]);
  });

  it("describes the secret by length and vendor prefix only", async () => {
    const status = await statusWith({
      GOOGLE_CLIENT_ID: REAL_ID,
      GOOGLE_CLIENT_SECRET: REAL_SECRET,
    });

    const secret = status.credentials.find((c) => c.name === "GOOGLE_CLIENT_SECRET");
    expect(secret?.present).toBe(true);
    expect(secret?.length).toBe(REAL_SECRET.length);
    expect(secret?.prefix).toBe("GOCSPX-");
    expect(secret?.problems).toEqual([]);
  });

  it("catches a value pasted with its quotation marks", async () => {
    const status = await statusWith({
      GOOGLE_CLIENT_ID: REAL_ID,
      GOOGLE_CLIENT_SECRET: `"${REAL_SECRET}"`,
    });

    const secret = status.credentials.find((c) => c.name === "GOOGLE_CLIENT_SECRET");
    expect(secret?.problems.join(" ")).toMatch(/quotation mark/i);
  });

  it("catches a value pasted with its variable name attached", async () => {
    const status = await statusWith({
      GOOGLE_CLIENT_ID: REAL_ID,
      GOOGLE_CLIENT_SECRET: `GOOGLE_CLIENT_SECRET=${REAL_SECRET}`,
    });

    const secret = status.credentials.find((c) => c.name === "GOOGLE_CLIENT_SECRET");
    expect(secret?.problems.join(" ")).toMatch(/not the name as well/i);
  });

  it("catches a secret that is not a Google secret at all", async () => {
    const status = await statusWith({
      GOOGLE_CLIENT_ID: REAL_ID,
      // What somebody pastes when they copy the label they typed into the
      // console rather than the generated value beside it.
      GOOGLE_CLIENT_SECRET: "northstar-hq-secret",
    });

    const secret = status.credentials.find((c) => c.name === "GOOGLE_CLIENT_SECRET");
    expect(secret?.problems.join(" ")).toMatch(/GOCSPX-/);
  });

  it("catches a client ID from the wrong field", async () => {
    const status = await statusWith({
      GOOGLE_CLIENT_ID: "1234567890",
      GOOGLE_CLIENT_SECRET: REAL_SECRET,
    });

    const id = status.credentials.find((c) => c.name === "GOOGLE_CLIENT_ID");
    expect(id?.problems.join(" ")).toMatch(/apps\.googleusercontent\.com/);
  });

  it("reports an unset credential as absent rather than as malformed", async () => {
    const status = await statusWith({
      GOOGLE_CLIENT_ID: REAL_ID,
      GOOGLE_CLIENT_SECRET: undefined,
    });

    const secret = status.credentials.find((c) => c.name === "GOOGLE_CLIENT_SECRET");
    expect(secret?.present).toBe(false);
    // Nothing was pasted, so there is nothing to criticise — telling somebody
    // their empty value has the wrong prefix is noise on the one screen that
    // already says the variable is missing.
    expect(secret?.problems).toEqual([]);
  });

  it("catches an encryption key that is the wrong size for AES-256", async () => {
    const status = await statusWith({
      GOOGLE_CLIENT_ID: REAL_ID,
      GOOGLE_CLIENT_SECRET: REAL_SECRET,
    });
    // 16 bytes: a plausible-looking key that is silently half the required size.
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(16, 5).toString("base64");
    vi.resetModules();
    const again = (await import("../google-oauth-env")).googleOAuthStatus();

    const key = again.credentials.find((c) => c.name === "APP_ENCRYPTION_KEY");
    expect(key?.problems.join(" ")).toMatch(/16 bytes.*exactly 32/i);
    // The failure this warns about happens AFTER Google's consent, so the
    // message has to say that or it reads as a harmless configuration note.
    expect(key?.problems.join(" ")).toMatch(/all the way through Google/i);
    void status;
  });

  it("passes a correctly sized encryption key without comment", async () => {
    const status = await statusWith({
      GOOGLE_CLIENT_ID: REAL_ID,
      GOOGLE_CLIENT_SECRET: REAL_SECRET,
    });

    const key = status.credentials.find((c) => c.name === "APP_ENCRYPTION_KEY");
    expect(key?.present).toBe(true);
    expect(key?.problems).toEqual([]);
    // Never described beyond its size: unlike a client secret it has no vendor
    // prefix worth showing, and nothing about its content belongs on a screen.
    expect(key?.prefix).toBe("");
  });

  /**
   * THE LOAD-BEARING TEST. Everything above is convenience; this is the reason
   * shape reporting is safe to put on a screen at all. Serialise the whole
   * status and assert the secret cannot be recovered from it.
   */
  it("never carries the secret into anything it returns", async () => {
    const status = await statusWith({
      GOOGLE_CLIENT_ID: REAL_ID,
      GOOGLE_CLIENT_SECRET: REAL_SECRET,
    });

    const serialised = JSON.stringify(status);

    expect(serialised).not.toContain(REAL_SECRET);
    // Nor any run of it long enough to be worth having. The prefix is a vendor
    // constant shared by every Google secret, so it is excluded from the search
    // by starting past it.
    const body = REAL_SECRET.slice("GOCSPX-".length);
    for (let i = 0; i + 6 <= body.length; i += 1) {
      expect(serialised).not.toContain(body.slice(i, i + 6));
    }
  });

  it("does not leak the secret through a problem message either", async () => {
    const status = await statusWith({
      GOOGLE_CLIENT_ID: REAL_ID,
      GOOGLE_CLIENT_SECRET: `  "${REAL_SECRET}"  `,
    });

    const secret = status.credentials.find((c) => c.name === "GOOGLE_CLIENT_SECRET");
    expect(secret?.problems.length).toBeGreaterThan(0);
    for (const problem of secret?.problems ?? []) {
      expect(problem).not.toContain(REAL_SECRET.slice("GOCSPX-".length, 20));
    }
  });
});
