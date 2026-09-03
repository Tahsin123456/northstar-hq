"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { NicheViewsGainedDTO, NicheViewsGainedEntryDTO } from "@/lib/dto";
import type { DateRange } from "@/lib/analytics/types";
import type { NicheFormat } from "@/lib/niches/niche-format";

/**
 * Views gained per niche — the read behind every niche money figure.
 *
 * The Overview earnings panel and the niche card's value strip price what the
 * tracked channels GAINED over the selected period: each channel's counter at
 * the period's close minus the same counter at its start, read from the
 * `ChannelViewSnapshot` series the sync writes on every run. See
 * `channel-views-gained.ts` for the rules.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE RANGE IS IN THIS QUERY KEY, AND WHY THAT DOES NOT BREAK THE RULE
 * ─────────────────────────────────────────────────────────────────────────────
 * The dataset's promise — moving a filter never refetches — holds for filters
 * that are pure re-slices of a payload already in the browser. A views-GAINED
 * figure is not one of those: it is a difference between counter readings
 * bracketing the period's ends, aggregated on the server, and the browser
 * never receives the reading series to re-slice. A wider period is different
 * data, exactly as the finance ledger's is, so the range keys the query — the
 * same reasoning `use-finance.ts` records at length. What must still never
 * appear in the key is any filter the dataset DOES answer client-side, and
 * `filters-never-refetch.test.ts` holds this file to that.
 *
 * ONE HOOK FOR BOTH SURFACES. The Overview panel and the niche cards read the
 * same key, so React Query's cache — not discipline — is what guarantees the
 * two screens price the same period from the same measurement.
 */

/** Prefix key: invalidate this wherever the dataset itself is invalidated —
 * a refresh writes new snapshots, which moves every delta measured to now. */
export const VIEWS_GAINED_KEY = ["views-gained"] as const;

const MS_PER_DAY = 86_400_000;

/**
 * Snaps the filter range to whole UTC days, for the same mechanical reason
 * `financeRangeFor` does: `useFilters().range` is re-anchored to a clock that
 * ticks every 30 seconds, and feeding the raw `endMs` into the key would mint
 * a new key twice a minute and refetch on a timer for a range describing the
 * same days. Semantically the snap is harmless here — the measurement takes
 * the last snapshot at or before each boundary, and midnight either side of a
 * tick brackets the identical readings.
 */
export function viewsGainedRangeFor(range: DateRange): DateRange {
  const startMs = Math.floor(range.startMs / MS_PER_DAY) * MS_PER_DAY;
  const endMs = Math.ceil(range.endMs / MS_PER_DAY) * MS_PER_DAY;
  return { startMs, endMs: endMs > startMs ? endMs : startMs + MS_PER_DAY };
}

export function useNicheViewsGained(
  format: NicheFormat,
  range: DateRange,
  /**
   * Caller-provided, because the caller knows two things this hook does not:
   * whether the reader may see niche economics at all (no rate means nothing
   * to price, so the read would be waste), and whether its own inputs are
   * ready. A disabled query costs nothing and renders as "loading" nowhere.
   */
  enabled: boolean,
) {
  const snapped = viewsGainedRangeFor(range);
  return useQuery<NicheViewsGainedDTO>({
    queryKey: [...VIEWS_GAINED_KEY, format, snapped.startMs, snapped.endMs] as const,
    queryFn: () => api.getNicheViewsGained(format, snapped),
    enabled,
    // Snapshots accrue on the refresh cadence, not per keystroke; five stale
    // minutes cannot change a settled day's delta, and mutations that DO move
    // it (a refresh, a tracker edit) invalidate the prefix explicitly.
    staleTime: 5 * 60 * 1000,
  });
}

/** The response, keyed for the per-niche lookups both surfaces do. */
export function nicheGainedById(
  response: NicheViewsGainedDTO,
): ReadonlyMap<string, NicheViewsGainedEntryDTO> {
  return new Map(response.niches.map((entry) => [entry.nicheId, entry]));
}
