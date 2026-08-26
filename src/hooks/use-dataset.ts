"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { DatasetDTO, OwnershipType } from "@/lib/dto";

/**
 * The dataset query key.
 *
 * Deliberately constant. Period and threshold are *not* part of it, so no
 * change to either can invalidate the cache or cause a fetch — the guarantee
 * the product requires, made structural rather than conventional.
 */
export const DATASET_KEY = ["dataset"] as const;

export function useDataset() {
  return useQuery<DatasetDTO>({
    queryKey: DATASET_KEY,
    queryFn: api.getDataset,
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
