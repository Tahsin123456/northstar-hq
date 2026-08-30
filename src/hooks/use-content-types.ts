"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import type {
  ChannelContentTypeRuleDTO,
  ChannelDTO,
  ContentTypeDTO,
  DatasetDTO,
  VideoDTO,
} from "@/lib/dto";
import type { ChannelRuleClosure } from "@/server/services/content-type-service";
import {
  EMPTY_RESOLUTION,
  buildInheritanceTimeline,
  planDeviations,
  resolveContentTypes,
  type ContentTypeResolution,
  type DeviationPlan,
  type InheritanceTimeline,
} from "@/lib/content-types/resolve";
import { RULE_AUTO_CLOSE_STREAK } from "@/lib/content-types/rules";
import { DATASET_KEY, useDataset } from "./use-dataset";

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
 * `VideoDTO` ships DEVIATIONS — the tags a Short adds to what it inherits, and
 * the ones it refuses. Its actual tags are
 *
 *     (the rules covering its publish date − exclusions) ∪ manual tags
 *
 * resolved by `src/lib/content-types/resolve.ts`, the same module the server
 * imports. That is what keeps the rules the LIVE source: applying a tag to a
 * channel relabels its whole back catalogue on the next render, and a rule
 * retiring un-labels exactly the uploads after the switch — with nothing written
 * per Short and nothing refetched. A precomputed effective list on the wire
 * would have gone stale the moment either happened in another tab.
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
 * THE CHANNEL-LEVEL WRITE IS NO LONGER THE EXCEPTION. It used to invalidate,
 * because it lived in a dialog on the channel page and could afford a refetch.
 * "Apply to this channel" is offered inside the tag picker on a Short — one
 * keystroke from the fastest control in the product — so it patches like
 * everything else here, with the rules the server says it stored.
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
 * "APPLY TO THIS CHANNEL" — one tag over the whole back catalogue and
 * everything published next.
 *
 * PATCHES RATHER THAN INVALIDATES, unlike the channel-wide write it replaces.
 * That write lived in a dialog on the channel page and could afford a refetch;
 * this one is offered inside the tag picker on a Short, one keystroke away from
 * the fastest control in the product. Re-downloading every channel's view
 * history to add one rule would make the "and while you're there, this is what
 * the whole channel does" gesture the slowest thing in the app.
 *
 * The patch is not a guess: the server returns the channel it stored, and only
 * its `contentTypeRules` are copied across. Copying the whole `ChannelDTO` would
 * clobber whatever else has moved in the cache since — an ownership flip, a
 * rename — with a snapshot taken for a different purpose.
 */
export function useApplyContentTypeToChannel() {
  const queryClient = useQueryClient();
  const invalidateCounts = useInvalidateCatalogueCounts();

  return useMutation({
    mutationFn: ({
      channelId,
      contentTypeId,
    }: {
      channelId: string;
      contentTypeId: string;
    }) => api.applyContentTypeToChannel(channelId, contentTypeId),
    onSuccess: ({ channel }) => {
      patchChannelRules(queryClient, channel.id, () => channel.contentTypeRules);
      // The rule count on the catalogue moved, and that number gates the delete
      // button on the management screen.
      invalidateCounts();
    },
  });
}

/**
 * CLOSE A RULE AT A DATE, OR RE-OPEN IT — the manual lever, and the undo on the
 * toast that announces a self-retirement.
 *
 * ONE MUTATION FOR BOTH, mirroring the one endpoint, because the undo has to be
 * the same shape as the do or the two will drift into disagreeing about what
 * gets reset alongside the window.
 */
export function useSetChannelRuleWindow() {
  const queryClient = useQueryClient();
  const invalidateCounts = useInvalidateCatalogueCounts();

  return useMutation({
    mutationFn: ({
      channelId,
      ruleId,
      effectiveUntil,
    }: {
      channelId: string;
      ruleId: string;
      effectiveUntil: number | null;
    }) => api.setChannelContentTypeRuleWindow(channelId, ruleId, effectiveUntil),
    onSuccess: ({ channel }) => {
      patchChannelRules(queryClient, channel.id, () => channel.contentTypeRules);
      invalidateCounts();
    },
  });
}

/**
 * TELL THE PERSON A RULE JUST RETIRED ITSELF, WHEREVER THEY WERE STANDING.
 *
 * IN THE MUTATION HOOKS RATHER THAN IN THE COMPONENTS, and that placement is the
 * decision. A rule retires as a SIDE EFFECT of removing a tag from one Short —
 * the third one, and nothing about the click says so — which means the surface
 * that fired it has no reason to expect an announcement and every reason to
 * forget to render one. There are four such surfaces. Putting the toast on the
 * three writes that can cause it makes "the user is told" a property of the
 * write instead of a thing four components each have to remember.
 *
 * THE DATE IS THE POINT OF THE SENTENCE. "Stopped applying Funny Memes to new
 * uploads on Gaming Central from 4 March" says what changed, where, and — the
 * part nobody could otherwise work out — how far back it reaches. A toast that
 * said only "rule closed" would send somebody to the channel page to find out
 * whether they had just un-labelled a week or a year.
 *
 * AND IT CARRIES THE UNDO. The close is a heuristic over three data points and
 * will sometimes be wrong; the answer to that is that it is announced and
 * reversible in one click, not that it is prevented. `duration` is long because
 * this is the one toast in the app a person has to read and decide about rather
 * than acknowledge.
 */
function useAnnounceClosedRules(): (closures: readonly ChannelRuleClosure[]) => void {
  const queryClient = useQueryClient();
  const reopen = useSetChannelRuleWindow();

  return React.useCallback(
    (closures) => {
      for (const closure of closures) {
        /*
         * THE CACHE MOVES FIRST, before anybody reads the toast.
         *
         * A retirement changes what every upload since the switch inherits, and
         * the per-Short response cannot carry that — it describes one Short's
         * rows. Without this the table behind the toast would go on showing the
         * tag on Shorts the database has just stopped giving it to, until
         * something unrelated triggered a refetch. The toast would be announcing
         * a change the screen contradicts, which is worse than not announcing it.
         *
         * Patched from the closure rather than refetched: it carries the rule id
         * and the date the server actually stored, so this is applying the
         * server's answer, not guessing at it.
         */
        patchChannelRules(queryClient, closure.channelId, (rules) =>
          rules.map((rule) =>
            rule.id === closure.ruleId
              ? {
                  ...rule,
                  effectiveUntil: closure.effectiveUntil,
                  // Stamped locally, and only to make the UI say "retired
                  // itself" rather than "somebody closed it". The exact instant
                  // is the server's and arrives with the next fetch; what has to
                  // be right now is which of the two sentences the channel page
                  // prints.
                  autoClosedAt: Date.now(),
                }
              : rule,
          ),
        );

        toast.warning(
          `Stopped applying “${closure.contentTypeName}” to new uploads on ${closure.channelName} from ${formatRuleDate(
            closure.effectiveUntil,
          )}`,
          {
            description:
              `${RULE_AUTO_CLOSE_STREAK} Shorts in a row had it removed, so the rule retired itself. Everything published before that date keeps the tag.`,
            duration: 12_000,
            action: {
              label: "Undo",
              onClick: () =>
                reopen.mutate(
                  {
                    channelId: closure.channelId,
                    ruleId: closure.ruleId,
                    effectiveUntil: null,
                  },
                  {
                    onSuccess: () =>
                      toast.success(
                        `“${closure.contentTypeName}” applies to new uploads on ${closure.channelName} again`,
                      ),
                    onError: (error) =>
                      toast.error("Could not re-open that rule", {
                        description:
                          error instanceof Error ? error.message : undefined,
                      }),
                  },
                ),
            },
          },
        );
      }
    },
    [queryClient, reopen],
  );
}

/**
 * "4 March 2025" — the same sentence the server writes into the audit log.
 *
 * `en-GB` and UTC on both sides deliberately: the log and the toast describe one
 * event, and a reader comparing them must not find two different days because
 * one was formatted against a browser in Auckland.
 */
function formatRuleDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
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
  const announce = useAnnounceClosedRules();

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
      announce(result.closedRules);
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
  const announce = useAnnounceClosedRules();

  return useMutation({
    mutationFn: ({ videoId, contentTypeId }: { videoId: string; contentTypeId: string }) =>
      api.excludeContentTypeFromVideo(videoId, contentTypeId),
    onSuccess: (result) => {
      patchStoredDeviations(queryClient, result);
      invalidateCounts();
      // THE gesture that retires a rule — the third removal in a row. Every
      // other announcement site exists because it amounts to this one.
      announce(result.closedRules);
    },
  });
}

/** Take that refusal back, so the rule's tag flows through again. */
export function useRestoreInheritedContentType() {
  const queryClient = useQueryClient();
  const invalidateCounts = useInvalidateCatalogueCounts();
  const announce = useAnnounceClosedRules();

  return useMutation({
    mutationFn: ({ videoId, contentTypeId }: { videoId: string; contentTypeId: string }) =>
      api.restoreInheritedContentType(videoId, contentTypeId),
    onSuccess: (result) => {
      patchStoredDeviations(queryClient, result);
      invalidateCounts();
      // Never fires in practice — restoring a tag CONFIRMS a rule, it cannot
      // retire one. Wired anyway rather than asserted away: the closure array is
      // part of this response's contract, and a silent drop here would be a
      // change nobody was told about if that ever stopped being true.
      announce(result.closedRules);
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
          const timeline = buildInheritanceTimeline(entry.channel.contentTypeRules);

          for (const video of entry.videos) {
            if (!targets.has(video.id)) continue;

            /*
             * "Add" unions with the Short's EFFECTIVE tags, not its stored rows.
             *
             * Those are different sets now, and using the rows would be a
             * destructive read: a Short inheriting "Ranking" from a rule stores
             * nothing, so unioning the rows would produce a desired set of just
             * the new tag — and `planDeviations` would dutifully write an
             * exclusion for the Ranking nobody asked to remove. The mode is
             * called "add" and it has to only add.
             */
            const effectiveIds = resolveContentTypes({
              inheritedIds: timeline.at(video.publishedAt),
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

        return applyVideoDeviations(current, targets, (video, inheritedIds) =>
          planDeviations({
            inheritedIds,
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
    const timeline = buildInheritanceTimeline(entry.channel.contentTypeRules);

    /*
     * One resolution per SEGMENT of the channel's history, shared by every Short
     * in it that does not deviate.
     *
     * The sharing is the same trick as before and it matters for the same
     * reason: non-deviating Shorts are the overwhelming majority of rows — the
     * whole point of storing nothing per Short — so a private copy of the same
     * two arrays each would allocate a few thousand identical objects per
     * payload for nothing, and would defeat every downstream memo that compares
     * resolutions by reference.
     *
     * What changed is only the KEY. It used to be "this channel"; it is now
     * "this stretch of this channel's history", of which a typical channel has
     * exactly one. Keyed on the inherited array's identity rather than on a
     * date, because the timeline already guarantees one array per segment —
     * which makes this a cache with no invalidation rule to get wrong.
     */
    const bySegment = new Map<readonly string[], ContentTypeResolution>();

    for (const video of entry.videos) {
      const inheritedIds = timeline.at(video.publishedAt);

      const deviates =
        video.manualContentTypeIds.length > 0 || video.excludedContentTypeIds.length > 0;

      let resolution: ContentTypeResolution;
      if (deviates) {
        resolution = resolveContentTypes({
          inheritedIds,
          manualIds: video.manualContentTypeIds,
          excludedIds: video.excludedContentTypeIds,
        });
      } else {
        const shared = bySegment.get(inheritedIds);
        if (shared) {
          resolution = shared;
        } else {
          resolution =
            inheritedIds.length === 0
              ? EMPTY_RESOLUTION
              : resolveContentTypes({
                  inheritedIds,
                  manualIds: NO_IDS,
                  excludedIds: NO_IDS,
                });
          bySegment.set(inheritedIds, resolution);
        }
      }

      // A genuinely tagless Short still misses the map, exactly as before —
      // `EMPTY_RESOLUTION` is what a miss means, so storing it would be storing
      // the default. What changed is that "tagless" is now a fact about this
      // Short's PLACE in its channel's history: an upload from before the rule
      // began, or from after it retired, is untagged on a channel that is not.
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

/**
 * videoId -> the channel that published it, built once per dataset payload.
 *
 * WHY A LOOKUP RATHER THAN A PROP. "Apply to this channel" is offered from the
 * tag picker, which renders on four surfaces — the Shorts table, Winners,
 * Outliers, Saved — none of which currently passes a channel down to it, and
 * two of which are flat lists of Shorts drawn from every channel at once.
 * Threading a `channelId` through four component trees to reach a popover would
 * be four chances to pass the wrong one; the dataset already knows which channel
 * a Short belongs to, and it is the same object the picker will patch.
 *
 * A WeakMap on the payload, exactly like the resolution index above and for the
 * same reasons: derived when the payload changes, shared by every caller, and
 * collected with it.
 */
const CHANNEL_BY_VIDEO = new WeakMap<DatasetDTO, Map<string, ChannelDTO>>();

function channelIndexFor(dataset: DatasetDTO): ReadonlyMap<string, ChannelDTO> {
  const cached = CHANNEL_BY_VIDEO.get(dataset);
  if (cached) return cached;

  const index = new Map<string, ChannelDTO>();
  for (const entry of dataset.channels) {
    for (const video of entry.videos) index.set(video.id, entry.channel);
  }

  CHANNEL_BY_VIDEO.set(dataset, index);
  return index;
}

/**
 * The channel that published this Short, or `null`.
 *
 * `null` is a real answer rather than a loading state: the dataset may not have
 * arrived, or the Short may sit outside this viewer's niche scope. Callers offer
 * no channel-level action in either case, which is right — the second is a
 * channel they are not entitled to change.
 */
export function useChannelForVideo(videoId: string): ChannelDTO | null {
  const { data } = useDataset();
  return data ? (channelIndexFor(data).get(videoId) ?? null) : null;
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
 * Replaces one channel's rules in the cached dataset.
 *
 * A NARROW PATCH ON PURPOSE, even though the server hands back a whole
 * `ChannelDTO`. That object is a snapshot taken to answer one question, and
 * spreading it over the cached channel would silently roll back anything else
 * that has moved in the meantime — an ownership flip in another tab, a rename
 * still settling. One field changed, one field written.
 *
 * Nothing downstream needs telling. Every consumer resolves each Short against
 * this array on render, so replacing it relabels the whole channel's library at
 * once — which is exactly the property that made rules worth having, working in
 * the browser rather than only in the database.
 */
function patchChannelRules(
  queryClient: QueryClient,
  channelId: string,
  next: (
    current: readonly ChannelContentTypeRuleDTO[],
  ) => readonly ChannelContentTypeRuleDTO[],
): void {
  queryClient.setQueryData<DatasetDTO>(DATASET_KEY, (current) => {
    if (!current) return current;

    let changed = false;
    const channels = current.channels.map((entry) => {
      if (entry.channel.id !== channelId) return entry;
      const rules = next(entry.channel.contentTypeRules);
      if (rules === entry.channel.contentTypeRules) return entry;
      changed = true;
      return { ...entry, channel: { ...entry.channel, contentTypeRules: rules } };
    });

    // Identity preserved when the channel is not in this viewer's scope, so an
    // edit to a channel they cannot see does not invalidate every memo they can.
    return changed ? { ...current, channels } : current;
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
 * `channelRuleCount` is not touched here — no write in this walk creates or
 * closes a rule. The rule paths invalidate the management screen's own read
 * instead, so the fresh count arrives with a refetch of the one query that shows
 * it rather than being guessed at from a dataset a niche-scoped member can only
 * see part of.
 *
 * Object identity is preserved for every channel, video and type that did not
 * move, so the analytics memos downstream re-run over the same arrays.
 */
function applyVideoDeviations(
  dataset: DatasetDTO,
  videoIds: ReadonlySet<string>,
  planFor: (video: VideoDTO, inheritedIds: readonly string[]) => DeviationPlan,
): DatasetDTO {
  if (videoIds.size === 0) return dataset;

  const manualDelta = new Map<string, number>();
  const excludedDelta = new Map<string, number>();
  let anyChanged = false;

  const channels = dataset.channels.map((entry) => {
    let changed = false;
    // Built per channel even when nothing in it is a target: it is a sort of a
    // handful of numbers, and hoisting the check would mean two walks over the
    // videos to save it.
    let timeline: InheritanceTimeline | null = null;

    const videos = entry.videos.map((video) => {
      if (!videoIds.has(video.id)) return video;

      const beforeManual = video.manualContentTypeIds;
      const beforeExcluded = video.excludedContentTypeIds;

      timeline ??= buildInheritanceTimeline(entry.channel.contentTypeRules);
      const plan = planFor(video, timeline.at(video.publishedAt));

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
