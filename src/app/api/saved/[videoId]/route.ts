import { z } from "zod";
import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  unsaveShort,
  updateSavedShortCollections,
} from "@/server/services/research-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ videoId: string }> };

const collectionsSchema = z.object({
  collectionIds: z.array(z.string().min(1)).max(20),
});

/** PUT /api/saved/:videoId — replace the collections this Short belongs to. */
export function PUT(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    // Re-filing a Short changes what the rest of the team sees on each board.
    await requirePermission("research.write");

    const { videoId } = await context.params;
    const parsed = collectionsSchema.safeParse(await readJson(request));
    if (!parsed.success) throw errors.invalidInput("Provide a list of collection ids.");
    return { saved: await updateSavedShortCollections(videoId, parsed.data.collectionIds) };
  });
}

export function DELETE(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    // Un-saving takes the Short off everyone's board, not just the caller's.
    await requirePermission("research.write");

    const { videoId } = await context.params;
    await unsaveShort(videoId);
    return { ok: true };
  });
}
