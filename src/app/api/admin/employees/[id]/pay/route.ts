import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  updateEmployeePay,
  updateEmployeePaySchema,
} from "@/server/services/employee-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * PATCH /api/admin/employees/:id/pay — set salary, hit payment and employment
 * dates.
 *
 * `payroll.manage`, which no role but Admin carries and which is deliberately
 * absent from the grantable list — see the note in src/lib/auth/permissions.ts.
 * Widening somebody into everyone's pay should be a considered act, not a stray
 * tick on a checklist.
 *
 * PATCH rather than PUT because this really is a partial update: an admin
 * correcting a hit rate should not have to resend a salary they did not touch.
 * The service resolves every absent field against what is stored, so a
 * one-field request cannot blank the rest — and `null` stays meaningful, as the
 * way to clear an employment date.
 *
 * Amounts arrive as integer minor units, validated as integers rather than
 * rounded. A request carrying a fractional cent means the caller has a bug, and
 * quietly rounding it would hide that bug inside somebody's salary.
 */
export function PATCH(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    await requirePermission("payroll.manage");

    const { id } = await context.params;
    const parsed = updateEmployeePaySchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That pay change is not valid.",
      );
    }

    return { pay: await updateEmployeePay(id, parsed.data, request) };
  });
}
