"use client";

import { useSession } from "@/components/providers/session-provider";
import type { NicheFormat } from "@/lib/niches/niche-format";

/**
 * Which format's dataset a FORMAT-NEUTRAL page should read.
 *
 * Notes and Saved belong to everybody — the sidebar calls them exactly that —
 * and they sit outside both format layouts, so the subtree context answers
 * "shorts" for every visitor. For a Long Form role that answer is not merely
 * a default, it is one the server refuses: `/api/dataset?format=shorts` is a
 * 403 for a role whose scope is "longs", so the Saved board rendered as a
 * full-page error with a Retry that failed the same way forever, and Notes
 * silently lost its channel and niche filters. Both invited the visit: the
 * Save button is on every Long Form card and the save itself works.
 *
 * So these pages ask the SESSION rather than the subtree. The role's own
 * `contentScope` is already on `ActorDTO`, derived beside `roleLabel` from the
 * same role table the server checks with, so the format chosen here cannot
 * disagree with the one `requireFormat` will allow.
 *
 * An admin ("all") gets Shorts, which is what `resolveAllowedFormats` puts
 * first and what these pages have always shown them.
 */
export function useResearchFormat(): NicheFormat {
  const { user } = useSession();
  return user.contentScope === "longs" ? "longform" : "shorts";
}
