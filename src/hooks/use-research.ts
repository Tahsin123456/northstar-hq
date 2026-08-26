"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { NoteTargetType } from "@/lib/dto";
import { useInvalidateDataset } from "./use-dataset";

/**
 * Note mutations must refresh both the per-target list and the aggregated
 * Notes page, or a note edited on a channel page would still read stale in the
 * research log.
 */
function useInvalidateNotes() {
  const queryClient = useQueryClient();
  const invalidateDataset = useInvalidateDataset();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["notes"] }),
      invalidateDataset(),
    ]);
  };
}

/**
 * Research-layer mutations: notes, collections and saved Shorts.
 *
 * Every mutation invalidates the dataset, which is the single payload the whole
 * client reads. Saving a Short therefore updates the Winners feed, the Outliers
 * list, the Saved page and the channel table together — there is no per-screen
 * cache to keep in step.
 */

export function useNotes(targetType: NoteTargetType, targetId: string, enabled = true) {
  return useQuery({
    queryKey: ["notes", targetType, targetId],
    queryFn: () => api.listNotes(targetType, targetId),
    enabled: enabled && Boolean(targetId),
    staleTime: 60_000,
  });
}

export function useCreateNote() {
  const invalidate = useInvalidateNotes();
  return useMutation({
    mutationFn: (payload: { targetType: NoteTargetType; targetId: string; body: string }) =>
      api.createNote(payload),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateNote() {
  const invalidate = useInvalidateNotes();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) => api.updateNote(id, body),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteNote() {
  const invalidate = useInvalidateNotes();
  return useMutation({
    mutationFn: (id: string) => api.deleteNote(id),
    onSuccess: () => invalidate(),
  });
}

export function useCreateCollection() {
  const invalidate = useInvalidateDataset();
  return useMutation({
    mutationFn: (name: string) => api.createCollection(name),
    onSuccess: () => invalidate(),
  });
}

export function useRenameCollection() {
  const invalidate = useInvalidateDataset();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameCollection(id, name),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteCollection() {
  const invalidate = useInvalidateDataset();
  return useMutation({
    mutationFn: (id: string) => api.deleteCollection(id),
    onSuccess: () => invalidate(),
  });
}

export function useSaveShort() {
  const invalidate = useInvalidateDataset();
  return useMutation({
    mutationFn: (payload: {
      videoId: string;
      channelMedianAtSave?: number | null;
      outlierMultipleAtSave?: number | null;
      collectionIds?: readonly string[];
    }) => api.saveShort(payload),
    onSuccess: () => invalidate(),
  });
}

export function useUnsaveShort() {
  const invalidate = useInvalidateDataset();
  return useMutation({
    mutationFn: (videoId: string) => api.unsaveShort(videoId),
    onSuccess: () => invalidate(),
  });
}

export function useSetSavedCollections() {
  const invalidate = useInvalidateDataset();
  return useMutation({
    mutationFn: ({ videoId, collectionIds }: { videoId: string; collectionIds: string[] }) =>
      api.setSavedCollections(videoId, collectionIds),
    onSuccess: () => invalidate(),
  });
}
