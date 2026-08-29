import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  deleteNiche,
  updateNiche,
  updateNicheSchema,
} from "@/server/services/niche-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * PATCH /api/niches/:id — rename, restyle, reorder, or set the hit threshold.
 *
 * `niches.manage` is the floor for all of it. The threshold is the one field
 * that needs more — `settings.manage`, because it redefines a hit for every
 * chart, report and payroll run — and `updateNiche` enforces that itself, so
 * the rule holds wherever the function is called from rather than only here.
 */
export function PATCH(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    // Renaming and recolouring a shared label is an operational act, not part
    // of the research baseline.
    await requirePermission("niches.manage");

    const { id } = await context.params;
    const parsed = updateNicheSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That update is not valid.",
      );
    }
    return { niche: await updateNiche(id, parsed.data) };
  });
}

/**
 * DELETE /api/niches/:id
 *
 * Removes the label only. Channels filed under it become unassigned; no
 * channel, video or snapshot is touched. The response reports how many
 * channels were unassigned so the UI can say so plainly.
 */
export function DELETE(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    // Unassigns every channel filed under the label for everybody, so it takes
    // the same permission that created it.
    await requirePermission("niches.manage");

    const { id } = await context.params;
    return deleteNiche(id);
  });
}
