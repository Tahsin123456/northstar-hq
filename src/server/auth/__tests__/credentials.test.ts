import { beforeAll, describe, expect, it } from "vitest";

/**
 * Credential handling: password hashing and session-token signing.
 *
 * These are the two pieces of code where a subtle mistake is invisible in
 * normal use and total in an incident, so they are tested against behaviour
 * rather than shape: a tampered token must not verify, a wrong password must
 * not pass, and a corrupt stored hash must fail rather than throw.
 *
 * scrypt at the configured cost is ~64 MiB and takes real time, so the password
 * cases here are deliberately few. That cost is the point of the algorithm; the
 * suite pays it once rather than avoiding it.
 */

// The token module reads SESSION_SECRET at call time via auth-env, which parses
// process.env at import. Set it before the dynamic imports below.
process.env.SESSION_SECRET = Buffer.alloc(32, 9).toString("base64");

type PasswordModule = typeof import("@/server/auth/password");
type TokenModule = typeof import("@/server/auth/tokens");

let password: PasswordModule;
let tokens: TokenModule;

beforeAll(async () => {
  password = await import("@/server/auth/password");
  tokens = await import("@/server/auth/tokens");
});

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const hash = await password.hashPassword("correct horse battery staple");

    expect((await password.verifyPassword("correct horse battery staple", hash)).valid).toBe(true);
    expect((await password.verifyPassword("Correct horse battery staple", hash)).valid).toBe(false);
    expect((await password.verifyPassword("", hash)).valid).toBe(false);
  }, 30_000);

  it("produces a different hash every time", async () => {
    // A per-password random salt is what stops one rainbow table covering every
    // account, and what stops two colleagues with the same password being
    // visibly identical in the database.
    const a = await password.hashPassword("the same passphrase");
    const b = await password.hashPassword("the same passphrase");
    expect(a).not.toBe(b);
    expect((await password.verifyPassword("the same passphrase", a)).valid).toBe(true);
    expect((await password.verifyPassword("the same passphrase", b)).valid).toBe(true);
  }, 40_000);

  it("records its cost parameters in the hash", async () => {
    const hash = await password.hashPassword("parameters are embedded");
    const [algorithm, n, r, p] = hash.split("$");
    expect(algorithm).toBe("scrypt");
    // Storing them is what lets the cost be raised later without invalidating
    // every existing password.
    expect(Number(n)).toBe(65_536);
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(2);
  }, 20_000);

  it("fails rather than throws on a malformed or missing hash", async () => {
    // Throwing here would let an attacker tell "no such user" from "corrupt
    // record" by watching for a 500.
    for (const stored of [null, undefined, "", "not-a-hash", "scrypt$$$$", "bcrypt$1$2$3$4$5"]) {
      const result = await password.verifyPassword("anything", stored);
      expect(result.valid).toBe(false);
    }
  });

  it("refuses a stored hash demanding more work than policy allows", async () => {
    // A hostile row could otherwise ask for gigabytes of memory per login.
    const absurd = ["scrypt", 1 << 30, 64, 64, "c2FsdA==", "aGFzaA=="].join("$");
    expect((await password.verifyPassword("anything", absurd)).valid).toBe(false);
  });

  it("enforces length, not composition", async () => {
    expect(password.validatePasswordStrength("short")).not.toBeNull();
    expect(password.validatePasswordStrength("a".repeat(11))).not.toBeNull();
    // Twelve lowercase characters is fine; NIST guidance is explicit that
    // composition rules push people toward weaker, harder-to-remember secrets.
    expect(password.validatePasswordStrength("correcthorse")).toBeNull();
    expect(password.validatePasswordStrength("a".repeat(300))).not.toBeNull();
    expect(password.validatePasswordStrength("password")).not.toBeNull();
  });
});

describe("session tokens", () => {
  it("round-trips a signed cookie", () => {
    const token = tokens.generateToken();
    const cookie = tokens.formatSessionCookie(token);
    expect(tokens.readSessionCookie(cookie)).toBe(token);
  });

  it("rejects a tampered token", () => {
    const token = tokens.generateToken();
    const cookie = tokens.formatSessionCookie(token);
    const [body, signature] = cookie.split(".");

    // Change the token but keep the signature.
    const swapped = `${tokens.generateToken()}.${signature}`;
    expect(tokens.readSessionCookie(swapped)).toBeNull();

    // Keep the token but change the signature.
    expect(tokens.readSessionCookie(`${body}.${signature.slice(0, -2)}xx`)).toBeNull();
  });

  it("rejects malformed cookie values", () => {
    for (const value of [undefined, null, "", ".", "nodot", "a.", ".b"]) {
      expect(tokens.readSessionCookie(value)).toBeNull();
    }
  });

  it("issues a distinct token every time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(tokens.generateToken());
    expect(seen.size).toBe(500);
  });

  it("stores a hash, never the token", () => {
    const token = tokens.generateToken();
    const hash = tokens.hashToken(token);

    // What goes in the database must not be the credential itself — a leaked
    // dump then yields no usable session.
    expect(hash).not.toBe(token);
    expect(hash).not.toContain(token);
    // Deterministic, so it can be an indexed lookup key.
    expect(tokens.hashToken(token)).toBe(hash);
    expect(tokens.hashToken(tokens.generateToken())).not.toBe(hash);
  });

  it("mints single-use tokens as a secret plus its hash", () => {
    const { token, tokenHash } = tokens.generateSingleUseToken();
    expect(tokenHash).toBe(tokens.hashToken(token));
    expect(tokenHash).not.toBe(token);
  });
});
