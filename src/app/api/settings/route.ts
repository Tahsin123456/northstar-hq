import { requirePermission } from "@/server/auth/dal";
import { handle, handleMutation, readJson } from "@/server/http";
import {
  getMySettings,
  parsePersonalSettingsUpdate,
  updateMySettings,
} from "@/server/services/settings-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/settings — the signed-in person's own settings.
 *
 * PERSONAL ONLY. This endpoint used to carry every field on
 * OrganizationSettings in both directions, with the authorization split done
 * here in the handler. Organization configuration now lives at
 * /api/settings/organization behind `settings.manage`, and the split is
 * enforced in the service rather than in this file — so an employee posting
 * directly to either URL meets the same check the UI does.
 *
 * The payload still includes the organization's default threshold and default
 * period, read-only. They are the numbers every chart is drawn with, and the
 * authenticated layout already hands both to the browser; see the note at the
 * top of settings-service.ts.
 */
export function GET() {
  return handle(async () => {
    await requirePermission("analytics.view");
    return { settings: await getMySettings() };
  });
}

/** PATCH /api/settings — your own display preferences. */
export function PATCH(request: Request) {
  return handleMutation(request, async () => {
    await requirePermission("analytics.view");

    // The schema is strict and has no organization keys, so a patch aimed at a
    // team-wide setting is rejected here rather than partially applied.
    const update = parsePersonalSettingsUpdate(await readJson(request));
    return { settings: await updateMySettings(update) };
  });
}
