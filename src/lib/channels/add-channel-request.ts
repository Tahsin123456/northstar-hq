import type { OwnershipType } from "@/lib/dto";
import type { NicheFormat } from "@/lib/niches/niche-format";

/**
 * The two request bodies the add-channel flow can send, as pure functions.
 *
 * They live outside the components so the SHAPES can be pinned by value
 * rather than read off JSX: whether `ownershipType` travels, and whether
 * `format` does, are the two facts that decide what the server may change —
 * and both are the kind of thing a tidy-up quietly regresses.
 */

export interface AddChannelRequest {
  readonly input: string;
  readonly ownershipType?: OwnershipType;
  readonly nicheIds: readonly string[];
  /**
   * Which side of the operation the channel was added on.
   *
   * Travels ONLY when it is Long Form, exactly as `createNicheRequest` sends
   * its own, so every Shorts request is byte-identical to the one that
   * always shipped. It decides where a channel with NO niches is listed —
   * an unfiled channel used to appear on both rosters, which put a row with
   * no verdicts, no window and no pay on the Long Form side of a channel
   * somebody added under Shorts.
   */
  readonly format?: "longform";
}

/**
 * What the dialog posts for a resolved channel.
 *
 * OWNERSHIP TRAVELS ONLY FOR A CHANNEL THE TRACKER HAS NEVER HELD, and the
 * two exceptions are the same mistake seen twice.
 *
 * A channel it already holds is FILED, not re-added: sending the dialog's
 * "competitor" default would demote an own channel because somebody filed it
 * from the other side of the operation.
 *
 * A channel it held BEFORE is restored, and the stored row already knows what
 * it was. The selector cannot show that — `ChannelPreviewDTO` carries no
 * ownership — so it renders its hard "competitor" default, and sending that
 * wrote "competitor" over "own" on every restore: the channel came back on
 * the wrong side of Us vs Market, dropped out of every own-channel figure,
 * and its hits stopped paying anyone a bonus, under preview copy promising it
 * "will come back with it". Omitting the key is what makes `addChannel`'s
 * documented "a restored row keeps what it had" branch reachable at all.
 *
 * The key is ABSENT in both cases, never null: `?? existingTracking.own…`
 * upstream distinguishes "said nothing" from "said something", and a null
 * would be the second.
 */
export function addChannelRequest(args: {
  readonly youtubeChannelId: string;
  readonly alreadyTracked: boolean;
  /** Tracked before and soft-removed. Restoring keeps the stored ownership. */
  readonly previouslyRemoved: boolean;
  readonly ownershipType: OwnershipType;
  readonly nicheIds: readonly string[];
  /** The dialog’s own side. Sent only when Long Form; see `AddChannelRequest`. */
  readonly format: NicheFormat | undefined;
}): AddChannelRequest {
  const { youtubeChannelId: input, nicheIds } = args;
  /*
   * ON THE ALREADY-TRACKED PATH TOO, and this is the one that is easy to get
   * wrong: that request FILES a channel the tracker holds, which is how a
   * Long Form niche reaches a channel the Shorts side added first. If the
   * caller unfiles it again later, the side it was last placed on is the
   * honest answer to where it belongs. Unlike `ownershipType`, this cannot
   * demote anything: a filed channel is listed by its niches regardless.
   */
  const side = args.format === "longform" ? { format: "longform" as const } : {};
  return args.alreadyTracked || args.previouslyRemoved
    ? { input, nicheIds, ...side }
    : { input, ownershipType: args.ownershipType, nicheIds, ...side };
}

/**
 * What the picker's inline "New niche" posts.
 *
 * The format travels only when it is Long Form, exactly as the Niches page
 * sends it, so every Shorts surface keeps sending the request it always sent.
 * It has to travel then: an absent format resolves to the caller's FIRST
 * allowed format on the server, which for an admin is Shorts — a Long Form
 * dialog that sent nothing would create a Shorts niche and file the channel
 * under it.
 */
export function createNicheRequest(
  name: string,
  format: NicheFormat | undefined,
): { readonly name: string; readonly format?: "longform" } {
  return format === "longform" ? { name, format } : { name };
}
