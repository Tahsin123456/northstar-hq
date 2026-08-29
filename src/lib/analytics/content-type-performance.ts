import { calculateHitRate, countHits } from "./hit-rate";
import { getShortsInDateRange } from "./filters";
import { mean, median, roundTo, sum } from "./stats";
import type { AnalyticsVideo, DateRange } from "./types";

/**
 * ==========================================================================
 * "WHAT KIND OF CONTENT IS ACTUALLY WORKING?"
 * ==========================================================================
 *
 * Content type as an analytics dimension: group the Shorts uploaded in the
 * window by the tags filed against them, and report how each tag performs.
 *
 * THE ROWS DO NOT SUM TO THE TOTAL, AND THAT IS NOT A BUG.
 *
 * A Short may carry several content types at once — "Character Moment" AND
 * "Funny Moment" is a normal, deliberate classification, and the picker does
 * not force a second choice. So a Short with two tags is counted in BOTH rows,
 * the counts overlap, and adding the column up gives a number larger than the
 * library. This is a set of OVERLAPPING SLICES, not a partition, and every
 * consumer has to say so: `taggedAssignments` is the sum of the tag rows and
 * `taggedShorts` is how many distinct Shorts they describe, so the UI can state
 * the overlap rather than leave a reader to discover it by adding up a column
 * and finding it wrong.
 *
 * IT COUNTS EFFECTIVE TAGS, AND IT HAS NO CHOICE.
 *
 * A Short's tags are its channel's, minus what it refuses, plus what it adds —
 * and the inherited majority of that is stored NOWHERE. Grouping by the rows
 * filed against each Short would therefore report a library where a channel
 * tagged "Rankings" with four hundred Shorts contributes four hundred to
 * "Untagged" and nothing to "Rankings": the table would say the team has
 * classified almost nothing, at the exact moment they had classified everything
 * in one gesture. The resolution happens before anything gets here — see
 * `effectiveContentTypeIds` on the input below, which is named the way it is so
 * that handing this function stored ids does not typecheck.
 *
 * THE UNTAGGED ROW IS PART OF THE ANSWER, NOT A REMAINDER.
 *
 * "Untagged: 310 Shorts" tells the owner how much of the library nobody has
 * classified, which is the first thing that makes every other row on the table
 * trustworthy or not. It is flagged `isUntagged` rather than being given a
 * sentinel id, because it is the one row that is NOT a tag: it cannot be
 * clicked through to a filter on a content type that does not exist, and a
 * caller that treats it as one should have to opt in by ignoring the flag.
 *
 * Its MEANING has moved with the rest: untagged is now "no tag reached this
 * Short from either direction" — its channel says nothing about it and nobody
 * said anything about it either. That is a stricter and much more useful claim
 * than the old one, and it is why the row is worth keeping rather than watching
 * it collapse to zero: the Shorts left in it are the genuinely undescribed ones,
 * on channels nobody has characterised.
 *
 * It is also the one row that never overlaps with any other — a Short is either
 * classified or it is not — so `untaggedShorts + taggedShorts === totalShorts`
 * holds exactly, and that is the only additive identity on this whole shape.
 *
 * A HIT IS DEFINED IN EXACTLY ONE PLACE.
 *
 * `countHits` / `calculateHitRate` from `./hit-rate`, which is the same pair
 * `calculateChannelMetrics` uses. There is one definition of a hit in this
 * codebase and this is not a second one — if the threshold rule changes, it
 * changes here for free.
 *
 * AND AN UNCONFIGURED THRESHOLD YIELDS `null`, NEVER `0`.
 *
 * Copied in spirit from `calculateChannelMetrics`, for the same reason set out
 * there: `0%` asserts "these Shorts were measured and none of them hit", which
 * is a completely different claim from "nobody has said what a hit is in this
 * niche". Everything that does not depend on a threshold — counts, medians,
 * means, total views — is still computed in full, because none of it was ever
 * in doubt. The UI renders the `null` as "Not configured".
 */

/**
 * The engine's video shape plus THE TAGS THAT ACTUALLY APPLY TO IT.
 *
 * Structural, not a Prisma or DTO type, so the maths stays testable with plain
 * objects and no database. Ids rather than objects because that is what travels
 * on the wire; the names come from the catalogue below.
 *
 * `VideoDTO` DELIBERATELY NO LONGER SATISFIES THIS. It used to, and a dataset
 * row could be handed straight in — a convenience that is now a trap, because a
 * `VideoDTO` carries deviations from its channel rather than its tags, and the
 * two coincide only for a Short on an untagged channel. The field is named for
 * what it must contain so the mistake is a compile error rather than a table
 * that quietly reports the wrong library; the caller resolves first, which it
 * can only do where the channel is in scope.
 */
export interface TaggedVideo extends AnalyticsVideo {
  /** `(channel's tags − exclusions) ∪ manual tags`, from `resolveContentTypes`. */
  readonly effectiveContentTypeIds: readonly string[];
}

/**
 * The catalogue entry this function needs, and nothing more.
 *
 * `name` and `colorIndex` are carried through so a caller does not have to
 * re-join the catalogue it just passed in, and `sortOrder` is not: the rows
 * come back ranked by what they measure, not by where the tag sits in a menu.
 */
export interface ContentTypeRef {
  readonly id: string;
  readonly name: string;
  readonly colorIndex: number;
}

export interface ContentTypePerformanceRow {
  /** The tag's id, or `null` for the untagged row. */
  readonly contentTypeId: string | null;
  readonly name: string;
  /** `null` on the untagged row, which is not a tag and has no accent. */
  readonly colorIndex: number | null;
  /** True on the one row that describes the absence of a classification. */
  readonly isUntagged: boolean;

  /** Shorts in the window carrying this tag. Overlaps other rows. */
  readonly shortsCount: number;
  readonly totalViews: number;
  /** `null` only when the row is empty, which this function never emits. */
  readonly medianViews: number | null;
  readonly meanViews: number | null;

  readonly hitCount: number;
  /**
   * Percentage 0..100, or `null` when there is no threshold to judge against.
   * Never `0` for want of a threshold — see the header.
   */
  readonly hitRate: number | null;

  /**
   * This row's Shorts as a share of every Short in the window, 0..1.
   *
   * Deliberately NOT a share of a partition: these do not sum to 1 when Shorts
   * carry several tags. It answers "how much of the library is this?", which is
   * the question a reader actually asks of a row like "Funny Memes — 42".
   */
  readonly shareOfShorts: number;
}

export interface ContentTypePerformance {
  readonly range: DateRange;
  readonly threshold: number | null;

  /**
   * One row per tag that has at least one Short in the window, ranked by
   * volume, plus the untagged row last when there is anything unclassified.
   */
  readonly rows: readonly ContentTypePerformanceRow[];

  /** Distinct Shorts in the window. The denominator of `shareOfShorts`. */
  readonly totalShorts: number;
  /** Distinct Shorts carrying at least one tag. */
  readonly taggedShorts: number;
  /** Distinct Shorts carrying none. `taggedShorts + untaggedShorts === totalShorts`. */
  readonly untaggedShorts: number;
  /**
   * The sum of the tag rows' `shortsCount`.
   *
   * Greater than `taggedShorts` exactly when some Short carries more than one
   * tag. This pair is what lets a caller state the overlap honestly instead of
   * presenting the table as a breakdown.
   */
  readonly taggedAssignments: number;
  /** `taggedAssignments > taggedShorts` — the UI's cue to explain the overlap. */
  readonly hasOverlap: boolean;
  /** Tags in the catalogue that no Short in this window carries. */
  readonly unusedContentTypeCount: number;
}

export interface ContentTypePerformanceInput {
  /** Shorts and long-form alike; the window and the Shorts filter are applied here. */
  readonly videos: readonly TaggedVideo[];
  readonly range: DateRange;
  /** `null` when the active niche has no configured threshold. */
  readonly threshold: number | null;
  /**
   * The organization's tags, for names and accents.
   *
   * ORG-WIDE AND FLAT. A content type is a tag on the organization's
   * vocabulary, not a niche's private list, so there is no niche narrowing to
   * apply here and any Short may carry any of them. An id on a video that the
   * catalogue does not contain is skipped rather than rendered as a bare cuid —
   * that only happens when the two are momentarily out of step, and inventing a
   * row named after a database id would be worse than briefly omitting it.
   */
  readonly contentTypes: readonly ContentTypeRef[];
}

/**
 * Performance by content type, over one window at one threshold.
 *
 * Pure and total, like the rest of this directory: hand it videos, a range, a
 * threshold and a catalogue, and it returns a complete set of rows with `null`
 * wherever a statistic genuinely does not exist.
 *
 * Single pass over the videos, then one pass per bucket. A dashboard holds a
 * few thousand Shorts and this runs on every filter change, so the grouping is
 * a Map of arrays rather than one `filter()` per tag.
 */
export function calculateContentTypePerformance(
  input: ContentTypePerformanceInput,
): ContentTypePerformance {
  const { videos, range, threshold, contentTypes } = input;

  // Shorts only, then inside the window — the same order, and the same helper,
  // as every other metric. Long-form can never reach the lines below.
  const shorts = getShortsInDateRange(videos, range);

  const known = new Map(contentTypes.map((type) => [type.id, type]));

  const buckets = new Map<string, AnalyticsVideo[]>();
  const untagged: AnalyticsVideo[] = [];
  let taggedShorts = 0;
  let taggedAssignments = 0;

  for (const short of shorts) {
    // Deduplicated per video. `resolveContentTypes` already guarantees it — a
    // tag both inherited and manually added collapses to one entry there — but
    // this function is structural and takes anything shaped like the input, and
    // a double count here would inflate a row silently rather than loudly.
    const ids = new Set(short.effectiveContentTypeIds);

    let counted = false;
    for (const id of ids) {
      if (!known.has(id)) continue;
      const bucket = buckets.get(id);
      if (bucket) bucket.push(short);
      else buckets.set(id, [short]);
      taggedAssignments += 1;
      counted = true;
    }

    // "Untagged" means no tag this catalogue knows about — which is the same
    // thing as no tag, for every purpose this table serves. A Short whose only
    // id is unrecognised would otherwise vanish from the table entirely, and
    // the untagged row exists precisely to account for everything.
    if (counted) taggedShorts += 1;
    else untagged.push(short);
  }

  const totalShorts = shorts.length;

  const rows: ContentTypePerformanceRow[] = [];

  for (const [id, bucketShorts] of buckets) {
    const type = known.get(id);
    // Unreachable — ids are only bucketed after a `known.has` — but narrowing
    // beats a non-null assertion.
    if (!type) continue;
    rows.push(
      buildRow(
        {
          contentTypeId: type.id,
          name: type.name,
          colorIndex: type.colorIndex,
          isUntagged: false,
        },
        bucketShorts,
        threshold,
        totalShorts,
      ),
    );
  }

  // Volume first, because the question is "what is working" and a tag with two
  // Shorts behind it is noise however well those two did. Name breaks ties so
  // the order is stable across renders rather than dependent on Map insertion.
  rows.sort(
    (a, b) => b.shortsCount - a.shortsCount || a.name.localeCompare(b.name),
  );

  // Always last, and only when there is something to report. A zero-Short
  // "Untagged" row would read as a claim that the backlog is clear, which is
  // true — and is better said by the row's absence than by a line of zeroes.
  if (untagged.length > 0) {
    rows.push(
      buildRow(
        {
          contentTypeId: null,
          name: UNTAGGED_ROW_LABEL,
          colorIndex: null,
          isUntagged: true,
        },
        untagged,
        threshold,
        totalShorts,
      ),
    );
  }

  return {
    range,
    threshold,
    rows,
    totalShorts,
    taggedShorts,
    untaggedShorts: untagged.length,
    taggedAssignments,
    hasOverlap: taggedAssignments > taggedShorts,
    unusedContentTypeCount: contentTypes.length - buckets.size,
  };
}

/** The label for the row that is not a tag. One string, so every surface agrees. */
export const UNTAGGED_ROW_LABEL = "Untagged";

/**
 * One row's statistics.
 *
 * Extracted so the untagged row is computed by *exactly* the same code as a
 * tag's — it is a real row about real Shorts, and the only thing that makes it
 * different is that nobody classified them.
 */
function buildRow(
  identity: Pick<
    ContentTypePerformanceRow,
    "contentTypeId" | "name" | "colorIndex" | "isUntagged"
  >,
  shorts: readonly AnalyticsVideo[],
  threshold: number | null,
  totalShorts: number,
): ContentTypePerformanceRow {
  const views = shorts.map((short) => short.views);
  const hitCount = countHits(shorts, threshold);
  const medianViews = median(views);
  const meanViews = mean(views);

  return {
    ...identity,
    shortsCount: shorts.length,
    totalViews: sum(views),
    medianViews: medianViews === null ? null : roundTo(medianViews, 0),
    meanViews: meanViews === null ? null : roundTo(meanViews, 0),
    hitCount,
    // The `threshold === null` guard is the whole point, and it is spelled out
    // rather than left to `calculateHitRate`: that function's `null` means "no
    // Shorts to divide by", and collapsing the two would make an unconfigured
    // niche indistinguishable from an empty row.
    hitRate: threshold === null ? null : calculateHitRate(hitCount, shorts.length),
    shareOfShorts: totalShorts > 0 ? shorts.length / totalShorts : 0,
  };
}
