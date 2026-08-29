/**
 * ==========================================================================
 * THE RESOLUTION RULE, WRITTEN ONCE
 * ==========================================================================
 *
 *     effective(short) = (channel's tags − short's exclusions) ∪ short's manual tags
 *
 * INHERITED TAGS ARE NEVER STORED. There is no row for an inherited tag and
 * there must never be one. A `VideoContentType` row is always a DEVIATION from
 * the channel:
 *
 *   • "manual"   — this Short carries a tag its channel does not.
 *   • "excluded" — this Short refuses a tag its channel does have. A TOMBSTONE,
 *                  kept even after the channel drops the tag, so re-adding it to
 *                  the channel does not silently undo somebody's explicit "no".
 *
 * WHY THIS FILE IS IN `src/lib/` AND NOT `src/server/`
 *
 * Both sides resolve. The dataset is held in memory and re-sliced in the
 * browser without refetching — that property is deliberate and predates this
 * change — so the client must be able to answer "what is this Short tagged as?"
 * from the payload alone. The server needs the same answer to write deviations
 * and to audit them. Deriving it twice in two places is how the two drift, so
 * it is derived once, here, in a module with no imports and no environment.
 *
 * WHY NOT SHIP A PRECOMPUTED EFFECTIVE LIST INSTEAD
 *
 * Because that list would be a SNAPSHOT taken at request time, which is exactly
 * the staleness this design exists to avoid. A channel gaining a tag would reach
 * nothing already rendered, and a channel losing one would leave every Short
 * still showing it until the next fetch. The channel stays the live source and
 * the payload carries the two short deviation arrays; the join happens here.
 */

/**
 * Where an effective tag came from.
 *
 * The UI needs it to label the chip and to decide what "Remove" means; the
 * analytics do not care and read the ids alone. Both come out of one pass so
 * neither has to recompute the other's half.
 */
export type ContentTypeOrigin = "inherited" | "manual";

export interface ResolvedContentType {
  readonly id: string;
  readonly origin: ContentTypeOrigin;
}

export interface ContentTypeResolution {
  /** Every effective tag with where it came from, ordered by id. */
  readonly effective: readonly ResolvedContentType[];
  /**
   * The same ids alone, for the consumers that only need the set.
   *
   * Materialised here rather than mapped at each call site: the Shorts feed and
   * the performance aggregate run this over a few thousand videos on every
   * filter change, and a fresh `.map()` per row per render is the difference
   * between a memo that holds and one that never does.
   */
  readonly effectiveIds: readonly string[];
  /**
   * Channel tags this Short is currently refusing.
   *
   * `channelTypeIds ∩ excludedIds` — the tombstones that are actually doing
   * work right now, as opposed to dormant ones for tags the channel has since
   * dropped. It is what lets the picker offer "restore" on the one tag a person
   * can meaningfully un-refuse, and say nothing about tombstones that currently
   * suppress nothing.
   */
  readonly suppressedIds: readonly string[];
}

export interface ResolveContentTypesInput {
  /** What the channel says it makes. The live source — never copied onto Shorts. */
  readonly channelTypeIds: readonly string[];
  /** `state: "manual"` rows — tags this Short carries that its channel does not. */
  readonly manualIds: readonly string[];
  /** `state: "excluded"` rows — tags this Short refuses. */
  readonly excludedIds: readonly string[];
}

/** Shared empty results, so a miss does not allocate and every memo downstream holds. */
const NO_IDS: readonly string[] = [];
const NO_RESOLVED: readonly ResolvedContentType[] = [];

export const EMPTY_RESOLUTION: ContentTypeResolution = {
  effective: NO_RESOLVED,
  effectiveIds: NO_IDS,
  suppressedIds: NO_IDS,
};

/**
 * Resolve one Short against its channel.
 *
 * PRECEDENCE, DECIDED HERE AND NOWHERE ELSE: if a tag is BOTH manually added and
 * provided by the channel, it appears ONCE and reads as INHERITED. The channel
 * provides it to everything, which is the more useful fact about it — and it is
 * what makes "Remove" on that chip mean "exclude it from this Short" rather than
 * "delete a row and watch the tag come straight back from the channel".
 *
 * The corollary the UI must honour: there is nothing to ADD for a tag that is
 * already effective. An "add" affordance on one would write a row that changes
 * nothing.
 *
 * Total and pure. Duplicates within any input array collapse, so no id can ever
 * appear twice in the result whatever the caller hands in.
 */
export function resolveContentTypes(
  input: ResolveContentTypesInput,
): ContentTypeResolution {
  const { channelTypeIds, manualIds, excludedIds } = input;

  // The overwhelmingly common Short: no deviations at all, so it is exactly its
  // channel. Worth the early exit — this runs per video per filter change.
  const excluded = excludedIds.length > 0 ? new Set(excludedIds) : null;

  const effective: ResolvedContentType[] = [];
  const seen = new Set<string>();

  for (const id of channelTypeIds) {
    if (excluded?.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    effective.push({ id, origin: "inherited" });
  }

  for (const id of manualIds) {
    // Already inherited: it appears once, and as inherited. See the precedence
    // note above — this is that decision, and it is the only place it is made.
    if (seen.has(id)) continue;
    // A manual row and an exclusion for the same tag cannot both exist — the
    // unique constraint on (organization, video, content type) makes it one row
    // with one state — but this function is also handed optimistically patched
    // client caches, so the refusal wins rather than being assumed impossible.
    if (excluded?.has(id)) continue;
    seen.add(id);
    effective.push({ id, origin: "manual" });
  }

  // Sorted by id so the arrays are stable across renders and across a re-save
  // that happened to reorder the inputs. Chips are ordered by the catalogue
  // downstream, so this is about identity, not presentation.
  effective.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const suppressed =
    excluded === null
      ? NO_IDS
      : [...new Set(channelTypeIds.filter((id) => excluded.has(id)))].sort();

  if (effective.length === 0 && suppressed.length === 0) return EMPTY_RESOLUTION;

  return {
    effective,
    effectiveIds: effective.map((entry) => entry.id),
    suppressedIds: suppressed,
  };
}

/** The effective ids alone, for callers that never look at the origin. */
export function effectiveContentTypeIds(input: ResolveContentTypesInput): readonly string[] {
  return resolveContentTypes(input).effectiveIds;
}

export interface DeviationPlanInput {
  /** What the channel provides right now. */
  readonly channelTypeIds: readonly string[];
  /** The complete set the caller wants this Short to end up carrying. */
  readonly desiredIds: readonly string[];
  /**
   * Manual rows the Short already has.
   *
   * Passed in rather than derived, because the plan is not a pure function of
   * the desired set — see the note on the redundant-manual rule below. Keeping
   * that rule HERE rather than in the service is the point of this module: the
   * server has no policy of its own to drift from.
   */
  readonly existingManualIds: readonly string[];
  /**
   * Refusal rows the Short already has.
   *
   * Needed for the DORMANT ones: a refusal recorded while the channel provided
   * the tag, which the channel has since dropped. Such a row is not part of
   * anything currently effective, so a plan computed from the desired set alone
   * simply does not mention it — and the reconciler, seeing a row the plan does
   * not account for, deletes it.
   *
   * That would make an override survive only until the next unrelated edit to
   * the Short, which is precisely the case the tombstone exists for: the whole
   * promise is that re-adding the tag to the channel does not quietly undo
   * somebody's "no".
   */
  readonly existingExcludedIds: readonly string[];
}

export interface DeviationPlan {
  readonly manualIds: readonly string[];
  readonly excludedIds: readonly string[];
}

/**
 * The inverse direction: a DESIRED EFFECTIVE SET becomes deviations.
 *
 * This is what `setVideoContentTypes` needs. The client sends the complete set
 * it wants the Short to carry — which is the only thing it can honestly send,
 * since that is what a person sees and edits — and the storage layer has to
 * translate it into the two kinds of row that are allowed to exist.
 *
 *   • a channel tag the caller does NOT want  → an exclusion
 *   • a wanted tag the channel does NOT give  → a manual row
 *   • a wanted tag the channel DOES give      → normally nothing at all
 *
 * THE ONE EXCEPTION, AND IT IS DELIBERATE: a manual row that ALREADY EXISTS for
 * a tag that is still wanted is KEPT, even when the channel now also provides
 * it. Dropping it would be a silent destruction of somebody's explicit "yes" on
 * the strength of a condition that can change — the channel picking up the tag
 * this week and dropping it next would take the Short's own classification with
 * it, and nobody would connect the two edits. What is never done is CREATE such
 * a row: a tag the channel already provides is a no-op, never a new manual row,
 * so the row count still scales with judgements people actually made rather
 * than with the size of the catalogue.
 *
 * Round-trips with `resolveContentTypes`: resolving the plan against the same
 * channel tags yields exactly `desiredIds`. That identity is pinned by a test,
 * because it is the whole contract between the two halves of this file.
 */
export function planDeviations(input: DeviationPlanInput): DeviationPlan {
  const { channelTypeIds, desiredIds, existingManualIds, existingExcludedIds } = input;

  const channel = new Set(channelTypeIds);
  const desired = new Set(desiredIds);
  const existingManual = new Set(existingManualIds);
  const existingExcluded = new Set(existingExcludedIds);

  const excludedIds = [
    // LIVE refusals: the channel gives it, nobody wants it on this Short.
    ...[...channel].filter((id) => !desired.has(id)),
    // DORMANT tombstones, carried forward untouched. The channel does not give
    // the tag today, so the row changes nothing about what this Short is — and
    // that is exactly why it has to be preserved rather than tidied away. Drop
    // it and the refusal lasts only until somebody edits this Short for an
    // unrelated reason, after which the channel re-adding the tag would put it
    // straight back on a Short whose owner had explicitly refused it.
    //
    // Not carried forward if the tag is now WANTED: asking for it back is the
    // deliberate undo, and it becomes a manual row below.
    ...[...existingExcluded].filter((id) => !channel.has(id) && !desired.has(id)),
  ].sort();

  const manualIds = [...desired]
    .filter((id) => !channel.has(id) || existingManual.has(id))
    .sort();

  return { manualIds, excludedIds };
}
