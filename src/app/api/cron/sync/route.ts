import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "@/server/env";
import { AppError, errors } from "@/server/errors";
import { handleMutation, readJson } from "@/server/http";
import { runScheduledSyncForAllOrganizations } from "@/server/services/sync-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * A sweep of a few dozen channels is minutes of upstream I/O, not milliseconds.
 * The default 10s serverless budget would kill it partway through and leave
 * half the tracker refreshed with no record of why.
 */
export const maxDuration = 300;

/**
 * ===========================================================================
 * POST/GET /api/cron/sync — the scheduled refresh entry point
 * ===========================================================================
 *
 * WHY THIS ROUTE IS EXEMPT FROM THE SESSION GATE
 * Every other route in this app starts with `requirePermission(...)`, which
 * resolves a session cookie. A scheduler has no cookie and never will: Vercel
 * Cron, a systemd timer and a queue worker are all processes, not people, and
 * there is no browser in the loop to have signed in. Requiring a session here
 * would mean either issuing a long-lived session to a robot account — a
 * credential with a *user's* full permissions, stored in a scheduler's config,
 * that no admin would think to revoke — or not having scheduled sync at all.
 *
 * WHY THAT IS SAFE
 * The exemption is from the *session* gate, not from authentication. This route
 * still proves who is calling, using a shared secret instead of a cookie, and
 * the trade is a good one on three counts:
 *
 *   1. The secret authorises exactly one capability — "refresh stale channels
 *      and prune expired rows" — and nothing else. It cannot read a video, a
 *      note, a user or a finance row. Compare that to a session token, which
 *      would carry every permission its owner holds.
 *   2. There is no ambient authority to abuse, so CSRF does not apply. A
 *      browser will happily be tricked into sending a *cookie* it already
 *      holds; it will not invent an `Authorization` header, and it cannot send
 *      a custom `x-cron-secret` cross-origin without a CORS preflight this
 *      route never approves.
 *   3. The blast radius of the worst case — someone with the secret calling it
 *      repeatedly — is bounded by the staleness filter and the per-run channel
 *      cap, which mean a second call a minute later does almost no work. It is
 *      a quota nuisance, not a data breach.
 *
 * WHAT IT REFUSES TO DO
 * Run unauthenticated. With `CRON_SECRET` unset the route returns 503 naming
 * the variable rather than treating "no secret configured" as "no secret
 * required" — the failure mode where a deploy quietly exposes an unauthenticated
 * state-changing endpoint to the internet.
 */

const cronRequestSchema = z.object({
  /** Override for a one-off catch-up sweep; the scheduler omits it. */
  maxChannels: z.number().int().min(1).max(200).optional(),
});

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
 * reasons that `timingSafeEqual` alone does not give:
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
 */
function authenticateScheduler(request: Request): void {
  const expected = env.cronSecret;
  if (expected === null) {
    throw errors.notConfigured("CRON_SECRET", "Scheduled synchronisation");
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

async function runCronSync(request: Request) {
  // First statement of the handler, exactly as `requirePermission` is
  // everywhere else: nothing is read, parsed or queried before the caller has
  // been proven.
  authenticateScheduler(request);

  // A GET carries no body and a scheduler rarely sends one on POST either, so a
  // missing or malformed body is the normal case rather than an error.
  const parsed = cronRequestSchema.safeParse(
    request.method === "POST" ? await readJson(request) : {},
  );
  const maxChannels = parsed.success ? parsed.data.maxChannels : undefined;

  const result = await runScheduledSyncForAllOrganizations({
    trigger: "cron",
    maxChannels,
    request,
  });

  return {
    ok: true as const,
    ...result,
  };
}

/**
 * POST is the conventional verb for something that changes state, and what most
 * schedulers send.
 */
export function POST(request: Request) {
  return handleMutation(request, () => runCronSync(request));
}

/**
 * GET does the same thing, because schedulers disagree about which verb a cron
 * target should use — Vercel Cron issues GET, most queue workers POST, and a
 * plain `curl` in a crontab defaults to GET. Refusing one of them would make
 * this endpoint depend on the scheduler's taste.
 *
 * It uses `handleMutation` rather than `handle` despite being a GET, which is
 * against this codebase's usual convention and deliberate: the convention
 * exists so state-changing routes cannot forget the origin check, and this GET
 * changes state. Following the letter of the rule here would mean applying the
 * weaker wrapper to the request that needs the stronger one. (The check is a
 * no-op for a scheduler, which sends no Origin header — see `assertSameOrigin`
 * — so this costs nothing and closes the browser-driven case.)
 */
export function GET(request: Request) {
  return handleMutation(request, () => runCronSync(request));
}
