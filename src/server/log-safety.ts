/**
 * =========================================================================
 * WHAT AN ERROR IS ALLOWED TO PUT IN THE SERVER LOG
 * =========================================================================
 *
 * `jsonError` logs `appError.cause` for every 5xx, which is the right instinct —
 * a cause chain is usually the only thing that explains an upstream failure —
 * and it has one bad case. A Prisma validation error's message contains the
 * SERIALISED ARGUMENT LIST of the failing query. On the token-writing paths in
 * `youtube-oauth-service` that argument list is `accessTokenEnc` and
 * `refreshTokenEnc`, so a schema mistake in one of those writes would print
 * encrypted Google credentials into the application log.
 *
 * It is ciphertext, not plaintext, so the exposure is small — but a log is a far
 * easier thing to read than the database, and the encryption key lives in the
 * same environment the log is written from. The callback route already guards
 * this exact case by hand, logging `error.message` alone and saying why; this
 * generalises that guard to every route rather than leaving it as one file's
 * private discipline.
 *
 * WHAT IT IS NOT. Not a secret scanner and not a promise. It knows the names
 * this codebase actually stores credentials under and the shape of its own
 * ciphertext envelope, and it removes those. Anything genuinely sensitive under
 * a name nobody here uses will still be printed — the real protection is that
 * secrets are not put in error messages in the first place.
 */

/** The token envelope written by `auth/crypto.ts`: `v1.<iv>.<tag>.<ciphertext>`. */
const CIPHERTEXT_ENVELOPE = /\bv1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/**
 * Field names this app stores or receives credentials under.
 *
 * The `*Enc` columns are ours; `access_token`, `refresh_token`, `id_token` and
 * `client_secret` are Google's own spellings, which arrive in token-endpoint
 * responses and could reach a cause chain from there.
 */
const SECRET_KEY = new RegExp(
  String.raw`\b(accessTokenEnc|refreshTokenEnc|access_?[Tt]oken|refresh_?[Tt]oken|id_?[Tt]oken|client_?[Ss]ecret|authorization)\b` +
    // The separator between a key and its value in every rendering we might
    // see: JSON (`"key": value`), Prisma's argument dump (`key: value`), a
    // query string (`key=value`). The optional quote is the JSON case — the
    // key's own closing quote sits between the name and the colon, and it is
    // captured so the redacted line is still readable as the shape it was.
    String.raw`(["']?\s*[:=]\s*)` +
    // The value: a quoted string, or a bare run of non-delimiter characters.
    String.raw`("[^"]*"|'[^']*'|[^\s,;}\]]+)`,
  "g",
);

export const REDACTED = "[redacted]";

/** Removes anything recognisable as a credential from a log line. */
export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_KEY, (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`)
    .replace(CIPHERTEXT_ENVELOPE, REDACTED);
}

/**
 * A cause, rendered for the log: informative, and stripped of credentials.
 *
 * The stack is kept — it is the whole reason for logging a cause — and redacted
 * along with everything else, because an Error's stack string begins with its
 * message and that is exactly where a Prisma argument dump lives.
 */
export function describeCauseForLog(cause: unknown): string {
  if (cause === null || cause === undefined) return "";

  if (cause instanceof Error) {
    return redactSecrets(cause.stack ?? `${cause.name}: ${cause.message}`);
  }

  if (typeof cause === "string") return redactSecrets(cause);

  try {
    return redactSecrets(JSON.stringify(cause) ?? String(cause));
  } catch {
    // Circular, or a value with a throwing `toJSON`. The type is still worth
    // saying; the contents are not worth a second attempt.
    return `[uninspectable ${typeof cause}]`;
  }
}
