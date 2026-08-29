"use client";

import { useOptionalSession } from "@/components/providers/session-provider";

/**
 * The two capabilities the content-type UI reads, in one place.
 *
 * TWO DIFFERENT THINGS MEET IN THIS FEATURE, and conflating them is how it ends
 * up useless to the people who use it most.
 *
 * APPLYING a tag — and REFUSING one, which is the same kind of act — is
 * `research.write`, the same permission behind writing a note or saving a Short.
 * Every editor can label the Shorts they work on, and can take a label off. An
 * editor who could tag a Short but not untag it would be one who can only ever
 * make the library less accurate.
 *
 * CREATING a tag is `niches.manage`, because it adds a word to the vocabulary the
 * whole team then argues in. An editor sees the list and files against it; they
 * do not get to extend it in passing.
 *
 * WHY THEY LIVE HERE RATHER THAN IN THE COMPONENT THAT FIRST NEEDED THEM. Three
 * modules now ask — the row control, the list body they share, and the Short's
 * own panel — and the list body cannot import from the control without a cycle.
 * A permission string copied into three files is a permission string that gets
 * changed in two of them.
 *
 * Both routes enforce regardless. Hiding an affordance only spares somebody a
 * control that would answer 403.
 */

/** May file a Short under a tag the team already has, and may take one off. */
export function useCanAssignContentTypes(): boolean {
  const session = useOptionalSession();
  return session?.can("research.write") ?? false;
}

/** May add a word to the vocabulary — a narrower thing, see the note above. */
export function useCanManageContentTypes(): boolean {
  const session = useOptionalSession();
  return session?.can("niches.manage") ?? false;
}
