import "server-only";

import { cache } from "react";
import type { AppUser, OrganizationSettings, UserSettings } from "@prisma/client";
import { prisma } from "@/server/db";
import { errors } from "@/server/errors";
import { requireActor, type AuthenticatedActor } from "@/server/auth/dal";

/**
 * Who is asking, and whose data are they entitled to.
 *
 * This module used to answer both questions with a constant: `LOCAL_USER_ID`,
 * memoised in a module-level variable. Both parts of that were fine for a
 * single-user tool and are disqualifying for a shared one:
 *
 *   • A module-level cache lives for the life of the Node process, so it is
 *     shared by every concurrent request. With real accounts it would hand one
 *     person's identity to another and keep a deactivated employee working
 *     until the next deploy.
 *   • A hardcoded id means every authenticated user silently resolves to the
 *     same tenant — no error, no symptom, just everyone reading and writing one
 *     shared pile.
 *
 * Both are gone. Identity now comes from the session on every request, and
 * memoisation is React's `cache()`, which is scoped to a single render pass and
 * starts empty on the next request.
 *
 * SCOPE vs IDENTITY
 * Services want two different things and must not confuse them:
 *   • `organizationId` — what data to read and write. Shared by the whole team.
 *   • `userId` — who to attribute a new row to, and whose personal preferences
 *     to apply.
 * `getScope()` returns both so a service never has to decide for itself.
 */

export type UserWithSettings = AppUser & { settings: UserSettings };

export interface RequestScope {
  /** Every query on a shared resource must filter on this. */
  readonly organizationId: string;
  /** Authorship for new rows; never a filter on shared data. */
  readonly userId: string;
  readonly actor: AuthenticatedActor;
}

/**
 * The organization and user for this request.
 *
 * Throws 401 when there is no valid session, so a service can never
 * accidentally run unscoped: there is no "no user" branch to fall through.
 */
export const getScope = cache(async (): Promise<RequestScope> => {
  const actor = await requireActor();
  return { organizationId: actor.organizationId, userId: actor.userId, actor };
});

/** Shorthand for the common case: what data may I touch? */
export async function getCurrentOrgId(): Promise<string> {
  return (await getScope()).organizationId;
}

/** Shorthand for authorship. */
export async function getCurrentUserId(): Promise<string> {
  return (await getScope()).userId;
}

/**
 * The signed-in account plus its personal display preferences.
 *
 * Self-heals a missing settings row — that can only happen if a previous run
 * was interrupted between two inserts, and repairing it is friendlier than
 * failing the request. It emphatically does NOT create the user: auto-creating
 * an account on read is how an unrecognised id quietly mints a tenant, and in a
 * multi-user app that is a vulnerability rather than a convenience.
 */
export const getCurrentUser = cache(async (): Promise<UserWithSettings> => {
  const { userId } = await getScope();

  const existing = await prisma.appUser.findUnique({
    where: { id: userId },
    include: { settings: true },
  });

  if (!existing) {
    // The session pointed at a user that no longer exists. Treat as signed out.
    throw errors.unauthenticated();
  }

  if (existing.settings) {
    return { ...existing, settings: existing.settings };
  }

  const settings = await prisma.userSettings.create({ data: { userId: existing.id } });
  return { ...existing, settings };
});

/**
 * Team-wide settings for the current organization.
 *
 * The hit threshold, the trailing period and the sync cadence live here rather
 * than on the user because they must mean the same thing to everyone: a hit
 * rate the Head of Shorts and a Director disagree about is not a metric.
 */
export const getCurrentOrgSettings = cache(async (): Promise<OrganizationSettings> => {
  const { organizationId } = await getScope();
  return getOrgSettings(organizationId);
});

/**
 * Settings for a given organization, creating the row on first use.
 *
 * Separate from `getCurrentOrgSettings` so background jobs — which have no
 * session — can still resolve settings for the organization they are syncing.
 */
export async function getOrgSettings(organizationId: string): Promise<OrganizationSettings> {
  const existing = await prisma.organizationSettings.findUnique({ where: { organizationId } });
  if (existing) return existing;
  return prisma.organizationSettings.create({ data: { organizationId } });
}
