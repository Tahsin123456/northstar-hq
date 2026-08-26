import "server-only";

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

/**
 * Hand-wrapped rather than `promisify(scrypt)`.
 *
 * `@types/node` declares a `__promisify__` overload for scrypt that accepts
 * only `(password, salt, keylen)` — there is no promisified signature carrying
 * `ScryptOptions`. Using `promisify` therefore makes the cost parameters below
 * unrepresentable in the type system: they are forwarded correctly at runtime
 * but fail `tsc`, which would mean either a failing build or an `as any` hiding
 * the one thing in this file that must not be wrong.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * Password hashing.
 *
 * WHY SCRYPT
 * scrypt (RFC 7914) is a memory-hard KDF and one of the algorithms OWASP lists
 * as acceptable for password storage. It ships in Node's standard library,
 * which matters more here than it might elsewhere: Argon2 and bcrypt are native
 * addons, and a node-gyp build step is exactly the kind of thing that breaks a
 * deploy on a machine that differs from the developer's. Nothing about this
 * choice is a compromise on strength — the cost parameters below are the
 * OWASP-recommended configuration.
 *
 * PARAMETERS
 * N = 2^16, r = 8, p = 2 is one of OWASP's named scrypt configurations. Memory
 * use is 128 * N * r ≈ 64 MiB per hash, which is the point: it makes offline
 * cracking expensive per guess. The cost of that on the server is bounded by
 * rate limiting on the login endpoint (see rate-limit.ts) — without that
 * pairing, an unauthenticated attacker could turn 64 MiB-per-request into a
 * denial of service.
 *
 * ENCODING
 * The parameters are stored *inside* the hash string, so raising the cost later
 * does not invalidate existing passwords: old hashes keep verifying with their
 * own parameters and are transparently upgraded on the next successful login.
 */

const ALGORITHM = "scrypt";
const COST_N = 1 << 16; // 65,536
const BLOCK_SIZE_R = 8;
const PARALLELISM_P = 2;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** scrypt refuses to allocate past `maxmem`; 128*N*r plus headroom. */
const MAX_MEM = 192 * 1024 * 1024;

export interface PasswordPolicyIssue {
  readonly message: string;
}

/**
 * Minimum password requirements.
 *
 * Length is the only rule that reliably correlates with strength, so it is the
 * only one enforced. Composition rules ("one uppercase, one symbol") push
 * people toward `Password1!` and are explicitly discouraged by current NIST
 * guidance; a 12-character passphrase is stronger and easier to remember.
 */
export { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH };

export function validatePasswordStrength(password: string): PasswordPolicyIssue | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      message: `Use at least ${MIN_PASSWORD_LENGTH} characters. A short phrase you can remember beats a short scramble you cannot.`,
    };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    // Bounded so a multi-megabyte "password" cannot be used to burn CPU.
    return { message: `Keep it under ${MAX_PASSWORD_LENGTH} characters.` };
  }
  // Rejects the handful of values that appear in every breach corpus. Not a
  // substitute for length, just a cheap floor.
  const normalized = password.trim().toLowerCase();
  if (["password", "123456789012", "northstarhq123", "letmeinplease"].includes(normalized)) {
    return { message: "That password is too common. Choose something unique to you." };
  }
  return null;
}

async function derive(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  // Normalising to NFC means the same typed passphrase verifies regardless of
  // how the client's keyboard composed its accents.
  const normalized = password.normalize("NFC");
  return scrypt(normalized, salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEM });
}

/** Produces `scrypt$N$r$p$salt$hash`, all base64. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(password, salt, COST_N, BLOCK_SIZE_R, PARALLELISM_P);
  return [
    ALGORITHM,
    COST_N,
    BLOCK_SIZE_R,
    PARALLELISM_P,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

export interface PasswordVerification {
  readonly valid: boolean;
  /** True when the stored hash used weaker parameters than the current policy. */
  readonly needsRehash: boolean;
}

/**
 * Verifies a password against a stored hash.
 *
 * Never throws on malformed input — a corrupt or unrecognised hash is simply a
 * failed verification, because throwing here would let an attacker distinguish
 * "no such user" from "broken record" by watching for a 500.
 */
export async function verifyPassword(
  password: string,
  storedHash: string | null | undefined,
): Promise<PasswordVerification> {
  if (!storedHash) return { valid: false, needsRehash: false };

  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== ALGORITHM) {
    return { valid: false, needsRehash: false };
  }

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return { valid: false, needsRehash: false };
  }
  // Refuse to spend unbounded memory on a hostile stored value.
  if (n > COST_N || r > 16 || p > 16) {
    return { valid: false, needsRehash: false };
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return { valid: false, needsRehash: false };
  }
  if (salt.length === 0 || expected.length === 0) {
    return { valid: false, needsRehash: false };
  }

  let actual: Buffer;
  try {
    actual = await derive(password, salt, n, r, p);
  } catch {
    return { valid: false, needsRehash: false };
  }

  // Length must match before timingSafeEqual, which throws on a mismatch.
  const valid = actual.length === expected.length && timingSafeEqual(actual, expected);
  const needsRehash = valid && (n !== COST_N || r !== BLOCK_SIZE_R || p !== PARALLELISM_P);
  return { valid, needsRehash };
}

/**
 * Burns roughly the same CPU as a real verification, and returns false.
 *
 * Called when the email does not exist or the account has no password set. A
 * login that fails instantly for unknown users and slowly for known ones is a
 * user-enumeration oracle: an attacker learns which of your employees have
 * accounts purely from response timing. Doing the work anyway removes the
 * signal.
 */
export async function fakeVerifyPassword(password: string): Promise<false> {
  await derive(password, DUMMY_SALT, COST_N, BLOCK_SIZE_R, PARALLELISM_P);
  return false;
}

/**
 * Fixed rather than random: this value never protects anything — it exists only
 * to make the timing of a doomed login match a real one.
 */
const DUMMY_SALT = Buffer.alloc(SALT_LENGTH, 7);
