import { z } from "zod";
import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { getTrackedChannel } from "@/server/services/channel-service";
import { setChannelNiches } from "@/server/services/niche-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const setNichesSchema = z.object({
  nicheIds: z.array(z.string().min(1)).max(20),
});

/**
 * PUT /api/channels/:id/niches
 *
 * Replaces the channel's niche assignments with the supplied set. PUT rather
 * than PATCH because the semantics are "these are now the niches", which makes
 * the call idempotent and avoids the drift that add/remove endpoints
 * accumulate. An empty array unassigns the channel entirely.
 */
export function PUT(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    // Re-scoping a channel edits the channel, so it takes the channel
    // capability rather than `niches.manage`, which governs the niches themselves.
    await requirePermission("channels.manage");

    const { id } = await context.params;
    const parsed = setNichesSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput("Provide a list of niche ids to assign.");
    }
    await setChannelNiches(id, parsed.data.nicheIds);
    return { channel: await getTrackedChannel(id) };
  });
}
