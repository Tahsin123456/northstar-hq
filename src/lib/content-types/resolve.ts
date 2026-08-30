/**
 * ==========================================================================
 * THE RESOLUTION RULE, WRITTEN ONCE
 * ==========================================================================
 *
 *     effective(short) = (inherited − short's exclusions) ∪ short's manual tags
 *
 * WHAT CHANGED, AND IT IS ONLY THE FIRST TERM. `inherited` used to mean "the
 * tags on this Short's channel" — a flat set, true of every Short the channel
 * had ever published or ever would. It now means "the tags whose RULE COVERS
 * THIS SHORT'S PUBLISH DATE", because a channel that made rankings all last year
 * and switched to cutscenes in March is two claims, not one, and the flat set
 * could only ever hold one of them. Everything below the first term is
 * untouched: exclusions still subtract, manual rows still add, and a tombstone
 * still outlives the thing it refused.
 *
 * INHERITED TAGS ARE NEVER STORED. There is no row for an inherited tag and
 * there must never be one. A `VideoContentType` row is always a DEVIATION from
 * what the channel's rules say:
 *
 *   • "manual"   — this Short carries a tag its channel's rules do not give it.
 *   • "excluded" — this Short refuses a tag a rule does give it. A TOMBSTONE,
 *                  kept even after the rule stops covering the Short, so
 *                  re-opening the rule does not silently undo somebody's "no".
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
 * the staleness this design exists to avoid. A rule gained or retired would
 * reach nothing already rendered. The rules stay the live source and the payload
 * carries them alongside the two short deviation arrays; the join happens here.
 */

/**
 * Shared empty results, so a miss does not allocate and every memo downstream
 * holds. Declared first because the timeline below closes over them at module
 * evaluation time.
 */
const NO_IDS: readonly string[] = [];
const NO_RESOLVED: readonly ResolvedContentType[] = [];

/**
 * One `ChannelContentTypeRule`, as far as resolution is concerned.
 *
 * A CLAIM ABOUT A STRETCH OF TIME, and deliberately nothing else: the streak
 * bookkeeping that lets a rule retire itself lives on the same row but plays no
 * part in what a Short carries, so it is not in this shape. Whether a rule
 * closed itself after three overrides or somebody closed it by hand, the Short
 * either falls inside the window or does not.
 *
 * Epoch milliseconds on both ends, because this type crosses the wire: the
 * browser resolves the same rules the server does, and a `Date` would arrive
 * there as a string that compares wrong.
 */
export interface ChannelContentTypeRuleWindow {
  readonly contentTypeId: string;
  /** Shorts published at or after this instant are covered. */
  readonly effectiveFrom: number;
  /** Shorts published BEFORE this are covered. `null` — still claiming new uploads. */
  readonly effectiveUntil: number | null;
}

/**
 * Does this rule reach a Short published then?
 *
 * HALF-OPEN, `[effectiveFrom, effectiveUntil)`, and the closed end is the half
 * that matters. Closing a rule sets `effectiveUntil` to the publish date of the
 * Short somebody first said no to, so that Short must come out from under the
 * rule — an inclusive end would leave the rule still claiming the very upload
 * that proved it wrong. The open start is then forced by symmetry: two
 * consecutive rules for the same tag meet at one instant and exactly one of them
 * may own it.
 */
export function ruleCoversPublishDate(
  rule: ChannelContentTypeRuleWindow,
  publishedAt: number,
): boolean {
  if (publishedAt < rule.effectiveFrom) return false;
  return rule.effectiveUntil === null || publishedAt < rule.effectiveUntil;
}

/**
 * THE FIRST TERM: what a Short published at this instant inherits.
 *
 * Total and pure, like everything else here. Duplicate rules for one tag —
 * legitimate, since a channel may carry "Ranking until March" and "Ranking again
 * from September" — collapse to one id, because a tag is either inherited or it
 * is not and nothing downstream can use it twice.
 *
 * For a channel's whole library, prefer `buildInheritanceTimeline` below: this
 * is the definition, that is the same definition arranged so a few thousand
 * Shorts do not each walk the rule list.
 */
export function inheritedContentTypeIds(
  rules: readonly ChannelContentTypeRuleWindow[],
  publishedAt: number,
): readonly string[] {
  if (rules.length === 0) return NO_IDS;

  const ids = new Set<string>();
  for (const rule of rules) {
    if (ruleCoversPublishDate(rule, publishedAt)) ids.add(rule.contentTypeId);
  }
  if (ids.size === 0) return NO_IDS;
  return [...ids].sort();
}

/**
 * A channel's rules, arranged for answering the same question a few thousand
 * times.
 *
 * WHY THIS EXISTS AT ALL, since `inheritedContentTypeIds` already answers it:
 * the flat channel array it replaces was ONE array shared by every Short on the
 * channel, and several things downstream quietly depended on that. The client
 * index hands the same `ContentTypeResolution` object to every Short that does
 * not deviate; the tally hoists one resolve out of its inner loop; the React
 * memos below both compare by reference. Resolving per Short from a rule list
 * would allocate a fresh array per row and defeat all of it.
 *
 * So the rules are cut into SEGMENTS at their own boundaries. Inside a segment
 * nothing changes, so every Short in it inherits the identical array — the same
 * object, not an equal one — and a channel whose rules are all open-ended and
 * epoch-dated (which is every rule the migration wrote) has exactly one segment
 * and therefore exactly the sharing the flat array used to give for free.
 *
 * Lookup is a binary search over the boundaries rather than a walk over the
 * rules: the cost stops depending on how many times the channel has changed its
 * mind.
 */
export interface InheritanceTimeline {
  /** What a Short published at this instant inherits. Shared per segment. */
  readonly at: (publishedAt: number) => readonly string[];
  /**
   * Every tag any rule has ever given this channel, sorted.
   *
   * The CHANNEL-level answer, for the surfaces whose unit is a channel rather
   * than a Short — the dashboard's content-type filter, and the "untagged
   * channels" backlog count beside it. A row there is a channel and its metrics
   * describe everything it published, so "does this channel make Rankings?" is
   * about its whole history and not about whichever rule happens to be open
   * today. A retired rule still describes a back catalogue.
   */
  readonly everClaimed: readonly string[];
}

const EMPTY_TIMELINE: InheritanceTimeline = {
  at: () => NO_IDS,
  everClaimed: NO_IDS,
};

export function buildInheritanceTimeline(
  rules: readonly ChannelContentTypeRuleWindow[],
): InheritanceTimeline {
  if (rules.length === 0) return EMPTY_TIMELINE;

  // Every instant at which the answer can change. A rule's start adds its tag
  // and a rule's end removes it, so between two adjacent boundaries the set is
  // constant — which is the property the whole structure is built on.
  const boundaries = [
    ...new Set(
      rules.flatMap((rule) =>
        rule.effectiveUntil === null
          ? [rule.effectiveFrom]
          : [rule.effectiveFrom, rule.effectiveUntil],
      ),
    ),
  ].sort((a, b) => a - b);

  // Resolved once per segment, at the segment's own start — which is inside it,
  // because the windows are half-open at the end.
  const segments = boundaries.map((start) => inheritedContentTypeIds(rules, start));

  const everClaimed = [...new Set(rules.map((rule) => rule.contentTypeId))].sort();

  return {
    at(publishedAt) {
      // Before the earliest rule begins nothing is claimed. Common enough to be
      // worth the check: a rule applied from a Short covers that channel's back
      // catalogue by starting at or before its earliest Short, but a rule
      // written by hand need not.
      if (publishedAt < boundaries[0]) return NO_IDS;

      // The last boundary at or before this instant. Its segment is the one this
      // Short falls in.
      let low = 0;
      let high = boundaries.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (boundaries[mid] <= publishedAt) low = mid;
        else high = mid - 1;
      }
      return segments[low];
    },
    everClaimed,
  };
}

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
   * Inherited tags this Short is currently refusing.
   *
   * `inheritedIds ∩ excludedIds` — the tombstones that are actually doing work
   * right now, as opposed to dormant ones for tags no rule gives this Short any
   * more. It is what lets the picker offer "restore" on the one tag a person can
   * meaningfully un-refuse, and say nothing about tombstones that currently
   * suppress nothing.
   *
   * A rule retiring is now one of the ways a tombstone goes dormant, alongside
   * the rule being closed by hand. In both cases the refusal stops suppressing
   * anything and stops being offered — and is still kept, because re-opening the
   * rule must not quietly undo it.
   */
  readonly suppressedIds: readonly string[];
}

export interface ResolveContentTypesInput {
  /**
   * What this Short's channel gives IT — the rules that cover its publish date,
   * already resolved.
   *
   * RENAMED FROM `channelTypeIds`, and the rename is the point: what used to
   * arrive here was a fact about the channel, true of all its Shorts at once.
   * What arrives now is a fact about THIS Short's place in the channel's
   * history, and a caller that kept passing the channel's whole tag list would
   * be silently re-introducing the bug this round removes. Every call site had
   * to be looked at, so none of them compiles until it has been.
   */
  readonly inheritedIds: readonly string[];
  /** `state: "manual"` rows — tags this Short carries that its rules do not give. */
  readonly manualIds: readonly string[];
  /** `state: "excluded"` rows — tags this Short refuses. */
  readonly excludedIds: readonly string[];
}

export const EMPTY_RESOLUTION: ContentTypeResolution = {
  effective: NO_RESOLVED,
  effectiveIds: NO_IDS,
  suppressedIds: NO_IDS,
};

/**
 * Resolve one Short against what it inherits.
 *
 * PRECEDENCE, DECIDED HERE AND NOWHERE ELSE: if a tag is BOTH manually added and
 * inherited, it appears ONCE and reads as INHERITED. A rule provides it to
 * everything in its window, which is the more useful fact about it — and it is
 * what makes "Remove" on that chip mean "exclude it from this Short" rather than
 * "delete a row and watch the tag come straight back from the rule".
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
  const { inheritedIds, manualIds, excludedIds } = input;

  // The overwhelmingly common Short: no deviations at all, so it is exactly what
  // its channel's rules say. Worth the early exit — this runs per video per
  // filter change.
  const excluded = excludedIds.length > 0 ? new Set(excludedIds) : null;

  const effective: ResolvedContentType[] = [];
  const seen = new Set<string>();

  for (const id of inheritedIds) {
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
      : [...new Set(inheritedIds.filter((id) => excluded.has(id)))].sort();

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
  /** What this Short inherits right now — the rules that cover its publish date. */
  readonly inheritedIds: readonly string[];
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
   * Needed for the DORMANT ones: a refusal recorded while a rule covered this
   * Short, whose rule has since been closed or retired. Such a row is not part
   * of anything currently effective, so a plan computed from the desired set
   * alone simply does not mention it — and the reconciler, seeing a row the plan
   * does not account for, deletes it.
   *
   * That would make an override survive only until the next unrelated edit to
   * the Short, which is precisely the case the tombstone exists for: the whole
   * promise is that re-opening a rule does not quietly undo somebody's "no".
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
 *   • an inherited tag the caller does NOT want  → an exclusion
 *   • a wanted tag nothing inherits              → a manual row
 *   • a wanted tag already inherited             → normally nothing at all
 *
 * THE ONE EXCEPTION, AND IT IS DELIBERATE: a manual row that ALREADY EXISTS for
 * a tag that is still wanted is KEPT, even when a rule now also provides it.
 * Dropping it would be a silent destruction of somebody's explicit "yes" on the
 * strength of a condition that can change — a rule opening this week and
 * retiring next would take the Short's own classification with it, and nobody
 * would connect the two edits. What is never done is CREATE such a row: a tag
 * already inherited is a no-op, never a new manual row, so the row count still
 * scales with judgements people actually made rather than with the size of the
 * catalogue.
 *
 * Round-trips with `resolveContentTypes`: resolving the plan against the same
 * inherited ids yields exactly `desiredIds`. That identity is pinned by a test,
 * because it is the whole contract between the two halves of this file.
 */
export function planDeviations(input: DeviationPlanInput): DeviationPlan {
  const { inheritedIds, desiredIds, existingManualIds, existingExcludedIds } = input;

  const inherited = new Set(inheritedIds);
  const desired = new Set(desiredIds);
  const existingManual = new Set(existingManualIds);
  const existingExcluded = new Set(existingExcludedIds);

  const excludedIds = [
    // LIVE refusals: a rule gives it, nobody wants it on this Short.
    ...[...inherited].filter((id) => !desired.has(id)),
    // DORMANT tombstones, carried forward untouched. Nothing gives this Short
    // the tag today, so the row changes nothing about what it is — and that is
    // exactly why it has to be preserved rather than tidied away. Drop it and
    // the refusal lasts only until somebody edits this Short for an unrelated
    // reason, after which re-opening the rule would put the tag straight back on
    // a Short whose owner had explicitly refused it.
    //
    // Not carried forward if the tag is now WANTED: asking for it back is the
    // deliberate undo, and it becomes a manual row below.
    ...[...existingExcluded].filter((id) => !inherited.has(id) && !desired.has(id)),
  ].sort();

  const manualIds = [...desired]
    .filter((id) => !inherited.has(id) || existingManual.has(id))
    .sort();

  return { manualIds, excludedIds };
}
