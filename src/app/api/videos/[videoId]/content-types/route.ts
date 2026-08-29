import { z } from "zod";
import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  contentTypeIdsSchema,
  setVideoContentTypes,
} from "@/server/services/content-type-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ videoId: string }> };

const setContentTypesSchema = z.object({
  contentTypeIds: contentTypeIdsSchema,
});

/**
 * PUT /api/videos/:videoId/content-types
 *
 * Replaces one Short's content-type tags. `:videoId` is the internal `Video`
 * row id (`VideoDTO.id`), which the client already holds from the dataset — not
 * the YouTube id, which is public and guessable.
 *
 * Returns the ids it stored rather than a video DTO. There is no video-shaped
 * read endpoint to mirror — the client gets its videos from `/api/dataset` —
 * and echoing the stored set is what the caller needs to reconcile its
 * optimistic update.
 *
 * THERE IS NO SIBLING `/available` ROUTE, and now there is nothing one could
 * usefully say. The catalogue is flat and org-wide, so the picker's options are
 * simply the organization's active tags — already in the dataset, the same
 * array for every Short. What the PUT below still checks is tenancy on both
 * sides: the tags must be this organization's, and the Short must be one this
 * caller can see.
 */
export function PUT(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    // Same permission as every other content-type write: classifying a Short
    // changes a label the whole team compares formats on.
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

    const { videoId } = await context.params;
    const parsed = setContentTypesSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput("Provide a list of content type ids to assign.");
    }

    await setVideoContentTypes(videoId, parsed.data.contentTypeIds, request);

    return { videoId, contentTypeIds: [...new Set(parsed.data.contentTypeIds)].sort() };
  });
}
