import { handle } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { requireFormat } from "@/server/auth/format-scope";
import { getHistoricalViews } from "@/server/services/history-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/history/views-as-of?asOfMs=…&windowDays=…
 *
 * View counts for Shorts uploaded in the window ending at `asOfMs`, as they
 * stood at that moment, reconstructed from stored snapshots. Reports coverage
 * so the caller can refuse to render an unreliable reconstruction.
 */
export function GET(request: Request) {
  return handle(async () => {
    // Past view counts are the same numbers the dashboard shows, read at an
    // earlier moment — one permission covers both.
    const actor = await requirePermission("analytics.view");

    /*
     * THE RECONSTRUCTION IS SHORTS DATA, SO THE SHORTS BOUNDARY APPLIES.
     * `getHistoricalViews` reads `isShort: true` across every tracked channel
     * — the same class of figures `/api/dataset?format=shorts` refuses a
     * longs-role actor. Asking `requireFormat` for "shorts" explicitly makes
     * this endpoint answer with the identical 403 rather than quietly serving
     * the Shorts product through a side door the dataset route closed.
     */
    requireFormat(actor.role, "shorts");

    const url = new URL(request.url);
    const asOfMs = Number(url.searchParams.get("asOfMs"));
    const windowDays = Number(url.searchParams.get("windowDays"));

    if (!Number.isFinite(asOfMs) || asOfMs <= 0) {
      throw errors.invalidInput("Provide a valid asOfMs timestamp.");
    }
    if (!Number.isFinite(windowDays) || windowDays <= 0 || windowDays > 3650) {
      throw errors.invalidInput("Provide a window of between 1 and 3650 days.");
    }

    return getHistoricalViews({ asOfMs, windowDays: Math.trunc(windowDays) });
  });
}
