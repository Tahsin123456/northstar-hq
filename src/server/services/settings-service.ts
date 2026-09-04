import "server-only";

import { z } from "zod";
import { prisma } from "@/server/db";
import { env, hasYouTubeApiKey } from "@/server/env";
import { errors } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { recordAudit } from "@/server/audit/audit-service";
import { toOrganizationSettingsDTO, toPersonalSettingsDTO } from "@/server/mappers";
import { MAX_THRESHOLD, MIN_THRESHOLD } from "@/lib/analytics/constants";
import type {
  OrganizationSettingsDTO,
  PersonalSettingsDTO,
  RuntimeConfigDTO,
} from "@/lib/dto";
import { getCurrentOrgSettings, getCurrentUser, getScope } from "./user-service";

/**
 * =========================================================================
 * SETTINGS — TWO OWNERS, TWO PERMISSIONS, TWO FUNCTIONS
 * =========================================================================
 *
 * WHAT WAS WRONG
 * This module used to expose one `getSettings()` / `updateSettings()` pair over
 * a flat DTO carrying every field on OrganizationSettings. The split between
 * personal and organization-wide existed, but only as a helper the ROUTE was
 * expected to call before deciding what to authorize. That is the hole the
 * brief names: the check lived at the edge, so an employee posting directly to
 * the endpoint depended on one handler remembering to run `splitSettingsUpdate`
 * and gate the team half — and reading was not gated at all. Everybody with
 * `analytics.view` (which is everybody) could read the sync cadence, the
 * lookback window and the probe switch.
 *
 * WHAT IS TRUE NOW
 * The permission check is in the SERVICE, on both the read and the write, on
 * every function that touches OrganizationSettings. A route is a convenience
 * for HTTP; it is not the boundary. `requirePermission("settings.manage")` is
 * the first statement of `getOrganizationSettings`, `updateOrganizationSettings`
 * and `getRuntimeConfig`, so any future caller — a server component, a job, a
 * second route somebody adds in a hurry — inherits the gate rather than having
 * to remember it.
 *
 * The two halves are also two schemas and two DTOs. The personal schema has no
 * key for an organization field, so an employee's patch cannot name one even by
 * accident; the flat object that used to make that possible no longer exists.
 *
 * WHAT AN EMPLOYEE STILL RECEIVES, AND WHY
 * `defaultThreshold` and `defaultPeriodDays`. Every chart is drawn against
 * them, and `(app)/layout.tsx` already reads both server-side to seed
 * `FiltersProvider`, so they are in the rendered HTML before any API call
 * happens. Withholding them here would hide nothing and break the dashboard.
 * They arrive read-only: changing either needs `settings.manage`.
 */

// ---------------------------------------------------------------------------
// PERSONAL — any member, their own row
// ---------------------------------------------------------------------------

/**
 * Sort key and direction are the only settings whose change cannot alter a
 * number somebody else sees, which is exactly why they are the only ones stored
 * per user and the only ones writable without `settings.manage`.
 */
export const personalSettingsUpdateSchema = z
  .object({
    defaultSortKey: z.string().min(1).max(64).optional(),
    defaultSortDirection: z.enum(["asc", "desc"]).optional(),
  })
  // Strict, so a patch that names an organization field is a 400 rather than a
  // silently ignored key. An employee who tries to set `defaultThreshold` here
  // should be told no, not told yes and have nothing happen.
  .strict();

export type PersonalSettingsUpdate = z.infer<typeof personalSettingsUpdateSchema>;

/** The caller's own preferences, plus the two org defaults the dashboard needs. */
export async function getMySettings(): Promise<PersonalSettingsDTO> {
  // The floor: these are the defaults every chart and table is drawn with, so
  // reading them is part of reading the numbers rather than a separate
  // privilege. It is still a check — an unauthenticated caller gets a 401.
  await requirePermission("analytics.view");

  // Two independent reads; they overlap rather than queue.
  const [user, orgSettings] = await Promise.all([getCurrentUser(), getCurrentOrgSettings()]);
  return toPersonalSettingsDTO(user.settings, orgSettings);
}

/**
 * Writes the caller's own preferences. Never anybody else's, never the org's.
 *
 * The row is keyed on `userId` from the session, and the only table this
 * function knows about is UserSettings — so there is no path from here to the
 * organization row, whatever the patch says. Upsert because the settings row is
 * created lazily on first read.
 */
export async function updateMySettings(
  update: PersonalSettingsUpdate,
): Promise<PersonalSettingsDTO> {
  await requirePermission("analytics.view");
  const { userId } = await getScope();

  const [userSettings, orgSettings] = await Promise.all([
    hasFields(update)
      ? prisma.userSettings.upsert({
          where: { userId },
          create: { userId, ...update },
          update,
        })
      : getCurrentUser().then((user) => user.settings),
    getCurrentOrgSettings(),
  ]);

  return toPersonalSettingsDTO(userSettings, orgSettings);
}

// ---------------------------------------------------------------------------
// ORGANIZATION — `settings.manage` only, on the read as well as the write
// ---------------------------------------------------------------------------

/**
 * Every field on OrganizationSettings that may be changed from the app.
 *
 * `baseCurrency` is deliberately absent and must stay absent. Every
 * FinanceEntry stores the rate it was converted at and the base amount that
 * produced, so changing the organization's base currency does not re-convert
 * history — it silently re-labels it, turning a column of euros into a column
 * of dollars with the same digits. That is a migration with a plan behind it,
 * not a settings field, and there has never been a write path for it. It is
 * still READ below, because an admin has to be able to see what it is.
 */
export const organizationSettingsUpdateSchema = z
  .object({
    defaultThreshold: z.number().int().min(MIN_THRESHOLD).max(MAX_THRESHOLD).optional(),
    defaultPeriodDays: z.number().int().min(1).max(3650).optional(),
    lookbackDays: z.number().int().min(7).max(3650).optional(),
    refreshIntervalMinutes: z.number().int().min(0).max(20160).optional(),
    snapshotIntervalMinutes: z.number().int().min(0).max(20160).optional(),
    shortsProbeEnabled: z.boolean().optional(),
    autoRefreshEnabled: z.boolean().optional(),
    companyName: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export type OrganizationSettingsUpdate = z.infer<typeof organizationSettingsUpdateSchema>;

/**
 * The organization's configuration.
 *
 * THE READ IS GATED, NOT JUST THE WRITE. An employee reading the sync cadence
 * learns nothing dangerous on its own, but the rule the brief sets is that
 * organization configuration is not theirs to see, and a read that is open
 * "because it is only a read" is how the next field added to this row — one
 * that does matter — ends up open too.
 */
export async function getOrganizationSettings(): Promise<OrganizationSettingsDTO> {
  await requirePermission("settings.manage");
  return toOrganizationSettingsDTO(await getCurrentOrgSettings());
}

/**
 * Changes a number the whole team reads.
 *
 * The upsert is keyed on the ORGANIZATION, not on whoever is signed in: a team
 * setting is one row for everyone, and keying it on the editor is how two
 * admins end up with two different hit thresholds and one argument.
 *
 * Audited, because this row is the answer to "who moved the team's threshold".
 * The audit entry names the fields, never a value it has no business storing.
 */
export async function updateOrganizationSettings(
  update: OrganizationSettingsUpdate,
): Promise<OrganizationSettingsDTO> {
  const actor = await requirePermission("settings.manage");
  const { organizationId } = await getScope();

  if (!hasFields(update)) {
    // Nothing to write. Returning the current row rather than bumping
    // `updatedAt` matters: that timestamp is the audit surface for this table.
    return toOrganizationSettingsDTO(await getCurrentOrgSettings());
  }

  const row = await prisma.organizationSettings.upsert({
    where: { organizationId },
    create: { organizationId, ...update },
    update,
  });

  await recordAudit(
    {
      organizationId,
      actorUserId: actor.userId,
      actorLabel: actor.name ?? actor.email,
    },
    {
      action: "settings.updated",
      summary: `Organization settings changed: ${Object.keys(update).sort().join(", ")}`,
    },
  );

  return toOrganizationSettingsDTO(row);
}

/**
 * Server facts the Settings page displays but cannot change.
 *
 * Behind `settings.manage` with the rest of the organization configuration.
 * Deliberately reports whether an API key *exists*, never the key itself — the
 * secret stays in the environment, and the UI only needs to know whether setup
 * is complete.
 */
export async function getRuntimeConfig(): Promise<RuntimeConfigDTO> {
  await requirePermission("settings.manage");

  return {
    hasApiKey: hasYouTubeApiKey(),
    probeEnabledInEnv: env.shortsProbeEnabled,
    databaseProvider: env.isSqlite ? "sqlite" : "postgresql",
    lookbackDays: env.lookbackDays,
    maxUploadPages: env.maxUploadPages,
  };
}

// ---------------------------------------------------------------------------
// SHARED
// ---------------------------------------------------------------------------

/** Whether a patch actually names a field, i.e. whether its table needs a write. */
export function hasFields(patch: object): boolean {
  return Object.keys(patch).length > 0;
}

/** Parses a personal patch, or throws a 400 written for a person. */
export function parsePersonalSettingsUpdate(input: unknown): PersonalSettingsUpdate {
  const parsed = personalSettingsUpdateSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  // A rejected unknown key is almost always somebody sending an organization
  // field to the personal endpoint, so the message says where it belongs
  // rather than leaving them to guess at "Unrecognized key".
  throw errors.invalidInput(
    parsed.error.issues[0]?.message ??
      "Only your own display preferences can be changed here. Organization settings live under Settings → Organization.",
  );
}

/** Parses an organization patch, or throws a 400 written for a person. */
export function parseOrganizationSettingsUpdate(input: unknown): OrganizationSettingsUpdate {
  const parsed = organizationSettingsUpdateSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  throw errors.invalidInput(
    parsed.error.issues[0]?.message ?? "Those settings are not valid.",
  );
}
