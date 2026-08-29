import {
  DEFAULT_PERIOD_PRESET,
  DEFAULT_THRESHOLD,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
} from "@/lib/analytics/constants";
import type { PeriodPresetId, PeriodSelection } from "@/lib/analytics/types";

/**
 * Persisted analysis filters, modelled as an external store.
 *
 * Period and threshold live in two places outside React — `localStorage` (so a
 * choice survives a reload) and the URL query string (so a view is shareable).
 * Reading them inside an effect after mount is the usual approach and is
 * exactly what React 19 flags: it sets state synchronously on mount and
 * cascades a second render.
 *
 * Treating them as what they are — an external, mutable, subscribable source —
 * lets `useSyncExternalStore` handle it correctly. The server snapshot is the
 * defaults, so SSR markup and first hydration agree; the stored values are
 * adopted immediately afterwards without a hydration mismatch.
 *
 * Deliberately *not* React Query state and never part of a query key: changing
 * a filter must recompute from data already in memory, never refetch.
 */

/**
 * Which niche the dashboard is scoped to.
 *
 * `"all"` and `"unassigned"` are reserved sentinels; anything else is a niche
 * id. `"unassigned"` earns its place because "I have channels I haven't filed
 * yet" is a real state a user needs to find and fix, and it would otherwise be
 * invisible behind "All Niches".
 */
export type NicheFilter = "all" | "unassigned" | (string & {});

/**
 * Which content type the view is scoped to.
 *
 * The same sentinels as `NicheFilter`, and for the same reasons. A content type
 * is an ORG-WIDE TAG, attached to both channels and Shorts, so this filter is
 * independent of the niche filter — any type may be selected under any niche,
 * and neither one has to move to accommodate the other.
 *
 * IT MEANS SOMETHING SLIGHTLY DIFFERENT ON EACH SURFACE, because the surfaces
 * have different units, and that is deliberate:
 *
 *   • On the CHANNEL LIST it reads the channel's own tags —
 *     `filterRowsByScope` in `src/hooks/use-channel-analytics.ts`. A row's
 *     metrics describe everything that channel published, so narrowing the list
 *     by a per-Short label would put a figure next to a label that did not
 *     describe it.
 *   • On the SHORTS surfaces — Winners, Outliers, the feeds, the Shorts table —
 *     it reads each Short's own classification (`useShortsFeed`), because there
 *     the row genuinely is a Short.
 *
 * `"unassigned"` means "not tagged" in whichever of those two senses applies. It
 * is offered for the same reason as its niche counterpart: things nobody has
 * described are invisible to every other option, and a user who cannot see the
 * gap cannot close it.
 */
export type ContentTypeFilter = "all" | "unassigned" | (string & {});

export type OwnershipFilter = "all" | "own" | "competitor";

export interface FiltersSnapshot {
  readonly period: PeriodSelection;
  /**
   * An explicit hit-threshold override, or `null` to follow the selected
   * niche default (falling back to the account default).
   *
   * Kept separate from the effective threshold so switching niche picks up that
   * niche's configured value automatically. The override is scoped to the niche
   * it was set in: it survives period, sort and ownership changes, but moving to
   * a different niche clears it so that niche's own definition of a hit applies.
   */
  readonly thresholdOverride: number | null;
  readonly niche: NicheFilter;
  readonly contentType: ContentTypeFilter;
  readonly ownership: OwnershipFilter;
  /**
   * Float the user's own channels to the top while keeping them in the same
   * ranked dataset. Off by default: hit rate is the primary sort and grouping
   * by ownership would bury the comparison the product exists to make.
   */
  readonly ownFirst: boolean;
}

// v2: `threshold` changed meaning from "the active threshold" to "an explicit
// override of the niche default". Bumping the key discards v1 state rather than
// silently reinterpreting a stored 1,000,000 as a permanent override that would
// mask every niche default the user configures.
const STORAGE_KEY = "northstar-hq:filters:v2";
const VALID_PRESETS: readonly string[] = ["7d", "30d", "90d", "180d", "custom"];

let serverSnapshot: FiltersSnapshot = {
  period: { preset: DEFAULT_PERIOD_PRESET },
  thresholdOverride: null,
  niche: "all",
  contentType: "all",
  ownership: "all",
  ownFirst: false,
};

const OWNERSHIP_FILTERS: readonly string[] = ["all", "own", "competitor"];

/**
 * Seeds the defaults that the server rendered with, so the server snapshot and
 * the first client render agree. Called once, before hydration.
 */
export function seedDefaults(defaults: { period: PeriodSelection }): void {
  // Object identity must stay stable — getServerSnapshot returning a fresh
  // object each call would make React loop.
  if (serverSnapshot.period.preset === defaults.period.preset) {
    return;
  }
  // Only the analysis defaults come from the server; the view filters (niche,
  // ownership) are always session state and reset to "show everything".
  serverSnapshot = { ...serverSnapshot, ...defaults };
  clientSnapshot = null;
}

let clientSnapshot: FiltersSnapshot | null = null;
const listeners = new Set<() => void>();

export function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_THRESHOLD;
  return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, Math.trunc(value)));
}

/** URL wins over storage: a shared link should show what the sender saw. */
function readFromEnvironment(): FiltersSnapshot {
  let period: PeriodSelection = serverSnapshot.period;
  let thresholdOverride = serverSnapshot.thresholdOverride;
  let niche: NicheFilter = serverSnapshot.niche;
  let contentType: ContentTypeFilter = serverSnapshot.contentType;
  let ownership: OwnershipFilter = serverSnapshot.ownership;
  let ownFirst = serverSnapshot.ownFirst;

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<FiltersSnapshot>;
      if (parsed.period && VALID_PRESETS.includes(parsed.period.preset)) {
        period = parsed.period;
      }
      if (parsed.thresholdOverride === null) {
        thresholdOverride = null;
      } else if (typeof parsed.thresholdOverride === "number") {
        thresholdOverride = clampThreshold(parsed.thresholdOverride);
      }
      if (typeof parsed.niche === "string") niche = parsed.niche;
      // Absent from anything stored before content types existed, which is why
      // this reads defensively rather than bumping the storage key: an old
      // snapshot is still entirely valid, it simply has no opinion here.
      if (typeof parsed.contentType === "string") contentType = parsed.contentType;
      if (typeof parsed.ownership === "string" && OWNERSHIP_FILTERS.includes(parsed.ownership)) {
        ownership = parsed.ownership as OwnershipFilter;
      }
      if (typeof parsed.ownFirst === "boolean") ownFirst = parsed.ownFirst;
    }
  } catch {
    // Corrupt JSON or storage blocked in a private window. Not worth failing a
    // page load over — fall through to the defaults.
  }

  try {
    const params = new URLSearchParams(window.location.search);
    const urlPeriod = params.get("period");
    const urlThreshold = params.get("threshold");
    const urlStart = params.get("start");
    const urlEnd = params.get("end");
    const urlNiche = params.get("niche");
    const urlContentType = params.get("contentType");
    const urlOwnership = params.get("ownership");

    if (urlPeriod && VALID_PRESETS.includes(urlPeriod)) {
      const preset = urlPeriod as PeriodPresetId;
      period =
        preset === "custom"
          ? {
              preset,
              customStartMs: urlStart ? Number(urlStart) : undefined,
              customEndMs: urlEnd ? Number(urlEnd) : undefined,
            }
          : { preset };
    }
    // A `threshold=` param is always an explicit override: it is only ever
    // written when the user chose one, so a shared link reproduces exactly what
    // the sender was looking at.
    if (urlThreshold) {
      const value = Number(urlThreshold);
      if (Number.isFinite(value)) thresholdOverride = clampThreshold(value);
    }
    // A `?niche=` link is how the Niches page navigates into a filtered
    // dashboard, so the URL must win over whatever was last stored.
    if (urlNiche) {
      // Landing on a different niche than the one that was stored discards a
      // carried-over override, for the same reason setNicheFilter does: the new
      // niche's own threshold should apply. An explicit `threshold=` in the same
      // link is a deliberate choice by the sender and still wins.
      if (urlNiche !== niche && !urlThreshold) thresholdOverride = null;
      niche = urlNiche;
    }
    if (urlContentType) contentType = urlContentType;
    if (urlOwnership && OWNERSHIP_FILTERS.includes(urlOwnership)) {
      ownership = urlOwnership as OwnershipFilter;
    }
  } catch {
    /* malformed URL — defaults stand */
  }

  return { period, thresholdOverride, niche, contentType, ownership, ownFirst };
}

function persist(snapshot: FiltersSnapshot): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* storage unavailable — the app works, it just will not remember */
  }

  try {
    const params = new URLSearchParams(window.location.search);
    params.set("period", snapshot.period.preset);
    // Only present when overridden, so the default view keeps a clean URL and
    // niche navigation is not pinned to a stale number.
    if (snapshot.thresholdOverride !== null) {
      params.set("threshold", String(snapshot.thresholdOverride));
    } else {
      params.delete("threshold");
    }
    if (snapshot.period.preset === "custom") {
      if (snapshot.period.customStartMs) {
        params.set("start", String(snapshot.period.customStartMs));
      }
      if (snapshot.period.customEndMs) {
        params.set("end", String(snapshot.period.customEndMs));
      }
    } else {
      params.delete("start");
      params.delete("end");
    }

    // Only write the view filters into the URL when they are actually
    // narrowing something, so a default view keeps a clean, shareable link.
    if (snapshot.niche !== "all") params.set("niche", snapshot.niche);
    else params.delete("niche");

    if (snapshot.contentType !== "all") params.set("contentType", snapshot.contentType);
    else params.delete("contentType");

    if (snapshot.ownership !== "all") params.set("ownership", snapshot.ownership);
    else params.delete("ownership");
    // replaceState, not the Next router: a segmented control should not push a
    // history entry or re-render the route tree on every click.
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  } catch {
    /* history API unavailable */
  }
}

export function subscribeToFilters(listener: () => void): () => void {
  listeners.add(listener);

  // Back/forward changes the URL without re-rendering through React's router,
  // so the store has to hear about it directly for history navigation to
  // restore the right niche and period.
  const onPopState = () => {
    lastSeenSearch = null; // force a re-read on the next getSnapshot
    for (const l of listeners) l();
  };
  window.addEventListener("popstate", onPopState);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", onPopState);
  };
}

/**
 * Forces the next read to re-derive from the URL.
 *
 * Used after a Next client-side route change, where `window.location` is
 * updated without a popstate event ever firing.
 */
export function invalidateFiltersFromUrl(): void {
  lastSeenSearch = null;
  for (const l of listeners) l();
}

/**
 * The query string the cached snapshot was derived from.
 *
 * This is what makes the URL the real source of truth. Without it the snapshot
 * was read exactly once per page load, so navigating from the Niches page to
 * `/?niche=RDR` returned the *previous* niche — and `persist()` then wrote that
 * stale value straight back into the URL, silently undoing the navigation.
 */
let lastSeenSearch: string | null = null;

export function getFiltersSnapshot(): FiltersSnapshot {
  const search = typeof window === "undefined" ? "" : window.location.search;

  // Re-derive whenever the URL changed underneath us — a Next client
  // navigation, a back/forward, or a pasted link. Otherwise return the same
  // object reference, which is what useSyncExternalStore compares to decide
  // nothing changed.
  if (clientSnapshot === null || search !== lastSeenSearch) {
    lastSeenSearch = search;
    clientSnapshot = readFromEnvironment();
  }
  return clientSnapshot;
}

export function getFiltersServerSnapshot(): FiltersSnapshot {
  return serverSnapshot;
}

function commit(next: FiltersSnapshot): void {
  clientSnapshot = next;
  persist(next);
  // persist() rewrites the query string; record it so the next read does not
  // mistake our own write for an external navigation and re-derive.
  lastSeenSearch = typeof window === "undefined" ? null : window.location.search;
  for (const listener of listeners) listener();
}

export function setPeriodPreset(preset: PeriodPresetId): void {
  const current = getFiltersSnapshot();
  commit({ ...current, period: { ...current.period, preset } });
}

export function setCustomRange(startMs: number, endMs: number): void {
  const current = getFiltersSnapshot();
  commit({
    ...current,
    period: { preset: "custom", customStartMs: startMs, customEndMs: endMs },
  });
}

/** Sets an explicit override for the current analysis. */
export function setThreshold(value: number): void {
  commit({ ...getFiltersSnapshot(), thresholdOverride: clampThreshold(value) });
}

/** Drops the override and returns to the niche (or account) default. */
export function clearThresholdOverride(): void {
  commit({ ...getFiltersSnapshot(), thresholdOverride: null });
}

export function setNicheFilter(niche: NicheFilter): void {
  const current = getFiltersSnapshot();
  if (current.niche === niche) return;
  // A threshold override is scoped to the niche it was made in. Carrying it
  // across a niche switch would mean selecting a niche no longer applies that
  // niche's own definition of a hit — so moving to a different niche drops the
  // override and falls back to that niche's default.
  commit({ ...current, niche, thresholdOverride: null });
}

/**
 * Sets the content-type scope.
 *
 * Unlike `setNicheFilter`, this does not touch the threshold override. A niche
 * carries its own definition of a hit, so switching niche has to drop an
 * override made under the previous one; a content type has no threshold of its
 * own and never will — what counts as a hit is a property of the audience, not
 * of the format — so there is nothing here for an override to contradict.
 */
export function setContentTypeFilter(contentType: ContentTypeFilter): void {
  const current = getFiltersSnapshot();
  if (current.contentType === contentType) return;
  commit({ ...current, contentType });
}

export function setOwnershipFilter(ownership: OwnershipFilter): void {
  commit({ ...getFiltersSnapshot(), ownership });
}

export function setOwnFirst(ownFirst: boolean): void {
  commit({ ...getFiltersSnapshot(), ownFirst });
}

export function resetFilters(): void {
  commit(serverSnapshot);
}
