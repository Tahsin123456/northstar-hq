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

/** PUT /api/saved/:videoId — replace the collections the caller's save belongs to. */
export function PUT(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    // Re-filing is a change to the caller's own board. `videoId` addresses it
    // because that is what the client holds; the service resolves it against
    // this person's save, so a colleague's filing is untouchable from here.
    await requirePermission("research.write");

    const { videoId } = await context.params;
    const parsed = collectionsSchema.safeParse(await readJson(request));
    if (!parsed.success) throw errors.invalidInput("Provide a list of collection ids.");
    return { saved: await updateSavedShortCollections(videoId, parsed.data.collectionIds) };
  });
}

export function DELETE(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    // Un-saving removes the caller's own save and nothing else. It used to
    // take the Short off whoever's board it happened to be on, because the row
    // was keyed on the video alone.
    await requirePermission("research.write");

    const { videoId } = await context.params;
    await unsaveShort(videoId);
    return { ok: true };
  });
}
