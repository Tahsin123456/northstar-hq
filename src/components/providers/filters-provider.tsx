"use client";

import * as React from "react";
import { DEFAULT_PERIOD_PRESET, DEFAULT_THRESHOLD } from "@/lib/analytics/constants";
import type { DateRange, PeriodPresetId, PeriodSelection } from "@/lib/analytics/types";
import { resolveDateRange } from "@/lib/date-range";
import { useNow } from "@/hooks/use-now";
import { useDataset } from "@/hooks/use-dataset";
import {
  clearThresholdOverride,
  getFiltersServerSnapshot,
  getFiltersSnapshot,
  resetFilters,
  seedDefaults,
  setCustomRange,
  setNicheFilter,
  setOwnFirst,
  setOwnershipFilter,
  setPeriodPreset,
  setThreshold,
  subscribeToFilters,
  type NicheFilter,
  type OwnershipFilter,
} from "@/lib/filters-store";

/**
 * Global analysis filters: which period, which niche, and what counts as a hit.
 *
 * THRESHOLD RESOLUTION
 * `threshold` is *derived*, not stored:
 *
 *     explicit override  ->  niche default  ->  account default
 *
 * That ordering is what makes niche-specific thresholds work without touching
 * a single consumer. Every screen already reads `threshold` from this context,
 * so selecting RDR switches the whole app to RDR's 750K automatically — hit
 * rate, charts, Winners, Outliers, Our vs Market and the PDF included — and
 * there is no way for one surface to be looking at a different number than
 * another.
 *
 * The override is deliberately transient state rather than a write to the
 * niche: experimenting with 1M on an RDR view should not silently reconfigure
 * the niche for everyone tomorrow. Saving is an explicit, separate action.
 *
 * None of this enters a query key, so changing any of it recomputes from data
 * already in memory and issues no request.
 */

export type ThresholdSource = "override" | "niche" | "account";

interface FiltersState {
  readonly period: PeriodSelection;
  /** The effective threshold every analytic should use. */
  readonly threshold: number;
  /** Where that number came from, so the UI can label it honestly. */
  readonly thresholdSource: ThresholdSource;
  /** The selected niche's configured threshold, if it has one. */
  readonly nicheDefaultThreshold: number | null;
  /** Display name of the active niche, for threshold labelling. */
  readonly nicheName: string | null;
  readonly hasThresholdOverride: boolean;

  /** Recomputed on a timer so "last 30 days" does not drift over a long session. */
  readonly range: DateRange;

  readonly niche: NicheFilter;
  readonly ownership: OwnershipFilter;
  readonly ownFirst: boolean;
  readonly hasScopeFilter: boolean;

  readonly setPeriodPreset: (preset: PeriodPresetId) => void;
  readonly setCustomRange: (startMs: number, endMs: number) => void;
  readonly setThreshold: (threshold: number) => void;
  readonly clearThresholdOverride: () => void;
  readonly setNiche: (niche: NicheFilter) => void;
  readonly setOwnership: (ownership: OwnershipFilter) => void;
  readonly setOwnFirst: (ownFirst: boolean) => void;
  readonly clearScopeFilters: () => void;
  readonly resetToDefaults: () => void;
}

const FiltersContext = React.createContext<FiltersState | null>(null);

export function FiltersProvider({
  children,
  defaultThreshold = DEFAULT_THRESHOLD,
  defaultPeriod = { preset: DEFAULT_PERIOD_PRESET },
}: {
  children: React.ReactNode;
  defaultThreshold?: number;
  defaultPeriod?: PeriodSelection;
}) {
  // Seeded during render on purpose: the store's server snapshot must match the
  // values the server rendered with *before* the first useSyncExternalStore
  // read, or hydration would disagree. seedDefaults is idempotent.
  seedDefaults({ period: defaultPeriod });

  const snapshot = React.useSyncExternalStore(
    subscribeToFilters,
    getFiltersSnapshot,
    getFiltersServerSnapshot,
  );

  // Niche thresholds live in the dataset, which every page fetches anyway; this
  // reads the existing cache rather than adding a request.
  const { data } = useDataset();

  const activeNiche = React.useMemo(() => {
    if (snapshot.niche === "all" || snapshot.niche === "unassigned") return null;
    return data?.niches.find((n) => n.id === snapshot.niche) ?? null;
  }, [data, snapshot.niche]);

  const nicheDefaultThreshold = activeNiche?.hitThreshold ?? null;

  const threshold =
    snapshot.thresholdOverride ?? nicheDefaultThreshold ?? defaultThreshold;

  const thresholdSource: ThresholdSource =
    snapshot.thresholdOverride !== null
      ? "override"
      : nicheDefaultThreshold !== null
        ? "niche"
        : "account";

  // Anchor for trailing windows. A dashboard left open overnight must not keep
  // computing "last 7 days" from yesterday's anchor.
  //
  // `0` during server render and the first hydration pass, which resolves to an
  // empty window ending at the epoch. That is deliberate: it is deterministic,
  // so hydration matches, and it is corrected the moment the clock store
  // subscribes — while the dataset is still loading and skeletons are showing.
  const nowMs = useNow();

  const range = React.useMemo(
    () => resolveDateRange(snapshot.period, nowMs),
    [snapshot.period, nowMs],
  );

  const value = React.useMemo<FiltersState>(
    () => ({
      period: snapshot.period,
      threshold,
      thresholdSource,
      nicheDefaultThreshold,
      nicheName: activeNiche?.name ?? null,
      hasThresholdOverride: snapshot.thresholdOverride !== null,
      range,
      niche: snapshot.niche,
      ownership: snapshot.ownership,
      ownFirst: snapshot.ownFirst,
      hasScopeFilter: snapshot.niche !== "all" || snapshot.ownership !== "all",
      setPeriodPreset,
      setCustomRange,
      setThreshold,
      clearThresholdOverride,
      setNiche: setNicheFilter,
      setOwnership: setOwnershipFilter,
      setOwnFirst,
      clearScopeFilters: () => {
        setNicheFilter("all");
        setOwnershipFilter("all");
      },
      resetToDefaults: resetFilters,
    }),
    [snapshot, range, threshold, thresholdSource, nicheDefaultThreshold, activeNiche],
  );

  return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
}

export function useFilters(): FiltersState {
  const context = React.useContext(FiltersContext);
  if (!context) {
    throw new Error("useFilters must be used inside a <FiltersProvider>.");
  }
  return context;
}

/**
 * The threshold to judge one specific channel by.
 *
 * A channel page is reached directly, so there is often no niche selected — and
 * falling back to the account default there would show an RDR channel measured
 * against 1M while the RDR niche defines a hit as 750K. Since a channel carries
 * its own niches, the honest answer is available without the user selecting
 * anything:
 *
 *     explicit override -> selected niche (if this channel is in it)
 *                       -> the channel's own niche -> account default
 *
 * When a channel sits in several niches that disagree on the threshold there is
 * no single right answer, so it falls back to the account default rather than
 * silently picking one. `source` says which rule applied so the UI can label it.
 */
export function useChannelThreshold(
  channelNicheRefs: readonly { id: string }[],
): { threshold: number; source: ThresholdSource; nicheName: string | null } {
  const { threshold, thresholdSource, niche, nicheName, hasThresholdOverride } = useFilters();
  // Channel niche refs are lightweight and carry no threshold, so the
  // configured values come from the dataset — the same cache the provider
  // itself reads, so there is only ever one definition in play.
  const { data } = useDataset();

  const channelNiches = React.useMemo(
    () =>
      channelNicheRefs
        .map((ref) => data?.niches.find((n) => n.id === ref.id))
        .filter((n): n is NonNullable<typeof n> => Boolean(n)),
    [channelNicheRefs, data],
  );

  return React.useMemo(() => {
    // An explicit override, or a selected niche this channel belongs to, is
    // already the right answer from the global filters.
    if (hasThresholdOverride) {
      return { threshold, source: "override" as const, nicheName };
    }
    if (channelNiches.some((n) => n.id === niche)) {
      return { threshold, source: thresholdSource, nicheName };
    }

    // No niche selected (or one this channel is not in): use the channel's own,
    // but only when its niches agree.
    const configured = channelNiches.filter((n) => n.hitThreshold !== null);
    const distinct = new Set(configured.map((n) => n.hitThreshold));
    if (configured.length > 0 && distinct.size === 1) {
      const only = configured[0];
      return {
        threshold: only.hitThreshold as number,
        source: "niche" as const,
        nicheName: configured.length === 1 ? only.name : null,
      };
    }

    return { threshold, source: thresholdSource, nicheName };
  }, [channelNiches, niche, nicheName, threshold, thresholdSource, hasThresholdOverride]);
}
