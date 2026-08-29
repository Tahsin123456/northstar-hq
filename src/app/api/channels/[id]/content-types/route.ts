import { z } from "zod";
import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { getTrackedChannel } from "@/server/services/channel-service";
import {
  contentTypeIdsSchema,
  setChannelContentTypes,
} from "@/server/services/content-type-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const setContentTypesSchema = z.object({
  contentTypeIds: contentTypeIdsSchema,
});

/**
 * PUT /api/channels/:id/content-types
 *
 * Replaces the channel's content-type tags with the supplied set — "what this
 * channel makes", as the team reads it. PUT rather than PATCH for the same
 * reason as `/niches` next door: the semantics are "these are now the tags",
 * which makes the call idempotent and avoids the drift that add/remove
 * endpoints accumulate. An empty array clears them.
 *
 * `:id` IS THE CHANNEL ID, matching `/api/channels/:id/niches` and
 * `ChannelDTO.id`. The `TrackedChannel` the join actually hangs off is resolved
 * from it inside the service, scoped to the caller's organization — a tracking
 * id in a URL would be a second addressing scheme for the same object.
 *
 * The updated channel comes back, so the client re-renders from what the server
 * stored rather than from what it hoped it wrote.
 */
export function PUT(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    // `niches.manage`, not `channels.manage`, and the split is deliberate:
    // `/niches` next door re-scopes a channel, which is an edit to the channel,
    // while this applies the user-defined taxonomy that `niches.manage` governs
    // everywhere else it appears — the same permission that created the tag.
    // Being able to invent a label but not apply it would be a strange half
    // capability.
    /*
     * APPLYING a tag is research.write, not niches.manage.
     *
     * Deciding the vocabulary and using it are different acts. Creating,
     * renaming and retiring content types shapes how the whole team describes
     * its work, and that stays with the heads and the admin (niches.manage).
     * Filing a Short under a label the team already agreed on is the same kind
     * of contribution as writing a note or saving a Short — which is exactly
     * what research.write governs — and an editor who cannot label the Shorts
     * they work on would leave the library to be classified by the two people
     * least likely to have watched them.
     */
    await requirePermission("research.write");

    const { id } = await context.params;
    const parsed = setContentTypesSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput("Provide a list of content type ids to assign.");
    }

    await setChannelContentTypes(id, parsed.data.contentTypeIds, request);
    return { channel: await getTrackedChannel(id) };
  });
}
