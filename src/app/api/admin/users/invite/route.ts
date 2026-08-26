import { handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { inviteMember, inviteMemberSchema } from "@/server/services/admin-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/users/invite
 *
 * Creates the invitation, then tries to email it. The two outcomes are reported
 * separately — `emailSent` and `emailConfigured` — because they mean different
 * things to the admin standing in front of the screen: "not configured" is a
 * setup task, "configured but not sent" is a provider problem, and in both
 * cases `inviteUrl` is the link they can send by hand. That fallback is why the
 * whole flow works with no mail provider at all.
 *
 * The body carries only what the invitee needs to be. Organization, inviter and
 * the audit attribution all come from the session inside the service.
 */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    await requirePermission("users.manage");

    const parsed = inviteMemberSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "That invitation is not valid.",
      );
    }

    return inviteMember(parsed.data, request);
  });
}
