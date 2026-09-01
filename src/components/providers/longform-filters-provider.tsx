"use client";

import * as React from "react";
import { FiltersProvider } from "@/components/providers/filters-provider";
import { FiltersUrlSync } from "@/components/providers/filters-url-sync";
import { longformFiltersStore } from "@/lib/filters-store";
import type { PeriodSelection } from "@/lib/analytics/types";

/**
 * The Long Form pages' filter state, as one client component the /longform
 * layout can mount.
 *
 * A SECOND `FiltersProvider` INSTANCE, INSIDE THE SHORTS ONE. The app shell's
 * provider wraps every authenticated route, /longform included; this one
 * shadows its context for the subtree, so everything under /longform reads
 * Long Form filters and the Long Form dataset while the shell around it (the
 * sidebar, the header) keeps reading the outer one. Shadowing works because
 * the two providers are backed by two real store instances — the refactor in
 * `filters-store.ts` — not two keys over one module's state.
 *
 * ITS OWN `FiltersUrlSync`, bound to its own store: the sync mounted in the
 * app layout nudges only the Shorts store, and a `?niche=` link into
 * /longform/… has to reach this one.
 */
export function LongformFiltersProvider({
  children,
  defaultThreshold,
  defaultPeriod,
}: {
  children: React.ReactNode;
  defaultThreshold: number;
  defaultPeriod: PeriodSelection;
}) {
  return (
    <FiltersProvider
      store={longformFiltersStore}
      format="longform"
      defaultThreshold={defaultThreshold}
      defaultPeriod={defaultPeriod}
    >
      <FiltersUrlSync store={longformFiltersStore} />
      {children}
    </FiltersProvider>
  );
}
