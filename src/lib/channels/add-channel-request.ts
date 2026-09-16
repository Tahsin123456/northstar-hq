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
}

/**
 * What the dialog posts for a resolved channel.
 *
 * A channel the tracker already holds is FILED, not re-added, and no
 * ownership travels with it — the key is absent, not null — because the
 * dialog's "competitor" default must not demote an own channel just because
 * it was filed from the other side of the operation. A fresh add or a restore
 * carries the choice the person made.
 */
export function addChannelRequest(args: {
  readonly youtubeChannelId: string;
  readonly alreadyTracked: boolean;
  readonly ownershipType: OwnershipType;
  readonly nicheIds: readonly string[];
}): AddChannelRequest {
  const { youtubeChannelId: input, nicheIds } = args;
  return args.alreadyTracked
    ? { input, nicheIds }
    : { input, ownershipType: args.ownershipType, nicheIds };
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
