import type { NicheFormat } from "@/lib/niches/niche-format";

/**
 * Where a channel's detail page is, for a given format.
 *
 * The two channel pages are the same body under two providers, at two URLs:
 * /channels/[id] reads the Shorts dataset and /longform/channels/[id] the
 * Long Form one. A link built on a Long Form surface that points at the
 * Shorts URL is not a broken link — it opens, and shows the same channel —
 * which is exactly why it is dangerous: every figure on the page it opens
 * counts the other format, under a heading that does not say so. This is the
 * one place the rule "stay inside the format you came from" is written.
 */
export function channelHref(format: NicheFormat, channelId: string): string {
  return format === "shorts"
    ? `/channels/${channelId}`
    : `/longform/channels/${channelId}`;
}
