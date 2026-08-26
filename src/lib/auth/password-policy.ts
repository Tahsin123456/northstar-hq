/**
 * Password rules the browser is allowed to know.
 *
 * Split out from src/server/auth/password.ts because that module is
 * `server-only` — it imports node:crypto and must never reach a client bundle.
 * The form needs the minimum length to render a `minLength` attribute and a
 * hint, so the constant lives here and the server imports it too, keeping one
 * definition.
 *
 * The client check is a courtesy that saves a round trip. The authoritative
 * check is `validatePasswordStrength` on the server, which runs on every
 * password-setting path regardless of what the browser sent.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;
