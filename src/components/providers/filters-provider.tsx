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
  setContentTypeFilter,
  setCustomRange,
  setNicheFilter,
  setOwnFirst,
  setOwnershipFilter,
  setPeriodPreset,
  setThreshold,
  subscribeToFilters,
  type ContentTypeFilter,
  type NicheFilter,
  type OwnershipFilter,
} from "@/lib/filters-store";

/**
 * Global analysis filters: which period, which niche, and what counts as a hit.
 *
 * THRESHOLD RESOLUTION
 * `threshold` is *derived*, not stored:
 *
 *     explicit override  ->  the selected niche's own threshold
 *                        ->  the organization default, but ONLY when no niche
 *                            is selected
 *
 * That ordering is what makes niche-specific thresholds work without touching
 * a single consumer. Every screen already reads `threshold` from this context,
 * so selecting RDR switches the whole app to RDR's 750K automatically — hit
 * rate, charts, Winners, Outliers, Our vs Market and the PDF included — and
 * there is no way for one surface to be looking at a different number than
 * another.
 *
 * WHY THE CHAIN STOPS AT A SELECTED NICHE
 * It used to read `override ?? nicheDefault ?? accountDefault`, so selecting a
 * niche nobody had configured silently borrowed the organization's 1,000,000
 * and the app printed a hit rate against it. That number looks identical to one
 * somebody chose, and it is not: it is the app guessing and then presenting the
 * guess as a measurement. So a *selected* niche with no threshold now resolves
 * to `threshold: null` / `thresholdSource: "unconfigured"`, and every consumer
 * renders "Not configured" instead of a figure.
 *
 * "All niches" is a different case and deliberately unaffected. With no niche
 * selected the organization default is the team's own deliberately-set number,
 * not a fallback — so it stays, and hit rates go on being reported.
 *
 * An override still wins over everything, including an unconfigured niche: that
 * is a number a person typed on purpose, on this screen, just now.
 *
 * The override is deliberately transient state rather than a write to the
 * niche: experimenting with 1M on an RDR view should not silently reconfigure
 * the niche for everyone tomorrow. Saving is an explicit, separate action.
 *
 * SCOPE
 * Niche, content type and ownership are three independent narrowings. They used
 * to be two-and-a-half — a content type belonged to a niche, so the pair had to
 * be reconciled — but a content type is an org-wide tag again and any of them
 * may be combined with any other.
 *
 * None of this enters a query key, so changing any of it recomputes from data
 * already in memory and issues no request.
 */

/**
 * Where the active threshold came from.
 *
 * `"unconfigured"` is not a source of a number — it is the honest absence of
 * one, and it travels beside `threshold: null` so a consumer cannot read the
 * figure without also having been told there isn't one.
 */
export type ThresholdSource = "override" | "niche" | "account" | "unconfigured";

interface FiltersState {
  readonly period: PeriodSelection;
  /**
   * The effective threshold every analytic should use, or `null` when the
   * selected niche has none configured.
   *
   * Nullable rather than "defaulted" on purpose: the type is what stops a new
   * screen from reintroducing `?? DEFAULT_THRESHOLD` without noticing.
   */
  readonly threshold: number | null;
  /** Where that number came from, so the UI can label it honestly. */
  readonly thresholdSource: ThresholdSource;
  /** Shorthand for `thresholdSource !== "unconfigured"`, for readability. */
  readonly isThresholdConfigured: boolean;
  /** The selected niche's configured threshold, if it has one. */
  readonly nicheDefaultThreshold: number | null;
  /** Display name of the active niche, for threshold labelling. */
  readonly nicheName: string | null;
  /** The selected niche's id, or null for "all"/"unassigned". */
  readonly nicheId: string | null;
  readonly hasThresholdOverride: boolean;

  /** Recomputed on a timer so "last 30 days" does not drift over a long session. */
  readonly range: DateRange;

  readonly niche: NicheFilter;
  readonly contentType: ContentTypeFilter;
  /** Display name of the active content type, for labelling. */
  readonly contentTypeName: string | null;
  readonly ownership: OwnershipFilter;
  readonly ownFirst: boolean;
  readonly hasScopeFilter: boolean;

  readonly setPeriodPreset: (preset: PeriodPresetId) => void;
  readonly setCustomRange: (startMs: number, endMs: number) => void;
  readonly setThreshold: (threshold: number) => void;
  readonly clearThresholdOverride: () => void;
  readonly setNiche: (niche: NicheFilter) => void;
  readonly setContentType: (contentType: ContentTypeFilter) => void;
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

  // Resolved from the catalogue the dataset already ships, and deliberately
  // including archived types: a link carrying `?contentType=` for a type that
  // has since been retired should still say which one, not fall back to "All".
  const activeContentType = React.useMemo(() => {
    if (snapshot.contentType === "all" || snapshot.contentType === "unassigned") return null;
    return data?.contentTypes.find((type) => type.id === snapshot.contentType) ?? null;
  }, [data, snapshot.contentType]);

  /*
   * NICHE AND CONTENT TYPE ARE TWO INDEPENDENT NARROWINGS AGAIN.
   *
   * There used to be a `reconcileScope` pass here — a whole pure function with
   * its own test file — whose job was to stop the pair reaching a state the
   * Type menu could not show: a content type belonged to exactly one niche, so
   * "GTA + Red Dead's Character Moments" was an empty intersection for a reason
   * nothing on screen explained.
   *
   * Content types are org-wide tags now. Every type is offered under every
   * niche, so there is no incoherent pair left to reconcile, and the whole
   * mechanism is gone rather than kept as a no-op. `setNiche` is the store's
   * setter directly, and a `?contentType=` link no longer has to move somebody's
   * niche filter to make its own selection visible.
   */
  const setNiche = setNicheFilter;

  const nicheDefaultThreshold = activeNiche?.hitThreshold ?? null;

  // A niche is "selected" for this purpose only when it resolves to a real row.
  // "All niches" and "Uncategorised" are both organization-wide views, where the
  // organization default is the right and deliberate answer.
  const hasSelectedNiche = activeNiche !== null;

  const { threshold, thresholdSource } = React.useMemo<{
    threshold: number | null;
    thresholdSource: ThresholdSource;
  }>(() => {
    // An override is a number a person typed on this screen. It outranks
    // everything, including a niche nobody has configured.
    if (snapshot.thresholdOverride !== null) {
      return { threshold: snapshot.thresholdOverride, thresholdSource: "override" };
    }
    if (nicheDefaultThreshold !== null) {
      return { threshold: nicheDefaultThreshold, thresholdSource: "niche" };
    }
    // The one case the old `??` chain got wrong: a selected niche with nothing
    // configured. Borrowing the organization default here is what made the app
    // report a hit rate nobody had defined.
    if (hasSelectedNiche) {
      return { threshold: null, thresholdSource: "unconfigured" };
    }
    return { threshold: defaultThreshold, thresholdSource: "account" };
  }, [snapshot.thresholdOverride, nicheDefaultThreshold, hasSelectedNiche, defaultThreshold]);

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
      isThresholdConfigured: thresholdSource !== "unconfigured",
      nicheDefaultThreshold,
      nicheName: activeNiche?.name ?? null,
      nicheId: activeNiche?.id ?? null,
      hasThresholdOverride: snapshot.thresholdOverride !== null,
      range,
      niche: snapshot.niche,
      contentType: snapshot.contentType,
      contentTypeName: activeContentType?.name ?? null,
      ownership: snapshot.ownership,
      ownFirst: snapshot.ownFirst,
      hasScopeFilter:
        snapshot.niche !== "all" ||
        snapshot.contentType !== "all" ||
        snapshot.ownership !== "all",
      setPeriodPreset,
      setCustomRange,
      setThreshold,
      clearThresholdOverride,
      setNiche,
      setContentType: setContentTypeFilter,
      setOwnership: setOwnershipFilter,
      setOwnFirst,
      clearScopeFilters: () => {
        setNicheFilter("all");
        setContentTypeFilter("all");
        setOwnershipFilter("all");
      },
      resetToDefaults: resetFilters,
    }),
    [
      snapshot,
      range,
      threshold,
      thresholdSource,
      nicheDefaultThreshold,
      activeNiche,
      activeContentType,
      setNiche,
    ],
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
 *
 * The unconfigured state reaches this hook through the first two rules and no
 * others: if the user has *selected* a niche this channel belongs to and that
 * niche has no threshold, the page says "Not configured" like every other
 * screen. With no niche selected, the channel's own configured niches still
 * answer, and the organization default remains the legitimate last resort —
 * "no niche selected" is not the unconfigured case.
 */
export function useChannelThreshold(
  channelNicheRefs: readonly { id: string }[],
): { threshold: number | null; source: ThresholdSource; nicheName: string | null } {
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
