"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type NotificationSettingsPatch } from "@/lib/api-client";
import { ADMIN_KEY } from "./use-admin";

/**
 * Payroll reads and writes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE CURRENT PERIOD IS NOT CACHED THE WAY THE REST OF THE APP IS
 * ─────────────────────────────────────────────────────────────────────────────
 * `/api/admin/payroll` is a live calculation over view counts that are still
 * moving — the server says so itself with `isDraft`. React Query's default
 * behaviour is to serve a cached payload instantly and revalidate behind it,
 * which is right for a tracker and wrong here: the number on this screen is
 * what somebody is about to be paid, and a stale one carries an authority it
 * has not earned. So `staleTime: 0` and a refetch on focus — coming back to the
 * tab is exactly the moment an admin re-reads the total.
 *
 * The history list and a finalized period are the opposite case. Once a month
 * is frozen its figures cannot change except through an adjustment, and an
 * adjustment goes through a mutation below that invalidates the namespace. They
 * still sit under the same prefix so one invalidation covers everything.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY EVERY WRITE INVALIDATES THE WHOLE `["payroll"]` NAMESPACE
 * ─────────────────────────────────────────────────────────────────────────────
 * No payroll write lands in only one read. Finalizing a month changes the
 * dashboard's header, adds a row to history, and turns the same month's detail
 * view from a calculation into a stored document. Adjusting one person's record
 * moves that record, its period's total, and the history row's total. Marking
 * a period paid moves the status in three places.
 *
 * Enumerating which key each mutation touches would be a list to keep in step
 * with what the *server* chooses to write, and the failure mode when it drifts
 * is a header disagreeing with the rows beneath it — on the one screen whose
 * entire job is to be trustworthy about money. Invalidating the prefix costs at
 * most a few requests on a page the admin is already looking at.
 */

/** Prefix key: invalidating this matches every payroll read below. */
export const PAYROLL_KEY = ["payroll"] as const;
export const PAYROLL_CURRENT_KEY = ["payroll", "current"] as const;
export const PAYROLL_PERIODS_KEY = ["payroll", "periods"] as const;
export const NOTIFICATION_SETTINGS_KEY = ["payroll", "notifications"] as const;

export function payrollPeriodKey(year: number, month: number) {
  return ["payroll", "period", year, month] as const;
}

/**
 * Force the next payroll read to come from the server.
 *
 * `["admin"]` goes with it, because the admin dashboard's Team group carries
 * the same month's total and its pay date, read from /api/admin/overview rather
 * than from here. Finalizing or paying the current period changes that tile —
 * "still moving" becomes "finalized" — and its cache entry is five minutes
 * stale by default with no refetch on focus, so without this a screen an admin
 * lands on straight afterwards would describe the month they just closed as
 * still open. Same reasoning as the payroll namespace above, one screen over.
 */
export function useInvalidatePayroll() {
  const queryClient = useQueryClient();
  return React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ADMIN_KEY });
    return queryClient.invalidateQueries({ queryKey: PAYROLL_KEY });
  }, [queryClient]);
}

// ---------------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------------

/** The month in progress, plus last month's run. */
export function usePayroll() {
  return useQuery({
    queryKey: PAYROLL_CURRENT_KEY,
    queryFn: api.getPayroll,
    // See the note at the top: a draft figure served from cache would present a
    // number as settled when it is not.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

/** Payroll history, newest first. */
export function usePayrollPeriods() {
  return useQuery({
    queryKey: PAYROLL_PERIODS_KEY,
    queryFn: api.listPayrollPeriods,
  });
}

/**
 * One period in full.
 *
 * `enabled` because the history screen only fetches the detail of the period
 * the admin actually opened — a year of months' worth of per-employee
 * breakdowns is not something to prefetch, and each open one costs an engine
 * run server-side.
 */
export function usePayrollPeriod(
  period: { year: number; month: number } | null,
) {
  return useQuery({
    queryKey: period
      ? payrollPeriodKey(period.year, period.month)
      : ["payroll", "period", "none"],
    queryFn: () => api.getPayrollPeriod(period!.year, period!.month),
    enabled: period !== null,
  });
}

/** Telegram configuration, its readiness, and the last delivery's outcome. */
export function useNotificationSettings() {
  return useQuery({
    queryKey: NOTIFICATION_SETTINGS_KEY,
    queryFn: api.getNotificationSettings,
  });
}

// ---------------------------------------------------------------------------
// WRITES
// ---------------------------------------------------------------------------

export function useFinalizePeriod() {
  const invalidate = useInvalidatePayroll();
  return useMutation({
    mutationFn: ({
      year,
      month,
      force,
    }: {
      year: number;
      month: number;
      force?: boolean;
    }) => api.finalizePayrollPeriod(year, month, { force }),
    onSuccess: () => invalidate(),
  });
}

export function useMarkPeriodPaid() {
  const invalidate = useInvalidatePayroll();
  return useMutation({
    mutationFn: ({ year, month }: { year: number; month: number }) =>
      api.markPayrollPeriodPaid(year, month),
    onSuccess: () => invalidate(),
  });
}

/**
 * Correct one person's finalized figure.
 *
 * The server requires a reason and records it in the audit log; the amount
 * stays on the record, behind `payroll.view`. Both of those are enforced
 * server-side — this hook only carries the request.
 */
export function useAdjustRecord() {
  const invalidate = useInvalidatePayroll();
  return useMutation({
    mutationFn: ({
      id,
      adjustmentMinor,
      adjustmentReason,
    }: {
      id: string;
      adjustmentMinor: number;
      adjustmentReason: string;
    }) => api.adjustPayrollRecord(id, { adjustmentMinor, adjustmentReason }),
    onSuccess: () => invalidate(),
  });
}

export function useMarkRecordPaid() {
  const invalidate = useInvalidatePayroll();
  return useMutation({
    mutationFn: (id: string) => api.markPayrollRecordPaid(id),
    onSuccess: () => invalidate(),
  });
}

/**
 * Save Telegram settings.
 *
 * The response is the whole settings view, so it is written straight into the
 * cache rather than triggering a refetch: the switches must not flicker back to
 * their old positions while a round trip confirms what the server already told
 * us it stored.
 */
export function useUpdateNotificationSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: NotificationSettingsPatch) =>
      api.updateNotificationSettings(patch),
    onSuccess: (result) => {
      queryClient.setQueryData(NOTIFICATION_SETTINGS_KEY, result);
    },
  });
}

/**
 * Prove the wiring. Sends no payroll figures.
 *
 * Invalidates the settings read on completion because a test that fails is how
 * an admin discovers a bad chat id, and the card's own status line should agree
 * with the toast they just saw.
 */
export function useSendNotificationTest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.sendNotificationTest(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: NOTIFICATION_SETTINGS_KEY }),
  });
}

/** Send, or re-send, the real summary for a finalized month. */
export function useSendPayrollNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { year: number; month: number; force?: boolean }) =>
      api.sendPayrollNotification(input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: NOTIFICATION_SETTINGS_KEY }),
  });
}
