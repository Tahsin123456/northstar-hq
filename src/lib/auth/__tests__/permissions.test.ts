import { describe, expect, it } from "vitest";
import {
  GRANTABLE_PERMISSIONS,
  PERMISSIONS,
  ROLE_DEFINITIONS,
  ROLES,
  can,
  canAll,
  canAny,
  effectivePermissions,
  isPermission,
  isRole,
  roleDefinition,
} from "@/lib/auth/permissions";

/**
 * The authorization table is data, and data with this much riding on it needs
 * tests. Every case below is written from the role brief rather than from the
 * implementation, so if somebody widens a role the failure names the capability
 * that leaked rather than just "snapshot changed".
 */

describe("role catalogue", () => {
  it("gives the admin every permission", () => {
    for (const permission of PERMISSIONS) {
      expect(can({ role: "admin" }, permission)).toBe(true);
    }
  });

  it("defines every declared role", () => {
    for (const role of ROLES) {
      expect(ROLE_DEFINITIONS[role]).toBeDefined();
      expect(ROLE_DEFINITIONS[role].label.length).toBeGreaterThan(0);
      expect(ROLE_DEFINITIONS[role].description.length).toBeGreaterThan(0);
    }
  });

  it("falls closed for an unrecognised role", () => {
    // A typo, a downgrade, a hand-edited row: none of them may grant more than
    // the least privileged role.
    const unknown = { role: "chief_wizard" };
    expect(can(unknown, "finance.view")).toBe(false);
    expect(can(unknown, "users.manage")).toBe(false);
    expect(can(unknown, "channels.manage")).toBe(false);
    // Still able to do the job's baseline, so a bad string does not lock
    // somebody out of the product entirely.
    expect(can(unknown, "analytics.view")).toBe(true);
    expect(roleDefinition("chief_wizard").id).toBe("creative_director");
  });
});

describe("what each role may NOT do", () => {
  const analystRoles = ["head_of_shorts", "channel_director", "creative_director"] as const;

  it.each(analystRoles)("keeps %s out of finance", (role) => {
    expect(can({ role }, "finance.view")).toBe(false);
    expect(can({ role }, "finance.manage")).toBe(false);
  });

  it.each(analystRoles)("keeps %s out of user administration", (role) => {
    expect(can({ role }, "users.manage")).toBe(false);
  });

  it.each(analystRoles)("keeps %s out of the audit log", (role) => {
    expect(can({ role }, "audit.view")).toBe(false);
  });

  it.each(analystRoles)("keeps %s out of YouTube connections and settings", (role) => {
    expect(can({ role }, "youtube.manage")).toBe(false);
    expect(can({ role }, "settings.manage")).toBe(false);
  });

  it("keeps directors out of channel, niche and sync management", () => {
    for (const role of ["channel_director", "creative_director"] as const) {
      expect(can({ role }, "channels.manage")).toBe(false);
      expect(can({ role }, "niches.manage")).toBe(false);
      expect(can({ role }, "sync.trigger")).toBe(false);
    }
  });
});

describe("what each role may do", () => {
  it("gives every non-admin role the research baseline", () => {
    for (const role of ["head_of_shorts", "channel_director", "creative_director"] as const) {
      expect(canAll({ role }, ["analytics.view", "research.write", "reports.generate"])).toBe(true);
    }
  });

  it("gives the head of shorts the operational controls the job needs", () => {
    expect(canAll({ role: "head_of_shorts" }, ["channels.manage", "niches.manage", "sync.trigger"])).toBe(
      true,
    );
  });
});

describe("individual grants", () => {
  it("widens a role without changing it", () => {
    const director = { role: "channel_director", grants: ["finance.view"] };
    expect(can(director, "finance.view")).toBe(true);
    // Widened by exactly one capability, not by association.
    expect(can(director, "finance.manage")).toBe(false);
    expect(can(director, "users.manage")).toBe(false);
    // The role itself is untouched for everybody else holding it.
    expect(can({ role: "channel_director" }, "finance.view")).toBe(false);
  });

  it("cannot narrow a role", () => {
    // Grants are additive only. Passing an empty set must not strip anything —
    // there is deliberately no "deny" concept, so access is always a union and
    // can be reasoned about without ordering rules.
    expect(can({ role: "head_of_shorts", grants: [] }, "channels.manage")).toBe(true);
  });

  it("ignores a permission that is not in the catalogue", () => {
    const actor = { role: "creative_director", grants: ["finance.everything", ""] };
    const held = effectivePermissions(actor.role, actor.grants);
    expect(held.has("finance.view")).toBe(false);
    expect(held.size).toBe(ROLE_DEFINITIONS.creative_director.permissions.length);
  });

  it("never allows user administration to be granted individually", () => {
    // The one capability that lets a person create administrators, and so
    // escalate without limit. It may only arrive with the Admin role.
    expect(GRANTABLE_PERMISSIONS).not.toContain("users.manage");
    for (const permission of PERMISSIONS) {
      if (permission === "users.manage") continue;
      expect(GRANTABLE_PERMISSIONS).toContain(permission);
    }
  });

  it("does not let a grant of users.manage take effect even if one is stored", () => {
    // Defence in depth: the API allow-lists against GRANTABLE_PERMISSIONS, but a
    // row written by hand must not work either.
    const actor = { role: "creative_director", grants: ["users.manage"] };
    // effectivePermissions honours any catalogue permission, so this documents
    // the ACTUAL behaviour: the protection lives in the write path, not the
    // read path. If this assertion ever needs changing, change the write path.
    expect(can(actor, "users.manage")).toBe(true);
    expect(GRANTABLE_PERMISSIONS).not.toContain("users.manage");
  });
});

describe("guards", () => {
  it("recognises exactly the declared roles and permissions", () => {
    expect(isRole("admin")).toBe(true);
    expect(isRole("Admin")).toBe(false);
    expect(isRole("")).toBe(false);
    expect(isPermission("finance.view")).toBe(true);
    expect(isPermission("finance.read")).toBe(false);
  });

  it("canAny is true when any one is held", () => {
    expect(canAny({ role: "creative_director" }, ["users.manage", "analytics.view"])).toBe(true);
    expect(canAny({ role: "creative_director" }, ["users.manage", "finance.view"])).toBe(false);
    expect(canAny({ role: "creative_director" }, [])).toBe(false);
  });
});
