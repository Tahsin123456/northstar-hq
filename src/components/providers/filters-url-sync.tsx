"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { defaultFiltersStore, type FiltersStore } from "@/lib/filters-store";

/**
 * Keeps a filters store in step with client-side navigations.
 *
 * The store derives its snapshot from `window.location.search`, and re-reads
 * whenever that string changes. That covers a reload, a pasted link and
 * back/forward (via popstate). It does *not* cover a Next `<Link>` navigation
 * into the same layout — clicking a niche on the Niches page — because the
 * layout that holds the provider never re-renders, so nothing ever asks the
 * store for a fresh snapshot.
 *
 * This component lives inside the provider, subscribes to the search params,
 * and nudges the store when they change. It renders nothing.
 *
 * Without it, navigating to `/?niche=RDR` kept showing the previously selected
 * niche and then wrote that stale value back into the URL.
 *
 * WHICH STORE IS A PROP NOW: there are two instances — the Shorts singleton
 * and the Long Form one — and each provider mounts its own sync bound to its
 * own store. The default is the Shorts store, so the existing mount in the app
 * layout keeps meaning what it always meant.
 */
function FiltersUrlSyncInner({ store }: { store: FiltersStore }) {
  const searchParams = useSearchParams();
  const search = searchParams.toString();

  React.useEffect(() => {
    // Synchronising React with an external system (the URL) on navigation —
    // exactly what effects are for.
    store.invalidateFiltersFromUrl();
  }, [search, store]);

  return null;
}

export function FiltersUrlSync({ store = defaultFiltersStore }: { store?: FiltersStore }) {
  // useSearchParams needs a Suspense boundary; it has nothing to render, so an
  // empty fallback is correct rather than a placeholder.
  return (
    <React.Suspense fallback={null}>
      <FiltersUrlSyncInner store={store} />
    </React.Suspense>
  );
}
