"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { DatasetDTO, OwnershipType } from "@/lib/dto";
import type { NicheFormat } from "@/lib/niches/niche-format";
import { useDatasetFormat } from "./dataset-format-context";

/**
 * The dataset query key PREFIX.
 *
 * Deliberately constant, and deliberately a prefix now rather than the whole
 * key: the two formats are two different payloads and cache under
 * `["dataset", format]`, while every mutation keeps invalidating this prefix —
 * React Query prefix-matches, so one invalidation reaches both formats and no
 * mutation hook had to learn the word "format". Period and threshold are still
 * *not* part of any key, so no filter change can cause a fetch — the guarantee
 * the product requires, made structural rather than conventional.
 */
export const DATASET_KEY = ["dataset"] as const;

export function useDataset(format?: NicheFormat) {
  // The subtree's format when the caller states none — which is every
  // existing call site. Under a Shorts page (or outside any provider) the
  // context answers "shorts", so bare calls mean exactly what they always
  // meant; under the /longform layout the same components read the Long Form
  // payload with no prop threading anywhere.
  const contextFormat = useDatasetFormat();
  const effective = format ?? contextFormat;
  return useQuery<DatasetDTO>({
    queryKey: [...DATASET_KEY, effective] as const,
    queryFn: () => api.getDataset(effective),
  });
}

/** Force the next read to come from the server (after a refresh or an edit). */
export function useInvalidateDataset() {
  const queryClient = useQueryClient();
  return React.useCallback(
    () => queryClient.invalidateQueries({ queryKey: DATASET_KEY }),
    [queryClient],
  );
}

export function useAddChannel() {
  const invalidate = useInvalidateDataset();
  return useMutation({
    mutationFn: (payload: {
      input: string;
      ownershipType?: OwnershipType;
      nicheIds?: readonly string[];
    }) => api.addChannel(payload),
    onSuccess: () => invalidate(),
  });
}

export function useRefreshChannel() {
  const invalidate = useInvalidateDataset();
  return useMutation({
    mutationFn: (id: string) => api.refreshChannel(id),
    onSuccess: () => invalidate(),
  });
}

export function useRefreshAll() {
  const invalidate = useInvalidateDataset();
  return useMutation({
    mutationFn: (force: boolean = false) => api.refreshAll(force),
    onSuccess: () => invalidate(),
  });
}

export function useRemoveChannel() {
  const invalidate = useInvalidateDataset();
  return useMutation({
    mutationFn: (id: string) => api.removeChannel(id),
    onSuccess: () => invalidate(),
  });
}

export function useRestoreChannel() {
  const invalidate = useInvalidateDataset();
  return useMutation({
    mutationFn: (id: string) => api.restoreChannel(id),
    onSuccess: () => invalidate(),
  });
}

export function useRenameChannel() {
  const invalidate = useInvalidateDataset();
  return useMutation({
    mutationFn: ({ id, label }: { id: string; label: string | null }) =>
      api.renameChannel(id, label),
    onSuccess: () => invalidate(),
  });
}
