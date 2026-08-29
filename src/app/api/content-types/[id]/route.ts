import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  deleteContentType,
  renameContentType,
  setContentTypeActive,
  updateContentTypeSchema,
} from "@/server/services/content-type-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * PATCH /api/content-types/:id — rename, restyle, reorder, archive or restore.
 *
 * `isActive` travels on the same PATCH as the rest rather than living behind
 * its own /archive endpoint, because from the client's side it is one more
 * property of the row. It is applied SECOND below, so a request that both
 * renames and archives records the archive against the new name.
 */
export function PATCH(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    await requirePermission("niches.manage");

    const { id } = await context.params;
    const parsed = updateContentTypeSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That update is not valid.",
      );
    }

    const { isActive, ...fields } = parsed.data;

    // Two service calls rather than one, because they are two different audit
    // events: renaming and archiving are separately findable in the log, and
    // folding them into one write would have to pick a single key for both.
    let contentType =
      Object.keys(fields).length > 0
        ? await renameContentType(id, fields, request)
        : null;

    if (isActive !== undefined) {
      contentType = await setContentTypeActive(id, isActive, request);
    }

    // Unreachable — the schema refuses an empty body — but the type has to be
    // narrowed and throwing beats a non-null assertion.
    if (!contentType) throw errors.invalidInput("Nothing to update.");

    return { contentType };
  });
}

/**
 * DELETE /api/content-types/:id
 *
 * Only ever removes a type nothing carries. One that is in use is refused with
 * a 400 naming how many Shorts and channels would lose the tag, and the client
 * is expected to offer archiving instead — see the note on `deleteContentType`.
 */
export function DELETE(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    await requirePermission("niches.manage");

    const { id } = await context.params;
    return deleteContentType(id, request);
  });
}
