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
 * Sets one Short's content-type tags. `:videoId` is the internal `Video` row id
 * (`VideoDTO.id`), which the client already holds from the dataset — not the
 * YouTube id, which is public and guessable.
 *
 * THE BODY IS THE DESIRED EFFECTIVE SET, not a list of rows to write. The
 * client sends what it wants the Short to carry — which is the only thing it can
 * honestly send, since a person sees a Short's tags and not which of them came
 * from the channel — and the service translates that into deviations: a channel
 * tag left out becomes an exclusion, a tag the channel does not give becomes a
 * manual row, and a tag the channel does give is stored nowhere at all.
 *
 * So an empty array is not "delete this Short's rows". On a Short whose channel
 * is tagged it is a set of refusals, and it has to be, or clearing the field
 * would leave the inherited tags showing.
 *
 * Returns the DEVIATIONS it stored plus the resolved effective set, rather than
 * a video DTO. There is no video-shaped read endpoint to mirror — the client
 * gets its videos from `/api/dataset` — and the deviations are exactly the two
 * fields `VideoDTO` carries, so the caller can patch its cache with them
 * without inferring the storage shape from a rendering one.
 *
 * The single-tag override lives next door at
 * `/api/videos/:videoId/content-types/:contentTypeId`; see the note there for
 * why removing one inherited chip must not be expressed as a whole-set PUT.
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

    // Echoing what the SERVICE stored rather than what the request asked for.
    // The two are no longer the same shape: the request names tags, the answer
    // names deviations, and the client patches its dataset with the answer.
    return setVideoContentTypes(videoId, parsed.data.contentTypeIds, request);
  });
}
