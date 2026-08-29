import { handleMutation } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import {
  excludeContentTypeFromVideo,
  restoreInheritedContentType,
} from "@/server/services/content-type-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ videoId: string; contentTypeId: string }> };

/**
 * THE SINGLE-TAG OVERRIDE — one Short, one content type.
 *
 * WHY THIS EXISTS ALONGSIDE THE WHOLE-SET PUT NEXT DOOR
 *
 * Because of what the request would otherwise carry. Removing one inherited chip
 * is a single click, and expressing it as `PUT { contentTypeIds: [...] }` would
 * make that click send everything the client currently believes about the Short.
 * A tab left open while a colleague edited a different tag would then silently
 * revert their change as a side effect of touching this one. A request that can
 * only name one tag can only affect one tag, and that is the whole argument.
 *
 * It is also the gesture the design actually asks for. A Short's tags mostly
 * come from its channel, so the common edit is not "here is the new set" but
 * "not this one, on this Short" — and its undo.
 *
 * DELETE — refuse this tag. On a tag the channel provides, that writes a
 *   TOMBSTONE which survives the channel later dropping and re-adding the tag,
 *   so nobody's explicit "no" is quietly reversed. On a tag the channel does not
 *   provide it simply removes the Short's own manual row, because there is
 *   nothing to refuse.
 *
 * POST — take the refusal back, so the channel's tag flows through again.
 *
 * Both are idempotent: repeating either writes nothing and logs nothing, which
 * matters on controls people double-click.
 *
 * `:videoId` is the internal `Video` row id, matching the PUT next door and
 * every other video route — not the public, guessable YouTube id.
 */
export function DELETE(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    /*
     * `research.write`, the same as applying a tag — and deliberately not
     * `niches.manage`.
     *
     * Refusing a label is the same kind of act as applying one: a judgement
     * about one Short, made by whoever watched it. What stays with the heads and
     * the admin is deciding the VOCABULARY, which is a different permission on a
     * different object. An editor who could tag a Short but not untag it would
     * be one who can only ever make the library less accurate.
     */
    await requirePermission("research.write");

    const { videoId, contentTypeId } = await context.params;
    return excludeContentTypeFromVideo(videoId, contentTypeId, request);
  });
}

export function POST(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    await requirePermission("research.write");

    const { videoId, contentTypeId } = await context.params;
    return restoreInheritedContentType(videoId, contentTypeId, request);
  });
}
