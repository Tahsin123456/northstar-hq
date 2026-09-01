import { handle } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { requireFormat } from "@/server/auth/format-scope";
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
    const actor = await requirePermission("analytics.view");

    const url = new URL(request.url);

    /*
     * WHICH FORMAT'S PRODUCT, enforced here because this payload IS the
     * product. `searchParams.get` answers `null` for an absent parameter and
     * `requireFormat` treats only `undefined` as "no preference", so the
     * coercion is load-bearing: passed through raw, every existing
     * parameterless client would be refused instead of defaulted. The default
     * is the role's own side of the operation — shorts for admin and every
     * shorts role, longform for the longs roles — and a REQUESTED format
     * outside the role's scope is a 403, never a substitution.
     */
    const format = requireFormat(actor.role, url.searchParams.get("format") ?? undefined);

    const lookbackParam = url.searchParams.get("lookbackDays");
    const lookbackDays = lookbackParam ? Number(lookbackParam) : undefined;

    return buildDataset({
      format,
      lookbackDays:
        lookbackDays && Number.isFinite(lookbackDays) && lookbackDays > 0
          ? Math.min(3650, Math.trunc(lookbackDays))
          : undefined,
    });
  });
}
