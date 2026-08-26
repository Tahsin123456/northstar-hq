import { z } from "zod";
import { prisma } from "@/server/db";
import { env, hasYouTubeApiKey } from "@/server/env";
import { toSettingsDTO } from "@/server/mappers";
import { MAX_THRESHOLD, MIN_THRESHOLD } from "@/lib/analytics/constants";
import type { RuntimeConfigDTO, SettingsDTO } from "@/lib/dto";
import { getCurrentOrgSettings, getCurrentUser, getScope } from "./user-service";

export const settingsUpdateSchema = z.object({
  defaultThreshold: z.number().int().min(MIN_THRESHOLD).max(MAX_THRESHOLD).optional(),
  defaultPeriodDays: z.number().int().min(1).max(3650).optional(),
  defaultSortKey: z.string().min(1).max(64).optional(),
  defaultSortDirection: z.enum(["asc", "desc"]).optional(),
  lookbackDays: z.number().int().min(7).max(3650).optional(),
  refreshIntervalMinutes: z.number().int().min(0).max(20160).optional(),
  snapshotIntervalMinutes: z.number().int().min(0).max(20160).optional(),
  shortsProbeEnabled: z.boolean().optional(),
  autoRefreshEnabled: z.boolean().optional(),
});

export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

/**
 * The half of a patch that belongs to the person editing it.
 *
 * Sort key and direction are the only settings whose change cannot alter a
 * number somebody else sees, so they are the only ones stored per user. Every
 * other field in the schema is team-wide by elimination — which is why the
 * team half is expressed as `Omit` rather than a second hand-written list that
 * could drift out of sync when a setting is added.
 */
export type PersonalSettingsUpdate = Pick<
  SettingsUpdate,
  "defaultSortKey" | "defaultSortDirection"
>;
export type TeamSettingsUpdate = Omit<SettingsUpdate, "defaultSortKey" | "defaultSortDirection">;

/**
 * Exported because the route has to authorize the two halves differently — a
 * member may retune their own sort order, but only `settings.manage` may move a
 * number the whole team reads. The gate and the write therefore have to agree
 * on where the line falls, so both derive it from this one function.
 */
export function splitSettingsUpdate(update: SettingsUpdate): {
  personal: PersonalSettingsUpdate;
  team: TeamSettingsUpdate;
} {
  const { defaultSortKey, defaultSortDirection, ...team } = update;
  const personal: PersonalSettingsUpdate = {};
  if (defaultSortKey !== undefined) personal.defaultSortKey = defaultSortKey;
  if (defaultSortDirection !== undefined) personal.defaultSortDirection = defaultSortDirection;
  return { personal, team };
}

/** Whether a patch actually names a field, i.e. whether its table needs a write. */
export function hasFields(patch: PersonalSettingsUpdate | TeamSettingsUpdate): boolean {
  return Object.keys(patch).length > 0;
}

export async function getSettings(): Promise<SettingsDTO> {
  // Two reads, one payload. They are independent, so they overlap rather than
  // queue: the root layout awaits this on every navigation.
  const [user, orgSettings] = await Promise.all([getCurrentUser(), getCurrentOrgSettings()]);
  return toSettingsDTO(user.settings, orgSettings);
}

/**
 * Applies a patch to whichever table owns each field.
 *
 * The client still sends one flat object, so the routing decision has to happen
 * here. A table is only written when the patch actually names one of its
 * fields: changing a personal sort order must not bump the organization row's
 * `updatedAt`, because that row is the audit surface for "who moved the team's
 * hit threshold".
 *
 * Both writes are upserts because the settings rows are created lazily on first
 * read, and an update against a row that does not exist yet would throw.
 *
 * Note there is no cache invalidation any more. `getCurrentUser` and
 * `getCurrentOrgSettings` are memoised with React's `cache()`, which is scoped
 * to one render pass — so the stale-read window the old `invalidateUserCache()`
 * guarded against no longer exists. Within *this* request we still return the
 * rows the writes produced rather than re-reading through those caches, which
 * were populated before the update.
 */
export async function updateSettings(update: SettingsUpdate): Promise<SettingsDTO> {
  const { organizationId, userId } = await getScope();
  const { personal, team } = splitSettingsUpdate(update);

  const [userSettings, orgSettings] = await Promise.all([
    hasFields(personal)
      ? prisma.userSettings.upsert({
          where: { userId },
          create: { userId, ...personal },
          update: personal,
        })
      : getCurrentUser().then((user) => user.settings),
    hasFields(team)
      ? prisma.organizationSettings.upsert({
          // Scope is the organization: a team setting is one row for everyone,
          // not one per editor, so the write is keyed on the org rather than on
          // whoever happens to be signed in.
          where: { organizationId },
          create: { organizationId, ...team },
          update: team,
        })
      : getCurrentOrgSettings(),
  ]);

  return toSettingsDTO(userSettings, orgSettings);
}

/**
 * Server facts the Settings page must display but cannot change.
 *
 * Deliberately reports whether a key *exists*, never the key itself. The
 * secret stays in the environment; the UI only needs to know whether setup is
 * complete.
 */
export async function getRuntimeConfig(): Promise<RuntimeConfigDTO> {
  return {
    hasApiKey: hasYouTubeApiKey(),
    probeEnabledInEnv: env.shortsProbeEnabled,
    databaseProvider: env.isSqlite ? "sqlite" : "postgresql",
    lookbackDays: env.lookbackDays,
    maxUploadPages: env.maxUploadPages,
  };
}
