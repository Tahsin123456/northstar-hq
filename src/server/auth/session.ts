import "server-only";

import { cookies } from "next/headers";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { authEnv } from "@/server/auth/auth-env";
import {
  SESSION_COOKIE_NAME,
  formatSessionCookie,
  generateToken,
  hashToken,
} from "@/server/auth/tokens";

/**
 * Session lifecycle: mint, refresh, revoke.
 *
 * A session is a database row. Creating one issues a random token to the
 * browser and stores only its hash; every subsequent request looks the row up
 * and re-reads the user's status from it. That is what makes "deactivate this
 * person" take effect on their next click rather than whenever a token expires.
 *
 * COOKIE WRITES ARE ROUTE-HANDLER ONLY
 * `cookies().set()` and `.delete()` throw outside a Route Handler or Server
 * Function, because HTTP cannot set a cookie once the response has started
 * streaming. Everything in this file that writes a cookie must therefore be
 * called from `src/app/api/auth/**`, never from a page or layout render.
 */

export interface NewSession {
  readonly sessionId: string;
  readonly expiresAt: Date;
}

/**
 * Starts a new session for a user who has just proven who they are.
 *
 * Always creates a fresh row with a fresh token. Reusing a session id across
 * two authentications is session fixation: an attacker who can plant a cookie
 * value before login would still hold a valid one afterwards.
 */
export async function createSession(
  userId: string,
  context: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<NewSession> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + authEnv.sessionTtlMs);

  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      ipAddress: context.ipAddress ?? null,
      // Bounded: a user-agent is attacker-controlled and unbounded in principle.
      userAgent: context.userAgent?.slice(0, 400) ?? null,
    },
    select: { id: true },
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, formatSessionCookie(token), {
    httpOnly: true,
    // Not readable from JavaScript, so an XSS bug cannot exfiltrate the
    // session — which is also why nothing about the session is ever put in
    // localStorage.
    secure: authEnv.isProduction,
    // `lax` still sends the cookie on top-level navigations, so following a
    // link into the app keeps you signed in, while withholding it from
    // cross-site POSTs — the CSRF vector that matters.
    sameSite: "lax",
    expires: expiresAt,
    path: "/",
  });

  return { sessionId: session.id, expiresAt };
}

/** Ends the current session and clears the cookie. */
export async function destroyCurrentSession(sessionId: string | null): Promise<void> {
  if (sessionId) {
    // Revoked rather than deleted: the row is the record that this device was
    // signed in and when it stopped, which the admin device list depends on.
    await prisma.session
      .update({ where: { id: sessionId }, data: { revokedAt: new Date() } })
      .catch(() => undefined);
  }

  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}

/**
 * Revokes every session belonging to a user.
 *
 * Called when an admin deactivates someone, when a password changes, and from
 * "sign out everywhere". Deactivation alone is already enough — the DAL checks
 * `deactivatedAt` on every request — but revoking the rows too keeps the
 * sessions table honest for the device list.
 */
/**
 * The slice of the client this needs, so one implementation serves both a
 * standalone call and one made inside an interactive transaction.
 *
 * Admin deactivation has to flip `AppUser.status` and revoke the sessions
 * atomically — a half-applied deactivation is exactly the state this feature
 * exists to prevent. The module-level `prisma` client does not join a
 * surrounding `$transaction`, so the caller passes its `tx` instead.
 */
type SessionClient = Pick<Prisma.TransactionClient, "session">;

export async function revokeAllSessionsForUser(
  userId: string,
  client: SessionClient = prisma,
): Promise<number> {
  const result = await client.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return result.count;
}

/**
 * Deletes rows that can no longer authorise anything.
 *
 * Expired and revoked sessions are dead weight after the audit window; this is
 * called opportunistically by the scheduled sync rather than on a request path.
 */
export async function pruneDeadSessions(olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await prisma.session.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
    },
  });
  return result.count;
}
