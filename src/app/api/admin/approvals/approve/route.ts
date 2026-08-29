import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { approveEmployees, bulkApprovalSchema } from "@/server/services/employee-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/approvals/approve — let several pending accounts in at once.
 *
 * The batch form of /api/admin/employees/:id/approve, over the identical
 * service call. Nothing here re-implements the transition: `approveEmployees`
 * loops `approveEmployee`, so the compare-and-set, the cleared lockout stamps
 * and the individual `employee.approved` audit entry are the same ones the
 * per-row button produces. Two surfaces, one mechanism.
 *
 * THE BODY IS A LIST OF IDS AND NOTHING ELSE. No role, no status, no
 * organization — an approval that took any of those would be an escalation API
 * wearing a button's clothes, and the scope every id is checked against comes
 * from the session inside the service. An id that names somebody in another
 * workspace does not resolve; it comes back as a failed row.
 *
 * A 200 WITH FAILURES IN IT IS THE SUCCESS CASE. The response is per-user
 * because the realistic failure is one stale id in a batch of ten — somebody a
 * colleague approved in another tab a minute ago — and refusing the whole
 * request over it would discard nine good decisions. `succeeded`, `failed` and
 * a named outcome per id let the caller say precisely which ones need another
 * look. Only a malformed body is a 400.
 */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    await requirePermission("users.manage");

    const parsed = bulkApprovalSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That is not a list of accounts to approve.",
      );
    }

    return approveEmployees(parsed.data.userIds, request);
  });
}
