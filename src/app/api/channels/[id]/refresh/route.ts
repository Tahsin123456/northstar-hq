import { handleMutation } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { refreshChannel } from "@/server/services/channel-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A large channel can take a while to walk; allow generous headroom. */
export const maxDuration = 120;

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/channels/:id/refresh
 *
 * Manual refresh. Ignores the staleness interval — the user asked explicitly,
 * and the interval exists to throttle *automatic* sweeps, not to argue with a
 * deliberate click.
 */
export function POST(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    // A hand-triggered sweep walks the channel on shared quota, which is exactly
    // what `sync.trigger` exists to ration.
    await requirePermission("sync.trigger");

    const { id } = await context.params;
    return { result: await refreshChannel(id) };
  });
}
