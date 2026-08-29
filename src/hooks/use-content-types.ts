"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ContentTypeDTO, DatasetDTO } from "@/lib/dto";
import { DATASET_KEY, useDataset, useInvalidateDataset } from "./use-dataset";

/**
 * Content types — catalogue reads, assignment writes, and the client-side index
 * that lets any surface render a Short's labels.
 *
 * ONE FLAT CATALOGUE. A content type is an org-wide tag, so there is no
 * per-niche narrowing anywhere in this file and no "which types may this Short
 * take?" to derive: the answer is the organization's active types, the same
 * array for every Short in the tracker.
 *
 * WHY ASSIGNMENT PATCHES THE CACHE INSTEAD OF INVALIDATING IT
 *
 * Every other mutation in this app invalidates `["dataset"]` and lets the next
 * render refetch. That is right for things that happen once per channel — a
 * rename, an ownership flip — and wrong for this one. Filing Shorts is a
 * RAPID, REPEATED gesture: a director works down a table classifying twenty
 * Shorts in twenty clicks, and re-downloading every channel's entire view
 * history twenty times would make the fastest control in the product the
 * slowest.
 *
 * So the writes below apply the server's own answer to the cached dataset in
 * place. This is not an optimistic guess: `PUT /api/videos/:id/content-types`
 * echoes back exactly what it stored, and the bulk endpoint's outcome is
 * deterministic ("add" unions, "replace" leaves exactly one). The usage counts
 * on the catalogue are adjusted by the same delta, so nothing on screen can
 * drift out of step with what was written.
 *
 * The CHANNEL-level write is the exception and invalidates like the niche
 * assignment it sits beside: it happens once per channel from a dialog, not
 * dozens of times from a table, so there is no gesture to keep fast.
 *
 * It also happens to be the behaviour the rest of the app promises: the dataset
 * is held in memory and re-sliced client-side, and a content type assignment is
 * no more a reason to hit the network again than moving the threshold slider.
 */

/**
 * The standalone catalogue read, keyed by its arguments.
 *
 * Archived types are part of the answer for the management screen and are not
 * for a picker, and a search is a genuinely different response again — so each
 * is its own cache entry rather than one entry the caller filters, which would
 * make "did this include archived?" depend on who fetched first.
 */
export const CONTENT_TYPES_KEY = ["content-types"] as const;

export function useContentTypeCatalogue(
  options: { includeInactive?: boolean; search?: string } = {},
) {
  const includeInactive = options.includeInactive ?? false;
  const search = options.search?.trim() ?? "";

  return useQuery({
    queryKey: [...CONTENT_TYPES_KEY, { includeInactive, search }] as const,
    queryFn: () => api.listContentTypes({ includeInactive, search }),
  });
}

/**
 * Refreshes the management screen's own read.
 *
 * That query is the only place usage counts are fetched rather than derived, so
 * it is invalidated after anything that could move them — and refetches only if
 * somebody is actually looking at it.
 */
function useInvalidateCatalogueCounts() {
  const queryClient = useQueryClient();
  return React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: CONTENT_TYPES_KEY });
  }, [queryClient]);
}

// ---------------------------------------------------------------------------
// Catalogue mutations
//
// These patch the dataset's copy of the catalogue rather than invalidating it,
// for one reason beyond speed: creating a type inline and immediately filing a
// Short under it is a single gesture in the assignment popover. If the create
// kicked off a dataset refetch, that refetch could be answered from BEFORE the
// assignment and land after it, quietly undoing the very thing the user just
// did. Patching removes the race rather than narrowing it.
// ---------------------------------------------------------------------------

export function useCreateContentType() {
  const queryClient = useQueryClient();
  const invalidateCounts = useInvalidateCatalogueCounts();
  return useMutation({
    // A name and nothing else. There is one catalogue, so there is no
    // destination to choose.
    mutationFn: ({ name }: { name: string }) => api.createContentType(name),
    onSuccess: ({ contentType }) => {
      patchCatalogue(queryClient, { upsert: contentType });
      invalidateCounts();
    },
  });
}

export function useRenameContentType() {
  const queryClient = useQueryClient();
  const invalidateCounts = useInvalidateCatalogueCounts();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.renameContentType(id, name),
    // A rename has to reach the dataset: every chip in the app resolves its
    // label through `DatasetDTO.contentTypes`, so a stale copy there would go
    // on showing the old name on the Shorts table until something else
    // happened to refetch.
    onSuccess: ({ contentType }) => {
      patchCatalogue(queryClient, { upsert: contentType });
      invalidateCounts();
    },
  });
}

export function useSetContentTypeActive() {
  const queryClient = useQueryClient();
  const invalidateCounts = useInvalidateCatalogueCounts();
  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.setContentTypeActive(id, isActive),
    onSuccess: ({ contentType }) => {
      patchCatalogue(queryClient, { upsert: contentType });
      invalidateCounts();
    },
  });
}

export function useDeleteContentType() {
  const queryClient = useQueryClient();
  const invalidateCounts = useInvalidateCatalogueCounts();
  return useMutation({
    mutationFn: (id: string) => api.deleteContentType(id),
    // No assignments to clean up: the server only ever deletes a type nothing
    // references, so removing the catalogue entry cannot leave a dangling id on
    // a video or a channel.
    onSuccess: (_result, id) => {
      patchCatalogue(queryClient, { removeId: id });
      invalidateCounts();
    },
  });
}

/**
 * Reordering the catalogue.
 *
 * Sends the COMPLETE set of ids — the server refuses a partial order rather
 * than inventing positions for what it was not sent, so a caller that hides
 * archived types still has to include them, in whatever positions they
 * currently occupy.
 *
 * Patches the dataset with the returned rows rather than invalidating, for the
 * same reason as every other catalogue mutation here: the order is what several
 * menus render in, and a refetch of every channel's view history to move one
 * row up is an absurd price for it.
 */
export function useReorderContentTypes() {
  const queryClient = useQueryClient();
  const invalidateCounts = useInvalidateCatalogueCounts();
  return useMutation({
    mutationFn: ({ orderedIds }: { orderedIds: readonly string[] }) =>
      api.reorderContentTypes(orderedIds),
    onSuccess: ({ contentTypes }) => {
      for (const contentType of contentTypes) {
        patchCatalogue(queryClient, { upsert: contentType });
      }
      invalidateCounts();
    },
  });
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * A channel's own tags.
 *
 * Invalidates rather than patches, deliberately unlike its video siblings: this
 * is a once-per-channel edit made in a dialog, so the refetch is neither hot
 * nor racing anything — and it is the same shape of write as
 * `useSetChannelNiches`, which does exactly this next door.
 */
export function useSetChannelContentTypes() {
  const invalidate = useInvalidateDataset();
  const invalidateCounts = useInvalidateCatalogueCounts();
  return useMutation({
    mutationFn: ({
      channelId,
      contentTypeIds,
    }: {
      channelId: string;
      contentTypeIds: readonly string[];
    }) => api.setChannelContentTypes(channelId, contentTypeIds),
    onSuccess: () => {
      invalidate();
      invalidateCounts();
    },
  });
}

export function useSetVideoContentTypes() {
  const queryClient = useQueryClient();
  const invalidateCounts = useInvalidateCatalogueCounts();

  return useMutation({
    mutationFn: ({
      videoId,
      contentTypeIds,
    }: {
      videoId: string;
      contentTypeIds: readonly string[];
    }) => api.setVideoContentTypes(videoId, contentTypeIds),
    onSuccess: (result) => {
      patchAssignments(queryClient, new Map([[result.videoId, result.contentTypeIds]]));
      invalidateCounts();
    },
  });
}

export interface BulkAssignInput {
  readonly videoIds: readonly string[];
  readonly contentTypeId: string;
  readonly mode: "add" | "replace";
}

export function useAssignContentTypeToVideos() {
  const queryClient = useQueryClient();
  const invalidateCounts = useInvalidateCatalogueCounts();

  return useMutation({
    mutationFn: (input: BulkAssignInput) => api.assignContentTypeToVideos(input),
    // `input` is the second argument React Query hands to onSuccess, so the
    // patch is derived from the request that actually succeeded rather than
    // from state that may have moved on while it was in flight.
    onSuccess: (_result, input) => {
      const targets = new Set(input.videoIds);

      queryClient.setQueryData<DatasetDTO>(DATASET_KEY, (current) => {
        if (!current) return current;

        // Computed against the cache as it is *now*, inside the updater, so
        // two overlapping bulk runs cannot each apply a stale "before".
        const updates = new Map<string, readonly string[]>();
        for (const entry of current.channels) {
          for (const video of entry.videos) {
            if (!targets.has(video.id)) continue;
            updates.set(
              video.id,
              input.mode === "replace"
                ? [input.contentTypeId]
                : normaliseIds([...video.contentTypeIds, input.contentTypeId]),
            );
          }
        }

        return applyAssignments(current, updates);
      });

      invalidateCounts();
    },
  });
}

// ---------------------------------------------------------------------------
// Reading assignments client-side
// ---------------------------------------------------------------------------

/**
 * The shared empty assignment.
 *
 * A stable reference on purpose: callers write `index.get(id) ?? NO_CONTENT_TYPES`
 * during render, and a fresh `[]` there would be a new dependency on every pass,
 * defeating each memo downstream of it.
 */
export const NO_CONTENT_TYPES: readonly string[] = [];

const EMPTY_INDEX: ReadonlyMap<string, readonly string[]> = new Map();
const EMPTY_CATALOGUE: readonly ContentTypeDTO[] = [];

/**
 * videoId -> the type ids filed against it, built once per dataset payload.
 *
 * A WeakMap keyed on the dataset object rather than a `useMemo` in each caller:
 * four surfaces need this index, several of them render a hundred rows, and a
 * per-component memo would rebuild the same map once per screen. Keying on the
 * payload means the index is derived exactly when the payload changes — which
 * includes the in-place patches above, since those produce a new dataset object
 * — and is garbage collected with it.
 */
const INDEX_BY_DATASET = new WeakMap<DatasetDTO, Map<string, readonly string[]>>();

function indexFor(dataset: DatasetDTO): ReadonlyMap<string, readonly string[]> {
  const cached = INDEX_BY_DATASET.get(dataset);
  if (cached) return cached;

  const index = new Map<string, readonly string[]>();
  for (const entry of dataset.channels) {
    for (const video of entry.videos) {
      // Only videos that carry a label go in. A miss means "no content types",
      // which is the overwhelmingly common case and costs nothing to store.
      if (video.contentTypeIds.length > 0) index.set(video.id, video.contentTypeIds);
    }
  }

  INDEX_BY_DATASET.set(dataset, index);
  return index;
}

/**
 * The index for the currently cached dataset.
 *
 * Call it once per list and look each row up, rather than once per row: the
 * lookup is a Map hit, but the query subscription behind it is not free.
 */
export function useVideoContentTypeIndex(): ReadonlyMap<string, readonly string[]> {
  const { data } = useDataset();
  return data ? indexFor(data) : EMPTY_INDEX;
}

/** The whole catalogue as the dataset ships it — archived types included. */
export function useContentTypesFromDataset(): readonly ContentTypeDTO[] {
  const { data } = useDataset();
  return data?.contentTypes ?? EMPTY_CATALOGUE;
}

/**
 * The live vocabulary — what may be offered for new work, anywhere.
 *
 * THIS IS THE PICKER'S OPTIONS, in full. A tag is org-wide, so there is nothing
 * to intersect it against: the same list is offered on every Short and every
 * channel, and the server accepts exactly what this returns.
 *
 * Archived types are excluded here and *only* here. They still render wherever
 * a judgement has already been recorded, because the label a person applied
 * does not stop being true when the type is retired.
 */
export function useActiveContentTypes(): readonly ContentTypeDTO[] {
  const contentTypes = useContentTypesFromDataset();
  return React.useMemo(
    () => contentTypes.filter((type) => type.isActive),
    [contentTypes],
  );
}

/**
 * The catalogue entries for a set of ids, in catalogue order.
 *
 * Shared by every surface that renders chips — a Short's, a channel's — so the
 * order is the stored one everywhere rather than whatever order the ids
 * happened to arrive in.
 */
export function useContentTypesByIds(ids: readonly string[]): readonly ContentTypeDTO[] {
  const catalogue = useContentTypesFromDataset();
  // Joined rather than held by reference: call sites pass arrays straight off a
  // DTO, and those are stable, but inline literals are common enough that
  // memoising on the value is the safer contract.
  const key = ids.join(" ");

  return React.useMemo(() => {
    if (key.length === 0) return EMPTY_CATALOGUE;
    const wanted = new Set(key.split(" "));
    return catalogue.filter((type) => wanted.has(type.id));
  }, [catalogue, key]);
}

// ---------------------------------------------------------------------------
// Cache patching
// ---------------------------------------------------------------------------

function normaliseIds(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort();
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((id, index) => id === b[index]);
}

/**
 * Adds, replaces or removes one entry in the dataset's catalogue copy.
 *
 * Re-sorted to match the order `listContentTypes` uses on the server, so a type
 * created here sits where it will sit after the next genuine fetch rather than
 * jumping on reload.
 */
function patchCatalogue(
  queryClient: QueryClient,
  change: { upsert: ContentTypeDTO } | { removeId: string },
): void {
  queryClient.setQueryData<DatasetDTO>(DATASET_KEY, (current) => {
    if (!current) return current;

    if ("removeId" in change) {
      const contentTypes = current.contentTypes.filter(
        (type) => type.id !== change.removeId,
      );
      if (contentTypes.length === current.contentTypes.length) return current;
      return { ...current, contentTypes };
    }

    const contentTypes = [
      ...current.contentTypes.filter((type) => type.id !== change.upsert.id),
      change.upsert,
    ].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

    return { ...current, contentTypes };
  });
}

function patchAssignments(
  queryClient: QueryClient,
  updates: ReadonlyMap<string, readonly string[]>,
): void {
  queryClient.setQueryData<DatasetDTO>(DATASET_KEY, (current) =>
    current ? applyAssignments(current, updates) : current,
  );
}

/**
 * Rewrites `contentTypeIds` on the named videos and adjusts the catalogue's
 * `videoCount` by the same movement.
 *
 * The counts are adjusted by DELTA rather than recounted from the payload. A
 * niche-scoped member sees only part of the organization's tracker, so counting
 * the videos in front of them would report a smaller number than the truth —
 * and would then present that undercount as the reason a type can or cannot be
 * deleted. Adding what changed to what the server said is correct whatever the
 * viewer can see.
 *
 * Only `videoCount` moves. `channelCount` is not touched by any write in this
 * file — the channel path invalidates instead of patching, so the fresh count
 * arrives with the refetch rather than being guessed at here.
 *
 * Object identity is preserved for every channel, video and type that did not
 * move, so the analytics memos downstream re-run over the same arrays.
 */
function applyAssignments(
  dataset: DatasetDTO,
  updates: ReadonlyMap<string, readonly string[]>,
): DatasetDTO {
  if (updates.size === 0) return dataset;

  const delta = new Map<string, number>();
  let anyChanged = false;

  const channels = dataset.channels.map((entry) => {
    let changed = false;

    const videos = entry.videos.map((video) => {
      const next = updates.get(video.id);
      if (next === undefined) return video;

      const before = video.contentTypeIds;
      if (sameIds(before, next)) return video;

      for (const id of next) {
        if (!before.includes(id)) delta.set(id, (delta.get(id) ?? 0) + 1);
      }
      for (const id of before) {
        if (!next.includes(id)) delta.set(id, (delta.get(id) ?? 0) - 1);
      }

      changed = true;
      return { ...video, contentTypeIds: next };
    });

    if (!changed) return entry;
    anyChanged = true;
    return { ...entry, videos };
  });

  if (!anyChanged) return dataset;

  const contentTypes = dataset.contentTypes.map((type) => {
    const movement = delta.get(type.id);
    if (!movement) return type;
    return { ...type, videoCount: Math.max(0, type.videoCount + movement) };
  });

  return { ...dataset, channels, contentTypes };
}
