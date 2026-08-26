import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "@/server/env";
import { AppError, errors } from "@/server/errors";

/**
 * =========================================================================
 * AUTHENTICATING A SCHEDULER
 * =========================================================================
 *
 * WHY THESE ROUTES ARE EXEMPT FROM THE SESSION GATE
 * Every other route in this app starts with `requirePermission(...)`, which
 * resolves a session cookie. A scheduler has no cookie and never will: Vercel
 * Cron, a systemd timer and a queue worker are all processes, not people, and
 * there is no browser in the loop to have signed in. Requiring a session would
 * mean either issuing a long-lived session to a robot account — a credential
 * with a *user's* full permissions, stored in a scheduler's config, that no
 * admin would think to revoke — or having no scheduled jobs at all.
 *
 * WHY THAT IS SAFE
 * The exemption is from the *session* gate, not from authentication. A cron
 * route still proves who is calling, using a shared secret instead of a cookie:
 *
 *   1. The secret authorises a fixed, small set of capabilities — refresh stale
 *      channels, finalize last month's payroll and announce it — and nothing
 *      else. It cannot read a video, a note, a user or a finance row. Compare
 *      that to a session token, which would carry every permission its owner
 *      holds.
 *   2. There is no ambient authority to abuse, so CSRF does not apply. A
 *      browser will happily be tricked into sending a *cookie* it already
 *      holds; it will not invent an `Authorization` header, and it cannot send
 *      a custom `x-cron-secret` cross-origin without a CORS preflight these
 *      routes never approve.
 *
 * WHAT IT REFUSES TO DO
 * Run unauthenticated. With `CRON_SECRET` unset the caller gets a 503 naming
 * the variable, rather than "no secret configured" being treated as "no secret
 * required" — the failure mode where a deploy quietly exposes an
 * unauthenticated state-changing endpoint to the internet.
 *
 * WHY THIS IS A MODULE AND NOT COPIED INTO EACH ROUTE
 * There is more than one scheduled endpoint now. A timing-safe comparison
 * implemented twice is a comparison that will eventually be implemented twice
 * *differently* — one of them gets a "quick fix" and silently becomes an
 * oracle. One implementation, used by every cron route, is the only version of
 * this that stays correct.
 */

/**
 * Constant-time secret comparison.
 *
 * `timingSafeEqual` is the point of this function: `===` on strings short-
 * circuits at the first differing byte, so the time it takes to fail is a
 * measurement of how many leading bytes were right. Given enough attempts that
 * recovers the secret one byte at a time, which is a real attack and not a
 * theoretical one.
 *
 * Both sides are hashed first rather than compared as raw buffers, for two
 * reasons `timingSafeEqual` alone does not give:
 *
 *   • It throws outright on length-mismatched buffers, so a naive
 *     implementation needs a length check — and *that* check is itself a
 *     variable-time oracle disclosing the secret's length. Two SHA-256 digests
 *     are always 32 bytes, so there is nothing to guard and nothing to leak.
 *   • Hashing is what makes the comparison total: any presented value, of any
 *     length or encoding, is comparable without a branch.
 */
function secretMatches(presented: string, expected: string): boolean {
  const presentedDigest = createHash("sha256").update(presented, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

/**
 * The secret the caller presented, from either header schedulers use.
 *
 * `Authorization: Bearer <secret>` is what Vercel Cron sends and is the
 * conventional shape; `x-cron-secret` is there for the schedulers that reserve
 * the Authorization header for their own proxy auth. Accepting both costs one
 * branch and removes an entire category of "why does my cron job 401" support.
 */
function presentedSecretFrom(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const [scheme, ...rest] = authorization.split(" ");
    const value = rest.join(" ").trim();
    if (scheme?.toLowerCase() === "bearer" && value.length > 0) return value;
  }

  const header = request.headers.get("x-cron-secret")?.trim();
  return header && header.length > 0 ? header : null;
}

/**
 * Authenticates the caller, or throws.
 *
 * Returns nothing on success: there is no "actor" here by design. The caller is
 * a machine holding one capability, not a user with a scope, and inventing a
 * synthetic actor would be the first step towards code elsewhere treating it
 * like one.
 *
 * `what` names the feature in the 503, so an operator who has not set
 * `CRON_SECRET` is told which job is affected.
 */
export function authenticateScheduler(request: Request, what: string): void {
  const expected = env.cronSecret;
  if (expected === null) {
    throw errors.notConfigured("CRON_SECRET", what);
  }

  const presented = presentedSecretFrom(request);
  if (presented === null || !secretMatches(presented, expected)) {
    // 401 with a deliberately incurious message. Distinguishing "no secret
    // sent" from "wrong secret sent" tells a prober which half of their setup
    // to work on, and this response is read by a log, not a person who needs
    // help. The `internalMessage` carries the distinction to the server log,
    // where the operator debugging their scheduler can actually see it.
    throw new AppError(
      "UNAUTHENTICATED",
      "This endpoint requires a valid scheduler credential.",
      {
        internalMessage:
          presented === null
            ? "cron: no Authorization: Bearer or x-cron-secret header present"
            : "cron: presented secret did not match CRON_SECRET",
      },
    );
  }
}
