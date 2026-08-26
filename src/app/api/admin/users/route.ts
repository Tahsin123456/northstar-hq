import { handle } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { listAdminDirectory } from "@/server/services/admin-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/users
 *
 * Everyone in the caller's organization, plus the invitations still
 * outstanding. Invitations are a separate array rather than fake user rows:
 * an invitation has no account behind it, nothing to deactivate and no
 * sessions, and flattening the two would put controls on a row that cannot
 * answer them.
 *
 * The membership list is a person-by-person account of who can reach the
 * team's data, so it takes the permission that changes that list rather than
 * the one that reads analytics.
 */
export function GET() {
  return handle(async () => {
    await requirePermission("users.manage");

    return listAdminDirectory();
  });
}
