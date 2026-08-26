import { handle } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { getExcludedVideos } from "@/server/services/dataset-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/channels/:id/excluded?startMs=&endMs=
 *
 * Videos stored for this channel that are *not* counted as Shorts, each with
 * the classifier's recorded reason. This is what makes "why isn't this in my
 * hit rate?" an answerable question instead of a trust exercise.
 */
export function GET(request: Request, context: RouteContext) {
  return handle(async () => {
    // The audit trail behind a hit rate is part of the analytics it explains.
    await requirePermission("analytics.view");

    const { id } = await context.params;
    const url = new URL(request.url);

    const parseMs = (key: string): number | undefined => {
      const raw = url.searchParams.get(key);
      if (!raw) return undefined;
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    };

    const videos = await getExcludedVideos(id, {
      startMs: parseMs("startMs"),
      endMs: parseMs("endMs"),
      limit: 300,
    });

    return { videos };
  });
}
