"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { History, Info } from "lucide-react";
import { api } from "@/lib/api-client";
import { calculateViewDistribution } from "@/lib/analytics/distribution";
import type { JudgedVideo, DateRange } from "@/lib/analytics/types";
import type { NicheFormat } from "@/lib/niches/niche-format";
import { useNow } from "@/hooks/use-now";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDate, formatPercent } from "@/lib/format";
import { DistributionChart } from "./distribution-chart";
import { cn } from "@/lib/utils";

/**
 * View distribution, with the option to compare against an earlier snapshot of
 * the same window.
 *
 * THE POINT OF THE HISTORICAL VIEW
 * A single distribution says what the output looks like now. The comparison
 * says which way it is *moving* — whether a channel is producing more sub-100K
 * Shorts, or shifting mass into the 1M+ buckets. That directional read is the
 * only reason to look backwards at all.
 *
 * IT IS BACKED BY REAL SNAPSHOTS OR IT IS NOT SHOWN
 * Reconstructing "30 days ago" from today's view counts would produce a chart
 * that looks plausible and is meaningless — every Short would appear to have
 * had its present-day views a month early. The comparison therefore reads from
 * the stored `VideoSnapshot` series, and when coverage is insufficient it says
 * so plainly instead of drawing something.
 */

interface HistoryOption {
  id: string;
  label: string;
  daysAgo: number;
}

const HISTORY_OPTIONS: readonly HistoryOption[] = [
  { id: "7d", label: "7D ago", daysAgo: 7 },
  { id: "14d", label: "14D ago", daysAgo: 14 },
  { id: "30d", label: "30D ago", daysAgo: 30 },
  { id: "90d", label: "90D ago", daysAgo: 90 },
];

export function DistributionPanel({
  shorts,
  range,
  threshold,
  /** Restricts the comparison series to one channel, when on a channel page. */
  channelId,
  format = "shorts",
  className,
}: {
  shorts: readonly JudgedVideo[];
  range: DateRange;
  /**
   * `null` when the niche in view has no configured threshold. The histogram
   * itself is unaffected — where Shorts land is a fact about the Shorts — but
   * no bucket is shaded as a hit zone, because there is no hit to zone.
   */
  threshold: number | null;
  channelId?: string;
  /**
   * Which format the (already-filtered) list describes. The histogram is
   * format-blind — it buckets whatever it is handed — but the HISTORICAL
   * comparison is not: the history endpoint reconstructs Shorts only, so on
   * a Long Form page the compare-with control is withheld entirely rather
   * than offered and answered with the other product's data.
   */
  format?: NicheFormat;
  className?: string;
}) {
  const [compareTo, setCompareTo] = React.useState<string | null>(null);
  const now = useNow();

  const windowDays = Math.max(
    1,
    Math.round((range.endMs - range.startMs) / 86_400_000),
  );

  const selected = HISTORY_OPTIONS.find((o) => o.id === compareTo) ?? null;
  const asOfMs =
    selected && now > 0 ? now - selected.daysAgo * 86_400_000 : null;

  const history = useQuery({
    queryKey: ["history", "views-as-of", asOfMs, windowDays],
    queryFn: () => api.getHistoricalViews(asOfMs!, windowDays),
    enabled: asOfMs !== null,
    staleTime: 5 * 60_000,
  });

  const currentBins = React.useMemo(
    () => calculateViewDistribution(shorts, threshold),
    [shorts, threshold],
  );

  // The historical series runs through the *same* distribution function as the
  // live one, so the two are directly comparable by construction.
  const comparisonBins = React.useMemo(() => {
    const data = history.data;
    if (!data || !data.available) return null;

    const scoped = channelId
      ? data.videos.filter((v) => v.channelId === channelId)
      : data.videos;
    if (scoped.length === 0) return null;

    /*
     * `hit: null` on every row, and that is the honest value rather than a
     * placeholder.
     *
     * These are RECONSTRUCTED view counts as of a past date, assembled from the
     * snapshot table so the two distributions can be compared. A verdict is
     * about a Short, not about a point in time, and the historical endpoint has
     * no evaluation to return — so every one of these lands in `unscoreable`
     * and contributes to no rate. Nothing on this comparison reads a tally, so
     * nothing is lost; what matters is that they cannot be silently counted as
     * misses by a future reader who does.
     */
    const asAnalytics: JudgedVideo[] = scoped.map((v) => ({
      id: v.id,
      youtubeVideoId: v.id,
      title: "",
      publishedAt: v.publishedAt,
      views: v.views,
      likes: null,
      comments: null,
      durationSeconds: 0,
      isShort: true,
      // Synthetic rows faking Shorts, so they say so on both columns: the
      // history endpoint only ever reconstructs Shorts, and a fabricated
      // "uncertain" here would drop every row out of both formats' filters.
      classification: "short",
      hit: null,
    }));

    return calculateViewDistribution(asAnalytics, threshold);
  }, [history.data, threshold, channelId]);

  return (
    <div className={className}>
      {format === "shorts" ? (
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 inline-flex items-center gap-1.5 text-[11px] text-subtle-foreground">
          <History className="size-3" />
          Compare with
        </span>

        <PeriodChip
          label="Current only"
          active={compareTo === null}
          onClick={() => setCompareTo(null)}
        />
        {HISTORY_OPTIONS.map((option) => (
          <PeriodChip
            key={option.id}
            label={option.label}
            active={compareTo === option.id}
            onClick={() => setCompareTo(compareTo === option.id ? null : option.id)}
          />
        ))}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="How historical comparison works"
              className="inline-flex size-3.5 items-center justify-center rounded-full text-subtle-foreground transition-colors hover:text-muted-foreground"
            >
              <Info className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            Historical distributions come from stored view snapshots — the view
            counts actually recorded at that time. They are never reconstructed
            from today&rsquo;s numbers, which would show the present distribution
            with a past date on it.
          </TooltipContent>
        </Tooltip>
      </div>
      ) : null}

      {selected && history.isLoading ? (
        <Skeleton className="h-[280px] w-full rounded-lg" />
      ) : selected && history.data && !history.data.available ? (
        <>
          <HistoryUnavailable
            label={selected.label}
            asOfMs={asOfMs}
            coverage={history.data.coverage}
            covered={history.data.covered}
            total={history.data.totalInWindow}
            earliestSnapshotMs={history.data.earliestSnapshotMs}
          />
          <DistributionChart bins={currentBins} threshold={threshold} />
        </>
      ) : (
        <DistributionChart
          bins={currentBins}
          threshold={threshold}
          comparisonBins={comparisonBins}
          comparisonLabel={selected?.label}
        />
      )}
    </div>
  );
}

function PeriodChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors duration-150",
        active
          ? "border-accent bg-accent-subtle text-foreground"
          : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

/**
 * The honest empty state.
 *
 * Says exactly what is missing and when it will be available, rather than a
 * generic "no data" — the user needs to know this is a coverage limitation
 * that resolves itself, not a bug or an empty period.
 */
function HistoryUnavailable({
  label,
  asOfMs,
  coverage,
  covered,
  total,
  earliestSnapshotMs,
}: {
  label: string;
  asOfMs: number | null;
  coverage: number;
  covered: number;
  total: number;
  earliestSnapshotMs: number | null;
}) {
  return (
    <div className="mb-3 rounded-lg border border-warning/25 bg-warning-subtle px-3.5 py-3">
      <p className="text-[13px] font-medium text-foreground">
        Historical data unavailable for {label}
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
        {total === 0 ? (
          <>
            No Shorts were published in the window ending{" "}
            {asOfMs ? formatDate(asOfMs) : "then"}.
          </>
        ) : (
          <>
            Only {covered} of {total} Shorts ({formatPercent(coverage * 100, 0)}) had a
            view snapshot recorded at that point, which is not enough to reconstruct the
            distribution reliably.
          </>
        )}{" "}
        {earliestSnapshotMs ? (
          <>
            Snapshot history currently begins {formatDate(earliestSnapshotMs)} and grows
            with every refresh.
          </>
        ) : (
          <>Snapshots are recorded on each refresh and will build up over time.</>
        )}{" "}
        The current distribution is shown below.
      </p>
    </div>
  );
}

