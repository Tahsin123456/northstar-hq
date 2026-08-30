"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type EmployeePayPatch } from "@/lib/api-client";
import { ADMIN_KEY } from "./use-admin";

/**
 * The roster half of Admin › People, one person's profile, and the writes
 * behind both.
 *
 * WHY EVERY WRITE ALSO INVALIDATES THE `["admin"]` NAMESPACE
 * These reads overlap with the account directory by design rather than by
 * accident: People renders ONE row out of both, so a write here lands in a
 * table the other read is also feeding. An approval flips `AppUser.status`,
 * which is a column that row renders from the directory and a figure the
 * Overview tiles count. A niche assignment and a pay change each write an audit
 * entry, which is a row the audit log shows. Refreshing only the employee
 * caches would leave half of the merged row — and the admin screen next door —
 * quietly asserting the opposite of what this one just did.
 *
 * React Query only refetches queries that are currently mounted, so the extra
 * key costs nothing on a page that is not open.
 *
 * NOTHING HERE ASKS FOR PAY. There is no `includePay` option to pass, because
 * the routes resolve `payroll.view` from the session and omit the fields
 * entirely for anyone without it. A caller cannot widen its own response.
 */

/** Prefix key: invalidating this matches every read below. */
export const EMPLOYEES_KEY = ["employees"] as const;
export const EMPLOYEES_LIST_KEY = ["employees", "list"] as const;

/**
 * The approvals queue, keyed UNDER the employees prefix on purpose.
 *
 * An approval is the one write that changes the roster and the queue in the
 * same instant — the row leaves one and appears in the other — so putting the
 * queue in its own namespace would mean every existing employee mutation had to
 * remember to invalidate a second key. Nesting it means the invalidation that
 * has always been there already covers it, and always will.
 */
export const EMPLOYEES_APPROVALS_KEY = ["employees", "approvals"] as const;

export function employeeKey(userId: string) {
  return ["employees", "profile", userId] as const;
}

/** Force the next employee read — and the admin screens beside it — from the server. */
export function useInvalidateEmployees() {
  const queryClient = useQueryClient();
  return React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: EMPLOYEES_KEY });
    void queryClient.invalidateQueries({ queryKey: ADMIN_KEY });
  }, [queryClient]);
}

/**
 * The same refresh, awaitable.
 *
 * `invalidateQueries` resolves once the active refetches it triggered have
 * come back, which is the difference the approvals queue depends on: a row
 * there may only disappear when the SERVER says it is gone, so the screen has
 * to be able to wait for the new list rather than assume one. The fire-and-
 * forget version above stays for the mutations that only need the neighbouring
 * screens to catch up eventually.
 */
export function useRefreshEmployees() {
  const queryClient = useQueryClient();
  return React.useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: EMPLOYEES_KEY }),
      queryClient.invalidateQueries({ queryKey: ADMIN_KEY }),
    ]);
  }, [queryClient]);
}

// ---------------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------------

/**
 * The roster.
 *
 * `enabled` for the same reason `usePendingApprovals` has one: the notes log
 * offers an author filter, and the roster behind it needs `users.manage`. A
 * screen that renders for everybody must be able to decline to ask, rather than
 * putting a 403 in every employee's console to populate a menu they will not
 * be shown.
 */
export function useEmployees(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: EMPLOYEES_LIST_KEY,
    queryFn: api.listEmployees,
    enabled: options.enabled ?? true,
  });
}

/**
 * Everybody waiting behind the approval gate.
 *
 * `enabled` exists for one caller: the admin sub-navigation, which renders for
 * anybody holding any admin capability — an auditor, somebody with only the
 * YouTube permission — and must not fire a `users.manage` request on their
 * behalf just to decide whether to draw a badge. A 403 in the console on every
 * admin page load would be this hook's fault, not theirs.
 *
 * Both callers share the key, so the tab badge and the queue itself are one
 * request and cannot disagree about how many people are waiting.
 */
export function usePendingApprovals(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: EMPLOYEES_APPROVALS_KEY,
    queryFn: api.listPendingApprovals,
    enabled: options.enabled ?? true,
  });
}

/**
 * One person's profile.
 *
 * `enabled` guards the empty id that a route param can briefly be, so a
 * half-resolved URL never fires a request that would 404.
 */
export function useEmployee(userId: string) {
  return useQuery({
    queryKey: employeeKey(userId),
    queryFn: () => api.getEmployee(userId),
    enabled: userId.length > 0,
  });
}

// ---------------------------------------------------------------------------
// WRITES
// ---------------------------------------------------------------------------

export function useSetEmployeeNiches() {
  const invalidate = useInvalidateEmployees();
  return useMutation({
    mutationFn: ({ userId, nicheIds }: { userId: string; nicheIds: readonly string[] }) =>
      api.setEmployeeNiches(userId, nicheIds),
    onSuccess: () => invalidate(),
  });
}

/**
 * Salary, hit payment and employment dates.
 *
 * A partial patch: the server resolves every absent field against what is
 * stored, so the form sends only what the admin actually changed. Requires
 * `payroll.manage`, which is checked in the route and again in the service —
 * the refusal comes back as an `ApiError` with a sentence to render.
 */
export function useUpdateEmployeePay() {
  const invalidate = useInvalidateEmployees();
  return useMutation({
    mutationFn: ({ userId, patch }: { userId: string; patch: EmployeePayPatch }) =>
      api.updateEmployeePay(userId, patch),
    onSuccess: () => invalidate(),
  });
}

export function useApproveEmployee() {
  const invalidate = useInvalidateEmployees();
  return useMutation({
    mutationFn: (userId: string) => api.approveEmployee(userId),
    onSuccess: () => invalidate(),
  });
}

export function useRejectEmployee() {
  const invalidate = useInvalidateEmployees();
  return useMutation({
    mutationFn: (userId: string) => api.rejectEmployee(userId),
    onSuccess: () => invalidate(),
  });
}

// ---------------------------------------------------------------------------
// WRITES: the approvals queue
// ---------------------------------------------------------------------------

/**
 * Approve or deny several accounts in one request.
 *
 * THE SAME DECISION AS THE TWO HOOKS ABOVE, over the same service functions —
 * `approveEmployee` and `rejectEmployee` — reached through the batch endpoints
 * instead of the per-account ones. Nothing about the transition differs: each
 * id gets its own compare-and-set and its own audit entry, so approving five
 * people leaves five `employee.approved` events rather than one summary of a
 * batch. The queue uses these for its per-row buttons too, a batch of one, so
 * that screen has a single code path and a single result shape to read.
 *
 * WHY `onSuccess` RETURNS THE REFRESH RATHER THAN FIRING IT
 * React Query awaits a promise returned from `onSuccess` before the mutation
 * leaves its pending state, so `await mutateAsync(...)` here resolves only once
 * the queue has actually been refetched. That is what lets the approvals screen
 * keep a row on screen, disabled, until the server has confirmed it is gone —
 * instead of removing it optimistically and having to put it back.
 *
 * A RESOLVED PROMISE IS NOT A CLEAN RUN. Both endpoints answer 200 with a
 * per-user breakdown, because one stale id must not abandon the other nine.
 * Callers have to read `results` / `failed`; only a malformed request or a lost
 * connection throws.
 */
export function useApproveApprovals() {
  const refresh = useRefreshEmployees();
  return useMutation({
    mutationFn: (userIds: readonly string[]) => api.approveApprovals(userIds),
    onSuccess: () => refresh(),
  });
}

export function useDenyApprovals() {
  const refresh = useRefreshEmployees();
  return useMutation({
    mutationFn: ({ userIds, reason }: { userIds: readonly string[]; reason?: string }) =>
      api.denyApprovals(userIds, reason),
    onSuccess: () => refresh(),
  });
}
