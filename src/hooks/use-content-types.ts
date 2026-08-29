"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ContentTypeDTO, DatasetDTO, VideoDTO } from "@/lib/dto";
import {
  EMPTY_RESOLUTION,
  planDeviations,
  resolveContentTypes,
  type ContentTypeResolution,
  type DeviationPlan,
} from "@/lib/content-types/resolve";
import { DATASET_KEY, useDataset, useInvalidateDataset } from "./use-dataset";

/**
 * Content types — catalogue reads, assignment writes, and the client-side index
 * that resolves every Short against its channel.
 *
 * ONE FLAT CATALOGUE. A content type is an org-wide tag, so there is no
 * per-niche narrowing anywhere in this file and no "which types may this Short
 * take?" to derive: the answer is the organization's active types, the same
 * array for every Short in the tracker.
 *
 * WHAT A SHORT CARRIES IS COMPUTED HERE, NEVER READ OFF THE WIRE
 *
 * `VideoDTO` ships DEVIATIONS — the tags a Short adds to its channel's, and the
 * ones it refuses. Its actual tags are
 *
 *     (channel's tags − exclusions) ∪ manual tags
 *
 * resolved by `src/lib/content-types/resolve.ts`, the same module the server
 * imports. That is what keeps the channel the LIVE source: tagging a channel
 * relabels every Short beneath it on the next render, with nothing written per
 * Short and nothing refetched. A precomputed effective list on the wire would
 * have gone stale the moment somebody edited a channel in another tab.
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
 * place. This is not an optimistic guess: every per-Short route echoes back the
 * DEVIATIONS it stored, and the bulk endpoint's outcome is derived here with
 * `planDeviations` — the same function the server used, against the same channel
 * tags, so "what the client thinks it wrote" and "what was written" are the same
 * computation rather than two that agree today. The usage counts on the
 * catalogue are adjusted by the same delta, so nothing on screen can drift out
 * of step with what was written.
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

/**
 * Set one Short's tags — the whole set, as the picker's main gesture sends it.
 *
 * Patches with the DEVIATIONS the server echoed back rather than re-deriving
 * them from the ids that were requested. Both would agree today, and the echo is
 * the one that stays right: the server planned against the Short's stored rows
 * at the instant it wrote, and this cache may have been a moment behind.
 */
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
      patchStoredDeviations(queryClient, result);
      invalidateCounts();
    },
  });
}

/**
 * REFUSE ONE INHERITED TAG — the "remove this chip" gesture, as one request.
 *
 * Its own mutation rather than a `setVideoContentTypes` call with one id
 * dropped, and the difference is what goes on the wire: this sends the tag being
 * removed and nothing else, so a tab that is a minute out of date cannot revert
 * somebody's edit to a DIFFERENT tag as a side effect of this click. See the
 * route for the whole argument.
 */
export function useExcludeContentTypeFromVideo() {
  const queryClient = useQueryClient();
  const invalidateCounts = useInvalidateCatalogueCounts();

  return useMutation({
    mutationFn: ({ videoId, contentTypeId }: { videoId: string; contentTypeId: string }) =>
      api.excludeContentTypeFromVideo(videoId, contentTypeId),
    onSuccess: (result) => {
      patchStoredDeviations(queryClient, result);
      invalidateCounts();
    },
  });
}

/** Take that refusal back, so the channel's tag flows through again. */
export function useRestoreInheritedContentType() {
  const queryClient = useQueryClient();
  const invalidateCounts = useInvalidateCatalogueCounts();

  return useMutation({
    mutationFn: ({ videoId, contentTypeId }: { videoId: string; contentTypeId: string }) =>
      api.restoreInheritedContentType(videoId, contentTypeId),
    onSuccess: (result) => {
      patchStoredDeviations(queryClient, result);
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
    /*
     * `input` is the second argument React Query hands to onSuccess, so the
     * patch is derived from the request that actually succeeded rather than
     * from state that may have moved on while it was in flight.
     *
     * THE ONE WRITE WHOSE RESULT THE CLIENT DERIVES. The per-Short routes echo
     * back the rows they stored; this endpoint answers with counts, because it
     * has up to 500 Shorts to describe. So the outcome is recomputed here with
     * `planDeviations` — the same function the server wrote through, against the
     * same channel tags. Not a parallel guess at the outcome: the same
     * computation, run twice.
     */
    onSuccess: (_result, input) => {
      const targets = new Set(input.videoIds);

      queryClient.setQueryData<DatasetDTO>(DATASET_KEY, (current) => {
        if (!current) return current;

        // Computed against the cache as it is *now*, inside the updater, so
        // two overlapping bulk runs cannot each apply a stale "before".
        const updates = new Map<string, readonly string[]>();
        for (const entry of current.channels) {
          const channelTypeIds = entry.channel.contentTypeIds;

          for (const video of entry.videos) {
            if (!targets.has(video.id)) continue;

            /*
             * "Add" unions with the Short's EFFECTIVE tags, not its stored rows.
             *
             * Those are different sets now, and using the rows would be a
             * destructive read: a Short inheriting "Ranking" from its channel
             * stores nothing, so unioning the rows would produce a desired set
             * of just the new tag — and `planDeviations` would dutifully write
             * an exclusion for the Ranking nobody asked to remove. The mode is
             * called "add" and it has to only add.
             */
            const effectiveIds = resolveContentTypes({
              channelTypeIds,
              manualIds: video.manualContentTypeIds,
              excludedIds: video.excludedContentTypeIds,
            }).effectiveIds;

            updates.set(
              video.id,
              input.mode === "replace"
                ? [input.contentTypeId]
                : normaliseIds([...effectiveIds, input.contentTypeId]),
            );
          }
        }

        return applyVideoDeviations(current, targets, (video, channelTypeIds) =>
          planDeviations({
            channelTypeIds,
            // Present for every id in `targets` that this cache knows about;
            // one it does not know about is a Short outside this viewer's niche
            // scope, and leaving its rows alone is the correct answer there.
            desiredIds: updates.get(video.id) ?? video.manualContentTypeIds,
            existingManualIds: video.manualContentTypeIds,
            // Carried through so the cache patch keeps dormant tombstones the
            // server keeps. Without it the optimistic view would show a refusal
            // dropped that the database still holds, and the two would disagree
            // until the next dataset fetch.
            existingExcludedIds: video.excludedContentTypeIds,
          }),
        );
      });

      invalidateCounts();
    },
  });
}

// ---------------------------------------------------------------------------
// Reading assignments client-side
// ---------------------------------------------------------------------------

const EMPTY_INDEX: ReadonlyMap<string, ContentTypeResolution> = new Map();
const EMPTY_CATALOGUE: readonly ContentTypeDTO[] = [];
/** A stable empty list, so the shared resolution below allocates nothing per channel. */
const NO_IDS: readonly string[] = [];

/**
 * videoId -> its RESOLVED tags, built once per dataset payload.
 *
 * A WeakMap keyed on the dataset object rather than a `useMemo` in each caller:
 * four surfaces need this index, several of them render a hundred rows, and a
 * per-component memo would rebuild the same map once per screen. Keying on the
 * payload means the index is derived exactly when the payload changes — which
 * includes the in-place patches above, since those produce a new dataset object
 * — and is garbage collected with it.
 *
 * THE INDEX IS WHERE THE CHANNEL AND THE SHORT ARE JOINED.
 *
 * It used to hold a Short's own stored ids and skip the ones that had none. Both
 * halves of that are now wrong: a Short's stored ids are its DEVIATIONS, and a
 * Short with none is not untagged — it is the ordinary case that carries exactly
 * what its channel carries. So every video is resolved here, against the channel
 * that owns it, and the map is built from the answer rather than from the rows.
 *
 * This is also the only place in the client where the two are in scope together.
 * Resolving here rather than at each surface is what stops the Shorts table, the
 * feeds and Saved deriving the rule three times and drifting.
 */
const INDEX_BY_DATASET = new WeakMap<DatasetDTO, Map<string, ContentTypeResolution>>();

function indexFor(dataset: DatasetDTO): ReadonlyMap<string, ContentTypeResolution> {
  const cached = INDEX_BY_DATASET.get(dataset);
  if (cached) return cached;

  const index = new Map<string, ContentTypeResolution>();

  for (const entry of dataset.channels) {
    const channelTypeIds = entry.channel.contentTypeIds;

    /*
     * The channel's own answer, resolved once and SHARED by every Short that
     * does not deviate from it.
     *
     * That is the overwhelming majority of rows — the whole point of storing
     * nothing per Short — so giving each of them a private copy of the same two
     * arrays would allocate a few thousand identical objects per payload for
     * nothing. Shared identity also means a consumer comparing resolutions by
     * reference gets a true answer cheaply.
     */
    const inheritedOnly =
      channelTypeIds.length === 0
        ? EMPTY_RESOLUTION
        : resolveContentTypes({
            channelTypeIds,
            manualIds: NO_IDS,
            excludedIds: NO_IDS,
          });

    for (const video of entry.videos) {
      const deviates =
        video.manualContentTypeIds.length > 0 || video.excludedContentTypeIds.length > 0;

      const resolution = deviates
        ? resolveContentTypes({
            channelTypeIds,
            manualIds: video.manualContentTypeIds,
            excludedIds: video.excludedContentTypeIds,
          })
        : inheritedOnly;

      // A genuinely tagless Short still misses the map, exactly as before —
      // `EMPTY_RESOLUTION` is what a miss means, so storing it would be storing
      // the default. What changed is that "tagless" is now a fact about the
      // channel too, not just about the Short.
      if (resolution !== EMPTY_RESOLUTION) index.set(video.id, resolution);
    }
  }

  INDEX_BY_DATASET.set(dataset, index);
  return index;
}

/**
 * The resolved index for the currently cached dataset.
 *
 * Call it once per list and look each row up, rather than once per row: the
 * lookup is a Map hit, but the query subscription behind it is not free. A miss
 * is `EMPTY_RESOLUTION`, which is a real answer ("nothing, from either source")
 * rather than an absence to handle.
 *
 * RENAMED FROM `useVideoContentTypeIndex` on purpose. It used to hand back the
 * Short's own ids and now hands back a resolution against the channel; a caller
 * that kept reading it as "the ids stored on this Short" would be silently
 * wrong, so the rename makes every one of them fail to compile until it has been
 * looked at.
 */
export function useVideoContentTypeResolutions(): ReadonlyMap<
  string,
  ContentTypeResolution
> {
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
 * Records one array's movement to another as +1/-1 per id.
 *
 * Extracted because it is now run twice per video — once for the manual rows and
 * once for the exclusions — and the two counts must be adjusted by identical
 * arithmetic or they will disagree about the same edit.
 */
function accumulate(
  delta: Map<string, number>,
  before: readonly string[],
  after: readonly string[],
): void {
  for (const id of after) {
    if (!before.includes(id)) delta.set(id, (delta.get(id) ?? 0) + 1);
  }
  for (const id of before) {
    if (!after.includes(id)) delta.set(id, (delta.get(id) ?? 0) - 1);
  }
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

/**
 * Applies the rows a per-Short route says it stored, verbatim.
 *
 * Nothing is re-planned here, and that is the point: the server has already
 * answered the question, against the state that actually existed at write time.
 * Re-deriving it from the request would reintroduce the possibility of this
 * cache and the database disagreeing about a Short nobody has refetched.
 */
function patchStoredDeviations(
  queryClient: QueryClient,
  stored: {
    videoId: string;
    manualContentTypeIds: readonly string[];
    excludedContentTypeIds: readonly string[];
  },
): void {
  const plan: DeviationPlan = {
    manualIds: stored.manualContentTypeIds,
    excludedIds: stored.excludedContentTypeIds,
  };
  queryClient.setQueryData<DatasetDTO>(DATASET_KEY, (current) =>
    current
      ? applyVideoDeviations(current, new Set([stored.videoId]), () => plan)
      : current,
  );
}

/**
 * Rewrites the named videos' deviation rows, and moves the catalogue counts by
 * the same arithmetic.
 *
 * ONE WALK, TWO CALLERS. The per-Short routes hand back the rows they stored and
 * the bulk path derives them; both end up here, so the delta arithmetic and the
 * object-identity rules exist once. What differs between them is only where the
 * plan comes from, which is why that arrives as a function rather than as data.
 *
 * The channel is in scope inside this walk, which is why the translation happens
 * at this level rather than in the mutation callbacks: `planDeviations` cannot
 * decide whether a wanted tag needs a row without knowing what the channel
 * already gives.
 *
 * The counts are adjusted by DELTA rather than recounted from the payload. A
 * niche-scoped member sees only part of the organization's tracker, so counting
 * the videos in front of them would report a smaller number than the truth —
 * and would then present that undercount as the reason a type can or cannot be
 * deleted. Adding what changed to what the server said is correct whatever the
 * viewer can see.
 *
 * BOTH ROW COUNTS MOVE, and they move independently. Clearing a tag off a Short
 * whose channel provides it does not decrement `manualVideoCount` — there was no
 * manual row — it INCREMENTS `excludedVideoCount`, because refusing it is what
 * actually got written. A patch that only tracked the first number would drift
 * the moment anybody used the feature as designed.
 *
 * `channelCount` is not touched by any write in this file — the channel path
 * invalidates instead of patching, so the fresh count arrives with the refetch
 * rather than being guessed at here.
 *
 * Object identity is preserved for every channel, video and type that did not
 * move, so the analytics memos downstream re-run over the same arrays.
 */
function applyVideoDeviations(
  dataset: DatasetDTO,
  videoIds: ReadonlySet<string>,
  planFor: (video: VideoDTO, channelTypeIds: readonly string[]) => DeviationPlan,
): DatasetDTO {
  if (videoIds.size === 0) return dataset;

  const manualDelta = new Map<string, number>();
  const excludedDelta = new Map<string, number>();
  let anyChanged = false;

  const channels = dataset.channels.map((entry) => {
    let changed = false;
    const channelTypeIds = entry.channel.contentTypeIds;

    const videos = entry.videos.map((video) => {
      if (!videoIds.has(video.id)) return video;

      const beforeManual = video.manualContentTypeIds;
      const beforeExcluded = video.excludedContentTypeIds;

      const plan = planFor(video, channelTypeIds);

      if (sameIds(beforeManual, plan.manualIds) && sameIds(beforeExcluded, plan.excludedIds)) {
        return video;
      }

      accumulate(manualDelta, beforeManual, plan.manualIds);
      accumulate(excludedDelta, beforeExcluded, plan.excludedIds);

      changed = true;
      return {
        ...video,
        manualContentTypeIds: plan.manualIds,
        excludedContentTypeIds: plan.excludedIds,
      };
    });

    if (!changed) return entry;
    anyChanged = true;
    return { ...entry, videos };
  });

  if (!anyChanged) return dataset;

  const contentTypes = dataset.contentTypes.map((type) => {
    const manualMovement = manualDelta.get(type.id) ?? 0;
    const excludedMovement = excludedDelta.get(type.id) ?? 0;
    if (manualMovement === 0 && excludedMovement === 0) return type;
    return {
      ...type,
      manualVideoCount: Math.max(0, type.manualVideoCount + manualMovement),
      excludedVideoCount: Math.max(0, type.excludedVideoCount + excludedMovement),
    };
  });

  return { ...dataset, channels, contentTypes };
}
