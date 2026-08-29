import type { Permission } from "@/lib/auth/permissions";

/**
 * The catalogue of auditable actions.
 *
 * WHAT IS RECORDED, AND WHAT IS NOT
 * This log exists for accountability: who changed access, who touched money,
 * who added or removed a channel, who connected a Google account. Every entry
 * answers "who did this to the system", and every one of them is an action a
 * person took deliberately and would expect to be attributable.
 *
 * It deliberately does NOT record which dashboards someone opened, what they
 * searched for, how long they looked at a competitor, or when they were at
 * their desk. That would be employee monitoring wearing an audit log's clothes,
 * and it is not what this is for. Reads are only logged where the read is
 * itself sensitive and disclosure matters — exporting financial data.
 *
 * Isomorphic on purpose so the admin UI can label entries from the same list
 * that produced them.
 */

export const AUDIT_ACTIONS = {
  // --- Authentication -------------------------------------------------------
  "auth.signed_in": "Signed in",
  "auth.signed_out": "Signed out",
  "auth.sign_in_failed": "Failed sign-in attempt",
  "auth.locked_out": "Account locked after repeated failures",
  "auth.password_changed": "Password changed",
  "auth.password_reset_requested": "Password reset requested",
  "auth.password_reset_completed": "Password reset completed",
  /**
   * Someone edited their own display name.
   *
   * Recorded because "who is this row" is answered by a name that can now
   * change, and a log entry attributing an action to "Ada" is easier to follow
   * when the rename is in the same timeline. It is not a security event, so it
   * carries no network context.
   */
  "auth.profile_updated": "Profile updated",
  /**
   * Someone changed the address they sign in with.
   *
   * A separate key from the one above, and a strictly more serious one: the
   * email is the login identifier and the destination of every password-reset
   * link, so moving it moves control of the account. That is exactly the event
   * an investigation into a compromised account starts from, which is why it
   * also earns IP and user-agent below.
   */
  "auth.email_changed": "Email address changed",

  // --- Users & access -------------------------------------------------------
  "user.invited": "User invited",
  "user.invitation_revoked": "Invitation revoked",
  "user.invitation_accepted": "Invitation accepted",
  "user.created": "User created",
  "user.deactivated": "User deactivated",
  "user.reactivated": "User reactivated",
  "user.role_changed": "Role changed",
  "user.permission_granted": "Permission granted",
  "user.permission_revoked": "Permission revoked",
  "user.sessions_revoked": "Sessions revoked",

  // --- Employees ------------------------------------------------------------
  //
  // Kept apart from the `user.*` keys above because they answer a different
  // question. `user.*` is about ACCESS — who can reach the team's data.
  // `employee.*` is about EMPLOYMENT — who works in which niche, what they are
  // paid, and who let them through the door. An admin auditing a salary change
  // should not have to read past a page of sign-ins to find it.
  "employee.approved": "Account approved",
  "employee.rejected": "Account rejected",
  "employee.niches_updated": "Niche assignments changed",
  "employee.pay_updated": "Employee pay updated",

  // --- Tracked data ---------------------------------------------------------
  "channel.added": "Channel added",
  "channel.removed": "Channel removed",
  "channel.restored": "Channel restored",
  "channel.ownership_changed": "Channel ownership changed",
  "channel.renamed": "Channel renamed",
  "niche.created": "Niche created",
  "niche.updated": "Niche updated",
  "niche.deleted": "Niche deleted",
  "niche.threshold_changed": "Niche hit threshold changed",

  // --- Content types --------------------------------------------------------
  //
  // Their own family rather than more `niche.*` keys, even though the two are
  // the same shape of user-defined taxonomy. A niche says which slice of the
  // operation a channel belongs to; a content type says what a Short *is*, and
  // it is the label every performance comparison between formats is drawn
  // against. When somebody asks why "Funny Moment" suddenly outperforms
  // everything, the first question is whether the label moved — so relabelling
  // has to be findable without reading past every niche edit.
  "contenttype.created": "Content type created",
  "contenttype.renamed": "Content type renamed",
  /**
   * Archiving, which is what happens instead of a delete once a type is in use.
   *
   * Separate from `deleted` because they are different events with different
   * consequences: a deactivated type keeps every Short already filed under it
   * and merely stops being offered on new work, while a delete only ever
   * happens to a type nothing referenced. Collapsing them into one key would
   * make "did we lose those classifications?" unanswerable from the log.
   */
  "contenttype.deactivated": "Content type deactivated",
  "contenttype.reactivated": "Content type reactivated",
  "contenttype.deleted": "Content type deleted",
  /**
   * The order of the catalogue changed.
   *
   * Worth a key of its own rather than folding into `renamed`: reordering is
   * the only catalogue edit that touches several rows at once, and it targets
   * the ORGANIZATION, so an entry filed under a content-type id would be
   * pointing at whichever row happened to be picked as representative.
   */
  "contenttype.reordered": "Content types reordered",
  /**
   * A channel's content-type tags changed — "what this channel makes".
   *
   * UN-RETIRED, not reinvented. `ChannelContentType` is back now that content
   * types are flat org-wide tags rather than a niche's private vocabulary, and
   * reusing the original key is what keeps entries written before the round
   * trip in one filter with the ones written after it. A new key would split
   * the same event into two histories and make "who changed this channel's
   * tags?" a question with two answers.
   */
  "contenttype.channel_assigned": "Channel content types changed",
  /**
   * A Short's classification changed — including the bulk path.
   *
   * One key for both the single-video edit and a 400-video bulk run, with the
   * count in `metadata`, because they are the same act at different scales and
   * an admin looking for "who relabelled the back catalogue" wants both hits in
   * one filter.
   */
  "contenttype.video_assigned": "Short content types assigned",

  // --- YouTube connections --------------------------------------------------
  "youtube.connected": "YouTube account connected",
  "youtube.disconnected": "YouTube account disconnected",
  "youtube.reauthorized": "YouTube account re-authorised",
  // Revenue import. `revenue_synced` records that money entered the ledger from
  // outside — the same class of event as somebody typing an entry, and the only
  // record of where a figure nobody entered came from. `revenue_sync_failed`
  // exists because a revenue import that silently stops is indistinguishable
  // from a month that genuinely earned nothing.
  "youtube.revenue_synced": "YouTube revenue synced",
  "youtube.revenue_sync_failed": "YouTube revenue sync failed",

  // --- Sync -----------------------------------------------------------------
  "sync.triggered": "Data sync triggered",
  "sync.failed": "Data sync failed",

  // --- Finance --------------------------------------------------------------
  "finance.entry_created": "Financial entry created",
  "finance.entry_updated": "Financial entry updated",
  "finance.entry_deleted": "Financial entry deleted",
  // Imported rows are kept apart from typed ones on purpose. "Who put this
  // number in the ledger" has a different answer for each — a person, or a
  // connector running on a clock — and an admin reconciling a month needs to
  // see which without opening the row. `entry_revised` is the one that matters
  // most: an imported figure MOVING after the fact is normal for an estimate
  // and completely abnormal for anything else, so it gets its own key rather
  // than hiding inside a generic update.
  "finance.entry_imported": "Financial entry imported",
  "finance.entry_revised": "Imported entry revised",
  "finance.category_created": "Finance category created",
  "finance.category_updated": "Finance category updated",
  "finance.category_archived": "Finance category archived",
  "finance.exported": "Financial data exported",
  "finance.rate_updated": "Exchange rate updated",

  // --- Payroll --------------------------------------------------------------
  //
  // These record that a payroll event HAPPENED and who caused it. They never
  // carry a figure: an audit entry is readable by anyone with `audit.view`,
  // which is a strictly wider group than the admins who hold `payroll.*`, so a
  // salary in `metadata` would route around the whole reason EmployeeProfile is
  // a separate table. Period, headcount and outcome — never money.
  "payroll.period_opened": "Payroll period opened",
  "payroll.period_finalized": "Payroll period finalized",
  "payroll.period_paid": "Payroll period marked paid",
  "payroll.record_paid": "Payroll payment marked paid",
  /**
   * The one action that changes a figure after it has been frozen.
   *
   * Finalizing exists to make a month reproducible; an adjustment is the
   * sanctioned exception to that, which makes it the payroll event most worth
   * being able to find again. Its own key, rather than a generic "updated", is
   * what makes it filterable — and the admin's stated reason travels with it,
   * because an entry recording that a total moved without recording why is not
   * an accountability record.
   */
  "payroll.record_adjusted": "Payroll record adjusted",
  /**
   * The same correction, made after the money had already left.
   *
   * A separate key rather than a flag inside `payroll.record_adjusted`, because
   * the two are different events to go looking for. Adjusting a finalized
   * figure changes what somebody is about to be paid; adjusting a figure
   * already marked paid changes the account of a payment that has happened —
   * the period's paid total moves, `paidAt` still points at the old transfer,
   * and somebody now has to settle a difference outside this system. That is
   * the entry an admin will one day be asked to produce, and it must not be
   * findable only by reading the metadata of every ordinary adjustment.
   *
   * The reason travels with it and the amount still does not, exactly as above.
   */
  "payroll.paid_record_adjusted": "Payroll record adjusted after payment",
  /**
   * The scheduled monthly run could not complete for an organization.
   *
   * Recorded rather than only logged because the failure mode this guards
   * against is silence: the 1st passes, no payroll appears, and nobody knows
   * whether that is because nothing was owed or because the job threw. A server
   * log nobody reads is not a control; an audit entry an admin can find is.
   */
  "payroll.run_failed": "Scheduled payroll run failed",
  "payroll.notification_sent": "Payroll notification sent",
  "payroll.notification_failed": "Payroll notification failed",
  "payroll.notification_skipped": "Payroll notification skipped",
  "payroll.test_notification_sent": "Test notification sent",

  // --- Settings -------------------------------------------------------------
  "settings.updated": "Settings changed",
  "settings.base_currency_changed": "Base currency changed",
  "settings.notifications_updated": "Notification settings changed",
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export function auditActionLabel(action: string): string {
  return (AUDIT_ACTIONS as Record<string, string>)[action] ?? action;
}

/**
 * Actions worth capturing IP and user-agent for.
 *
 * Limited to security-relevant events, where "was this really them, and from
 * where?" is a question an investigation would genuinely need to answer. Adding
 * every action here would turn the log into a location history, so the default
 * is to record nothing of the kind.
 */
const NETWORK_CONTEXT_ACTIONS: ReadonlySet<string> = new Set<AuditAction>([
  "auth.signed_in",
  "auth.sign_in_failed",
  "auth.locked_out",
  "auth.password_changed",
  "auth.password_reset_completed",
  // Moving the login identifier is a takeover if it was not the account holder
  // who did it, so "was this really them, and from where" is the question this
  // entry exists to answer.
  "auth.email_changed",
  // Account creation, from either path. "Which address claimed the owner
  // account, and from where" is the single most consequential event this
  // system records.
  "user.created",
  "user.invitation_accepted",
  "user.invited",
  "user.deactivated",
  "user.reactivated",
  "user.role_changed",
  "user.permission_granted",
  "user.permission_revoked",
  // Approval is the moment an account stops being a form submission and starts
  // being a way in, so "who let them in, and from where" is worth the same
  // capture as a role change. Rejection is its mirror.
  "employee.approved",
  "employee.rejected",
  // Not because pay is a security event, but because an unexplained salary
  // change is the entry somebody will one day have to account for, and "which
  // admin, from which machine" is half the answer.
  "employee.pay_updated",
  // Same reasoning, one step later in the process: an adjustment is the only
  // thing that moves a total after it was frozen, so it is the one somebody
  // will be asked to explain. Its post-payment twin all the more so — that one
  // moves a total after the transfer.
  "payroll.record_adjusted",
  "payroll.paid_record_adjusted",
  "youtube.connected",
  "youtube.disconnected",
  "finance.exported",
]);

export function shouldRecordNetworkContext(action: string): boolean {
  return NETWORK_CONTEXT_ACTIONS.has(action);
}

/**
 * The permissions that unlock an amount carried by an audit entry.
 *
 * Two of them, not one, because the log carries two different kinds of money.
 * `payroll.*` figures are an individual's pay; `finance.*` figures are the
 * company's transactions. `permissions.ts` keeps those apart on purpose —
 * "somebody trusted with one is not automatically trusted with the other" — and
 * an audit reader must not be the place that quietly joins them back together.
 */
export type AuditMoneyPermission = Extract<Permission, "payroll.view" | "finance.view">;

/**
 * Actions whose metadata may carry a monetary figure, and what it takes to read
 * it.
 *
 * WHY THE READ SIDE NEEDS THIS LIST AT ALL
 * `audit.view` is a strictly wider group than either money permission. It is
 * grantable on its own, so an admin can hand somebody the log to investigate an
 * incident without meaning to hand them the payroll or the ledger — and the
 * moment they do, every amount sitting in `metadata` becomes readable by that
 * wider group. So the rule is: anything readable THROUGH the log must be
 * readable by everyone who can read the log. Amounts are not, which makes them
 * the exception that has to be stripped from a reader who lacks the MATCHING
 * permission.
 *
 * MATCHING is the load-bearing word. This used to answer a yes/no question —
 * "may this reader see amounts?" — resolved once per request from
 * `payroll.view`. That made `payroll.view` a key to the ledger and, once
 * finance actions joined the list, `finance.view` no key at all. The value
 * below is which permission a given entry's figures actually belong to, so the
 * decision is made per entry against the right permission.
 *
 * The write side already keeps money out of every entry it can — see the
 * payroll note above, and the finance summaries which no longer quote a figure
 * — but `employee.pay_updated` is the deliberate exception (a salary change
 * with no record of what it changed from is not an audit entry), and rows
 * already written cannot be un-written. Redaction therefore happens where the
 * rows are READ: src/server/audit/audit-service.ts.
 *
 * The whole `payroll.*` family is covered BY PREFIX rather than enumerated,
 * which is the one place this file departs from the style of the set above. An
 * enumeration is a list somebody has to remember to extend, and the entry they
 * forget is by definition the new one nobody has thought about yet — a redaction
 * list that drifts fails open, silently. Prefixing costs the ability to exempt a
 * payroll action that provably carries no money, which is a thing worth losing.
 */
const MONEY_CARRYING_ACTIONS: ReadonlyMap<string, AuditMoneyPermission> = new Map<
  AuditAction,
  AuditMoneyPermission
>([["employee.pay_updated", "payroll.view"]]);

/** Every action under these carries money until proven otherwise. */
const MONEY_CARRYING_PREFIXES: readonly (readonly [string, AuditMoneyPermission])[] = [
  ["payroll.", "payroll.view"],
  // finance.entry_created / entry_updated write amountMinor and
  // previousAmountMinor into metadata. Exactly the same shape of leak as
  // payroll, one permission over: audit.view is wider than finance.view, so a
  // reader granted the log would otherwise read every transaction's value.
  ["finance.", "finance.view"],
] as const;

/**
 * Which permission an entry's figures belong to, or `null` if it carries none.
 *
 * The single classification of audit money in this codebase. A reader is
 * entitled to the amounts on an entry when they hold exactly this — not some
 * other money permission, and not a request-wide flag standing in for one.
 */
export function moneyPermissionFor(action: string): AuditMoneyPermission | null {
  const exact = MONEY_CARRYING_ACTIONS.get(action);
  if (exact) return exact;
  for (const [prefix, permission] of MONEY_CARRYING_PREFIXES) {
    if (action.startsWith(prefix)) return permission;
  }
  return null;
}

export function carriesMoneyMetadata(action: string): boolean {
  return moneyPermissionFor(action) !== null;
}

/** Groups used by the admin log filter. */
export const AUDIT_CATEGORIES = [
  { id: "auth", label: "Authentication", prefix: "auth." },
  { id: "users", label: "Users & access", prefix: "user." },
  { id: "employees", label: "Employees & pay", prefix: "employee." },
  { id: "channels", label: "Channels & niches", prefix: "channel." },
  { id: "niches", label: "Niches", prefix: "niche." },
  // Its own filter rather than folded under "Niches": the prefixes are distinct
  // strings, so a shared group would have to match two of them and the filter
  // is built from exactly one.
  { id: "contentTypes", label: "Content types", prefix: "contenttype." },
  { id: "youtube", label: "YouTube", prefix: "youtube." },
  { id: "sync", label: "Sync", prefix: "sync." },
  { id: "finance", label: "Finance", prefix: "finance." },
  { id: "payroll", label: "Payroll", prefix: "payroll." },
  { id: "settings", label: "Settings", prefix: "settings." },
] as const;
