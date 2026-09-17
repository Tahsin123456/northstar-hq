import type { NicheFormat } from "@/lib/niches/niche-format";
import { UPLOAD_VIEWS_TIP, UPLOAD_VIEWS_TIP_LONGFORM } from "@/lib/analytics/constants";

/**
 * The words on the Channels roster that name the format's unit.
 *
 * The roster is one module mounted at two URLs (`/channels` and
 * `/longform/channels`), and these are the only strings on it that say
 * "Shorts". They live here, as a pure function of the format, so the Shorts
 * route's copy can be pinned byte-for-byte in a test — a re-export that
 * quietly changed what the Shorts page says would be a regression nobody
 * would notice from the Long Form side, where the words are new.
 */
export interface ChannelsPageCopy {
  /** The empty state's second line, under "No channels tracked yet". */
  readonly emptyDescription: string;
  /** The definition behind the card's "Upload views" figure. */
  readonly uploadViewsTip: string;
  /** What the Removed channels block says survives a removal. */
  readonly removedHistory: string;
}

export function channelsPageCopy(format: NicheFormat): ChannelsPageCopy {
  if (format === "shorts") {
    return {
      emptyDescription:
        "Add a YouTube channel to start measuring how consistently it produces high-performing Shorts.",
      uploadViewsTip: UPLOAD_VIEWS_TIP,
      removedHistory:
        "Hidden from your dashboard. Their Shorts history is still stored and comes back intact.",
    };
  }
  return {
    emptyDescription:
      "Add a YouTube channel to start measuring how consistently it produces high-performing long-form videos.",
    uploadViewsTip: UPLOAD_VIEWS_TIP_LONGFORM,
    removedHistory:
      "Hidden from your dashboard. Their video history is still stored and comes back intact.",
  };
}
