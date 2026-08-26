import { requirePermission } from "@/server/auth/dal";
import { recordAudit } from "@/server/audit/audit-service";
import { errors } from "@/server/errors";
import { handle, handleMutation, readJson } from "@/server/http";
import { getScope } from "@/server/services/user-service";
import {
  changedSettingKeys,
  getNotificationSettings,
  notificationSettingsUpdateSchema,
  updateNotificationSettings,
} from "@/server/services/notification-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ===========================================================================
 * GET/PATCH /api/admin/notifications/settings
 * ===========================================================================
 *
 * Where this organization's notifications go, and whether they go at all.
 *
 * WHY `settings.manage` RATHER THAN `payroll.manage`
 * This endpoint configures a delivery channel; it does not read or send a
 * payroll figure. Someone trusted to change the sync cadence and the base
 * currency is the same someone trusted to point the bot at the right chat, and
 * requiring the payroll permission to fix a chat id would mean an operator has
 * to be given everybody's salary to correct a typo.
 *
 * WHAT THE RESPONSE DOES NOT CONTAIN
 * The bot token. It is reported as `telegram.tokenConfigured`, a boolean, and
 * nowhere else — see `src/server/services/telegram-env.ts`. An admin needs to
 * know whether the deployment holds a token; nobody needs it handed back out of
 * the API. The chat id IS returned, because an admin has to be able to see and
 * correct what they typed, and a chat id grants nothing on its own: posting to
 * a chat requires the token and the bot's membership of it.
 */

export function GET() {
  return handle(async () => {
    // First statement, before anything is read.
    await requirePermission("settings.manage");

    const { organizationId } = await getScope();
    return getNotificationSettings(organizationId);
  });
}

export function PATCH(request: Request) {
  return handleMutation(request, async () => {
    const actor = await requirePermission("settings.manage");

    // Scope from the session, never from the body.
    const { organizationId } = await getScope();

    const parsed = notificationSettingsUpdateSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "Those notification settings are not valid.",
      );
    }

    const changed = changedSettingKeys(parsed.data);
    if (changed.length === 0) {
      throw errors.invalidInput("Nothing to change.");
    }

    const result = await updateNotificationSettings(organizationId, parsed.data);

    await recordAudit(
      {
        organizationId,
        actorUserId: actor.userId,
        actorLabel: actor.name ?? actor.email,
        request,
      },
      {
        action: "settings.notifications_updated",
        summary: `Changed notification settings: ${changed.join(", ")}`,
        targetType: "notification_settings",
        targetId: organizationId,
        // WHICH fields changed, never their values. A chat id is not a secret,
        // but an audit entry is the wrong place to accumulate a history of
        // where a team's private messages are routed, and the switches are the
        // part an investigation would actually ask about.
        metadata: {
          changed,
          telegramEnabled: result.settings.telegramEnabled,
          payrollNotificationsEnabled: result.settings.payrollNotificationsEnabled,
        },
      },
    );

    return result;
  });
}
