"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type EmployeePayPatch } from "@/lib/api-client";
import { ADMIN_KEY } from "./use-admin";

/**
 * Admin › Employees: the roster, one person's profile, and the writes behind
 * both.
 *
 * WHY EVERY WRITE ALSO INVALIDATES THE `["admin"]` NAMESPACE
 * These two screens overlap with Users by design rather than by accident. An
 * approval flips `AppUser.status`, which is a column the Users table renders and
 * a figure the Overview tiles count. A niche assignment and a pay change each
 * write an audit entry, which is a row the audit log shows. Refreshing only the
 * employee caches would leave the neighbouring admin screen quietly asserting
 * the opposite of what this one just did — on the pair of screens whose whole
 * job is to say who works here and what they can reach.
 *
 * React Query only refetches queries that are currently mounted, so the extra
 * key costs nothing on a page that is not open.
 *
 * NOTHING HERE ASKS FOR PAY. There is no `includePay` option to pass, because
 * the routes resolve `payroll.view` from the session and omit the fields
 * entirely for anyone without it. A caller cannot widen its own response.
 */

/** Prefix key: invalidating this matches both reads below. */
export const EMPLOYEES_KEY = ["employees"] as const;
export const EMPLOYEES_LIST_KEY = ["employees", "list"] as const;

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

// ---------------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------------

export function useEmployees() {
  return useQuery({
    queryKey: EMPLOYEES_LIST_KEY,
    queryFn: api.listEmployees,
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
