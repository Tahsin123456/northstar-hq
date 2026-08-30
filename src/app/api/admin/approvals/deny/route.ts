import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { bulkDenialSchema, denyEmployees } from "@/server/services/employee-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/approvals/deny — turn several pending accounts away.
 *
 * The mirror of /approve, and deliberately not a DELETE. Denying deactivates
 * each account rather than removing it: the account, the invitation behind it
 * and the audit entry recorded for it are the evidence that somebody applied
 * and was refused, and a hard delete would erase the decision along with its
 * subject. An admin who changes their mind reactivates from the People screen.
 *
 * `reason` is optional, applies to the whole batch, and is written into each
 * denial's own audit entry — never into a single batch record, so a person's
 * account still carries a complete account of its own decision. It reaches the
 * log and stops there; nothing mails it to the person who was denied.
 *
 * Same partial-success contract as /approve: every id is attempted, each
 * outcome is named, and one stale row does not abandon the rest.
 */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    await requirePermission("users.manage");

    const parsed = bulkDenialSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That is not a list of accounts to deny.",
      );
    }

    return denyEmployees(parsed.data.userIds, request, { reason: parsed.data.reason });
  });
}
