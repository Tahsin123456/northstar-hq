import { handle, handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  createNiche,
  createNicheSchema,
  listNiches,
} from "@/server/services/niche-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/niches — all niches with their active channel counts. */
export function GET() {
  return handle(async () => {
    // Niches are how the dashboard is sliced, and the counts are channel data:
    // reading them is reading analytics, not administering them.
    await requirePermission("analytics.view");

    return { niches: await listNiches() };
  });
}

/** POST /api/niches — create a niche. */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    // A niche is shared taxonomy — everyone's charts regroup around it — so
    // creating one is an operational act, not part of the research baseline.
    await requirePermission("niches.manage");

    const parsed = createNicheSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That niche name is not valid.",
      );
    }
    return { niche: await createNiche(parsed.data) };
  });
}
