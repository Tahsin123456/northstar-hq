"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { NoteTargetType, NoteVisibility } from "@/lib/dto";
import type { SavedShortsQuery } from "@/server/services/research-service";
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

/**
 * What a create call may say. Same union as the route's schema — see
 * `api.createNote`.
 */
export type CreateNotePayload =
  | {
      targetType: NoteTargetType;
      targetId: string;
      body: string;
      visibility?: NoteVisibility;
      /** A pasted YouTube link; the server turns it into the stored URL. */
      externalShortUrl?: string | null;
    }
  | {
      targetType: "general";
      body: string;
      visibility?: NoteVisibility;
      externalShortUrl?: string | null;
    };

export function useCreateNote() {
  const invalidate = useInvalidateNotes();
  return useMutation({
    mutationFn: (payload: CreateNotePayload) => api.createNote(payload),
    onSuccess: () => invalidate(),
  });
}

/**
 * Edit a note's text, its visibility, the Short it quotes, or any of them.
 *
 * One mutation for all of them because they are one row and one endpoint — and
 * because sharing a note changes who its list is for, so it has to invalidate
 * exactly what an edit does. A patch with no fields at all is refused
 * server-side rather than silently touching `updatedAt`.
 *
 * `externalShortUrl: null` is how a link is REMOVED. It has to be sent
 * explicitly, because leaving the key out is already how a caller says "I am
 * not touching the link" — the two cannot share a spelling.
 */
export function useUpdateNote() {
  const invalidate = useInvalidateNotes();
  return useMutation({
    mutationFn: ({
      id,
      ...patch
    }: {
      id: string;
      body?: string;
      visibility?: NoteVisibility;
      externalShortUrl?: string | null;
    }) => api.updateNote(id, patch),
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

// ---------------------------------------------------------------------------
// Saved Shorts
// ---------------------------------------------------------------------------

/**
 * Prefix key for the saved-Shorts board. Invalidating it matches every
 * filter combination currently cached, which is the point: a save made from
 * Winners must not leave a filtered Saved page asserting the old answer.
 */
export const SAVED_KEY = ["saved"] as const;

/**
 * The board, narrowed and ordered BY THE SERVER.
 *
 * ==========================================================================
 * WHY THIS IS A REQUEST AND NOT A `.filter()` OVER THE DATASET
 * ==========================================================================
 * The dataset payload still carries `savedShorts`, and the feeds still read it
 * to decide which cards show a filled bookmark — that is a question about the
 * viewer's own saves and it needs no request. This is the other question. An
 * admin's board holds the whole team's shortlists, so "Hana's saves, last 30
 * days" is a question ABOUT WHICH ROWS ARE SENT. Answering it in the browser
 * would mean shipping everybody's library and hiding most of it, which is the
 * exact shape of the ownership bug this area already had once.
 *
 * The parameters cannot widen the answer — `listSavedShorts` ANDs them with the
 * ownership filter — so naming a colleague only ever narrows.
 *
 * `placeholderData` keeps the previous rows on screen while the next answer is
 * in flight, so changing a filter dims the board instead of blanking it.
 */
export function useSavedShorts(query: SavedShortsQuery = {}) {
  return useQuery({
    queryKey: [...SAVED_KEY, query],
    queryFn: () => api.listSaved(query),
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });
}

/**
 * Refresh the board and the dataset together.
 *
 * Both, always. The board is its own request now, but `savedShorts` is still in
 * the dataset payload behind every bookmark icon in Winners and Outliers —
 * refreshing one and not the other is how a Short comes back unsaved on one
 * screen and saved on the next.
 */
function useInvalidateSaved() {
  const queryClient = useQueryClient();
  const invalidateDataset = useInvalidateDataset();
  return React.useCallback(
    async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: SAVED_KEY }),
        invalidateDataset(),
      ]);
    },
    [queryClient, invalidateDataset],
  );
}

/*
 * The collection mutations invalidate the board too, and not out of caution:
 * deleting a collection drops its rows' membership, so `collectionIds` on a
 * saved row changes without the save itself being touched. Renaming one changes
 * the text the row prints. Both are the board going stale from a write nobody
 * made against it.
 */
export function useCreateCollection() {
  const invalidate = useInvalidateSaved();
  return useMutation({
    mutationFn: (name: string) => api.createCollection(name),
    onSuccess: () => invalidate(),
  });
}

export function useRenameCollection() {
  const invalidate = useInvalidateSaved();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameCollection(id, name),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteCollection() {
  const invalidate = useInvalidateSaved();
  return useMutation({
    mutationFn: (id: string) => api.deleteCollection(id),
    onSuccess: () => invalidate(),
  });
}

export function useSaveShort() {
  const invalidate = useInvalidateSaved();
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
  const invalidate = useInvalidateSaved();
  return useMutation({
    mutationFn: (videoId: string) => api.unsaveShort(videoId),
    onSuccess: () => invalidate(),
  });
}

/**
 * Removes a save whose owner's account is gone.
 *
 * Separate from `useUnsaveShort` because the two address different things — a
 * video for your own save, a row id for one that belongs to nobody — and
 * collapsing them would put a nullable owner in the middle of the one call
 * every card on every board makes.
 */
export function useRemoveOrphanedSave() {
  const invalidate = useInvalidateSaved();
  return useMutation({
    mutationFn: (savedShortId: string) => api.removeOrphanedSave(savedShortId),
    onSuccess: () => invalidate(),
  });
}

export function useSetSavedCollections() {
  const invalidate = useInvalidateSaved();
  return useMutation({
    mutationFn: ({ videoId, collectionIds }: { videoId: string; collectionIds: string[] }) =>
      api.setSavedCollections(videoId, collectionIds),
    onSuccess: () => invalidate(),
  });
}
