import { handle } from "@/server/http";
import { actorCan, requirePermission } from "@/server/auth/dal";
import { getEmployeeProfile } from "@/server/services/employee-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/admin/employees/:id — one person's full profile.
 *
 * `:id` is the AppUser id, matching the `userId` the list returns. The
 * membership it maps to is resolved against the caller's organization inside
 * the service, so an id from another workspace is a 404 rather than a read.
 *
 * The payroll block — pay configuration, the current period's estimate and the
 * payment history — is added only for a caller holding `payroll.view`, decided
 * here from the session. Everyone else gets a response with no `payroll` key at
 * all. See the note on the list route for why that is a key that is absent
 * rather than a value that is null.
 */
export function GET(_request: Request, context: RouteContext) {
  return handle(async () => {
    await requirePermission("users.manage");

    const { id } = await context.params;
    const includePay = await actorCan("payroll.view");

    return { employee: await getEmployeeProfile(id, { includePay }) };
  });
}
