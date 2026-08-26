"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { invalidateFiltersFromUrl } from "@/lib/filters-store";

/**
 * Keeps the filters store in step with client-side navigations.
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
 */
function FiltersUrlSyncInner() {
  const searchParams = useSearchParams();
  const search = searchParams.toString();

  React.useEffect(() => {
    // Synchronising React with an external system (the URL) on navigation —
    // exactly what effects are for.
    invalidateFiltersFromUrl();
  }, [search]);

  return null;
}

export function FiltersUrlSync() {
  // useSearchParams needs a Suspense boundary; it has nothing to render, so an
  // empty fallback is correct rather than a placeholder.
  return (
    <React.Suspense fallback={null}>
      <FiltersUrlSyncInner />
    </React.Suspense>
  );
}
