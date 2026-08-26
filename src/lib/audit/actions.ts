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

  // --- YouTube connections --------------------------------------------------
  "youtube.connected": "YouTube account connected",
  "youtube.disconnected": "YouTube account disconnected",
  "youtube.reauthorized": "YouTube account re-authorised",

  // --- Sync -----------------------------------------------------------------
  "sync.triggered": "Data sync triggered",
  "sync.failed": "Data sync failed",

  // --- Finance --------------------------------------------------------------
  "finance.entry_created": "Financial entry created",
  "finance.entry_updated": "Financial entry updated",
  "finance.entry_deleted": "Financial entry deleted",
  "finance.category_created": "Finance category created",
  "finance.category_updated": "Finance category updated",
  "finance.category_archived": "Finance category archived",
  "finance.exported": "Financial data exported",
  "finance.rate_updated": "Exchange rate updated",

  // --- Settings -------------------------------------------------------------
  "settings.updated": "Settings changed",
  "settings.base_currency_changed": "Base currency changed",
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
  "youtube.connected",
  "youtube.disconnected",
  "finance.exported",
]);

export function shouldRecordNetworkContext(action: string): boolean {
  return NETWORK_CONTEXT_ACTIONS.has(action);
}

/** Groups used by the admin log filter. */
export const AUDIT_CATEGORIES = [
  { id: "auth", label: "Authentication", prefix: "auth." },
  { id: "users", label: "Users & access", prefix: "user." },
  { id: "channels", label: "Channels & niches", prefix: "channel." },
  { id: "niches", label: "Niches", prefix: "niche." },
  { id: "youtube", label: "YouTube", prefix: "youtube." },
  { id: "sync", label: "Sync", prefix: "sync." },
  { id: "finance", label: "Finance", prefix: "finance." },
  { id: "settings", label: "Settings", prefix: "settings." },
] as const;
