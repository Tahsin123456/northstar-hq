import { requirePermission } from "@/server/auth/dal";
import { handle, handleMutation, readJson } from "@/server/http";
import { errors } from "@/server/errors";
import {
  getRuntimeConfig,
  getSettings,
  hasFields,
  settingsUpdateSchema,
  splitSettingsUpdate,
  updateSettings,
} from "@/server/services/settings-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/settings — user preferences plus read-only server configuration. */
export function GET() {
  return handle(async () => {
    // These are the defaults every chart and table is drawn with, so reading
    // them is part of reading the numbers rather than a separate privilege.
    await requirePermission("analytics.view");

    const [settings, config] = await Promise.all([getSettings(), getRuntimeConfig()]);
    return { settings, config };
  });
}

/** PATCH /api/settings */
export function PATCH(request: Request) {
  return handleMutation(request, async () => {
    // The floor. Sort key and direction are stored per user and cannot change a
    // number anybody else sees, so any member may edit their own.
    await requirePermission("analytics.view");

    const parsed = settingsUpdateSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput(
        parsed.error.issues[0]?.message ?? "Those settings are not valid.",
      );
    }

    // Everything else — thresholds, cadences, lookback, the probe switch — is
    // one row for the whole organization, so changing any of it silently
    // rewrites what every colleague sees. Split with the same helper the write
    // uses, so the gate cannot disagree with which table gets touched.
    const { team } = splitSettingsUpdate(parsed.data);
    if (hasFields(team)) {
      await requirePermission("settings.manage");
    }

    const settings = await updateSettings(parsed.data);
    return { settings };
  });
}
