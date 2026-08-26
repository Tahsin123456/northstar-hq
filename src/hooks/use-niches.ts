"use client";

import { useMutation } from "@tanstack/react-query";
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

export function useCreateNiche() {
  const invalidate = useInvalidateDataset();
  return useMutation({
    mutationFn: (name: string) => api.createNiche(name),
    onSuccess: () => invalidate(),
  });
}

export function useRenameNiche() {
  const invalidate = useInvalidateDataset();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameNiche(id, name),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateNicheThreshold() {
  const invalidate = useInvalidateDataset();
  return useMutation({
    mutationFn: ({ id, hitThreshold }: { id: string; hitThreshold: number | null }) =>
      api.setNicheThreshold(id, hitThreshold),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteNiche() {
  const invalidate = useInvalidateDataset();
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
