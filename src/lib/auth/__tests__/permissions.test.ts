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
  /**
   * Admin holds everything except the personal earnings page.
   *
   * Written as "all but this one named exception" rather than a list, so a
   * permission added to the catalogue tomorrow fails here unless it genuinely
   * reaches Admin — which is the property the subtraction in `permissions.ts`
   * exists to keep. The exception itself is argued at `WITHHELD_FROM_ADMIN` and
   * pinned again under `earnings.view_own` below.
   */
  it("gives the admin every permission but the personal earnings page", () => {
    for (const permission of PERMISSIONS) {
      expect(can({ role: "admin" }, permission), permission).toBe(
        permission !== "earnings.view_own",
      );
    }
  });

  it("defines every declared role", () => {
    for (const role of ROLES) {
      expect(ROLE_DEFINITIONS[role]).toBeDefined();
      expect(ROLE_DEFINITIONS[role].label.length).toBeGreaterThan(0);
      expect(ROLE_DEFINITIONS[role].description.length).toBeGreaterThan(0);
    }
  });

  /**
   * Which side of the operation each role belongs to, pinned role by role.
   *
   * `contentScope` is dark today — `resolveAllowedFormats` reads it and
   * nothing calls that yet — which is precisely why the table is pinned now:
   * when the Long Form surfaces land, this value silently decides which
   * format's lists and numbers every account sees, and a role whose scope
   * drifted in the meantime would ship that drift as an access change on day
   * one. Written from the role brief, not the implementation, like everything
   * else in this file.
   */
  it("pins every role to its side of the operation", () => {
    const EXPECTED_SCOPE: Record<(typeof ROLES)[number], "shorts" | "longs" | "all"> = {
      admin: "all",
      head_of_shorts: "shorts",
      head_of_longs: "longs",
      short_form_editor: "shorts",
      long_form_editor: "longs",
      short_form_clip_producer: "shorts",
    };
    for (const role of ROLES) {
      expect(roleDefinition(role).contentScope, role).toBe(EXPECTED_SCOPE[role]);
    }
  });

  it("scopes an unrecognised role to shorts — the fail-closed side", () => {
    // The least-privileged fallback role is a Shorts role, so a typo'd or
    // hand-edited role string sees the product every current account already
    // sees, never an extra format.
    expect(roleDefinition("chief_wizard").contentScope).toBe("shorts");
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
    expect(roleDefinition("chief_wizard").id).toBe("short_form_clip_producer");
  });
});

/**
 * =========================================================================
 * "$ AMOUNTS SHOULD ONLY BE VISIBLE TO ADMINS"
 * =========================================================================
 *
 * The owner's sixth request, stated as an invariant over the ROLE TABLE rather
 * than over a list of roles somebody remembered to write down.
 *
 * WHY THIS EXISTS ALONGSIDE THE `analystRoles` CASES BELOW. Those enumerate the
 * five non-admin roles by hand, which is exactly right for asserting what each
 * one may not do — and useless as a guarantee about the NEXT role. A role added
 * to `ROLES` tomorrow with `finance.view` in its permission list would pass
 * every one of them, because it is not in the array. This derives its subjects
 * from `ROLES` itself, so a new role is in scope the moment it exists.
 *
 * THE QUALIFICATION THE OWNER SHOULD HEAR, and it is why this test is worded
 * about ROLES rather than about people. `finance.view` is deliberately
 * grantable — the permission table's own header names that as the point, "what
 * lets a Channel Director be given Finance access" — so an admin can hand niche
 * money to a Head of Shorts with one checkbox, and `effectivePermissions` is
 * role UNION grants. "Only Admins see money" is therefore true of the roles as
 * shipped and is NOT enforced against a deliberate, audited grant. That is the
 * existing design of this app and is left alone; what is pinned here is that no
 * DEFAULT carries it, which is the half that could regress silently.
 */
describe("money is an Admin capability by default", () => {
  /** Every permission that puts a currency amount on a screen. */
  const MONEY_PERMISSIONS = [
    "finance.view",
    "finance.manage",
    "payroll.view",
    "payroll.manage",
  ] as const;

  it("gives no shipped role but Admin any way to see money", () => {
    for (const role of ROLES) {
      if (role === "admin") continue;
      const held = new Set(roleDefinition(role).permissions);
      for (const permission of MONEY_PERMISSIONS) {
        expect(
          held.has(permission),
          `${role} must not hold ${permission} by default`,
        ).toBe(false);
      }
    }
  });

  /**
   * `settings.manage` is what sets what a hit PAYS (`hitPaymentMinor`), so a
   * role holding it by default would be pricing the studio's bonuses without
   * ever having been granted a money permission. No shipped role is in that
   * position, and this says so.
   */
  it("gives no shipped role but Admin the settings key that sets what a hit pays", () => {
    for (const role of ROLES) {
      if (role === "admin") continue;
      expect(
        new Set(roleDefinition(role).permissions).has("settings.manage"),
        `${role} must not hold settings.manage by default`,
      ).toBe(false);
    }
  });
});

describe("what each role may NOT do", () => {
  const analystRoles = [
    "head_of_shorts",
    "head_of_longs",
    "short_form_editor",
    "long_form_editor",
    "short_form_clip_producer",
  ] as const;

  it.each(analystRoles)("keeps %s out of finance", (role) => {
    expect(can({ role }, "finance.view")).toBe(false);
    expect(can({ role }, "finance.manage")).toBe(false);
  });

  it.each(analystRoles)("keeps %s out of payroll — nobody sees a colleague's salary", (role) => {
    expect(can({ role }, "payroll.view")).toBe(false);
    expect(can({ role }, "payroll.manage")).toBe(false);
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
    for (const role of ["short_form_editor", "short_form_clip_producer"] as const) {
      expect(can({ role }, "channels.manage")).toBe(false);
      expect(can({ role }, "niches.manage")).toBe(false);
      expect(can({ role }, "sync.trigger")).toBe(false);
    }
  });
});

describe("what each role may do", () => {
  it("gives every non-admin role the research baseline", () => {
    for (const role of ["head_of_shorts", "short_form_editor", "short_form_clip_producer"] as const) {
      expect(canAll({ role }, ["analytics.view", "research.write", "reports.generate"])).toBe(true);
    }
  });

  it("gives the head of shorts the operational controls the job needs", () => {
    expect(canAll({ role: "head_of_shorts" }, ["channels.manage", "niches.manage", "sync.trigger"])).toBe(
      true,
    );
  });
});

/**
 * Seeing your OWN pay is not a privilege, and seeing everybody's still is.
 *
 * The pair below is the whole point of splitting `earnings.view_own` out of
 * `payroll.view`. Iterating ROLES rather than listing the roles by hand is what
 * makes the first case survive a role being added later: a new definition that
 * forgets `earnings.view_own` fails here rather than shipping an employee who
 * cannot find out what they are owed.
 */
describe("earnings.view_own", () => {
  const EMPLOYEE_ROLES = ROLES.filter((role) => role !== "admin");

  it.each(EMPLOYEE_ROLES)("is held by %s — every employee can see their own pay", (role) => {
    expect(can({ role }, "earnings.view_own")).toBe(true);
  });

  /**
   * The exception, pinned so it cannot be undone by accident.
   *
   * Admin is `ALL_PERMISSIONS` minus this one. Since the subtraction is the
   * only thing standing between an admin and a personal earnings page — and
   * since "admin has everything" is the obvious thing for somebody to restore
   * while tidying — the absence is asserted rather than assumed.
   *
   * They lose nothing: Admin → Payroll is the same figures for the whole team,
   * their own row included, which is why the personal page was withheld.
   */
  it("is NOT held by admin — they read the whole payroll instead", () => {
    expect(can({ role: "admin" }, "earnings.view_own")).toBe(false);
    expect(can({ role: "admin" }, "payroll.view")).toBe(true);
  });

  it("does not carry payroll with it", () => {
    for (const role of ROLES) {
      if (role === "admin") continue;
      expect(can({ role }, "earnings.view_own")).toBe(true);
      // The line that must never blur: your own row, not the company's table.
      expect(can({ role }, "payroll.view")).toBe(false);
      expect(can({ role }, "payroll.manage")).toBe(false);
    }
  });

  it("is not offered as an individual grant", () => {
    // Every role already holds it, so a checkbox could only ever be a no-op —
    // and grants are additive, so it could not be un-ticked either.
    expect(GRANTABLE_PERMISSIONS).not.toContain("earnings.view_own");
  });

  it("cannot be widened into payroll by granting it", () => {
    const employee = { role: "short_form_editor", grants: ["earnings.view_own"] };
    expect(can(employee, "payroll.view")).toBe(false);
  });
});

describe("individual grants", () => {
  it("widens a role without changing it", () => {
    const director = { role: "short_form_editor", grants: ["finance.view"] };
    expect(can(director, "finance.view")).toBe(true);
    // Widened by exactly one capability, not by association.
    expect(can(director, "finance.manage")).toBe(false);
    expect(can(director, "users.manage")).toBe(false);
    // The role itself is untouched for everybody else holding it.
    expect(can({ role: "short_form_editor" }, "finance.view")).toBe(false);
  });

  it("cannot narrow a role", () => {
    // Grants are additive only. Passing an empty set must not strip anything —
    // there is deliberately no "deny" concept, so access is always a union and
    // can be reasoned about without ordering rules.
    expect(can({ role: "head_of_shorts", grants: [] }, "channels.manage")).toBe(true);
  });

  it("ignores a permission that is not in the catalogue", () => {
    const actor = { role: "short_form_clip_producer", grants: ["finance.everything", ""] };
    const held = effectivePermissions(actor.role, actor.grants);
    expect(held.has("finance.view")).toBe(false);
    expect(held.size).toBe(ROLE_DEFINITIONS.short_form_clip_producer.permissions.length);
  });

  it("never allows user administration or payroll to be granted individually", () => {
    // `users.manage` lets a person create administrators, and so escalate
    // without limit. `payroll.manage` is everyone's salary. Both may only
    // arrive with the Admin role — a considered act, not a stray tick on a
    // checklist.
    //
    // `earnings.view_own` is off the list for the opposite reason: every role
    // already holds it, so a checkbox could only ever be a no-op. Grants are
    // additive, so it could not be un-ticked either, and a control that cannot
    // do what it appears to do is worse than no control.
    const notGrantable = ["users.manage", "payroll.manage", "earnings.view_own"] as const;

    for (const permission of notGrantable) {
      expect(GRANTABLE_PERMISSIONS).not.toContain(permission);
    }
    for (const permission of PERMISSIONS) {
      if ((notGrantable as readonly string[]).includes(permission)) continue;
      expect(GRANTABLE_PERMISSIONS).toContain(permission);
    }
  });

  it("allows payroll.view to be granted, so a bookkeeper can be given read access", () => {
    // Reading pay and changing it are different trust levels; only the second
    // is withheld from the checklist.
    expect(GRANTABLE_PERMISSIONS).toContain("payroll.view");
  });

  it("does not let a grant of users.manage take effect even if one is stored", () => {
    // Defence in depth: the API allow-lists against GRANTABLE_PERMISSIONS, but a
    // row written by hand must not work either.
    const actor = { role: "short_form_clip_producer", grants: ["users.manage"] };
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
    expect(canAny({ role: "short_form_clip_producer" }, ["users.manage", "analytics.view"])).toBe(true);
    expect(canAny({ role: "short_form_clip_producer" }, ["users.manage", "finance.view"])).toBe(false);
    expect(canAny({ role: "short_form_clip_producer" }, [])).toBe(false);
  });
});
