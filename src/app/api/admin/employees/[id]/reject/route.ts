import { handleMutation } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { rejectEmployee } from "@/server/services/employee-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/admin/employees/:id/reject — turn a pending account away.
 *
 * The mirror of /approve, and deliberately not a DELETE. Rejecting deactivates
 * the account rather than removing it: the account, the invitation behind it
 * and the audit entry recorded here are the evidence that somebody applied and
 * was refused, and a hard delete would erase the decision along with its
 * subject. An admin who changes their mind reactivates it from the Users
 * screen.
 *
 * Like /approve it takes no body, and the transition is compare-and-set in the
 * service, so a simultaneous approve and reject produce one winner rather than
 * a half-applied account.
 */
export function POST(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    await requirePermission("users.manage");

    const { id } = await context.params;
    return { employee: await rejectEmployee(id, request) };
  });
}
