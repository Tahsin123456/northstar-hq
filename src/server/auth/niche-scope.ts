import "server-only";

import { cache } from "react";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { requireActor } from "@/server/auth/dal";
import { isNicheScoped } from "@/lib/auth/permissions";

/**
 * =========================================================================
 * NICHE SCOPING — WHICH CHANNELS IS THE CALLER ENTITLED TO SEE?
 * =========================================================================
 *
 * `dal.ts` answers "who is asking, and may they?". This module answers the
 * narrower question that follows for the three niche-scoped roles: *of the
 * things they may see, which ones are theirs?*
 *
 * An editor assigned to GTA sees GTA. A Head sees the whole operation, because
 * comparing across niches is the job. That distinction is declared once, as
 * `nicheScoped` in `src/lib/auth/permissions.ts`, and read here — nothing in
 * this file compares a role string of its own.
 *
 * WHY IT IS A QUERY FILTER AND NOT A UI CONCERN
 * Filtering in the browser means the server already sent the data: the payload
 * is in the network tab, in the React cache, and in `/api/dataset` to anyone
 * who types the URL. So the visible-niche set is folded into the same `where`
 * clause that already carries `organizationId`, as close to the rows as the
 * organization filter itself.
 *
 * FAIL CLOSED
 * A niche-scoped member with no assignments sees NOTHING — not everything.
 * Treating "no rows" as "no restriction" is the classic shape of this bug:
 * the moment an assignment is deleted, or an editor is created before anybody
 * gets round to filing them, the least-privileged account in the building
 * quietly becomes the most privileged. `resolveVisibleNicheIds` returns an
 * empty array for that case and every filter built from it matches no rows.
 *
 * The `null` / `string[]` distinction is deliberate and load-bearing:
 *   • `null`      — this role is not niche-scoped; do not filter at all.
 *   • `string[]`  — filter to exactly these niches; `[]` means nothing.
 * A single "empty means everything" shortcut would collapse the two, which is
 * exactly the collapse that produces the bug above.
 */

/**
 * The caller's visible niches, or `null` when they see everything.
 *
 * Not `readonly string[] | null` at the point of use by accident: callers must
 * check for `null` before treating it as a list, and the type makes forgetting
 * a compile error rather than an outage.
 */
export type VisibleNiches = readonly string[] | null;

/**
 * The whole decision, as a pure function.
 *
 * Split out from the query below so the rule can be tested exhaustively without
 * a database — role in, visible set out. See
 * `src/server/__tests__/niche-scope.test.ts`.
 */
export function resolveVisibleNicheIds(
  role: string,
  assignedNicheIds: readonly string[],
): VisibleNiches {
  // Roles that are not niche-scoped are not merely "assigned to every niche":
  // they are outside the mechanism, and must keep seeing channels that have no
  // niche at all. Returning `null` rather than a list of every niche id is what
  // preserves that — an unfiled channel belongs to no niche and would vanish
  // from a Head's dashboard the moment we started filtering them by one.
  if (!isNicheScoped(role)) return null;

  // Deduplicated and ordered so the result is stable: it feeds an `in` clause
  // and a memoised value, and a set that reshuffles per request makes query
  // plans and test failures needlessly interesting.
  return [...new Set(assignedNicheIds)].sort();
}

/**
 * The caller's visible niches for this request.
 *
 * Memoised with React `cache()` like the rest of the DAL: several services ask
 * this question during one render — the dataset, the channel list, a direct
 * channel lookup — and they should cost one query between them, not one each.
 * The memo is per render pass, so a niche unassigned a second ago is respected
 * on the very next request. There is no module-level cache here, and there must
 * never be one.
 */
export const getVisibleNicheIds = cache(async (): Promise<VisibleNiches> => {
  const actor = await requireActor();

  // Skip the query entirely for roles the answer cannot depend on. This is not
  // only a saved round trip: it means a Head with stray MemberNiche rows (from
  // a demotion, say) is not accidentally narrowed by them.
  if (!isNicheScoped(actor.role)) return null;

  const rows = await prisma.memberNiche.findMany({
    where: {
      // The membership, resolved from the session — never from anything the
      // request supplied. `memberId` is not on the actor, so it is reached
      // through the (organizationId, userId) unique pair the session already
      // proves.
      member: { organizationId: actor.organizationId, userId: actor.userId },
      // Belt and braces: an assignment pointing at another organization's niche
      // must not widen this one. It cannot happen through the app today, and it
      // costs one indexed join to make sure it never does.
      niche: { organizationId: actor.organizationId },
    },
    select: { nicheId: true },
  });

  return resolveVisibleNicheIds(
    actor.role,
    rows.map((row) => row.nicheId),
  );
});

/**
 * The `where` fragment that narrows tracked channels to the visible niches.
 *
 * Returned as a fragment to spread rather than applied here, so it composes
 * with the `organizationId` filter every query already carries instead of
 * replacing it. Tenancy and niche scoping are two independent narrowings and
 * both must survive.
 */
export function trackedChannelNicheFilter(
  visible: VisibleNiches,
): Prisma.TrackedChannelWhereInput {
  if (visible === null) return {};

  // No assignments means no channels. Prisma already resolves `in: []` to
  // "matches nothing", so the clause below would do the right thing on its own —
  // but the fail-closed case is the one that matters most and the one a future
  // refactor is likeliest to break, so it is spelled out rather than inferred.
  if (visible.length === 0) return { id: { in: [] } };

  return { niches: { some: { nicheId: { in: [...visible] } } } };
}
