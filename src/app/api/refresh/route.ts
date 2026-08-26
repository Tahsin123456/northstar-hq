import { z } from "zod";
import { handleMutation, readJson } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { RATE_LIMITS, enforceRateLimit } from "@/server/auth/rate-limit";
import { refreshStaleChannels } from "@/server/services/channel-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const refreshAllSchema = z.object({
  /** Bypass the staleness interval. The UI only sets this on an explicit click. */
  force: z.boolean().optional(),
  maxChannels: z.number().int().min(1).max(200).optional(),
});

/**
 * POST /api/refresh
 *
 * Sweep every tracked channel that has gone stale.
 *
 * This is also the endpoint an external scheduler (cron, a queue worker, a
 * Vercel Cron job) would call to make refreshes automatic — the staleness
 * filter means it is safe to invoke on a tight schedule without generating
 * redundant YouTube traffic. Such a caller now needs a session like any other:
 * the gate below is unconditional.
 */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    // Spends the organization's shared YouTube quota — up to 200 channels in
    // one call, `force` skipping the staleness filter entirely — so it takes
    // the operational sync permission, and it is resolved before the body is
    // read so an unpermitted caller can never reach the API.
    const actor = await requirePermission("sync.trigger");

    // Permission says who may sweep; the limiter says how often. Without it one
    // permitted account can drain the day's quota for everybody in a few
    // minutes, and the quota is the resource the whole product depends on.
    await enforceRateLimit(RATE_LIMITS.syncByUser, actor.userId);

    const parsed = refreshAllSchema.safeParse(await readJson(request));
    const options = parsed.success ? parsed.data : {};
    const results = await refreshStaleChannels(options);

    return {
      results,
      refreshed: results.length,
      failed: results.filter((r) => r.status === "error").length,
      quotaUnitsUsed: results.reduce((total, r) => total + r.quotaUnitsUsed, 0),
    };
  });
}
