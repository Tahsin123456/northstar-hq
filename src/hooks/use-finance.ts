"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type ExchangeRateInput,
  type FinanceCategoryInput,
  type FinanceCategoryPatch,
  type FinanceEntriesQuery,
} from "@/lib/api-client";
import type { DateRange } from "@/lib/analytics/types";
import type {
  FinanceEntryCreateInput,
  FinanceEntryUpdateInput,
} from "@/server/services/finance-service";
import { useFilters } from "@/components/providers/filters-provider";
import { useNow } from "./use-now";

/**
 * The finance ledger.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE PERIOD IS IN THIS QUERY KEY, AND DELIBERATELY NOT IN THE TRACKER'S
 * ─────────────────────────────────────────────────────────────────────────────
 * `DATASET_KEY` in use-dataset.ts is the constant `["dataset"]`, with no period
 * and no threshold in it. That is not an oversight and it is not a pattern to
 * copy here: the tracker payload holds every tracked video in memory, and every
 * filter over it — period, threshold, niche, ownership — is a pure re-slice of
 * an array that is already in the browser. Putting the period in that key would
 * turn a few milliseconds of recomputation into a network round trip and break
 * the product's central promise that moving a filter never refetches.
 *
 * The ledger is the opposite shape, because the filtering happens on the
 * server. The range goes to Prisma as a `where` on `occurredOn`; the headline
 * revenue and expense totals come from a grouped aggregate the browser never
 * receives; and `listEntriesPage` caps how many rows come back at all. A wider
 * period is therefore *different data*, not a wider window over data already
 * here — there is nothing client-side to re-slice.
 *
 * So a constant key would pin the cache to whichever range happened to be
 * fetched first and then serve those totals under every other period the user
 * selects. On a tracker that would be a stale chart; on a financial screen it
 * is a confident, authoritative, wrong revenue figure. Hence: the range is part
 * of the key, on purpose. Please do not "fix" this to match the dataset's.
 */

const MS_PER_DAY = 86_400_000;

/** Prefix key: invalidating this matches every finance read below. */
export const FINANCE_KEY = ["finance"] as const;
export const FINANCE_CATEGORIES_KEY = ["finance", "categories"] as const;
export const FINANCE_RATES_KEY = ["finance", "rates"] as const;

export function financeOverviewKey(range: DateRange) {
  return ["finance", "overview", range.startMs, range.endMs] as const;
}

export function financeEntriesKey(query: FinanceEntriesQuery) {
  return ["finance", "entries", query] as const;
}

/**
 * Snaps a filter range out to whole UTC days.
 *
 * Two reasons, and the second is a bug rather than a nicety.
 *
 * Semantically, `occurredOn` is stored at UTC midnight — an entry carries the
 * day the money moved, not a timestamp — so a boundary with a time of day in it
 * asks a question the ledger cannot answer any differently from the midnight
 * either side of it. Snapping also matches what `resolveFinanceRange` does
 * server-side, so the window the user reads on screen is the window that was
 * queried.
 *
 * Mechanically, `useFilters().range` is re-anchored to `useNow()`, which ticks
 * every 30 seconds so that "last 30 days" cannot drift over a long session.
 * Feeding that raw `endMs` into a query key would mint a brand new key twice a
 * minute and refetch the entire Finance dashboard on a timer, for a range
 * describing exactly the same days. Snapping keeps the key stable for as long
 * as it means the same thing.
 */
export function financeRangeFor(range: DateRange): DateRange {
  // The epoch is itself UTC midnight, so flooring by whole days lands on one.
  const startMs = Math.floor(range.startMs / MS_PER_DAY) * MS_PER_DAY;
  // Rounded up and exclusive, so entries dated today are always inside.
  const endMs = Math.ceil(range.endMs / MS_PER_DAY) * MS_PER_DAY;
  return { startMs, endMs: endMs > startMs ? endMs : startMs + MS_PER_DAY };
}

/**
 * Force every finance read to come from the server.
 *
 * The whole namespace, for the same reason as the admin one: no finance write
 * lands in a single read. Booking an entry moves the summary totals, both
 * series, the per-channel table and the ledger inside the overview payload.
 * Renaming or archiving a category moves the breakdown slices that are labelled
 * with it and its own `entryCount`. Even a rate change — which explicitly does
 * not touch a single existing entry — changes the `rates` array the overview
 * carries and the currencies the entry form is allowed to offer.
 *
 * Every write touches the overview, so splitting these into narrower
 * invalidations would buy nothing and cost a class of bug where one total on
 * the page refreshes and another does not.
 */
export function useInvalidateFinance() {
  const queryClient = useQueryClient();
  return React.useCallback(
    () => queryClient.invalidateQueries({ queryKey: FINANCE_KEY }),
    [queryClient],
  );
}

// ---------------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------------

/**
 * Everything the Finance dashboard renders, in one request.
 *
 * Defaults to the global period so this screen obeys the same control as every
 * other one. Pass an explicit range for a surface that has to fix its window at
 * render time — an export, or a comparison against a fixed quarter — rather
 * than following the header.
 */
export function useFinanceOverview(range?: DateRange) {
  const { range: filterRange } = useFilters();
  const nowMs = useNow();

  const followsFilters = range === undefined;
  const resolved = financeRangeFor(range ?? filterRange);

  return useQuery({
    queryKey: financeOverviewKey(resolved),
    queryFn: () =>
      api.getFinanceOverview({ startMs: resolved.startMs, endMs: resolved.endMs }),
    // `useNow()` is 0 during server render and the first hydration pass, which
    // resolves a trailing period to a window ending at the epoch. Fetching that
    // would spend a request on 1969 and cache a whole set of zeroes under a key
    // nothing will ever read again. One render's wait costs nothing — the page
    // is showing skeletons anyway.
    enabled: !followsFilters || nowMs > 0,
    // Keep the previous period's figures on screen while the new ones load, so
    // changing the range does not blank every total on the page.
    placeholderData: (previous) => previous,
  });
}

/**
 * The ledger on its own, narrowed by kind, channel or category.
 *
 * The overview already embeds the entries for its period, so this is for the
 * cases that want a different slice — one channel's expenses, say — without
 * refetching the entire dashboard alongside it.
 *
 * Check `truncated` on the result before summing `entries` client-side: past
 * the server's cap the array is the newest N rows, not the period.
 */
export function useFinanceEntries(query: FinanceEntriesQuery = {}) {
  return useQuery({
    queryKey: financeEntriesKey(query),
    queryFn: () => api.listFinanceEntries(query),
  });
}

/**
 * Every category, archived ones included.
 *
 * Archived categories are how historical entries keep their label, so the table
 * needs them even though the entry form will not offer them.
 */
export function useFinanceCategories() {
  return useQuery({
    queryKey: FINANCE_CATEGORIES_KEY,
    queryFn: api.listFinanceCategories,
  });
}

/** Also the source of truth for which foreign currencies may be entered at all. */
export function useExchangeRates() {
  return useQuery({
    queryKey: FINANCE_RATES_KEY,
    queryFn: api.listExchangeRates,
  });
}

// ---------------------------------------------------------------------------
// WRITES
//
// Note what these do NOT invalidate: the admin audit log. Every finance write
// records one, but the trail is append-only and read on a different screen, so
// coupling the two would refetch a table nobody has open in order to show an
// entry that will be there when they next open it.
// ---------------------------------------------------------------------------

export function useCreateFinanceEntry() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: (payload: FinanceEntryCreateInput) => api.createFinanceEntry(payload),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateFinanceEntry() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: FinanceEntryUpdateInput }) =>
      api.updateFinanceEntry(id, patch),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteFinanceEntry() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: (id: string) => api.deleteFinanceEntry(id),
    onSuccess: () => invalidate(),
  });
}

export function useCreateFinanceCategory() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: (payload: FinanceCategoryInput) => api.createFinanceCategory(payload),
    onSuccess: () => invalidate(),
  });
}

/** Rename, archive, or both — the server applies them in that order. */
export function useUpdateFinanceCategory() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: FinanceCategoryPatch }) =>
      api.updateFinanceCategory(id, patch),
    onSuccess: () => invalidate(),
  });
}

/** Saves the whole rate table at once; see the note on `api.setExchangeRates`. */
export function useSetExchangeRates() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: (rates: readonly ExchangeRateInput[]) => api.setExchangeRates(rates),
    onSuccess: () => invalidate(),
  });
}
