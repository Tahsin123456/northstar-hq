import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { replaceGrantsSchema, replaceMemberGrants } from "@/server/services/admin-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * PUT /api/admin/users/:id/grants — set this member's individual permissions.
 *
 * A replace rather than an add/remove pair. The UI is a checklist, so the
 * honest request is "these are the boxes that are ticked"; sending deltas from
 * a checklist invites two in-flight edits to each apply half of what the admin
 * saw.
 *
 * Every entry is validated against GRANTABLE_PERMISSIONS in the service, which
 * excludes `users.manage` on purpose — that one may only arrive with the Admin
 * role, never as a quiet checkbox. The note in src/lib/auth/permissions.ts
 * explains why.
 */
export function PUT(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    await requirePermission("users.manage");

    const { id } = await context.params;
    const parsed = replaceGrantsSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That permission set is not valid.",
      );
    }

    return replaceMemberGrants(id, parsed.data.permissions, request);
  });
}
