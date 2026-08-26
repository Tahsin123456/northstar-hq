import { z } from "zod";
import { handle, handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  getTrackedChannel,
  removeChannel,
  renameChannel,
  restoreChannel,
  setChannelOwnership,
} from "@/server/services/channel-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  label: z.string().max(120).nullable().optional(),
  ownershipType: z.enum(["own", "competitor"]).optional(),
  action: z.enum(["restore"]).optional(),
});

/** GET /api/channels/:id */
export function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    // Reading one channel's metadata is the same capability as reading the list.
    await requirePermission("analytics.view");

    const { id } = await context.params;
    return { channel: await getTrackedChannel(id) };
  });
}

/** PATCH /api/channels/:id — rename, or restore a soft-deleted channel. */
export function PATCH(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    // Renaming, re-scoping and restoring all change shared tracker state.
    await requirePermission("channels.manage");

    const { id } = await context.params;
    const parsed = patchSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput("Label must be 120 characters or fewer.");
    }

    if (parsed.data.action === "restore") {
      return { channel: await restoreChannel(id) };
    }

    if (parsed.data.ownershipType !== undefined) {
      return { channel: await setChannelOwnership(id, parsed.data.ownershipType) };
    }

    if (parsed.data.label !== undefined) {
      return { channel: await renameChannel(id, parsed.data.label) };
    }

    throw errors.invalidInput("Nothing to update.");
  });
}

/**
 * DELETE /api/channels/:id
 *
 * Soft delete. The channel leaves the tracker; its videos and snapshots stay,
 * because those measurements cannot be recreated after the fact.
 */
export function DELETE(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    // Removing a channel takes it out of everyone's tracker.
    await requirePermission("channels.manage");

    const { id } = await context.params;
    return { channel: await removeChannel(id) };
  });
}
