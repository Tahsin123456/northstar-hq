import {
  buildInheritanceTimeline,
  resolveContentTypes,
  type ChannelContentTypeRuleWindow,
} from "./resolve";

/**
 * ==========================================================================
 * HOW MANY SHORTS CARRY EACH TAG — THE ONLY WAY THAT NUMBER CAN BE GOT
 * ==========================================================================
 *
 * `ContentTypeDTO` ships `manualVideoCount` and `excludedVideoCount`, and
 * NEITHER of them answers "how many Shorts are filed as Memes". They cannot:
 * inheritance means a tag on a channel reaches every Short beneath it with no
 * row written for any of them, so a row count is a count of DEVIATIONS. A menu
 * that showed it would offer "Memes · 3" and then return four hundred rows.
 *
 * The real answer requires resolving every Short against its channel, which is
 * a client-side pass over the dataset already in memory — the same pass, and the
 * same rule, as the filter the number labels. That is the point of putting it
 * here rather than at each call site: the badge on the filter menu and the feed
 * the filter produces are two readings of one derivation, so they cannot drift
 * into offering a number and delivering a different one.
 *
 * NOT ON THE SERVER, AND NOT ON THE CATALOGUE ROW. A server-side tally would be
 * a snapshot taken when the payload was assembled, and this dataset is re-sliced
 * in the browser for a whole session without refetching — so tagging a channel
 * in another tab would leave every count stale while the chips beneath them had
 * already moved. Deriving it from the same arrays the UI renders keeps the two
 * in step by construction.
 *
 * ONE PASS, BOTH ANSWERS. The untagged count is not a separate walk: a Short is
 * untagged exactly when its resolution is empty, so computing it here rather
 * than beside costs nothing and removes the chance of the two disagreeing about
 * what "untagged" means.
 */

/** The fields this tally reads. Structural, so `VideoDTO` satisfies it. */
export interface TallyVideo {
  readonly isShort: boolean;
  /**
   * Epoch ms — and now load-bearing rather than incidental.
   *
   * What a Short inherits depends on WHEN it was published, so two Shorts on one
   * channel can legitimately carry different tags with no deviation rows between
   * them. A tally that ignored this would count a whole library under whatever
   * the channel's newest rule happens to say.
   */
  readonly publishedAt: number;
  readonly manualContentTypeIds: readonly string[];
  readonly excludedContentTypeIds: readonly string[];
}

/** One channel's Shorts, with the rules that decide what each of them inherits. */
export interface TallyGroup {
  readonly rules: readonly ChannelContentTypeRuleWindow[];
  readonly videos: readonly TallyVideo[];
}

export interface EffectiveShortsTally {
  /**
   * typeId -> Shorts effectively carrying it.
   *
   * OVERLAPPING, like every other content-type count in this codebase: a Short
   * with two tags is in both entries, so these do not sum to `total`. Absent
   * rather than zero for a tag nothing carries, so a caller reads it as
   * `?? 0` and an unused tag costs no entry.
   */
  readonly byType: ReadonlyMap<string, number>;
  /** Shorts no tag reaches — from their channel or from themselves. */
  readonly untagged: number;
  /** Shorts considered. Long-form never enters any of these numbers. */
  readonly total: number;
}

const EMPTY_TALLY: EffectiveShortsTally = {
  byType: new Map(),
  untagged: 0,
  total: 0,
};

/**
 * Tally the effective tags across a set of channels' Shorts.
 *
 * Pure and total. Long-form is dropped first — every content-type surface in the
 * product counts Shorts, and a tally that quietly included the channel's
 * uploads would disagree with the feed it labels.
 *
 * Single pass. What a Short inherits now depends on WHEN it was published, so
 * the answer can no longer be computed once per channel — but it changes only at
 * the channel's own rule boundaries, so the segments are built once per channel
 * and a Short that does not deviate simply IS its segment's array. The whole
 * thing stays one walk over the library.
 */
export function tallyEffectiveShorts(
  groups: readonly TallyGroup[],
): EffectiveShortsTally {
  if (groups.length === 0) return EMPTY_TALLY;

  const byType = new Map<string, number>();
  let untagged = 0;
  let total = 0;

  for (const group of groups) {
    /*
     * The channel's rules, cut into segments once.
     *
     * The hoist that used to lift ONE resolve out of the inner loop is now this:
     * what a Short inherits varies with its publish date, so the answer cannot
     * be computed once per channel — but the number of DISTINCT answers is the
     * number of times the channel changed its mind, which is small. Every Short
     * inside one segment gets the identical shared array, so the common channel
     * (one open-ended rule, or none) costs exactly what it did before.
     */
    const timeline = buildInheritanceTimeline(group.rules);

    for (const video of group.videos) {
      if (!video.isShort) continue;
      total += 1;

      const inheritedIds = timeline.at(video.publishedAt);

      const deviates =
        video.manualContentTypeIds.length > 0 ||
        video.excludedContentTypeIds.length > 0;

      // The overwhelmingly common Short says nothing of its own, so its
      // effective tags are exactly what it inherits — already an array, already
      // shared with everything else in its segment.
      const effectiveIds = deviates
        ? resolveContentTypes({
            inheritedIds,
            manualIds: video.manualContentTypeIds,
            excludedIds: video.excludedContentTypeIds,
          }).effectiveIds
        : inheritedIds;

      if (effectiveIds.length === 0) {
        untagged += 1;
        continue;
      }

      for (const id of effectiveIds) {
        byType.set(id, (byType.get(id) ?? 0) + 1);
      }
    }
  }

  return { byType, untagged, total };
}
