import { handle } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { buildDataset } from "@/server/services/dataset-service";

// Prisma requires the Node.js runtime, and this payload must never be cached
// at the edge — it is the user's live tracker state.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/dataset
 *
 * The one payload the client needs. Every period, threshold, sort, comparison
 * and channel-detail view is computed in the browser from this response, so
 * changing a filter costs zero requests.
 */
export function GET(request: Request) {
  return handle(async () => {
    // This single payload is the entire tracker — every channel, video and
    // snapshot the UI can show — so it is the analytics boundary itself.
    await requirePermission("analytics.view");

    const url = new URL(request.url);
    const lookbackParam = url.searchParams.get("lookbackDays");
    const lookbackDays = lookbackParam ? Number(lookbackParam) : undefined;

    return buildDataset({
      lookbackDays:
        lookbackDays && Number.isFinite(lookbackDays) && lookbackDays > 0
          ? Math.min(3650, Math.trunc(lookbackDays))
          : undefined,
    });
  });
}
