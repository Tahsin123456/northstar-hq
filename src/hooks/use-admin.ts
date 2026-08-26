"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type AuditLogQuery, type MemberUpdate } from "@/lib/api-client";

/**
 * User administration: the directory, the overview tiles and the audit trail.
 *
 * WHY EVERY WRITE INVALIDATES THE WHOLE `["admin"]` NAMESPACE
 * No admin write lands in only one of the three reads. Inviting somebody adds a
 * row to the directory *and* moves the "invited" tile on the overview *and*
 * writes an audit entry. Deactivating an account changes the directory, the
 * active-session count and the log. Replacing grants changes the member's row
 * and, again, the log.
 *
 * Enumerating which key each mutation touches would be four lists to keep in
 * step with what the *server* chooses to audit — and the failure mode when one
 * drifts is a tile quietly disagreeing with the table underneath it, on the one
 * screen whose job is to say who can reach the team's data. Invalidating the
 * namespace as a unit costs at most three requests on a page the user is
 * already looking at. (React Query only refetches *active* queries; an audit
 * page nobody has open is merely marked stale.)
 */

/** Prefix key: invalidating this matches every admin read below. */
export const ADMIN_KEY = ["admin"] as const;
export const ADMIN_OVERVIEW_KEY = ["admin", "overview"] as const;
export const ADMIN_USERS_KEY = ["admin", "users"] as const;

/**
 * Audit pages are keyed by their filters, so each page and each filter
 * combination is its own cache entry. The object is hashed by value, so passing
 * a fresh literal every render is fine — it is the same key.
 */
export function adminAuditKey(query: AuditLogQuery) {
  return ["admin", "audit", query] as const;
}

/** Force the next admin read to come from the server. */
export function useInvalidateAdmin() {
  const queryClient = useQueryClient();
  return React.useCallback(
    () => queryClient.invalidateQueries({ queryKey: ADMIN_KEY }),
    [queryClient],
  );
}

// ---------------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------------

export function useAdminOverview() {
  return useQuery({
    queryKey: ADMIN_OVERVIEW_KEY,
    queryFn: api.getAdminOverview,
  });
}

export function useAdminUsers() {
  return useQuery({
    queryKey: ADMIN_USERS_KEY,
    queryFn: api.listAdminUsers,
  });
}

/**
 * A page of the audit trail, newest first.
 *
 * `placeholderData` holds the previous page on screen while the next one
 * loads. Paging a log that blanks to a skeleton on every click makes it
 * impossible to follow a sequence of events, which is the only reason anybody
 * opens this table.
 */
export function useAuditLog(query: AuditLogQuery = {}) {
  return useQuery({
    queryKey: adminAuditKey(query),
    queryFn: () => api.getAuditLog(query),
    placeholderData: (previous) => previous,
  });
}

// ---------------------------------------------------------------------------
// WRITES
// ---------------------------------------------------------------------------

export function useInviteMember() {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: (payload: {
      email: string;
      name?: string;
      role: string;
      nicheIds?: readonly string[];
    }) => api.inviteMember(payload),
    onSuccess: () => invalidate(),
  });
}

/**
 * Change a member's role, their status, or both.
 *
 * Two guards live on the server, next to the writes: an admin may not edit
 * their own access, and the last active admin may not be demoted or
 * deactivated. Both come back as an `ApiError` with a sentence to render — the
 * UI should also disable the controls (`AdminUserDTO.isSelf`), but the check
 * that actually holds is the one at the moment of the write.
 */
export function useUpdateMember() {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: ({ id, ...update }: MemberUpdate & { id: string }) =>
      api.updateMember(id, update),
    onSuccess: () => invalidate(),
  });
}

export function useSetMemberGrants() {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: ({ id, permissions }: { id: string; permissions: readonly string[] }) =>
      api.setMemberGrants(id, permissions),
    onSuccess: () => invalidate(),
  });
}

export function useRevokeInvitation() {
  const invalidate = useInvalidateAdmin();
  return useMutation({
    mutationFn: (id: string) => api.revokeInvitation(id),
    onSuccess: () => invalidate(),
  });
}
