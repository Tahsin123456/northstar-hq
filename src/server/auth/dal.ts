import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { prisma } from "@/server/db";
import { errors } from "@/server/errors";
import { authEnv } from "@/server/auth/auth-env";
import { SESSION_COOKIE_NAME, hashToken, readSessionCookie } from "@/server/auth/tokens";
import {
  can,
  effectivePermissions,
  roleDefinition,
  type Permission,
  type Role,
} from "@/lib/auth/permissions";

/**
 * =========================================================================
 * DATA ACCESS LAYER — THE AUTHORIZATION BOUNDARY
 * =========================================================================
 *
 * This is where "who is asking, and may they?" is actually decided. Nothing
 * else in the application is a security boundary:
 *
 *   • `src/proxy.ts` redirects unauthenticated browsers to /login. It runs on
 *     prefetches, cannot see the database, and its matcher excludes /api — it
 *     is a convenience, and treating it as protection would leave every byte
 *     of real data open.
 *   • Hiding a nav item or a button in React changes what is rendered, not
 *     what is reachable. The API is the app.
 *
 * So every route handler and every server-side data read goes through
 * `requireSession()` / `requirePermission()` here, as close to the data as it
 * is possible to put the check.
 *
 * WHY THE SESSION IS RE-READ EVERY REQUEST
 * The lookup is one indexed query joined to the user row, and it deliberately
 * is not cached beyond a single request. The Next.js docs suggest caching a
 * session "for its lifetime" for speed; doing that here would mean a
 * deactivated employee keeps working for up to two weeks, which is precisely
 * the requirement this design exists to satisfy. React's `cache()` memoises
 * within one render pass only — several components asking who the user is cost
 * one query, and the next request starts clean.
 *
 * There is no module-level cache in this file, and there must never be one.
 */

export interface AuthenticatedActor {
  readonly userId: string;
  readonly sessionId: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly role: Role | string;
  /** Individual permissions granted on top of the role. */
  readonly grants: readonly string[];
  /** Role permissions ∪ grants, precomputed for convenience. */
  readonly permissions: ReadonlySet<Permission>;
}

/**
 * Resolves the caller, or null when there is no valid session.
 *
 * Returns null rather than throwing so callers can choose their own failure —
 * a route handler wants a 401, a page wants a redirect, and the login page
 * itself wants neither.
 */
export const getActor = cache(async (): Promise<AuthenticatedActor | null> => {
  const cookieStore = await cookies();
  const token = readSessionCookie(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      expiresAt: true,
      revokedAt: true,
      lastSeenAt: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          status: true,
          deactivatedAt: true,
          memberships: {
            select: {
              organizationId: true,
              role: true,
              organization: { select: { name: true } },
              grants: { select: { permission: true } },
            },
            // Ordered, not merely limited. `take: 1` without an ordering is
            // whatever the database returns first, which is not guaranteed to
            // be stable — so a person in two organizations could read one on
            // this request and the other on the next, with every service
            // scoping to whichever came back. Oldest membership wins, which is
            // deterministic and matches "the workspace you joined first".
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: 1,
          },
        },
      },
    },
  });

  if (!session) return null;

  const now = Date.now();
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() <= now) return null;

  // Idle timeout. An unattended browser stops being a way in without requiring
  // the absolute lifetime to have elapsed.
  if (now - session.lastSeenAt.getTime() > authEnv.idleTimeoutMs) return null;

  // The two checks that make deactivation immediate.
  const user = session.user;
  if (user.deactivatedAt) return null;
  if (user.status !== "active") return null;

  const membership = user.memberships[0];
  if (!membership) return null; // An account with no workspace can see nothing.

  const grants = membership.grants.map((g) => g.permission);

  // Advance the activity clock. This has to happen here, on the one code path
  // every authenticated request already takes: the idle timeout above compares
  // against `lastSeenAt`, so if nothing ever writes it the check degrades into
  // "time since sign-in" and logs people out mid-work.
  //
  // The write is throttled inside the query — it matches no rows unless the
  // stamp is genuinely stale — so the usual cost is one indexed no-op update,
  // not a write per request.
  await touchLastSeen(session.id, session.lastSeenAt, now);

  return {
    userId: user.id,
    sessionId: session.id,
    email: user.email,
    name: user.name,
    organizationId: membership.organizationId,
    organizationName: membership.organization.name,
    role: membership.role,
    grants,
    permissions: effectivePermissions(membership.role, grants),
  };
});

/**
 * The caller, or a 401.
 *
 * The default for every route handler that touches data.
 */
export async function requireActor(): Promise<AuthenticatedActor> {
  const actor = await getActor();
  if (!actor) throw errors.unauthenticated();
  return actor;
}

/**
 * The caller, or a 403 if they lack the capability.
 *
 * Returns the actor so the common case is one call:
 *   const actor = await requirePermission("finance.view");
 */
export async function requirePermission(permission: Permission): Promise<AuthenticatedActor> {
  const actor = await requireActor();
  if (!actor.permissions.has(permission)) {
    throw errors.forbidden(describePermission(permission));
  }
  return actor;
}

/** True when the caller holds the permission; never throws. */
export async function actorCan(permission: Permission): Promise<boolean> {
  const actor = await getActor();
  return actor ? actor.permissions.has(permission) : false;
}

/**
 * The organization every query must be scoped to.
 *
 * This is the single answer to "whose data is this?" — the replacement for the
 * hardcoded `LOCAL_USER_ID` the app used before it had accounts. Services call
 * this instead of deciding scope themselves, so there is one place to audit.
 */
export async function requireOrganizationId(): Promise<string> {
  return (await requireActor()).organizationId;
}

/** Convenience for services that need both scope and authorship. */
export async function requireScope(): Promise<{
  organizationId: string;
  userId: string;
  actor: AuthenticatedActor;
}> {
  const actor = await requireActor();
  return { organizationId: actor.organizationId, userId: actor.userId, actor };
}

/**
 * Advances the session's activity clock, at most once every few minutes.
 *
 * Writing on every request would add a database write to every page load for no
 * benefit, since the idle window is measured in hours. The staleness condition
 * lives in the `where` clause so the throttle is enforced by the database
 * rather than by a counter this process would have to hold.
 *
 * Failures are swallowed: not recording activity must never fail the request
 * the person actually made.
 */
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;

async function touchLastSeen(sessionId: string, lastSeenAt: Date, nowMs: number): Promise<void> {
  if (nowMs - lastSeenAt.getTime() < LAST_SEEN_WRITE_INTERVAL_MS) return;
  try {
    await prisma.session.updateMany({
      where: { id: sessionId },
      data: { lastSeenAt: new Date(nowMs) },
    });
  } catch {
    /* activity tracking is best-effort */
  }
}

function describePermission(permission: Permission): string {
  switch (permission) {
    case "finance.view":
    case "finance.manage":
      return "access financial data";
    case "payroll.view":
    case "payroll.manage":
      return "access payroll";
    case "earnings.view_own":
      return "see your earnings";
    case "users.manage":
      return "manage users";
    case "audit.view":
      return "view the audit log";
    case "youtube.manage":
      return "manage YouTube connections";
    case "settings.manage":
      return "change system settings";
    case "channels.manage":
      return "manage tracked channels";
    case "niches.manage":
      return "manage niches";
    case "sync.trigger":
      return "trigger a data sync";
    case "research.write":
      return "save notes and Shorts";
    case "reports.generate":
      return "generate reports";
    case "analytics.view":
    default:
      return "view this";
  }
}

/**
 * A serialisable description of the caller for the client.
 *
 * A DTO rather than the row: `passwordHash`, session ids and anything else the
 * browser has no business holding simply are not fields on this type, so they
 * cannot leak by accident when a component spreads the object into props.
 */
export interface ActorDTO {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly role: string;
  readonly roleLabel: string;
  readonly organizationName: string;
  readonly permissions: readonly Permission[];
}

export function toActorDTO(actor: AuthenticatedActor): ActorDTO {
  return {
    id: actor.userId,
    name: actor.name,
    email: actor.email,
    role: actor.role,
    roleLabel: roleDefinition(actor.role).label,
    organizationName: actor.organizationName,
    permissions: [...actor.permissions],
  };
}

/** Re-exported so callers need only one import for the common pattern. */
export { can };
