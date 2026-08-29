/**
 * =========================================================================
 * AUTHORIZATION — THE SINGLE SOURCE OF TRUTH
 * =========================================================================
 *
 * Every "is this person allowed to…" question in Northstar HQ is answered
 * here. Nothing else in the codebase should compare a role string.
 *
 * WHY ONE FILE
 * Permission checks scattered across components rot in a specific way: the
 * sidebar hides Finance, someone later adds a link elsewhere, and the API is
 * still open. Centralising the *rules* means the server enforcement and the UI
 * affordances are derived from the same table, so they cannot disagree — and
 * adding a role is a data change in this file rather than a hunt through
 * screens.
 *
 * WHERE IT IS ENFORCED
 * This module is isomorphic and deliberately contains no I/O, so the client can
 * use it to decide what to render. That is a convenience, never a boundary:
 * hiding a button stops nobody. The real check runs server-side in
 * `src/server/auth/dal.ts` (`requirePermission`), which every route handler
 * calls before touching data. If a permission is not enforced there, it is not
 * enforced.
 *
 * ROLES ARE A FLOOR, GRANTS WIDEN
 * A member's effective permissions are their role's set plus any individual
 * grants. Grants are additive only — there is no "deny" — so access can always
 * be reasoned about as a union, and revoking means removing a grant or changing
 * the role. This is what lets a Channel Director be given Finance access
 * without inventing a bespoke role for them.
 */

/** Every capability the product recognises. */
export const PERMISSIONS = [
  // --- Analytics & research -------------------------------------------------
  /** See the dashboard, channels, charts, Winners, Outliers, Our vs Market. */
  "analytics.view",
  /** Write notes, save Shorts, manage collections. */
  "research.write",
  /** Generate a branded PDF report. */
  "reports.generate",

  // --- Operational ----------------------------------------------------------
  /** Add, rename, re-scope and remove tracked channels. */
  "channels.manage",
  /**
   * Create and edit niches, their content types, and how Shorts are filed
   * under them. NOT their hit thresholds — `assertMayConfigureThreshold` in
   * niche-service holds that behind `settings.manage`, because a threshold is
   * the number every hit rate and every hit bonus is measured against and is
   * not the same decision as naming a niche.
   */
  "niches.manage",
  /** Trigger a refresh / sync run by hand. */
  "sync.trigger",

  // --- Finance --------------------------------------------------------------
  /** Read revenue, expenses, profit and margins. */
  "finance.view",
  /** Create, edit and delete financial entries and categories. */
  "finance.manage",

  // --- Self-service ---------------------------------------------------------
  /**
   * See YOUR OWN pay: base salary, hit bonus, and the hits behind them.
   *
   * NOT a narrower `payroll.view`, and it must never be widened into one. The
   * payroll keys below answer "what does the company owe everybody" — every
   * colleague's salary in one table. This one answers "what am I owed", about
   * the caller and nobody else, and the service behind it takes the user id
   * from the session with no parameter that could redirect it.
   *
   * Held by every EMPLOYEE role, and deliberately not by Admin — see
   * `WITHHELD_FROM_ADMIN`. An admin reads the whole payroll, of which their own
   * row is one line; a personal earnings page would be a smaller version of a
   * screen they already have.
   *
   * Not grantable, for the same reason it is not a privilege: an employee
   * asking what they earned is not something an administrator hands out, and a
   * checklist entry already ticked for every role that should have it would
   * only suggest it could be un-ticked. It cannot — grants are additive.
   */
  "earnings.view_own",

  // --- Payroll --------------------------------------------------------------
  /**
   * Read salaries, hit payments and payroll runs.
   *
   * Separate from finance because they answer different questions and leak
   * differently: company revenue is commercially sensitive, an individual's
   * salary is personal. Somebody trusted with one is not automatically trusted
   * with the other.
   */
  "payroll.view",
  /** Set pay, finalize a period, mark it paid, record an adjustment. */
  "payroll.manage",

  // --- Long Form (reserved) --------------------------------------------------
  /**
   * The Long Form system does not exist yet.
   *
   * The key is declared now so the Longs roles below are real rather than
   * aspirational: they can be assigned, they appear in the admin UI, and when
   * the Longs features land they gate themselves without anybody having to
   * revisit the employee or payroll systems. Nothing checks it today, which is
   * correct — an unenforced permission that grants nothing is safe; a role that
   * cannot be created until a feature ships is not.
   */
  "longs.view",

  // --- Administration -------------------------------------------------------
  /** Invite, deactivate and reactivate people; change their roles. */
  "users.manage",
  /** Read the audit log. */
  "audit.view",
  /** Connect and disconnect YouTube/Google accounts. */
  "youtube.manage",
  /** Change organization-wide settings, including sync cadence and currency. */
  "settings.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Roles ship as data so a new one never requires a migration. */
export const ROLES = [
  "admin",
  "head_of_shorts",
  "head_of_longs",
  "short_form_editor",
  "long_form_editor",
  "short_form_clip_producer",
] as const;

export type Role = (typeof ROLES)[number];

export interface RoleDefinition {
  readonly id: Role;
  readonly label: string;
  readonly description: string;
  readonly permissions: readonly Permission[];
  /**
   * Whether this role sees only the niches the person is assigned to.
   *
   * A Head sees the whole operation because their job is comparing across it.
   * An editor assigned to GTA sees GTA. This is enforced server-side, in the
   * same query that already scopes by organization — not by filtering in the
   * browser, which would send the data and then hide it.
   */
  readonly nicheScoped: boolean;
  /**
   * Which side of the operation the role belongs to.
   *
   * "longs" roles are real and assignable today; the Long Form features they
   * will eventually unlock simply do not exist yet. Modelling it now is what
   * keeps adding Longs from becoming a rewrite of the employee system.
   */
  readonly contentScope: "shorts" | "longs" | "all";
}

/**
 * Every capability there is, derived so it cannot drift from the list above.
 *
 * The Admin role is this MINUS `WITHHELD_FROM_ADMIN` — see the note there. It
 * is spelled as a subtraction rather than a hand-written list so a permission
 * added later still reaches Admin without anybody remembering to add it.
 */
const ALL_PERMISSIONS: readonly Permission[] = PERMISSIONS;

/**
 * Held by every EMPLOYEE role, without exception. Admin is the one role that
 * does not take it — see `WITHHELD_FROM_ADMIN`.
 *
 * Spread explicitly into each definition below rather than folded into the
 * research baseline, because it is not research: a Long Form Editor who never
 * opens a Shorts dashboard still has a salary and is still entitled to see it.
 * `src/lib/auth/__tests__/permissions.test.ts` pins that every EMPLOYEE role
 * carries it, so a role added later cannot quietly ship without it — and that
 * Admin does not, so the exception cannot be undone by accident either.
 */
const SELF_SERVICE: readonly Permission[] = ["earnings.view_own"];

/**
 * What analytics work looks like for everyone who is not an administrator:
 * read the numbers, annotate them, export them.
 */
const RESEARCH_BASELINE: readonly Permission[] = [
  "analytics.view",
  "research.write",
  "reports.generate",
];

/** What a department head needs on top of the research baseline. */
const HEAD_OPERATIONS: readonly Permission[] = ["channels.manage", "niches.manage", "sync.trigger"];

/**
 * The one capability an Admin deliberately does NOT hold.
 *
 * `earnings.view_own` draws a personal pay page: your salary, your hit bonus,
 * your history. An Admin already has Admin → Payroll, which is the same figures
 * for everybody including themselves, so the personal page would be a second,
 * narrower answer to a question they can already ask better — and a nav entry
 * that promises something the screen beside it does more of.
 *
 * Subtracted from `ALL_PERMISSIONS` by name rather than by hand-listing the
 * rest, so a permission added later still reaches Admin automatically. "Admin
 * has everything" remains the rule; this is its one stated exception, and
 * stating it here is what stops it being rediscovered as a bug.
 */
const WITHHELD_FROM_ADMIN: readonly Permission[] = ["earnings.view_own"];

const ADMIN_PERMISSIONS: readonly Permission[] = ALL_PERMISSIONS.filter(
  (permission) => !WITHHELD_FROM_ADMIN.includes(permission),
);

export const ROLE_DEFINITIONS: Readonly<Record<Role, RoleDefinition>> = {
  admin: {
    id: "admin",
    label: "Admin",
    description:
      "Full access, including payroll, finance, user administration, YouTube connections and system settings. Sees the whole payroll rather than a personal earnings page.",
    permissions: ADMIN_PERMISSIONS,
    nicheScoped: false,
    contentScope: "all",
  },
  head_of_shorts: {
    id: "head_of_shorts",
    label: "Head of Shorts",
    description:
      "Runs the Shorts operation across every niche: full analytics and research, plus the channel, niche and sync controls the job needs. No payroll, finance or user administration.",
    // Operational capabilities are deliberately included: someone accountable
    // for Shorts performance who cannot add a competitor channel to track,
    // organise their niches or trigger a sync cannot do the job. Each one is
    // reversible and audited.
    //
    // Hit thresholds are NOT among them, deliberately. `settings.manage` is an
    // admin permission and `assertMayConfigureThreshold` requires it, so a Head
    // can create the niche and an Admin sets what counts as a hit in it. The
    // number decides hit rates and hit bonuses across the whole operation, and
    // the person measured by it should not be the person setting it.
    permissions: [...SELF_SERVICE, ...RESEARCH_BASELINE, ...HEAD_OPERATIONS],
    nicheScoped: false,
    contentScope: "shorts",
  },
  head_of_longs: {
    id: "head_of_longs",
    label: "Head of Longs",
    description:
      "Runs the Long Form operation. The Long Form features are not built yet, so today this role sees the same analytics and research as a Head of Shorts.",
    permissions: [...SELF_SERVICE, ...RESEARCH_BASELINE, ...HEAD_OPERATIONS, "longs.view"],
    nicheScoped: false,
    contentScope: "longs",
  },
  short_form_editor: {
    id: "short_form_editor",
    label: "Short Form Editor",
    description:
      "Edits Shorts for their assigned niches. Sees analytics and research for those niches only, and can write notes and save Shorts.",
    permissions: [...SELF_SERVICE, ...RESEARCH_BASELINE],
    nicheScoped: true,
    contentScope: "shorts",
  },
  long_form_editor: {
    id: "long_form_editor",
    label: "Long Form Editor",
    description:
      "Edits long-form video for their assigned niches. The Long Form features are not built yet; today this role sees the same niche-scoped analytics as a Short Form Editor.",
    permissions: [...SELF_SERVICE, ...RESEARCH_BASELINE, "longs.view"],
    nicheScoped: true,
    contentScope: "longs",
  },
  short_form_clip_producer: {
    id: "short_form_clip_producer",
    label: "Short Form Clip Producer",
    description:
      "Finds and produces clips for their assigned niches. Sees analytics and research for those niches, and can write notes and save Shorts.",
    permissions: [...SELF_SERVICE, ...RESEARCH_BASELINE],
    nicheScoped: true,
    contentScope: "shorts",
  },
};

/** Ordered for display: most privileged first. */
export const ROLE_ORDER: readonly Role[] = [
  "admin",
  "head_of_shorts",
  "head_of_longs",
  "short_form_editor",
  "long_form_editor",
  "short_form_clip_producer",
];

/**
 * Roles retired when the team model moved to job titles.
 *
 * Kept as a mapping rather than deleted so an account still carrying an old
 * role resolves to the closest current one instead of silently falling back to
 * the least-privileged default. Remove once no membership row uses them.
 */
const RETIRED_ROLE_ALIASES: Readonly<Record<string, Role>> = {
  channel_director: "short_form_editor",
  creative_director: "short_form_clip_producer",
};

/** True when the role only ever sees its own assigned niches. */
export function isNicheScoped(role: string): boolean {
  return roleDefinition(role).nicheScoped;
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Falls back to the least-privileged role rather than throwing.
 *
 * An unrecognised role string in the database — a downgrade, a typo, a
 * hand-edited row — must not grant more access than intended. Failing closed
 * here means the worst case is somebody sees too little and says so.
 */
export function roleDefinition(role: string): RoleDefinition {
  if (isRole(role)) return ROLE_DEFINITIONS[role];

  const alias = RETIRED_ROLE_ALIASES[role];
  if (alias) return ROLE_DEFINITIONS[alias];

  // Unknown string: fail closed to the least privileged role rather than
  // guessing. The worst outcome is somebody seeing too little and saying so.
  return ROLE_DEFINITIONS.short_form_clip_producer;
}

/** The permissions a member actually has: their role's set, widened by grants. */
export function effectivePermissions(
  role: string,
  grants: readonly string[] = [],
): ReadonlySet<Permission> {
  const result = new Set<Permission>(roleDefinition(role).permissions);
  for (const grant of grants) {
    if (isPermission(grant)) result.add(grant);
  }
  return result;
}

/**
 * The one predicate the whole app asks.
 *
 * Pure and synchronous so a component can call it during render and a route
 * handler can call it before a query, with no chance of the two disagreeing.
 */
export function can(
  actor: { readonly role: string; readonly grants?: readonly string[] },
  permission: Permission,
): boolean {
  return effectivePermissions(actor.role, actor.grants ?? []).has(permission);
}

/** True when the actor holds every listed permission. */
export function canAll(
  actor: { readonly role: string; readonly grants?: readonly string[] },
  permissions: readonly Permission[],
): boolean {
  const held = effectivePermissions(actor.role, actor.grants ?? []);
  return permissions.every((permission) => held.has(permission));
}

/** True when the actor holds at least one of the listed permissions. */
export function canAny(
  actor: { readonly role: string; readonly grants?: readonly string[] },
  permissions: readonly Permission[],
): boolean {
  const held = effectivePermissions(actor.role, actor.grants ?? []);
  return permissions.some((permission) => held.has(permission));
}

/**
 * Permissions that can be handed to an individual on top of their role.
 *
 * `users.manage` is excluded on purpose: the ability to create administrators
 * is the one capability that lets a person escalate themselves without limit,
 * so it may only arrive with the Admin role — a deliberate, visible decision —
 * never as a quiet checkbox on somebody's profile.
 */
const NON_GRANTABLE: readonly Permission[] = [
  // Creating administrators is the one capability that lets a person escalate
  // themselves without limit, so it may only arrive with the Admin role.
  "users.manage",
  // Excluded for the opposite reason to everything else on this list: every
  // role that should have it already does, so offering it as a checkbox would
  // imply it could be cleared. Grants are additive — unticking it would change
  // nothing — and a control that cannot do what it appears to do is worse than
  // no control. It is also the one thing an Admin cannot grant themselves back;
  // see WITHHELD_FROM_ADMIN.
  "earnings.view_own",
  // Payroll carries every colleague's salary. It is grantable in principle but
  // deliberately not from the ordinary permission checklist — widening someone
  // into everyone's pay should be a considered act, not a stray tick. An admin
  // who genuinely needs to delegate it can still assign the Admin role.
  "payroll.manage",
];

export const GRANTABLE_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter(
  (permission) => !NON_GRANTABLE.includes(permission),
);

/** Human-readable labels for the admin UI and the audit log. */
export const PERMISSION_LABELS: Readonly<Record<Permission, string>> = {
  "analytics.view": "View analytics",
  "research.write": "Write notes & save Shorts",
  "reports.generate": "Generate PDF reports",
  "channels.manage": "Manage tracked channels",
  "niches.manage": "Manage niches & thresholds",
  "sync.trigger": "Trigger data syncs",
  "finance.view": "View finance",
  "finance.manage": "Manage finance",
  "earnings.view_own": "See your own earnings",
  "payroll.view": "View payroll & salaries",
  "payroll.manage": "Manage payroll",
  "longs.view": "Long Form access (reserved)",
  "users.manage": "Manage users & roles",
  "audit.view": "View audit log",
  "youtube.manage": "Manage YouTube connections",
  "settings.manage": "Manage system settings",
};
