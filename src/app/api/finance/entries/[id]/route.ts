import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  deleteEntry,
  financeEntryUpdateSchema,
  updateEntry,
} from "@/server/services/finance-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * PATCH /api/finance/entries/:id
 *
 * Changing the amount or the currency re-converts the entry at today's rate;
 * changing anything else leaves the stored conversion exactly as it was. See
 * the note in `finance-service` — a historical figure must not move as a side
 * effect of fixing a typo in a note.
 */
export function PATCH(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    await requirePermission("finance.manage");

    const { id } = await context.params;
    const parsed = financeEntryUpdateSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That update is not valid.",
      );
    }

    return { entry: await updateEntry(id, parsed.data, request) };
  });
}

/**
 * DELETE /api/finance/entries/:id
 *
 * A real delete — there is no soft-delete column on the ledger. What survives
 * is the audit record, which carries the amount and currency precisely because
 * the row will not be there to look up afterwards.
 */
export function DELETE(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    await requirePermission("finance.manage");

    const { id } = await context.params;
    return deleteEntry(id, request);
  });
}
