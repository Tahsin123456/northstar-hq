import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { requireEncryptionKey } from "@/server/auth/auth-env";

/**
 * Symmetric encryption for secrets the application must be able to read back.
 *
 * Used for one thing today: Google OAuth refresh tokens. A refresh token is a
 * long-lived key to Northstar's YouTube data, so storing it in plaintext would
 * mean a database backup, a leaked dump or an over-broad read query hands
 * somebody standing access to the company's channels.
 *
 * AES-256-GCM is authenticated encryption: tampering with the ciphertext fails
 * the tag check on decrypt rather than silently yielding different plaintext.
 * A fresh random IV per encryption is mandatory — reusing an IV with GCM is
 * catastrophic, leaking the keystream — so it is generated here and never
 * supplied by a caller.
 *
 * Format: `v1.<iv>.<authTag>.<ciphertext>`, all base64url. Versioned so the key
 * or algorithm can be rotated later without guessing at what an old row holds.
 */

const VERSION = "v1";
const IV_LENGTH = 12; // 96 bits, the size GCM is specified for.

export function encryptSecret(plaintext: string): string {
  const key = requireEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Returns null rather than throwing on anything malformed or tampered with.
 *
 * A failed decrypt is an operational condition, not a crash: the right response
 * is to mark the connection as needing re-authorisation and tell an admin, not
 * to return a 500 from whatever request happened to touch the row.
 */
export function decryptSecret(encoded: string | null | undefined): string | null {
  if (!encoded) return null;

  const parts = encoded.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;

  try {
    const key = requireEncryptionKey();
    const iv = Buffer.from(parts[1], "base64url");
    const authTag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");

    if (iv.length !== IV_LENGTH) return null;

    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
