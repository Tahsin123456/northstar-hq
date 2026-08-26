import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { authEnv } from "@/server/auth/auth-env";

/**
 * Opaque token minting and verification.
 *
 * Deliberately NOT marked `server-only`: `src/proxy.ts` imports
 * `readSessionCookie` to do its optimistic redirect, and proxy runs in its own
 * server bundle. Nothing here touches the database or reads a secret at module
 * scope, so it is safe in either place — but it must never be imported from a
 * client component, which is why every consumer that does touch data lives
 * behind `server-only` instead.
 *
 * DESIGN: OPAQUE TOKEN + STORED HASH
 * The cookie carries a 256-bit random token. The database stores only its
 * SHA-256 hash, exactly as it would for a password. Two consequences matter:
 *
 *   1. A database leak yields no usable sessions. An attacker with a full dump
 *      still cannot forge a cookie, because the hash is not the credential.
 *   2. There is nothing to decrypt and no payload to trust. The token means
 *      nothing on its own — it is a lookup key whose row carries the truth,
 *      which is what makes instant revocation possible.
 *
 * A JWT would have been the conventional choice and is the wrong one here: a
 * signed token stays valid until it expires no matter what the database says,
 * so a deactivated employee would keep working for the life of their token.
 *
 * WHY THE COOKIE IS ALSO SIGNED
 * The token is additionally HMAC'd so `proxy.ts` can reject a garbage or
 * tampered cookie without a database round trip — it runs on every prefetch,
 * where a query per request would be unacceptable. The signature is a
 * performance and UX affordance only. It proves the cookie came from us, never
 * that the session behind it is still valid; only the database can say that.
 */

const TOKEN_BYTES = 32;

/** The cookie name. `__Host-` in production pins it to this exact origin: it
 * forbids a `Domain` attribute and requires Secure + Path=/, so a subdomain
 * — including one an attacker manages to stand up — cannot set or overwrite
 * it. The prefix is dropped in development because it also requires HTTPS,
 * and http://localhost would silently drop the cookie. */
export const SESSION_COOKIE_NAME =
  process.env.NODE_ENV === "production" ? "__Host-northstar_session" : "northstar_session";

/** A fresh, unguessable token. Returned once, to the client, and never stored. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** What goes in the database. Base64 of SHA-256; deterministic and indexable. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64");
}

function sign(token: string): string {
  return createHmac("sha256", authEnv.sessionSecret).update(token, "utf8").digest("base64url");
}

/** The value written to the cookie: `<token>.<hmac>`. */
export function formatSessionCookie(token: string): string {
  return `${token}.${sign(token)}`;
}

/**
 * Recovers the token from a cookie value, or null if it was not issued by us.
 *
 * The comparison is timing-safe so the signature cannot be brute-forced a byte
 * at a time.
 */
export function readSessionCookie(value: string | undefined | null): string | null {
  if (!value) return null;
  const separator = value.lastIndexOf(".");
  if (separator <= 0 || separator === value.length - 1) return null;

  const token = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  if (token.length === 0 || signature.length === 0) return null;

  let provided: Buffer;
  let expected: Buffer;
  try {
    provided = Buffer.from(signature, "base64url");
    expected = Buffer.from(sign(token), "base64url");
  } catch {
    return null;
  }

  if (provided.length !== expected.length) return null;
  return timingSafeEqual(provided, expected) ? token : null;
}

/**
 * Single-use tokens for invitations and password resets.
 *
 * Same construction as a session token — random secret out, hash in — so a
 * leaked database cannot be used to accept somebody's invitation or complete
 * their password reset. Returned as a pair because the caller must send
 * `token` and persist `tokenHash`.
 */
export function generateSingleUseToken(): { token: string; tokenHash: string } {
  const token = generateToken();
  return { token, tokenHash: hashToken(token) };
}
