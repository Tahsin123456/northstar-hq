"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

/**
 * Your own earnings.
 *
 * Deliberately NOT under the `["payroll"]` namespace the admin screens use.
 * That prefix is invalidated wholesale by every payroll mutation, and those
 * mutations belong to a different permission and a different set of screens;
 * sharing the key would mean an employee's cache entry and an admin's live
 * dashboard were the same cached thing under two authorizations. Two subjects,
 * two namespaces.
 *
 * `staleTime: 0` and a refetch on focus, for the same reason the payroll
 * dashboard does it: an open period is a live estimate over view counts that
 * are still climbing, and a cached figure about somebody's own pay would carry
 * an authority it has not earned. A finalized period cannot move at all, so the
 * extra request costs nothing that matters.
 */
export const EARNINGS_KEY = ["earnings"] as const;

export type EarningsPeriodQuery =
  | { kind: "current" }
  | { kind: "previous" }
  | { kind: "custom"; startsAt: number; endsAt: number };

export function earningsKey(period: EarningsPeriodQuery) {
  return period.kind === "custom"
    ? ([...EARNINGS_KEY, "custom", period.startsAt, period.endsAt] as const)
    : ([...EARNINGS_KEY, period.kind] as const);
}

export function useMyEarnings(period: EarningsPeriodQuery) {
  return useQuery({
    queryKey: earningsKey(period),
    queryFn: () =>
      api.getMyEarnings(
        period.kind === "custom"
          ? { period: "custom", startsAt: period.startsAt, endsAt: period.endsAt }
          : { period: period.kind },
      ),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

/**
 * Your earnings history: the months already settled.
 *
 * Under the same `["earnings"]` namespace as the figure above, for the same
 * reason — it is the same subject read under the same permission, and an admin
 * mutation that invalidates `["payroll"]` has no business touching it.
 *
 * `staleTime` is a full minute here, not zero. Unlike the current month, none
 * of these figures can move: they are stored records of what was owed. The one
 * thing that does change is whether a period has been marked paid, which the
 * refetch on focus picks up — a minute of staleness on that is a minute, not a
 * wrong number.
 */
export const EARNINGS_HISTORY_KEY = [...EARNINGS_KEY, "history"] as const;

export function useMyEarningsHistory(limit?: number) {
  return useQuery({
    queryKey: limit === undefined ? EARNINGS_HISTORY_KEY : ([...EARNINGS_HISTORY_KEY, limit] as const),
    queryFn: () => api.getMyEarningsHistory(limit === undefined ? {} : { limit }),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * The per-niche hit lines behind one settled month.
 *
 * ONLY FETCHED WHEN A ROW IS OPENED. The caller mounts this hook from inside
 * the opened panel, so a closed row costs nothing — which is the whole reason
 * the breakdown is a second request rather than a field on the list. A year of
 * history is a dozen rows of three numbers each; the hits behind all of them are
 * hundreds of Shorts nobody asked to see.
 *
 * `staleTime: Infinity`. Unlike the list — where whether a month has been marked
 * paid can still change — a settled month's hits are a closed document. Once
 * fetched, re-fetching it can only ever return the same rows, so a row that is
 * opened, closed and opened again costs one request. `refetchOnWindowFocus` is
 * off for the same reason.
 */
export function useMyEarningsHistoryBreakdown(month: { year: number; month: number }) {
  return useQuery({
    // "month" discriminates against the list's own key, which is this prefix
    // plus a page size — two numbers deep rather than one, but a literal here
    // costs nothing and means a `limit` can never be read as a year.
    queryKey: [...EARNINGS_HISTORY_KEY, "month", month.year, month.month] as const,
    queryFn: () => api.getMyEarningsHistoryBreakdown(month),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
