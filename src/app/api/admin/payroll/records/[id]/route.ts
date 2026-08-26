import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import {
  adjustRecord,
  markRecordPaid,
  payrollRecordPatchSchema,
} from "@/server/services/payroll-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RecordRouteContext = { params: Promise<{ id: string }> };

/**
 * PATCH /api/admin/payroll/records/:id — adjust one person's figure, or record
 * that they have been paid.
 *
 * Exactly one of the two per request:
 *   • `{ adjustmentMinor, adjustmentReason }` — the ONLY way a finalized figure
 *     changes. The computed parts are left alone and the correction sits beside
 *     them as its own signed line, so the record still shows what the engine
 *     produced, what an admin changed, and why. The reason is required.
 *   • `{ paymentStatus: "paid" }` — for teams that pay people individually
 *     rather than settling a whole period at once.
 *
 * `:id` is a PayrollRecord id. It is resolved through its period's organization
 * inside the service, so an id from another workspace reads as a 404 rather
 * than as somebody else's salary.
 */
export function PATCH(request: Request, context: RecordRouteContext) {
  return handleMutation(request, async () => {
    await requirePermission("payroll.manage");

    const { id } = await context.params;

    const parsed = payrollRecordPatchSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That payroll change is not valid.",
      );
    }

    const input = parsed.data;

    // The schema has already established that exactly one intent is present;
    // the narrowing here is what turns that into two distinct, separately
    // audited operations rather than one ambiguous update.
    if (input.adjustmentMinor !== undefined && input.adjustmentReason !== undefined) {
      return {
        record: await adjustRecord(
          id,
          {
            adjustmentMinor: input.adjustmentMinor,
            adjustmentReason: input.adjustmentReason,
          },
          request,
        ),
      };
    }

    return { record: await markRecordPaid(id, request) };
  });
}
