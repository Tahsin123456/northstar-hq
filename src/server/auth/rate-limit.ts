import "server-only";

import { prisma } from "@/server/db";
import { errors } from "@/server/errors";

/**
 * Rate limiting for authentication endpoints.
 *
 * WHY THE DATABASE AND NOT MEMORY
 * An in-process counter is the obvious implementation and the wrong one: it
 * resets on every deploy, and with two instances behind a load balancer each
 * one grants the full allowance, so the real limit is silently double what it
 * says. Auth endpoints are low-traffic by nature, so the cost of a row write
 * per attempt is irrelevant next to being correct.
 *
 * WHY IT MATTERS MORE THAN USUAL HERE
 * Password verification is deliberately expensive — scrypt at 64 MiB per hash
 * (see password.ts). Without a limiter that is not just a brute-force hole but
 * a denial-of-service amplifier: a few hundred concurrent login attempts would
 * exhaust the server's memory. The two mechanisms only work as a pair.
 *
 * LAYERS
 * Per-IP limits stop a single source hammering the endpoint. Per-account limits
 * (plus the lockout on AppUser) stop a distributed attempt against one known
 * employee. Both are needed: neither alone covers the other's case.
 */

export interface RateLimitRule {
  /** Distinct namespace, e.g. "login:ip". */
  readonly scope: string;
  readonly limit: number;
  readonly windowMs: number;
}

export const RATE_LIMITS = {
  /** Per source address: generous enough for a shared office NAT. */
  loginByIp: { scope: "login:ip", limit: 20, windowMs: 15 * 60 * 1000 },
  /** Per account: tight, because a single person does not fail ten times. */
  loginByAccount: { scope: "login:account", limit: 8, windowMs: 15 * 60 * 1000 },
  /** Password reset requests, to stop the endpoint being used as a mail cannon. */
  passwordResetByIp: { scope: "reset:ip", limit: 6, windowMs: 60 * 60 * 1000 },
  passwordResetByAccount: { scope: "reset:account", limit: 4, windowMs: 60 * 60 * 1000 },
  /** Invitation acceptance / setup, to slow token guessing. */
  tokenExchangeByIp: { scope: "token:ip", limit: 15, windowMs: 15 * 60 * 1000 },
  /** Manual sync triggers — the most expensive authenticated action. */
  syncByUser: { scope: "sync:user", limit: 10, windowMs: 60 * 60 * 1000 },
} as const satisfies Record<string, RateLimitRule>;

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

/**
 * Counts one attempt against a fixed window.
 *
 * Fixed windows can allow a burst across a boundary (up to 2× the limit in the
 * worst case). That is an accepted trade here: the limits are set low enough
 * that twice them is still harmless, and a sliding-window implementation would
 * need either per-attempt rows or Redis, neither of which this deployment
 * should require.
 */
export async function consumeRateLimit(
  rule: RateLimitRule,
  subject: string,
): Promise<RateLimitResult> {
  const key = `${rule.scope}:${subject}`.slice(0, 512);
  const now = Date.now();

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.rateLimitBucket.findUnique({ where: { key } });
      const windowExpired =
        !existing || existing.windowStartedAt.getTime() + rule.windowMs <= now;

      if (windowExpired) {
        const startedAt = new Date(now);
        const expiresAt = new Date(now + rule.windowMs);
        await tx.rateLimitBucket.upsert({
          where: { key },
          create: { key, count: 1, windowStartedAt: startedAt, expiresAt },
          update: { count: 1, windowStartedAt: startedAt, expiresAt },
        });
        return { allowed: true, remaining: rule.limit - 1, retryAfterSeconds: 0 };
      }

      const nextCount = existing.count + 1;
      const resetAt = existing.windowStartedAt.getTime() + rule.windowMs;

      if (nextCount > rule.limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)),
        };
      }

      await tx.rateLimitBucket.update({ where: { key }, data: { count: nextCount } });
      return {
        allowed: true,
        remaining: rule.limit - nextCount,
        retryAfterSeconds: 0,
      };
    });
  } catch {
    // FAIL OPEN, DELIBERATELY.
    //
    // If the database is unreachable the limiter cannot count — but neither can
    // anything else in the app work, so failing closed here would turn a
    // transient database blip into "nobody can sign in", which is a worse
    // outcome than a brief window without throttling. The per-account lockout
    // on AppUser is unaffected because it lives in the same row the login reads.
    return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0 };
  }
}

/** Throws the 429 directly; the common case at the top of a handler. */
export async function enforceRateLimit(rule: RateLimitRule, subject: string): Promise<void> {
  const result = await consumeRateLimit(rule, subject);
  if (!result.allowed) throw errors.tooManyAttempts(result.retryAfterSeconds);
}

/** Clears a subject's counter — called after a successful authentication. */
export async function resetRateLimit(rule: RateLimitRule, subject: string): Promise<void> {
  await prisma.rateLimitBucket
    .delete({ where: { key: `${rule.scope}:${subject}`.slice(0, 512) } })
    .catch(() => undefined);
}

/** Housekeeping for the scheduled job; expired buckets are dead weight. */
export async function pruneRateLimits(): Promise<number> {
  const result = await prisma.rateLimitBucket.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}

/**
 * Best-effort client address.
 *
 * `x-forwarded-for` is trivially spoofable when the app is exposed directly, so
 * this is only trustworthy behind a proxy that overwrites the header — which is
 * what every supported deployment target does (Vercel, Fly, a Caddy/nginx
 * front). Two consequences are deliberate:
 *
 *   • The *first* entry is used, which is what platform proxies set to the real
 *     client. Behind a chain you control, prefer the rightmost trusted hop.
 *   • A spoofed value can only ever make an attacker's own limit stricter or
 *     spread their attempts; it cannot lift anybody else's limit, because the
 *     per-account counter and the account lockout do not depend on it.
 */
export function clientIpFrom(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return (
    request.headers.get("x-real-ip")?.slice(0, 64) ??
    request.headers.get("cf-connecting-ip")?.slice(0, 64) ??
    "unknown"
  );
}

export function userAgentFrom(request: Request): string | null {
  return request.headers.get("user-agent")?.slice(0, 400) ?? null;
}
