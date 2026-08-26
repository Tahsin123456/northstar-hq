import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { updateMember, updateMemberSchema } from "@/server/services/admin-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * PATCH /api/admin/users/:id — change a member's role, their status, or both.
 *
 * `:id` is the AppUser id, matching the `id` the user list returns. The
 * membership it maps to is resolved against the caller's organization inside
 * the service, so an id from another workspace is a 404 rather than an edit.
 *
 * Two guards live in the service, next to the writes they protect, because
 * both have to hold at the moment of the write rather than at the moment of the
 * request: an admin may not edit their own access, and the last active admin
 * may not be demoted or deactivated. See the comments there for why the second
 * one is counted inside the transaction.
 */
export function PATCH(request: Request, context: RouteContext) {
  return handleMutation(request, async () => {
    await requirePermission("users.manage");

    const { id } = await context.params;
    const parsed = updateMemberSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That change is not valid.",
      );
    }

    return { user: await updateMember(id, parsed.data, request) };
  });
}
