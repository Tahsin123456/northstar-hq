import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  setEmployeeNiches,
  setEmployeeNichesSchema,
} from "@/server/services/employee-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * PUT /api/admin/employees/:id/niches — set this person's assigned niches.
 *
 * A replace rather than an add/remove pair, because the UI is a checklist and
 * the honest request from a checklist is "these are the boxes that are ticked".
 * Two in-flight edits then resolve to whichever admin saved last, rather than
 * each applying half of what the other saw.
 *
 * `users.manage`, not `niches.manage`. Editing a niche changes a definition;
 * assigning one changes what a colleague can see and what they are paid, which
 * is an access decision.
 *
 * Every id in the body is validated against the caller's own organization
 * inside the service. An id is a claim until it is checked, and an unchecked
 * one here would write a MemberNiche row across the tenant boundary — the row a
 * payroll bonus is calculated from.
 */
export function PUT(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    await requirePermission("users.manage");

    const { id } = await context.params;
    const parsed = setEmployeeNichesSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That niche selection is not valid.",
      );
    }

    return setEmployeeNiches(id, parsed.data.nicheIds, request);
  });
}
