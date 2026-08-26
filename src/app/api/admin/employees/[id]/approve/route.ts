import { handleMutation } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { approveEmployee } from "@/server/services/employee-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/admin/employees/:id/approve — let a pending account in.
 *
 * The last step of the invitation flow: the person accepted their invitation
 * and chose a password, which left them at `pending_approval`, and an
 * administrator now decides whether they may actually sign in.
 *
 * There is no body. The only thing this endpoint can do is move one named
 * account from `pending_approval` to `active`, so there is nothing for a caller
 * to supply and nothing to validate — which is the point. An approval that took
 * a role, or a status, would be an escalation API wearing a button's clothes.
 *
 * POST rather than PATCH: this is a decision being recorded, not a field being
 * edited, and it is audited as one.
 */
export function POST(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    await requirePermission("users.manage");

    const { id } = await context.params;
    return { employee: await approveEmployee(id, request) };
  });
}
