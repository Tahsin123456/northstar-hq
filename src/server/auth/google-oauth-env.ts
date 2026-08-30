import "server-only";

import { z } from "zod";
import { AppError } from "@/server/errors";
import { authEnv, resolveAppUrl } from "@/server/auth/auth-env";
import type { CredentialShapeDTO, GoogleOAuthStatusDTO } from "@/lib/dto";

/**
 * Google OAuth client credentials.
 *
 * Mirrors `auth-env.ts` in shape but inverts its strictness on purpose. The
 * session secret is required because nothing works without it; these are
 * optional because connecting a Google account is one feature of the product,
 * and refusing to boot over a variable most deployments never set would turn an
 * optional integration into a hard dependency. Every path that actually needs
 * the credentials calls `requireGoogleOAuthConfig()` and gets a 503 with a
 * setup message, exactly as the YouTube API key does in `server/env.ts`.
 *
 * `server-only` because this module reads a client *secret* at import time. It
 * is safe for a Server Component to import (that is how the admin page asks
 * what is missing); it must never be reachable from a client bundle, and the
 * import guard enforces that rather than trusting review to catch it.
 */

const schema = z.object({
  GOOGLE_CLIENT_ID: z.string().trim().optional(),
  GOOGLE_CLIENT_SECRET: z.string().trim().optional(),
});

// Every field is optional, so this cannot fail — but parsing rather than
// reading `process.env` directly keeps the trimming and the shape in one place.
const raw = schema.parse(process.env);

/** An unset variable and one set to the empty string mean the same thing here. */
function present(value: string | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

export const googleOAuthEnv = {
  clientId: present(raw.GOOGLE_CLIENT_ID),
  clientSecret: present(raw.GOOGLE_CLIENT_SECRET),
} as const;

/**
 * Where Google sends the browser back to. Must match a URI registered on the
 * OAuth client byte for byte, which is why it is a constant rather than
 * something each route rebuilds.
 */
export const GOOGLE_OAUTH_CALLBACK_PATH = "/api/youtube/callback";

/**
 * The redirect URI, always derived from `APP_URL`.
 *
 * Never from the request's `Host` header. A spoofed Host would otherwise send
 * the authorization code — a one-time credential for Northstar's YouTube data —
 * to whatever origin the attacker named, and Google would happily redirect
 * there if that URI were ever registered. Deriving it from configuration means
 * the destination is fixed at deploy time and cannot be influenced per request.
 */
export function googleOAuthRedirectUri(): string {
  return `${resolveAppUrl(null)}${GOOGLE_OAUTH_CALLBACK_PATH}`;
}

/**
 * True when a Google account can actually be connected right now.
 *
 * `APP_ENCRYPTION_KEY` counts as part of "configured" even though it is not a
 * Google setting: without it the refresh token cannot be stored, so a flow
 * started with only the client id and secret would run all the way through
 * Google's consent screen and then fail on the last write. Better to report the
 * feature as unavailable up front.
 */
export function isGoogleOAuthConfigured(): boolean {
  return (
    googleOAuthEnv.clientId !== null && googleOAuthEnv.clientSecret !== null && encryptionKeyUsable()
  );
}

/**
 * Whether the key can actually encrypt, not merely whether somebody set it.
 *
 * "Non-empty" was the old test, and it let a truncated key through every gate to
 * fail at the last write — after consent, after the authorization code was
 * spent. Size is cheap to check and the only property that matters here, so
 * "configured" now means usable.
 */
function encryptionKeyUsable(): boolean {
  if (authEnv.encryptionKey === null) return false;
  return Buffer.from(authEnv.encryptionKey, "base64").length === 32;
}

/**
 * What is still missing, for an admin screen that has to explain itself.
 *
 * Ordered the way the setup is actually done — create the OAuth client, then
 * generate the encryption key — so the list reads as instructions rather than
 * an inventory.
 */
export function googleOAuthStatus(): GoogleOAuthStatusDTO {
  const missing: string[] = [];
  if (googleOAuthEnv.clientId === null) missing.push("GOOGLE_CLIENT_ID");
  if (googleOAuthEnv.clientSecret === null) missing.push("GOOGLE_CLIENT_SECRET");
  // Listed as missing when it is set but unusable, too. The setup card names the
  // variable and the credentials panel below it explains the size problem, which
  // together is more use than a screen that calls a broken key configured.
  if (!encryptionKeyUsable()) missing.push("APP_ENCRYPTION_KEY");

  // `resolveAppUrl` throws in production when APP_URL is unset. That is the
  // correct behaviour for a link in an email; here it would crash the admin
  // page that exists to tell the admin about it, so the failure is reported as
  // a missing variable instead.
  let redirectUri: string | null = null;
  try {
    redirectUri = googleOAuthRedirectUri();
  } catch {
    missing.push("APP_URL");
  }

  return {
    configured: isGoogleOAuthConfigured(),
    missing,
    redirectUri,
    credentials: [
      describeCredential("GOOGLE_CLIENT_ID", "clientId"),
      describeCredential("GOOGLE_CLIENT_SECRET", "secret"),
      describeEncryptionKey(),
    ],
  };
}

/**
 * The fixed vendor prefixes. Constants Google puts on every credential of the
 * type, so echoing one back reveals nothing about this particular value — and a
 * value that lacks the expected one is almost always a paste that went wrong.
 */
const CREDENTIAL_PREFIXES = ["GOCSPX-"] as const;
const CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";

/**
 * Describes a credential without disclosing it.
 *
 * Reads the RAW `process.env` value rather than the parsed one on purpose: the
 * schema trims, so by the time a value reaches `googleOAuthEnv` the leading
 * newline that came with a copy-paste is gone and the evidence with it. Trimming
 * is right for USING the value and wrong for explaining it, so this looks at
 * what was actually set.
 *
 * Every branch reports punctuation the person included by accident. None of them
 * can echo secret material: the prefix is shown only when it matches a known
 * vendor constant, and the length of a secret constrains nothing.
 */
function describeCredential(name: string, expectation: "clientId" | "secret"): CredentialShapeDTO {
  const rawValue = process.env[name];

  if (!rawValue || rawValue.trim().length === 0) {
    return { name, present: false, length: 0, prefix: "", problems: [] };
  }

  const trimmed = rawValue.trim();
  const problems: string[] = [];

  if (rawValue !== trimmed) {
    problems.push("Has a space or line break around it, which is ignored — but it often means the value was pasted with something else attached.");
  }
  if (/^["']|["']$/.test(trimmed)) {
    problems.push('Starts or ends with a quotation mark. Paste the value on its own, without quotes around it.');
  }
  if (trimmed.startsWith(`${name}=`)) {
    problems.push(`Starts with "${name}=". Paste only the value, not the name as well.`);
  }

  if (expectation === "secret") {
    if (!CREDENTIAL_PREFIXES.some((p) => trimmed.startsWith(p))) {
      problems.push('Does not start with "GOCSPX-", which every Google client secret does. This is usually the name given to the secret rather than the secret itself, or a value from a different field.');
    }
  } else if (!trimmed.endsWith(CLIENT_ID_SUFFIX)) {
    problems.push(`Does not end with "${CLIENT_ID_SUFFIX}", which every Google client ID does.`);
  }

  const prefix = CREDENTIAL_PREFIXES.find((p) => trimmed.startsWith(p)) ?? "";

  return {
    name,
    present: true,
    length: trimmed.length,
    // A client ID is not secret — it is sent in the URL of every consent screen
    // — so it is shown whole, which is what makes "these two are from different
    // OAuth clients" visible at a glance. A SECRET only ever reports the vendor
    // prefix, which is a constant shared by every Google secret and narrows
    // nothing about this one.
    prefix: expectation === "clientId" ? trimmed : prefix,
    problems,
  };
}

/**
 * Whether the AES key can actually encrypt, not merely whether it is set.
 *
 * `isGoogleOAuthConfigured()` asks only whether this variable is non-empty,
 * while `requireEncryptionKey()` insists it decodes to exactly 32 bytes — and
 * that second check runs at the END of the connect flow, after Google's consent
 * and after a successful token exchange. So a key that is set but malformed
 * reports as configured, survives the whole approval, and fails on the last
 * write: the same shape of late failure as a stale client secret, arrived at by
 * a different route.
 *
 * That is not hypothetical here. This deployment's key was rotated recently, and
 * a rotation is exactly when a value gets truncated or pasted with padding lost.
 *
 * Byte length only. The key itself is never described beyond whether it is the
 * right size — unlike a client secret it has no vendor prefix to show, and there
 * is nothing about its content that a screen has any business reporting.
 */
function describeEncryptionKey(): CredentialShapeDTO {
  const name = "APP_ENCRYPTION_KEY";
  const rawValue = process.env[name];

  if (!rawValue || rawValue.trim().length === 0) {
    return { name, present: false, length: 0, prefix: "", problems: [] };
  }

  const trimmed = rawValue.trim();
  const problems: string[] = [];

  if (/^["']|["']$/.test(trimmed)) {
    problems.push("Starts or ends with a quotation mark. Paste the value on its own, without quotes.");
  }

  const decodedBytes = Buffer.from(trimmed, "base64").length;
  if (decodedBytes !== 32) {
    problems.push(
      `Decodes to ${decodedBytes} bytes, but AES-256 needs exactly 32. Connecting will get all the ` +
        "way through Google's screens and then fail when it tries to store the account. Generate a " +
        'replacement with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }

  return { name, present: true, length: trimmed.length, prefix: "", problems };
}

export interface GoogleOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * Narrowing accessor for the code paths that talk to Google.
 *
 * Throws `MISSING_API_KEY` (503) rather than a generic 500 because "correctly
 * built, not yet configured" is a setup prompt, not a bug — the same
 * distinction `errors.ts` draws for the YouTube Data API key.
 */
export function requireGoogleOAuthConfig(): GoogleOAuthConfig {
  const { clientId, clientSecret } = googleOAuthEnv;
  if (clientId === null || clientSecret === null) {
    throw new AppError(
      "MISSING_API_KEY",
      "Google sign-in is not configured on this deployment. Add GOOGLE_CLIENT_ID and " +
        "GOOGLE_CLIENT_SECRET to .env.local (see .env.example) and restart the server.",
    );
  }
  /*
   * Set AND the right size, checked together.
   *
   * A key that is present but does not decode to 32 bytes used to pass every
   * gate on the way in and fail at `encryptSecret`, deep inside the callback —
   * which is to say AFTER Google's five screens and after the single-use
   * authorization code had been spent. It threw a plain Error rather than an
   * AppError, so the callback had no message to forward and the admin got the
   * generic "could not connect" banner with nothing in it, on every attempt,
   * forever.
   *
   * That is the same late-failure shape the client-credential pre-flight was
   * written to eliminate, reached by a different route — and the risk is live
   * here, because a rotated key is exactly the one that arrives truncated or
   * missing its base64 padding.
   *
   * Checked here rather than at import so a deployment that never connects a
   * Google account still boots, which is the whole reason these variables are
   * optional.
   */
  const keyBytes =
    authEnv.encryptionKey === null ? 0 : Buffer.from(authEnv.encryptionKey, "base64").length;
  if (keyBytes !== 32) {
    throw new AppError(
      "MISSING_API_KEY",
      authEnv.encryptionKey === null
        ? "APP_ENCRYPTION_KEY is not configured, so a Google account's tokens cannot be stored " +
          "securely. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
        : `APP_ENCRYPTION_KEY decodes to ${keyBytes} bytes, but AES-256 needs exactly 32, so a ` +
          "Google account's tokens cannot be stored. This usually means the value was truncated " +
          "or lost its padding when it was pasted. Generate a replacement with: node -e " +
          "\"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  return { clientId, clientSecret };
}
