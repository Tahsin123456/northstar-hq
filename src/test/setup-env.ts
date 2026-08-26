/**
 * Test environment bootstrap.
 *
 * `src/server/env.ts` validates configuration at import time, which is exactly
 * what you want in production and inconvenient in a unit test. Setting these
 * before any module loads lets the pure logic under test — the analytics engine
 * and the Shorts classifier — be imported without a database or an API key.
 *
 * `YOUTUBE_API_KEY` is deliberately left unset: nothing in the test suite makes
 * a network call, and leaving it empty proves that.
 */

process.env.DATABASE_URL ??= "file:./prisma/test.db";
process.env.SHORTS_PROBE_ENABLED ??= "false";

// NODE_ENV is typed readonly by @types/node; Vitest already sets it to "test",
// so this only fills the gap if something cleared it.
if (!process.env.NODE_ENV) {
  Object.assign(process.env, { NODE_ENV: "test" });
}
