"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { OwnershipType } from "@/lib/dto";
import { useInvalidateDataset } from "./use-dataset";

/**
 * Niche and ownership mutations.
 *
 * Each invalidates the dataset, which is the single source the whole client
 * reads from — so creating a niche or flipping a channel to "own" updates the
 * filter menus, the table, the Niches page and Compare together, with no
 * per-screen cache to keep in step.
 */

/**
 * The niche catalogue on its own, for screens that need the list without the
 * tracker.
 *
 * Everywhere else reads niches out of `useDataset`, which is right when the page
 * is already showing channels and videos. Admin › Employees is not: it wants the
 * names and colours of ~10 niches to draw an assignment checklist, and pulling
 * every channel's full view history to get them would be a heavy fetch for a
 * screen that renders none of it. `/api/niches` sits behind `analytics.view`,
 * which the Admin role carries along with everything else.
 */
export const NICHES_KEY = ["niches"] as const;

export function useNicheList() {
  return useQuery({
    queryKey: NICHES_KEY,
    queryFn: api.listNiches,
  });
}

/**
 * Invalidates both readers of the catalogue.
 *
 * Anything that adds, renames, retires or re-thresholds a niche changes the
 * dataset AND the standalone list above. Refreshing only the first would leave
 * the assignment checklist offering a niche that no longer exists, or a name
 * nobody uses any more, for as long as its cache stayed fresh.
 */
function useInvalidateNicheCatalogue() {
  const invalidateDataset = useInvalidateDataset();
  const queryClient = useQueryClient();
  return React.useCallback(() => {
    void invalidateDataset();
    void queryClient.invalidateQueries({ queryKey: NICHES_KEY });
  }, [invalidateDataset, queryClient]);
}

/**
 * Takes a payload rather than a bare name, because an Admin creating a niche
 * may set its hit threshold in the same step.
 *
 * Callers without `settings.manage` pass `{ name }` and nothing else — the
 * field is not merely hidden from them, it is absent from the request, which is
 * what makes the server's refusal a real boundary rather than a formality.
 */
export function useCreateNiche() {
  const invalidate = useInvalidateNicheCatalogue();
  return useMutation({
    mutationFn: (payload: { name: string; hitThreshold?: number }) =>
      api.createNiche(payload),
    onSuccess: () => invalidate(),
  });
}

export function useRenameNiche() {
  const invalidate = useInvalidateNicheCatalogue();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameNiche(id, name),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateNicheThreshold() {
  const invalidate = useInvalidateNicheCatalogue();
  return useMutation({
    mutationFn: ({ id, hitThreshold }: { id: string; hitThreshold: number | null }) =>
      api.setNicheThreshold(id, hitThreshold),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteNiche() {
  const invalidate = useInvalidateNicheCatalogue();
  return useMutation({
    mutationFn: (id: string) => api.deleteNiche(id),
    onSuccess: () => invalidate(),
  });
}

export function useSetChannelNiches() {
  const invalidate = useInvalidateDataset();
  return useMutation({
    mutationFn: ({ channelId, nicheIds }: { channelId: string; nicheIds: string[] }) =>
      api.setChannelNiches(channelId, nicheIds),
    onSuccess: () => invalidate(),
  });
}

export function useSetChannelOwnership() {
  const invalidate = useInvalidateDataset();
  return useMutation({
    mutationFn: ({
      channelId,
      ownershipType,
    }: {
      channelId: string;
      ownershipType: OwnershipType;
    }) => api.setChannelOwnership(channelId, ownershipType),
    onSuccess: () => invalidate(),
  });
}
