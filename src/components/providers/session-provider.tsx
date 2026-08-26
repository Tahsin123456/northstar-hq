"use client";

import * as React from "react";
import type { ActorDTO } from "@/server/auth/dal";
import { can, canAny, type Permission } from "@/lib/auth/permissions";

/**
 * Who is signed in, for the client.
 *
 * The value is handed down from the server layout, so there is no fetch on
 * first paint and no flash of a shell rendered for the wrong person.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT
 * Use it to decide what to *render*: hide the Finance nav item from someone
 * without `finance.view`, disable a control they cannot use, show their name.
 * That is an affordance — it stops people bumping into doors that will not open
 * for them.
 *
 * It is NOT a security boundary, and no decision that matters may rest on it.
 * Anything in the browser can be edited, so the answer to "may I?" is only ever
 * the one the server gives in `src/server/auth/dal.ts`. The two agree because
 * both derive from the same table in `src/lib/auth/permissions.ts` — this
 * provider just carries the actor's resolved permission set across the wire.
 */

interface SessionValue {
  readonly user: ActorDTO;
  /** True when the signed-in user holds the permission. */
  readonly can: (permission: Permission) => boolean;
  readonly canAny: (permissions: readonly Permission[]) => boolean;
}

const SessionContext = React.createContext<SessionValue | null>(null);

export function SessionProvider({
  user,
  children,
}: {
  user: ActorDTO;
  children: React.ReactNode;
}) {
  const value = React.useMemo<SessionValue>(() => {
    // The DTO carries the already-resolved set (role permissions ∪ individual
    // grants), so the client never re-derives it and cannot disagree with the
    // server about what a role means.
    const held = new Set<string>(user.permissions);
    return {
      user,
      can: (permission) => held.has(permission),
      canAny: (permissions) => permissions.some((permission) => held.has(permission)),
    };
  }, [user]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const context = React.useContext(SessionContext);
  if (!context) {
    throw new Error(
      "useSession must be used inside a <SessionProvider>. Components under src/app/(app) have one; " +
        "the sign-in and setup pages deliberately do not.",
    );
  }
  return context;
}

/**
 * The session when there is one, or null.
 *
 * For components that render on both sides of the auth boundary — a footer, an
 * error page — where throwing would be worse than rendering a signed-out state.
 */
export function useOptionalSession(): SessionValue | null {
  return React.useContext(SessionContext);
}

/**
 * Renders children only when the signed-in user holds the permission.
 *
 * A declarative shorthand for the common case, so call sites read as
 * `<IfPermitted to="finance.view">` rather than repeating the hook and a
 * ternary. Same caveat as above: this hides UI, it does not protect data.
 */
export function IfPermitted({
  to,
  children,
  fallback = null,
}: {
  to: Permission | readonly Permission[];
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const session = useOptionalSession();
  if (!session) return <>{fallback}</>;

  const allowed = Array.isArray(to)
    ? session.canAny(to)
    : session.can(to as Permission);

  return <>{allowed ? children : fallback}</>;
}

/** Re-exported so a component needs one import for the common pattern. */
export { can, canAny };
export type { Permission };
