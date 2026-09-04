import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Organization settings are admin-only IN THE SERVICE, not just in the route.
 *
 * The bug this file exists to prevent already shipped once. The split between
 * personal and organization-wide settings was real, but it lived in the route
 * handler: `PATCH /api/settings` called a helper to work out which half a patch
 * touched and asked for `settings.manage` only if the team half was non-empty.
 * That meant the boundary held exactly as long as one handler remembered to run
 * it — and the READ had no check at all, so every employee could pull the sync
 * cadence, the lookback window and the probe switch out of the API.
 *
 * So what is pinned here is not the plumbing. It is that an employee who skips
 * the UI and calls the service directly is refused, on the read as well as the
 * write, before Prisma is touched at all. Prisma, the session and the audit
 * writer are stubs; `requirePermission` is the real module, driven by a
 * swappable actor, because it is the thing under test.
 */

// The settings module graph reaches the DAL, which validates SESSION_SECRET
// through auth-env at import time. Set it before anything is imported, as the
// sibling service tests do.
process.env.SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");

const ORG_ID = "org_northstar";

const mocks = vi.hoisted(() => ({
  /** Swapped per test: an employee, then an admin. */
  actor: {
    userId: "user_employee",
    sessionId: "sess_1",
    email: "sam@example.com",
    name: "Sam",
    organizationId: "org_northstar",
    organizationName: "Northstar",
    role: "short_form_editor",
    grants: [] as string[],
  },
  upsertOrgSettings: vi.fn(),
  upsertUserSettings: vi.fn(),
  recordAudit: vi.fn(),
}));

const ORG_SETTINGS_ROW = {
  defaultThreshold: 1_000_000,
  defaultPeriodDays: 30,
  lookbackDays: 400,
  refreshIntervalMinutes: 360,
  snapshotIntervalMinutes: 360,
  shortsProbeEnabled: true,
  autoRefreshEnabled: false,
  baseCurrency: "USD",
  companyName: "Northstar Studios",
};

const USER_SETTINGS_ROW = { defaultSortKey: "hitRate", defaultSortDirection: "desc" };

vi.mock("@/server/db", () => ({
  prisma: {
    organizationSettings: { upsert: mocks.upsertOrgSettings },
    userSettings: { upsert: mocks.upsertUserSettings },
  },
}));

/**
 * The real `requirePermission` runs; only the session under it is faked. The
 * point of the test is that the service calls it, so stubbing it out would
 * leave nothing worth asserting.
 */
vi.mock("@/server/auth/dal", async () => {
  const { effectivePermissions } = await import("@/lib/auth/permissions");
  const { errors } = await import("@/server/errors");

  const resolve = () => ({
    ...mocks.actor,
    permissions: effectivePermissions(mocks.actor.role, mocks.actor.grants),
  });

  return {
    getActor: async () => resolve(),
    requireActor: async () => resolve(),
    requirePermission: async (permission: string) => {
      const actor = resolve();
      if (!actor.permissions.has(permission as never)) {
        throw errors.forbidden("do that");
      }
      return actor;
    },
  };
});

vi.mock("../user-service", () => ({
  getScope: async () => ({
    organizationId: mocks.actor.organizationId,
    userId: mocks.actor.userId,
    actor: mocks.actor,
  }),
  getCurrentOrgId: async () => ORG_ID,
  getCurrentOrgSettings: async () => ORG_SETTINGS_ROW,
  getOrgSettings: async () => ORG_SETTINGS_ROW,
  getCurrentUser: async () => ({ id: mocks.actor.userId, settings: USER_SETTINGS_ROW }),
}));

vi.mock("@/server/audit/audit-service", () => ({ recordAudit: mocks.recordAudit }));

const {
  getMySettings,
  getOrganizationSettings,
  getRuntimeConfig,
  organizationSettingsUpdateSchema,
  personalSettingsUpdateSchema,
  updateMySettings,
  updateOrganizationSettings,
} = await import("../settings-service");

function signInAs(role: string, grants: string[] = []) {
  mocks.actor.role = role;
  mocks.actor.grants = grants;
  mocks.actor.userId = role === "admin" ? "user_admin" : "user_employee";
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.upsertOrgSettings.mockResolvedValue(ORG_SETTINGS_ROW);
  mocks.upsertUserSettings.mockResolvedValue(USER_SETTINGS_ROW);
  mocks.recordAudit.mockResolvedValue(undefined);
  signInAs("short_form_editor");
});

describe("an employee and organization settings", () => {
  it("cannot READ them through the service", async () => {
    await expect(getOrganizationSettings()).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("cannot WRITE them through the service", async () => {
    await expect(updateOrganizationSettings({ defaultThreshold: 1 })).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });

    // Refused BEFORE the database, not after. A guard that throws once the
    // upsert has landed is not a guard.
    expect(mocks.upsertOrgSettings).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });

  it("cannot read the server configuration either", async () => {
    // `hasApiKey` and the database provider are facts about the deployment. No
    // employee screen needs either, so they travel with the rest of the org
    // configuration rather than sitting on the open endpoint they used to.
    await expect(getRuntimeConfig()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("is refused even while holding every OTHER permission", async () => {
    // The check is on `settings.manage` specifically — not on "is this person
    // important". A Head of Shorts with finance and audit granted still has no
    // business moving the team's sync cadence.
    signInAs("head_of_shorts", ["finance.manage", "audit.view", "reports.generate"]);

    await expect(getOrganizationSettings()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateOrganizationSettings({ lookbackDays: 30 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("what an employee CAN do", () => {
  it("reads their own preferences, plus the two defaults the dashboard needs", async () => {
    const settings = await getMySettings();

    expect(settings).toEqual({
      defaultSortKey: "hitRate",
      defaultSortDirection: "desc",
      defaultThreshold: 1_000_000,
      defaultPeriodDays: 30,
    });

    // The exact shape is the boundary. Every other column on
    // OrganizationSettings is absent, so no handler can leak one by spreading
    // this object into a response.
    expect(Object.keys(settings).sort()).toEqual([
      "defaultPeriodDays",
      "defaultSortDirection",
      "defaultSortKey",
      "defaultThreshold",
    ]);
  });

  it("writes their own sort order, and only to their own row", async () => {
    await updateMySettings({ defaultSortDirection: "asc" });

    expect(mocks.upsertUserSettings).toHaveBeenCalledTimes(1);
    expect(mocks.upsertOrgSettings).not.toHaveBeenCalled();

    // Keyed on the session's user id. There is no parameter that could name
    // somebody else's row, and the where clause proves the one that is used.
    const call = mocks.upsertUserSettings.mock.calls[0]?.[0] as { where: { userId: string } };
    expect(call.where).toEqual({ userId: "user_employee" });
  });
});

describe("the schemas keep the two halves apart", () => {
  it("rejects an organization field sent to the personal endpoint", () => {
    // Strict, so this is a 400 rather than a key that is quietly dropped. An
    // employee who tries to move the team's threshold is told no.
    expect(personalSettingsUpdateSchema.safeParse({ defaultThreshold: 1 }).success).toBe(false);
    expect(personalSettingsUpdateSchema.safeParse({ lookbackDays: 7 }).success).toBe(false);
    expect(personalSettingsUpdateSchema.safeParse({ autoRefreshEnabled: true }).success).toBe(
      false,
    );
  });

  it("accepts the two fields that are genuinely personal", () => {
    expect(personalSettingsUpdateSchema.safeParse({ defaultSortKey: "views" }).success).toBe(true);
    expect(
      personalSettingsUpdateSchema.safeParse({ defaultSortDirection: "asc" }).success,
    ).toBe(true);
  });

  it("refuses to change the base currency at all", () => {
    // Not an oversight. Finance entries store the rate they were converted at,
    // so changing the base currency re-labels history rather than re-converting
    // it. It is readable, and it is not writable from a settings form.
    expect(organizationSettingsUpdateSchema.safeParse({ baseCurrency: "EUR" }).success).toBe(
      false,
    );
  });
});

describe("an admin", () => {
  beforeEach(() => signInAs("admin"));

  it("reads the whole organization row", async () => {
    await expect(getOrganizationSettings()).resolves.toMatchObject({
      lookbackDays: 400,
      baseCurrency: "USD",
      companyName: "Northstar Studios",
    });
  });

  it("writes it, keyed on the organization rather than on themselves", async () => {
    await updateOrganizationSettings({ defaultThreshold: 500_000 });

    const call = mocks.upsertOrgSettings.mock.calls[0]?.[0] as {
      where: { organizationId: string };
      update: Record<string, unknown>;
    };
    // A team setting is one row for everyone. Keyed on the editor, two admins
    // would end up with two different hit thresholds and one argument.
    expect(call.where).toEqual({ organizationId: ORG_ID });
    expect(call.update).toEqual({ defaultThreshold: 500_000 });
  });

  it("records who moved it, without recording the value", async () => {
    await updateOrganizationSettings({ lookbackDays: 500 });

    expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
    const [context, payload] = mocks.recordAudit.mock.calls[0] as [
      { actorUserId: string },
      { action: string; summary: string },
    ];
    expect(context.actorUserId).toBe("user_admin");
    expect(payload.action).toBe("settings.updated");
    expect(payload.summary).toContain("lookbackDays");
  });

  it("does not touch the row when the patch is empty", async () => {
    // `updatedAt` on this table is the audit surface for "who moved the team's
    // threshold". A no-op write would put a name against a change nobody made.
    await updateOrganizationSettings({});

    expect(mocks.upsertOrgSettings).not.toHaveBeenCalled();
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });
});
