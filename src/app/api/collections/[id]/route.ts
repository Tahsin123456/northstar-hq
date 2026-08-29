import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  deleteCollection,
  renameCollection,
  updateCollectionSchema,
} from "@/server/services/research-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export function PATCH(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    // Renaming is curating a research board. Which board — the service matches
    // the folder against its owner, or an admin holding `users.manage`.
    await requirePermission("research.write");

    const { id } = await context.params;
    const parsed = updateCollectionSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That collection name is not valid.",
      );
    }
    return { collection: await renameCollection(id, parsed.data.name) };
  });
}

/** Deletes the folder only. The saved Shorts inside it survive, uncollected. */
export function DELETE(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    // Dropping a folder rearranges its owner's board, so it needs the same
    // write capability as creating one.
    await requirePermission("research.write");

    const { id } = await context.params;
    return deleteCollection(id);
  });
}
