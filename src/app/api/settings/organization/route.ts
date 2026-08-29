import { requirePermission } from "@/server/auth/dal";
import { handle, handleMutation, readJson } from "@/server/http";
import {
  getOrganizationSettings,
  getRuntimeConfig,
  parseOrganizationSettingsUpdate,
  updateOrganizationSettings,
} from "@/server/services/settings-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/settings/organization — configuration for the whole team.
 *
 * Analysis defaults, the data-collection window, the refresh and snapshot
 * cadences, the Shorts probe, the base currency and the company name. Every one
 * of them changes something a colleague sees or spends, which is why the whole
 * endpoint sits behind `settings.manage` — on the READ as well as the write.
 *
 * The check here is the first thing that happens, and it is not the only one:
 * each service function repeats it. That is deliberate. A route is a
 * convenience for HTTP; the service is where the rule lives, so a server
 * component or a second route added later cannot reach this data by skipping
 * this file.
 */
export function GET() {
  return handle(async () => {
    await requirePermission("settings.manage");

    const [organization, config] = await Promise.all([
      getOrganizationSettings(),
      getRuntimeConfig(),
    ]);
    return { organization, config };
  });
}

/** PATCH /api/settings/organization — change a number the whole team reads. */
export function PATCH(request: Request) {
  return handleMutation(request, async () => {
    await requirePermission("settings.manage");

    const update = parseOrganizationSettingsUpdate(await readJson(request));
    return { organization: await updateOrganizationSettings(update) };
  });
}
