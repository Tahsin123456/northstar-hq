import { handle } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { listPendingApprovals } from "@/server/services/employee-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/approvals — everybody waiting to be let in.
 *
 * The queue behind Admin › Approvals, and the count on its tab. One permission
 * and no widening: unlike /api/admin/employees there is no second capability
 * that adds columns here, because this payload has no pay in it to add. The
 * `PendingApprovalDTO` shape carries who somebody is and what they were invited
 * as, and nothing about what they will be paid — so `payroll.view` has nothing
 * to decide and is not consulted.
 *
 * `users.manage` is the same gate the approve and deny endpoints beside this
 * one enforce. Seeing the queue and being able to action it are deliberately
 * the same capability: a read-only approvals screen would be a list of jobs
 * nobody looking at it could do.
 */
export function GET() {
  return handle(async () => {
    await requirePermission("users.manage");

    return { approvals: await listPendingApprovals() };
  });
}
