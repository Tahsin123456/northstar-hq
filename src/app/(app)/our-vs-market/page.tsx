"use client";

import * as React from "react";
import Link from "next/link";
import { Minus, Swords, TrendingDown, TrendingUp, Users } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { PeriodSelector } from "@/components/dashboard/period-selector";
import { ThresholdSelector } from "@/components/dashboard/threshold-selector";
import { NicheFilterControl } from "@/components/dashboard/scope-filters";
import { ErrorState } from "@/components/common/error-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { InfoTip } from "@/components/ui/tooltip";
import { useChannelRows } from "@/hooks/use-channel-analytics";
import { useDataset } from "@/hooks/use-dataset";
import { useFilters } from "@/components/providers/filters-provider";
import { compareToMarket, type MarketMetric } from "@/lib/analytics/market";
import {
  calculateMarketShare,
  calculateMarketShareSeries,
  pickShareGranularity,
  TRACKED_MARKET_SHARE_DEFINITION,
} from "@/lib/analytics/market-share";
import { calculateTrend, previousRange } from "@/lib/analytics/trends";
import { MarketShareDonut, MarketShareTrendChart } from "@/components/charts/market-share-charts";
import { TrendIndicator } from "@/components/metrics/trend-indicator";
import { GenerateReportDialog } from "@/components/report/generate-report-dialog";
import { BRAND } from "@/lib/brand";
import { calculateViewDistribution } from "@/lib/analytics/distribution";
import {
  AXIS_TICK,
  percentAxisWidth,
  TOOLTIP_CONTAINMENT,
  xAxisHeight,
} from "@/components/charts/chart-layout";
import { EM_DASH, formatCompactNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Our vs Market — are we beating the field in this niche?
 *
 * Splits the active niche into our channels and the competitor pool and
 * compares them on the metrics that describe output quality. Deliberately
 * scoped to one niche at a time: comparing our GTA channels against the
 * combined average of GTA, Finance and Minecraft competitors would be
 * meaningless.
 */
export default function OurVsMarketPage() {
  const { data, isLoading, error, refetch } = useDataset();
  const { range, threshold, niche } = useFilters();

  const rows = useChannelRows(data);

  const inNiche = React.useMemo(
    () =>
      rows.filter((row) => {
        if (niche === "all") return true;
        if (niche === "unassigned") return row.channel.niches.length === 0;
        return row.channel.niches.some((n) => n.id === niche);
      }),
    [rows, niche],
  );

  const ourChannels = inNiche.filter((r) => r.channel.ownershipType === "own");
  const competitorChannels = inNiche.filter((r) => r.channel.ownershipType !== "own");

  const comparison = React.useMemo(
    () =>
      compareToMarket(
        ourChannels.map((r) => ({ videos: r.videos })),
        competitorChannels.map((r) => ({ videos: r.videos })),
        range,
        threshold,
      ),
    [ourChannels, competitorChannels, range, threshold],
  );

  const share = React.useMemo(
    () =>
      calculateMarketShare(
        ourChannels.map((r) => ({ videos: r.videos })),
        competitorChannels.map((r) => ({ videos: r.videos })),
        range,
      ),
    [ourChannels, competitorChannels, range],
  );

  // Same window immediately before this one, so the delta is like-for-like.
  const previousShare = React.useMemo(
    () =>
      calculateMarketShare(
        ourChannels.map((r) => ({ videos: r.videos })),
        competitorChannels.map((r) => ({ videos: r.videos })),
        previousRange(range),
      ),
    [ourChannels, competitorChannels, range],
  );

  const shareTrend = React.useMemo(
    () =>
      calculateTrend(share.sharePercent, previousShare.sharePercent, {
        direction: "higherIsBetter",
        unit: "percentagePoints",
      }),
    [share, previousShare],
  );

  const shareSeries = React.useMemo(
    () =>
      calculateMarketShareSeries(
        ourChannels.map((r) => ({ videos: r.videos })),
        competitorChannels.map((r) => ({ videos: r.videos })),
        range,
        pickShareGranularity(range),
      ),
    [ourChannels, competitorChannels, range],
  );

  const nicheName =
    niche === "all"
      ? "all niches"
      : niche === "unassigned"
        ? "uncategorised channels"
        : (data?.niches.find((n) => n.id === niche)?.name ?? "this niche");

  if (error) {
    return (
      <PageContainer>
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      </PageContainer>
    );
  }

  const hasBothSides = ourChannels.length > 0 && competitorChannels.length > 0;

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader
        title="Our vs Market"
        description={`How your channels compare to the competitor pool in ${nicheName}.`}
        actions={<GenerateReportDialog />}
      />

      <div className="flex flex-wrap items-center gap-2">
        <NicheFilterControl
          niches={data?.niches ?? []}
          unassignedCount={rows.filter((r) => r.channel.niches.length === 0).length}
        />
        <PeriodSelector />
        <ThresholdSelector />
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-28 w-full rounded-lg" />
          <Skeleton className="h-72 w-full rounded-lg" />
        </div>
      ) : !hasBothSides ? (
        <Card>
          <EmptyState
            icon={<Users />}
            title={
              ourChannels.length === 0
                ? "No channels marked as yours in this niche"
                : "No competitor channels in this niche"
            }
            description={
              ourChannels.length === 0 ? (
                <>
                  This page compares your channels against the market. Mark at least one
                  channel as <strong className="text-foreground">Our channel</strong> from
                  its row menu, then come back.
                </>
              ) : (
                <>
                  There is nothing to compare against yet. Add a competitor channel to{" "}
                  {nicheName} to see how you stack up.
                </>
              )
            }
            action={
              <Button variant="primary" asChild>
                <Link href="/channels">Manage channels</Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <Scoreboard
            comparison={comparison}
            nicheName={nicheName}
            ourCount={ourChannels.length}
            marketCount={competitorChannels.length}
          />

          <div className="grid gap-4 xl:grid-cols-[minmax(260px,1fr)_1.6fr]">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-1.5">
                  <CardTitle>Tracked market share</CardTitle>
                  <InfoTip>{TRACKED_MARKET_SHARE_DEFINITION}</InfoTip>
                </div>
                <CardDescription>
                  <span className="inline-flex items-center gap-2">
                    <TrendIndicator trend={shareTrend} valueFormat="percent" size="sm" />
                    <span>vs previous period</span>
                  </span>
                </CardDescription>
              </CardHeader>
              <CardContent>
                <MarketShareDonut share={share} ourLabel={BRAND.company} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Market share over time</CardTitle>
                <CardDescription>
                  Are we taking more of {nicheName === "all niches" ? "the tracked market" : nicheName} over time?
                </CardDescription>
              </CardHeader>
              <CardContent>
                <MarketShareTrendChart
                  points={shareSeries}
                  averageShare={share.sharePercent}
                />
              </CardContent>
            </Card>
          </div>

          <MetricTable metrics={comparison.metrics} />

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Headline comparison</CardTitle>
                <CardDescription>
                  Hit rate and median views, side by side. The two numbers that decide
                  whether output is working.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <HeadlineChart comparison={comparison} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>View distribution</CardTitle>
                <CardDescription>
                  Where each side&rsquo;s Shorts land, as a share of that side&rsquo;s
                  output — so the shapes are comparable even when the volumes are not.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <DistributionComparison
                  ourViews={comparison.ours.shorts.map((s) => s.views)}
                  marketViews={comparison.market.shorts.map((s) => s.views)}
                  threshold={threshold}
                />
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </PageContainer>
  );
}

function Scoreboard({
  comparison,
  nicheName,
  ourCount,
  marketCount,
}: {
  comparison: ReturnType<typeof compareToMarket>;
  nicheName: string;
  ourCount: number;
  marketCount: number;
}) {
  // Niche names are user-supplied and often already start with an article
  // ("The Last of Us"), so a hardcoded "the" would read as "the The Last of
  // Us". Drop ours when theirs is already there.
  const marketLabel = nicheName.replace(/^(the|a|an) /i, "");

  const above = comparison.metrics.filter((m) => m.outperforming === true);
  const below = comparison.metrics.filter((m) => m.outperforming === false);
  const neutral = comparison.metrics.filter(
    (m) => m.direction === "neutral" || m.outperforming === null,
  );

  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border",
            comparison.outperformingCount * 2 >= comparison.comparableCount
              ? "border-success/25 bg-success-subtle text-success"
              : "border-warning/25 bg-warning-subtle text-warning",
          )}
        >
          <Swords className="size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-medium tracking-tight text-foreground">
            {comparison.comparableCount === 0 ? (
              <>Not enough data to score {nicheName} yet.</>
            ) : (
              <>
                You&rsquo;re outperforming the {marketLabel} market in{" "}
                <span className="text-accent">
                  {comparison.outperformingCount} of {comparison.comparableCount}
                </span>{" "}
                scored metrics.
              </>
            )}
          </h2>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {/* "1 of your channel" is wrong: the partitive keeps the plural
                regardless of the count, unlike the competitor noun. */}
            {ourCount} of your channels vs {marketCount} competitor{" "}
            {marketCount === 1 ? "channel" : "channels"} ·{" "}
            {comparison.ours.shorts.length} vs {comparison.market.shorts.length} Shorts in
            this period.
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <ScoreList title="Above market" tone="success" metrics={above} />
            <ScoreList title="Below market" tone="danger" metrics={below} />
          </div>

          {neutral.length > 0 ? (
            <p className="mt-3 border-t border-border pt-3 text-[11px] leading-relaxed text-subtle-foreground">
              Not scored:{" "}
              {neutral.map((m) => m.label.toLowerCase()).join(", ")}. Upload frequency in
              particular is a strategy choice, not a performance result — posting more is
              not inherently better, so declaring a winner on it would be misleading.
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function ScoreList({
  title,
  tone,
  metrics,
}: {
  title: string;
  tone: "success" | "danger";
  metrics: readonly MarketMetric[];
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
        {tone === "success" ? (
          <TrendingUp className="size-3 text-success" />
        ) : (
          <TrendingDown className="size-3 text-danger" />
        )}
        {title}
      </div>
      {metrics.length === 0 ? (
        <p className="mt-1.5 text-[12px] text-subtle-foreground">{EM_DASH}</p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1">
          {metrics.map((metric) => (
            <li key={metric.key} className="flex items-center justify-between gap-3 text-[12px]">
              <span className="truncate text-foreground">{metric.label}</span>
              <span
                className={cn(
                  "tnum shrink-0",
                  tone === "success" ? "text-success" : "text-danger",
                )}
              >
                {formatDeltaFor(metric)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatValue(value: number | null, format: MarketMetric["format"]): string {
  if (value === null) return EM_DASH;
  switch (format) {
    case "percent":
      return formatPercent(value);
    case "views":
      return formatCompactNumber(value);
    case "decimal":
      return value.toFixed(1);
    case "count":
    default:
      return String(Math.round(value));
  }
}

/**
 * Percentage-point deltas for rates, relative percentages for magnitudes.
 * Saying a hit rate is "+33%" when it moved 21% -> 28% is a classic way to
 * mislead; those seven points are percentage points, not a third better.
 */
function formatDeltaFor(metric: MarketMetric): string {
  if (metric.format === "percent") {
    if (metric.delta === null) return EM_DASH;
    const sign = metric.delta > 0 ? "+" : metric.delta < 0 ? "−" : "";
    return `${sign}${Math.abs(metric.delta).toFixed(1)} pp`;
  }
  if (metric.deltaPercent === null) return EM_DASH;
  const sign = metric.deltaPercent > 0 ? "+" : metric.deltaPercent < 0 ? "−" : "";
  return `${sign}${Math.abs(metric.deltaPercent).toFixed(0)}%`;
}

function MetricTable({ metrics }: { metrics: readonly MarketMetric[] }) {
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-left">
          <thead>
            <tr className="border-b border-border bg-surface-sunken">
              <th className="px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                Metric
              </th>
              <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-accent">
                Our channels
              </th>
              <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                Market
              </th>
              <th className="px-4 py-2.5 text-right text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                Difference
              </th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((metric) => (
              <tr
                key={metric.key}
                className="border-b border-border transition-colors last:border-b-0 hover:bg-surface-hover/40"
              >
                <td className="px-4 py-2.5">
                  <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
                    {metric.label}
                    {metric.hint ? <InfoTip>{metric.hint}</InfoTip> : null}
                  </span>
                </td>
                <td className="tnum px-4 py-2.5 text-right text-[13px] font-medium text-foreground">
                  {formatValue(metric.ours, metric.format)}
                </td>
                <td className="tnum px-4 py-2.5 text-right text-[13px] text-muted-foreground">
                  {formatValue(metric.market, metric.format)}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <span
                    className={cn(
                      "tnum inline-flex items-center gap-1 text-[12px]",
                      metric.outperforming === true
                        ? "text-success"
                        : metric.outperforming === false
                          ? "text-danger"
                          : "text-subtle-foreground",
                    )}
                  >
                    {metric.outperforming === null ? (
                      <Minus className="size-3" />
                    ) : metric.outperforming ? (
                      <TrendingUp className="size-3" />
                    ) : (
                      <TrendingDown className="size-3" />
                    )}
                    {formatDeltaFor(metric)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border px-4 py-2.5 text-[11px] text-subtle-foreground">
        Rates are compared in percentage points (pp); magnitudes as a relative
        percentage. A dash means one side had no Shorts to measure.
      </p>
    </Card>
  );
}

function HeadlineChart({ comparison }: { comparison: ReturnType<typeof compareToMarket> }) {
  const hitRate = comparison.metrics.find((m) => m.key === "hitRate");
  const medianViews = comparison.metrics.find((m) => m.key === "medianViews");

  const data = [
    {
      metric: "Hit rate (%)",
      Ours: hitRate?.ours ?? 0,
      Market: hitRate?.market ?? 0,
    },
    {
      metric: "Median views",
      Ours: medianViews?.ours ?? 0,
      Market: medianViews?.market ?? 0,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {data.map((row) => {
        const max = Math.max(row.Ours, row.Market, 1);
        const isRate = row.metric.includes("%");
        return (
          <div key={row.metric}>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-subtle-foreground">
              {row.metric}
            </div>
            <div className="flex flex-col gap-1.5">
              {(["Ours", "Market"] as const).map((side) => {
                const value = row[side];
                return (
                  <div key={side} className="flex items-center gap-2.5">
                    <span className="w-12 shrink-0 text-[11px] text-muted-foreground">
                      {side}
                    </span>
                    <div className="h-4 flex-1 overflow-hidden rounded bg-surface-sunken">
                      <div
                        className={cn(
                          "h-full rounded transition-[width] duration-500",
                          side === "Ours" ? "bg-accent" : "bg-border-strong",
                        )}
                        style={{ width: `${Math.max(2, (value / max) * 100)}%` }}
                      />
                    </div>
                    <span className="tnum w-16 shrink-0 text-right text-[12px] text-foreground">
                      {isRate ? formatPercent(value) : formatCompactNumber(value)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DistributionComparison({
  ourViews,
  marketViews,
  threshold,
}: {
  ourViews: number[];
  marketViews: number[];
  threshold: number;
}) {
  const ourBins = calculateViewDistribution(
    ourViews.map((views, i) => ({
      id: `o${i}`,
      youtubeVideoId: `o${i}`,
      title: "",
      publishedAt: 0,
      views,
      likes: null,
      comments: null,
      durationSeconds: 0,
      isShort: true,
    })),
    threshold,
  );
  const marketBins = calculateViewDistribution(
    marketViews.map((views, i) => ({
      id: `m${i}`,
      youtubeVideoId: `m${i}`,
      title: "",
      publishedAt: 0,
      views,
      likes: null,
      comments: null,
      durationSeconds: 0,
      isShort: true,
    })),
    threshold,
  );

  // Shares, not counts: the two pools are different sizes, so raw bars would
  // compare volume rather than shape.
  const data = ourBins.map((bin, i) => ({
    label: bin.label,
    Ours: Math.round(bin.share * 1000) / 10,
    Market: Math.round((marketBins[i]?.share ?? 0) * 1000) / 10,
    isHitBucket: bin.isHitBucket,
  }));

  if (ourViews.length === 0 || marketViews.length === 0) {
    return (
      <div className="flex h-[220px] items-center justify-center rounded-lg border border-dashed border-border text-[13px] text-subtle-foreground">
        Not enough Shorts on both sides to compare
      </div>
    );
  }

  // Axis space is derived from the strings that will actually be drawn. The
  // previous negative left margin pulled the Y axis outside the SVG, so every
  // percentage tick was sliced by the left edge.
  const labels = data.map((d) => d.label);
  const maxShare = Math.max(...data.map((d) => Math.max(d.Ours, d.Market)), 10);
  const yAxisWidth = percentAxisWidth(maxShare);
  const xHeight = xAxisHeight(labels, { rotated: true });

  return (
    <div style={{ height: 240 + xHeight }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            interval={0}
            angle={-35}
            textAnchor="end"
            height={xHeight}
            tick={AXIS_TICK}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={yAxisWidth}
            tickFormatter={(v: number) => `${v}%`}
            tick={AXIS_TICK}
          />
          <RechartsTooltip
            cursor={{ fill: "var(--surface-hover)" }}
            contentStyle={{
              background: "var(--surface-raised)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 11,
            }}
            formatter={(value, name) => [`${Number(value ?? 0)}% of Shorts`, String(name ?? "")]}
            {...TOOLTIP_CONTAINMENT}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="Ours" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {data.map((entry, i) => (
              <Cell key={`o${i}`} fill="var(--chart-1)" />
            ))}
          </Bar>
          <Bar dataKey="Market" radius={[3, 3, 0, 0]} isAnimationActive={false}>
            {data.map((entry, i) => (
              <Cell key={`m${i}`} fill="var(--border-strong)" />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
