import "server-only";

import { errors } from "@/server/errors";
import { roleDefinition } from "@/lib/auth/permissions";
import type { NicheFormat } from "@/lib/niches/niche-format";

/**
 * =========================================================================
 * FORMAT SCOPING — WHICH SIDE OF THE OPERATION MAY THE CALLER SEE?
 * =========================================================================
 *
 * `niche-scope.ts` answers "of the niches, which ones are theirs?". This
 * module answers the question that arrives with Long Form: *which FORMAT'S
 * lists and numbers is this role about?* A Short Form Editor's dashboard is
 * the Shorts operation; a Head of Longs runs Long Form; an Admin compares
 * across both. That distinction is declared once, as `contentScope` on the
 * role table in `src/lib/auth/permissions.ts`, and read here — nothing in
 * this file compares a role string of its own.
 *
 * NOTHING CALLS THIS YET, DELIBERATELY. This deploy ships the Long Form
 * plumbing dark: the resolver exists, is tested, and is wired to the same
 * role table the admin UI already shows, so the LATER deploy that adds Long
 * Form surfaces enforces scope by calling it rather than by inventing it
 * under deadline. Shipping an enforcement point before any caller is how the
 * niche-scope module landed too, and it is the order that cannot regress the
 * running product.
 *
 * FAIL CLOSED, INHERITED RATHER THAN RESTATED. An unknown role string never
 * reaches this module's own logic: `roleDefinition` already resolves it to
 * the least-privileged role, whose `contentScope` is "shorts". So a typo'd or
 * hand-edited role sees the Shorts product — the one every current user has —
 * and never an extra format. `requireFormat` fails closed in its own right
 * too: a requested format outside the allowed set is a `forbidden` error, not
 * a fallback to something the caller did not ask for.
 */

/**
 * The formats a role is entitled to, in the order a default should prefer
 * them.
 *
 * A list rather than a single format because "all" is a real answer — Admin
 * compares across the operation — and because the first entry is what
 * `requireFormat` defaults to when the caller expresses no preference.
 * Shorts-first for "all", so an Admin who has not chosen lands on the product
 * that exists today.
 */
export function resolveAllowedFormats(role: string): readonly NicheFormat[] {
  switch (roleDefinition(role).contentScope) {
    case "shorts":
      return ["shorts"];
    case "longs":
      return ["longform"];
    case "all":
      return ["shorts", "longform"];
  }
}

/**
 * The format a request is entitled to proceed with.
 *
 * The whole decision, as a pure function of role and request — no I/O, so it
 * can be tested exhaustively and called from any depth of the server without
 * cost. Callers hand it the actor's role and whatever format the request
 * named (or `undefined` when it named none) and get back a format they may
 * act on, or a thrown `forbidden`.
 *
 * DEFAULTING IS NOT WIDENING. With no requested format the caller gets the
 * role's first allowed format — a Short Form Editor asking for "the
 * dashboard" gets Shorts. But a format that WAS requested is validated, never
 * substituted: a Long Form Editor requesting "shorts" gets a 403, not a
 * silent redirect to longform, because answering a question with data from a
 * scope the caller may see — but did not ask about — is how numbers end up
 * misread.
 */
export function requireFormat(actorRole: string, requested?: string): NicheFormat {
  const allowed = resolveAllowedFormats(actorRole);

  if (requested === undefined) return allowed[0];

  // `as NicheFormat` never widens: `includes` only admits values that are in
  // the allowed list, and everything in the list is a NicheFormat already.
  // An unrecognised string — "Shorts", "long", garbage — is simply not in the
  // list and is refused below rather than normalised into something valid.
  if ((allowed as readonly string[]).includes(requested)) {
    return requested as NicheFormat;
  }

  throw errors.forbidden("view this content format");
}
