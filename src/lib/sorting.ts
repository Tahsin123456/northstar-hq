import type { ChannelMetrics } from "@/lib/analytics/types";
import type { ChannelDTO } from "@/lib/dto";

/** Every column the comparison table can be ordered by. */
export type SortKey =
  | "name"
  | "subscribers"
  | "totalViews"
  | "shortsUploaded"
  | "averageViews"
  | "medianViews"
  | "bestShort"
  | "hitCount"
  | "hitRate"
  | "consistency"
  | "lastUpdated";

export type SortDirection = "asc" | "desc";

export interface SortState {
  readonly key: SortKey;
  readonly direction: SortDirection;
}

/**
 * Hit rate descending is the default because it is the question the product
 * exists to answer. The table should open already showing the answer.
 */
export const DEFAULT_SORT: SortState = { key: "hitRate", direction: "desc" };

export interface SortableRow {
  readonly channel: ChannelDTO;
  readonly metrics: ChannelMetrics;
}

/** Extracts the comparable value for a column. `null` means "no data". */
function valueFor(row: SortableRow, key: SortKey): number | string | null {
  switch (key) {
    case "name":
      return row.channel.displayName.toLocaleLowerCase();
    case "subscribers":
      return row.channel.subscriberCount;
    case "totalViews":
      return row.metrics.totalViews;
    case "shortsUploaded":
      return row.metrics.totalShorts;
    case "averageViews":
      return row.metrics.averageViews;
    case "medianViews":
      return row.metrics.medianViews;
    case "bestShort":
      return row.metrics.bestShort?.views ?? null;
    case "hitCount":
      return row.metrics.hits.hits;
    case "hitRate":
      return row.metrics.hits.rate;
    case "consistency":
      return row.metrics.consistencyScore;
    case "lastUpdated":
      return row.channel.lastFetchedAt;
    default:
      return null;
  }
}

/**
 * Sorts rows, keeping "no data" rows at the bottom in *both* directions.
 *
 * This matters more than it sounds, and it matters more again now. A channel
 * with no Shorts this period has a `null` hit rate, not a zero — and so does a
 * channel whose Shorts are all still inside their hit windows, or all in a
 * niche nobody has configured. If nulls sorted as zero, all three would flood
 * the top of an ascending sort and read as the worst performers, when in fact
 * they are unmeasured, unfinished and unconfigured respectively. Parking them
 * at the end in either direction keeps the ranked list about channels that
 * actually have a number.
 */
export function sortRows<T extends SortableRow>(
  rows: readonly T[],
  sort: SortState,
  options: {
    /**
     * Float the user's own channels above competitors while leaving them in
     * the same ranked list. Deliberately a *pre-sort partition* rather than a
     * separate table: the whole point of tracking competitors is comparing
     * against them, and splitting the table would make that a two-step task.
     */
    ownFirst?: boolean;
  } = {},
): T[] {
  const factor = sort.direction === "asc" ? 1 : -1;

  return [...rows].sort((a, b) => {
    if (options.ownFirst) {
      const aOwn = a.channel.ownershipType === "own" ? 0 : 1;
      const bOwn = b.channel.ownershipType === "own" ? 0 : 1;
      if (aOwn !== bOwn) return aOwn - bOwn;
    }

    const aValue = valueFor(a, sort.key);
    const bValue = valueFor(b, sort.key);

    const aMissing = aValue === null || aValue === undefined;
    const bMissing = bValue === null || bValue === undefined;
    if (aMissing && bMissing) return tieBreak(a, b);
    if (aMissing) return 1;
    if (bMissing) return -1;

    if (typeof aValue === "string" || typeof bValue === "string") {
      const comparison = String(aValue).localeCompare(String(bValue));
      return comparison !== 0 ? comparison * factor : tieBreak(a, b);
    }

    const comparison = (aValue as number) - (bValue as number);
    return comparison !== 0 ? comparison * factor : tieBreak(a, b);
  });
}

/**
 * Stable tie-break: more DECIDED Shorts first, then alphabetically.
 *
 * Two channels both at 40% are not equally convincing — one proved it over 50
 * decided Shorts and the other over 5. Decided rather than uploaded, because a
 * channel that published forty Shorts this week has not yet proved anything
 * with them: they are all pending, they are in nobody's rate, and ranking on
 * them would let volume alone break a tie between two measured results.
 * Uploads remain the tie-break when neither side has anything decided.
 */
function tieBreak(a: SortableRow, b: SortableRow): number {
  const byJudged = b.metrics.hits.judged - a.metrics.hits.judged;
  if (byJudged !== 0) return byJudged;
  const byVolume = b.metrics.totalShorts - a.metrics.totalShorts;
  if (byVolume !== 0) return byVolume;
  return a.channel.displayName.localeCompare(b.channel.displayName);
}

/** Sensible initial direction when a user clicks a column header. */
export function defaultDirectionFor(key: SortKey): SortDirection {
  // Names read best A→Z; every metric reads best biggest-first.
  return key === "name" ? "asc" : "desc";
}

export function nextSortState(current: SortState, key: SortKey): SortState {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: defaultDirectionFor(key) };
}
