import { handle } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { requireFormat } from "@/server/auth/format-scope";
import { getNicheViewsGained } from "@/server/services/niche-views-gained-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/niches/views-gained?format=…&startMs=…&endMs=…
 *
 * Views gained per visible niche of one format over the covered part of the
 * requested period, from the snapshot series — the view side of the niche
 * money figures. Reports `measuredFromMs` so the caller can label a span the
 * history only partly covers rather than presenting it as the whole period.
 */
export function GET(request: Request) {
  return handle(async () => {
    // View deltas are the same class of numbers the dashboard already shows,
    // read as a difference instead of a total — one permission covers both.
    // The money they get multiplied into stays behind `finance.view`, on the
    // rate the dataset withholds.
    const actor = await requirePermission("analytics.view");

    /*
     * THE FORMAT BOUNDARY, SAME AS THE DATASET'S. These are one format's
     * niche figures, so a role scoped to the other side gets the identical
     * 403 rather than a side door into numbers the dataset route refuses.
     * `?? undefined` because `searchParams.get` answers null, which
     * `requireFormat` must read as "no preference", not as a garbage format.
     */
    const url = new URL(request.url);
    const format = requireFormat(actor.role, url.searchParams.get("format") ?? undefined);

    const startMs = Number(url.searchParams.get("startMs"));
    const endMs = Number(url.searchParams.get("endMs"));

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      throw errors.invalidInput("Provide a valid startMs and endMs, with startMs before endMs.");
    }
    if (endMs - startMs > 3650 * 86_400_000) {
      throw errors.invalidInput("Provide a period of at most 3650 days.");
    }

    return getNicheViewsGained({ format, startMs, endMs });
  });
}
