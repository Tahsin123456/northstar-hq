import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  reorderContentTypes,
  reorderContentTypesSchema,
} from "@/server/services/content-type-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/content-types/reorder — set the organization's list order.
 *
 * A static segment beside `/api/content-types/[id]`, which Next resolves in
 * favour of the literal path, so "reorder" can never be read as an id — the
 * same arrangement `assign` already relies on.
 *
 * POST rather than PATCH on the collection because the body is not a partial
 * edit of anything: it is the complete new order of the vocabulary, and the
 * server refuses a partial list rather than inventing positions for what it was
 * not sent. See `reorderContentTypes`.
 *
 * No `nicheId` any more. Sort order is one org-wide sequence now that the
 * catalogue is flat; the per-niche positions the old body named do not exist.
 *
 * The full list comes back, so the client re-renders from the order the server
 * actually stored rather than from the one it hoped it wrote.
 */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    await requirePermission("niches.manage");

    const parsed = reorderContentTypesSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That ordering is not valid.",
      );
    }

    return {
      contentTypes: await reorderContentTypes(parsed.data.orderedIds, request),
    };
  });
}
