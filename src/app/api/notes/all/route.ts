import { handle } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { listAllNotes } from "@/server/services/research-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/notes/all — every note with its channel / niche / Short context. */
export function GET() {
  return handle(async () => {
    // This is the whole organization's annotations in one payload — the same
    // analytics readership as the boards they were written on.
    await requirePermission("analytics.view");

    return { notes: await listAllNotes() };
  });
}
