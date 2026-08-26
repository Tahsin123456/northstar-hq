"use client";

import * as React from "react";
import Link from "next/link";
import { GitCompareArrows, Tv2, X } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { AddChannelDialog } from "@/components/channels/add-channel-dialog";
import { PeriodSelector } from "@/components/dashboard/period-selector";
import { SearchInput } from "@/components/dashboard/search-input";
import { ThresholdSelector } from "@/components/dashboard/threshold-selector";
import {
  ComparisonChart,
  seriesColor,
  type ComparisonDatum,
} from "@/components/charts/comparison-chart";
import { ErrorState } from "@/components/common/error-state";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { InfoTip } from "@/components/ui/tooltip";
import {
  filterRows,
  useChannelRows,
  useScopedRows,
  type ChannelRow,
} from "@/hooks/use-channel-analytics";
import {
  NicheFilterControl,
  OwnershipFilterControl,
} from "@/components/dashboard/scope-filters";
import { useDataset } from "@/hooks/use-dataset";
import { useFilters } from "@/components/providers/filters-provider";
import {
  EM_DASH,
  formatCompactNumber,
  formatFraction,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import { cn } from "@/lib/utils";

/** Beyond this the table stops being readable on a normal screen. */
const MAX_COMPARE = 6;

/**
 * Compare — head-to-head across a chosen subset.
 *
 * The metric table transposes the dashboard: metrics down the side, channels
 * across the top. That is the right orientation for a small set, because it
 * puts the numbers being compared adjacent to each other on the same row
 * instead of separated by a column of unrelated values.
 */
export default function ComparePage() {
  const { data, isLoading, error, refetch } = useDataset();
  const { threshold, niche, ownership } = useFilters();

  const allRows = useChannelRows(data);
  // Comparison operates inside the active scope: with "GTA + Our Channels"
  // selected, the picker offers exactly those channels. Comparing across a
  // filter the user has set would quietly contradict it.
  const rows = useScopedRows(allRows, niche, ownership);
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const [query, setQuery] = React.useState("");

  // Preselect the top channels by hit rate so the page is useful immediately
  // rather than presenting an empty comparison and an instruction.
  const initialised = React.useRef(false);
  React.useEffect(() => {
    if (initialised.current || rows.length === 0) return;
    initialised.current = true;
    const ranked = [...rows]
      .filter((row) => row.metrics.hitRate !== null)
      .sort((a, b) => (b.metrics.hitRate ?? 0) - (a.metrics.hitRate ?? 0));
    const seed = (ranked.length > 0 ? ranked : rows).slice(0, 3);
    setSelectedIds(seed.map((row) => row.channel.id));
  }, [rows]);

  // A selection that falls outside the current scope is dropped rather than
  // rendered, so the chart can never show a channel the filters exclude.
  const selected = React.useMemo(
    () =>
      selectedIds
        .map((id) => rows.find((row) => row.channel.id === id))
        .filter((row): row is ChannelRow => row !== undefined),
    [selectedIds, rows],
  );

  const pickerRows = React.useMemo(() => filterRows(rows, query), [rows, query]);

  const toggle = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id)
        ? prev.filter((existing) => existing !== id)
        : prev.length >= MAX_COMPARE
          ? prev
          : [...prev, id],
    );
  };

  const chartData: ComparisonDatum[] = selected.map((row, index) => ({
    id: row.channel.id,
    name: row.channel.displayName,
    hitRate: row.metrics.hitRate,
    hitCount: row.metrics.hitCount,
    totalShorts: row.metrics.totalShorts,
    medianViews: row.metrics.medianViews,
    colorIndex: index,
  }));

  if (error) {
    return (
      <PageContainer>
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader
        title="Compare"
        description={`Put channels side by side at ${formatCompactNumber(threshold)}+ views.`}
      />

      <div className="flex flex-wrap items-center gap-2">
        <NicheFilterControl
          niches={data?.niches ?? []}
          unassignedCount={allRows.filter((r) => r.channel.niches.length === 0).length}
        />
        <OwnershipFilterControl
          ownCount={allRows.filter((r) => r.channel.ownershipType === "own").length}
          competitorCount={allRows.filter((r) => r.channel.ownershipType !== "own").length}
        />
        <PeriodSelector />
        <ThresholdSelector />
      </div>

      {isLoading ? (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          <Skeleton className="h-80 w-full rounded-lg" />
          <Skeleton className="h-80 w-full rounded-lg" />
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Tv2 />}
            title="Nothing to compare yet"
            description="Add at least two channels to see them side by side."
            action={
              <AddChannelDialog
                trigger={
                  <Button variant="primary">
                    <span className="text-base leading-none">+</span>
                    Add Channel
                  </Button>
                }
              />
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          {/* --- Picker --- */}
          <Card className="flex h-fit flex-col">
            <CardHeader>
              <CardTitle>Select channels</CardTitle>
              <CardDescription>
                {selected.length} of {MAX_COMPARE} selected
              </CardDescription>
            </CardHeader>

            <div className="px-5 pb-3">
              <SearchInput value={query} onChange={setQuery} placeholder="Filter…" />
            </div>

            <div className="max-h-[420px] overflow-y-auto border-t border-border">
              {pickerRows.length === 0 ? (
                <p className="px-5 py-6 text-center text-[12px] text-subtle-foreground">
                  No channels match.
                </p>
              ) : (
                pickerRows.map((row) => {
                  const isSelected = selectedIds.includes(row.channel.id);
                  const atLimit = !isSelected && selectedIds.length >= MAX_COMPARE;
                  const colorIndex = selectedIds.indexOf(row.channel.id);

                  return (
                    <label
                      key={row.channel.id}
                      className={cn(
                        "flex cursor-pointer items-center gap-2.5 border-b border-border px-5 py-2.5 transition-colors last:border-b-0",
                        atLimit ? "cursor-not-allowed opacity-40" : "hover:bg-surface-hover/50",
                      )}
                    >
                      <Checkbox
                        checked={isSelected}
                        disabled={atLimit}
                        onCheckedChange={() => toggle(row.channel.id)}
                      />
                      <Avatar
                        src={row.channel.avatarUrl}
                        name={row.channel.displayName}
                        size={22}
                      />
                      <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
                        {row.channel.displayName}
                      </span>
                      <span className="tnum shrink-0 text-[11px] text-subtle-foreground">
                        {formatPercent(row.metrics.hitRate, 0)}
                      </span>
                      {isSelected ? (
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{ background: seriesColor(colorIndex) }}
                          aria-hidden
                        />
                      ) : null}
                    </label>
                  );
                })
              )}
            </div>
          </Card>

          {/* --- Comparison --- */}
          <div className="flex min-w-0 flex-col gap-4">
            {selected.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<GitCompareArrows />}
                  title="Pick channels to compare"
                  description={`Select up to ${MAX_COMPARE} channels from the list to see their hit rates side by side.`}
                />
              </Card>
            ) : (
              <>
                <Card>
                  <CardHeader>
                    <CardTitle>Hit rate</CardTitle>
                    <CardDescription>
                      The share of each channel&rsquo;s Shorts that reached{" "}
                      {formatCompactNumber(threshold)} views this period.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ComparisonChart data={chartData} />
                  </CardContent>
                </Card>

                <ComparisonTable rows={selected} onRemove={toggle} />
              </>
            )}
          </div>
        </div>
      )}
    </PageContainer>
  );
}

interface MetricRow {
  label: string;
  hint?: string;
  /** Higher is better — used to mark the leader in each row. */
  higherIsBetter: boolean;
  value: (row: ChannelRow) => number | null;
  format: (row: ChannelRow) => React.ReactNode;
}

const METRIC_ROWS: MetricRow[] = [
  {
    label: "Subscribers",
    higherIsBetter: true,
    value: (row) => row.channel.subscriberCount,
    format: (row) =>
      row.channel.hiddenSubscriberCount
        ? EM_DASH
        : formatCompactNumber(row.channel.subscriberCount),
  },
  {
    label: "Shorts uploaded",
    hint: "Shorts published inside the selected period. Long-form is excluded.",
    higherIsBetter: true,
    value: (row) => row.metrics.totalShorts,
    format: (row) => formatNumber(row.metrics.totalShorts),
  },
  {
    label: "Total views",
    higherIsBetter: true,
    value: (row) => row.metrics.totalViews,
    format: (row) => formatCompactNumber(row.metrics.totalViews),
  },
  {
    label: "Average views",
    higherIsBetter: true,
    value: (row) => row.metrics.averageViews,
    format: (row) => formatCompactNumber(row.metrics.averageViews),
  },
  {
    label: "Median views",
    hint: "More resistant than the average to a single viral outlier.",
    higherIsBetter: true,
    value: (row) => row.metrics.medianViews,
    format: (row) => formatCompactNumber(row.metrics.medianViews),
  },
  {
    label: "Best Short",
    higherIsBetter: true,
    value: (row) => row.metrics.bestShort?.views ?? null,
    format: (row) => formatCompactNumber(row.metrics.bestShort?.views ?? null),
  },
  {
    label: "Hits",
    higherIsBetter: true,
    value: (row) => row.metrics.hitCount,
    format: (row) => formatFraction(row.metrics.hitCount, row.metrics.totalShorts),
  },
  {
    label: "Hit rate",
    hint: "The headline metric: hits divided by Shorts uploaded in the period.",
    higherIsBetter: true,
    value: (row) => row.metrics.hitRate,
    format: (row) => formatPercent(row.metrics.hitRate),
  },
  {
    label: "Consistency",
    hint: "0–100. How tightly this channel's Shorts cluster around their median.",
    higherIsBetter: true,
    value: (row) => row.metrics.consistencyScore,
    format: (row) =>
      row.metrics.consistencyScore === null
        ? EM_DASH
        : row.metrics.consistencyScore.toFixed(0),
  },
  {
    label: "Top 10% average",
    hint: "Mean views of this channel's best-performing decile — how high its ceiling is.",
    higherIsBetter: true,
    value: (row) => row.metrics.topDecileAverageViews,
    format: (row) => formatCompactNumber(row.metrics.topDecileAverageViews),
  },
];

function ComparisonTable({
  rows,
  onRemove,
}: {
  rows: readonly ChannelRow[];
  onRemove: (id: string) => void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-border bg-surface-sunken">
              <th
                scope="col"
                className="sticky left-0 z-10 min-w-[160px] bg-surface-sunken px-4 py-3"
              >
                <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                  Metric
                </span>
              </th>
              {rows.map((row, index) => (
                <th
                  key={row.channel.id}
                  scope="col"
                  className="min-w-[132px] px-4 py-3 text-right"
                >
                  <div className="flex items-center justify-end gap-2">
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: seriesColor(index) }}
                      aria-hidden
                    />
                    <Link
                      href={`/channels/${row.channel.id}`}
                      className="truncate text-[12px] font-medium text-foreground transition-colors hover:text-accent"
                      title={row.channel.displayName}
                    >
                      {row.channel.displayName}
                    </Link>
                    <button
                      type="button"
                      onClick={() => onRemove(row.channel.id)}
                      aria-label={`Remove ${row.channel.displayName} from comparison`}
                      className="rounded p-0.5 text-subtle-foreground transition-colors hover:text-foreground"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {METRIC_ROWS.map((metric) => {
              // Mark the leader so a scan down a row lands on the winner
              // without comparing every number by eye.
              const values = rows.map((row) => metric.value(row));
              const present = values.filter((v): v is number => v !== null);
              const best =
                present.length > 1
                  ? metric.higherIsBetter
                    ? Math.max(...present)
                    : Math.min(...present)
                  : null;

              return (
                <tr
                  key={metric.label}
                  className="border-b border-border transition-colors last:border-b-0 hover:bg-surface-hover/40"
                >
                  <th
                    scope="row"
                    className="sticky left-0 z-10 bg-surface px-4 py-2.5 text-left font-normal"
                  >
                    <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
                      {metric.label}
                      {metric.hint ? <InfoTip>{metric.hint}</InfoTip> : null}
                    </span>
                  </th>

                  {rows.map((row, index) => {
                    const value = values[index];
                    const isBest = best !== null && value !== null && value === best;
                    return (
                      <td key={row.channel.id} className="px-4 py-2.5 text-right">
                        <span
                          className={cn(
                            "tnum text-[13px]",
                            value === null
                              ? "text-subtle-foreground"
                              : isBest
                                ? "font-medium text-foreground"
                                : "text-muted-foreground",
                          )}
                        >
                          {metric.format(row)}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="border-t border-border px-4 py-2.5 text-[11px] text-subtle-foreground">
        The strongest value in each row is shown in full contrast. An em dash
        means the channel published no Shorts in this period — not a zero.
      </p>
    </Card>
  );
}
