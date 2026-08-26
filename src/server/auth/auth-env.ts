import { z } from "zod";

/**
 * Authentication and encryption secrets.
 *
 * Kept separate from `src/server/env.ts` on purpose: `src/proxy.ts` needs the
 * session secret to validate a cookie signature, but has no business requiring
 * `DATABASE_URL` or constructing a Prisma client. This module reads nothing but
 * secrets and has no imports beyond Zod, so it is safe in the proxy bundle.
 *
 * NO FALLBACKS
 * There is deliberately no development default for `SESSION_SECRET`. A
 * hardcoded fallback is the classic way a weak key reaches production, and a
 * randomly generated one is worse in Next.js specifically — the proxy and the
 * route handlers are separate bundles, so each would mint a different secret
 * and no cookie would ever validate. Requiring it, loudly, is the only version
 * of this that is both secure and debuggable.
 */

const SECRET_MIN_BYTES = 32;

const secret = (name: string, hint: string) =>
  z
    .string({ message: `${name} is required. ${hint}` })
    .min(1, `${name} is required. ${hint}`)
    .refine((value) => Buffer.from(value, "base64").length >= SECRET_MIN_BYTES, {
      message: `${name} must be at least ${SECRET_MIN_BYTES} bytes of base64-encoded randomness. ${hint}`,
    });

const GENERATE_HINT = 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"';

const schema = z.object({
  SESSION_SECRET: secret("SESSION_SECRET", GENERATE_HINT),

  /**
   * Encrypts OAuth refresh tokens at rest. Optional until a Google account is
   * actually connected — the app is fully usable without YouTube OAuth, and
   * demanding a key for a feature nobody has switched on turns setup into a
   * scavenger hunt. `requireEncryptionKey()` throws a clear error at the point
   * of use instead.
   */
  APP_ENCRYPTION_KEY: z.string().optional(),

  /**
   * Public origin, e.g. https://northstarhq.com. Used to build invitation and
   * password-reset links and the OAuth redirect URI, all of which must be
   * absolute and must match what Google has registered.
   */
  APP_URL: z.string().url().optional(),

  /** Session lifetime and idle timeout, in hours/minutes. */
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).optional(),
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().min(5).max(60 * 24 * 30).optional(),

  NODE_ENV: z.enum(["development", "test", "production"]).optional(),
});

/**
 * An empty environment variable means "not set".
 *
 * Hosting platforms create variables in bulk — Vercel's import screen reads
 * `.env.example` and pre-creates every key it finds there, so a real
 * deployment arrives with a dozen keys present and blank. Handing those to Zod
 * as empty strings produces two bad outcomes: a numeric setting coerces "" to
 * 0 and fails its own minimum, refusing to boot over a variable nobody chose;
 * and a boolean-ish setting reads "" as false, switching a feature off with
 * nothing to announce it.
 *
 * Stripping blanks before parsing makes absence and emptiness the same thing,
 * which is what an operator means by leaving a box empty. Genuinely required
 * values still fail — they simply fail as "required" rather than as "invalid",
 * which is the more useful message.
 */
function withoutBlanks(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (value.trim() === "") continue;
    result[key] = value;
  }
  return result;
}

const parsed = schema.safeParse(withoutBlanks(process.env));

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  • ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  throw new Error(
    `Invalid authentication configuration:\n${issues}\n\n` +
      "These belong in .env.local (git-ignored). See .env.example.",
  );
}

const raw = parsed.data;

export const authEnv = {
  sessionSecret: raw.SESSION_SECRET,
  encryptionKey: raw.APP_ENCRYPTION_KEY ?? null,
  appUrl: raw.APP_URL ?? null,
  /** Absolute cap on a session's life, regardless of activity. */
  sessionTtlMs: (raw.SESSION_TTL_HOURS ?? 24 * 14) * 60 * 60 * 1000,
  /**
   * Idle timeout. A browser left open on an unattended desk stops being a way
   * in after this long without a request.
   */
  idleTimeoutMs: (raw.SESSION_IDLE_TIMEOUT_MINUTES ?? 60 * 12) * 60 * 1000,
  isProduction: raw.NODE_ENV === "production",
} as const;

/**
 * The AES key for OAuth token storage.
 *
 * Separated from `authEnv.encryptionKey` so the failure is a clear, actionable
 * message at the moment somebody tries to connect a Google account, rather than
 * a boot crash for a feature they may never use.
 */
export function requireEncryptionKey(): Buffer {
  if (!authEnv.encryptionKey) {
    throw new Error(
      "APP_ENCRYPTION_KEY is not configured, so YouTube account tokens cannot be stored securely. " +
        GENERATE_HINT,
    );
  }
  const key = Buffer.from(authEnv.encryptionKey, "base64");
  if (key.length !== 32) {
    throw new Error(
      `APP_ENCRYPTION_KEY must decode to exactly 32 bytes for AES-256 (got ${key.length}). ${GENERATE_HINT}`,
    );
  }
  return key;
}

/**
 * Absolute base URL for links sent by email.
 *
 * Falls back to the request's own origin when unset, which is right for local
 * development and wrong for production — an invitation link is generated by the
 * server and must not depend on whichever host header a request happened to
 * carry, or a spoofed Host turns into a phishing link with a valid token.
 */
export function resolveAppUrl(requestOrigin: string | null): string {
  if (authEnv.appUrl) return authEnv.appUrl.replace(/\/$/, "");
  if (authEnv.isProduction) {
    throw new Error(
      "APP_URL must be set in production so invitation and password-reset links cannot be " +
        "forged by sending a crafted Host header.",
    );
  }
  return (requestOrigin ?? "http://localhost:3000").replace(/\/$/, "");
}
