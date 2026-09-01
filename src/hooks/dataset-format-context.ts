"use client";

import * as React from "react";
import type { NicheFormat } from "@/lib/niches/niche-format";

/**
 * Which format's dataset the CURRENT SUBTREE is about.
 *
 * The dataset now exists once per format, and dozens of components — save
 * buttons, note dialogs, content-type controls, the filters provider's own
 * threshold resolution — call a bare `useDataset()`. Teaching each of them a
 * `format` prop would be churn on every Shorts surface for the benefit of
 * none of them; instead the provider that already knows the answer (the
 * `FiltersProvider` mounted by the layout) publishes it here, and
 * `useDataset()` reads it as its default.
 *
 * ITS OWN MODULE rather than a field on the filters context, because
 * `use-dataset.ts` must read it and `filters-provider.tsx` must write it —
 * and the provider imports the hook, so putting the context in either file
 * would be a cycle.
 *
 * The default is "shorts": outside any provider — and under every existing
 * Shorts page — a bare `useDataset()` means exactly what it always meant.
 */
export const DatasetFormatContext = React.createContext<NicheFormat>("shorts");

/** The subtree's dataset format — "shorts" anywhere nothing says otherwise. */
export function useDatasetFormat(): NicheFormat {
  return React.useContext(DatasetFormatContext);
}
