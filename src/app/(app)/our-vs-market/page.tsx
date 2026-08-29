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
import {
  compareToMarket,
  type MarketMetric,
  type MarketPool,
} from "@/lib/analytics/market";
import {
  NOTHING_DECIDED_SHORT,
  UNCONFIGURED_RULE_SHORT,
} from "@/lib/analytics/constants";
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
import { HitRuleNotConfiguredNotice } from "@/components/metrics/hit-rule-not-configured";
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
          {/* Hit rate is one row of the comparison rather than the whole of it,
              so the page still earns its place with a null threshold — median
              views, upload cadence and market share are all unaffected. The
              banner says which row is missing and why. */}
          {threshold === null ? (
            <HitRuleNotConfiguredNotice nicheName={nicheName} />
          ) : null}

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

/**
 * The plainest kind of nothing, in one place so the two rows cannot word it
 * differently. Distinct from the em dash: this says why.
 */
const NO_SHORTS_IN_PERIOD = "No Shorts in period";

/** One side of one row: a figure, or the reason there isn't one. */
interface HeadlineSide {
  readonly label: "Ours" | "Market";
  readonly value: number | null;
  /** What to say in the bar's place. Only read when `value` is null. */
  readonly absence: string;
}

/**
 * Why a side has no hit rate — read off that side's own verdicts rather than
 * inferred from the missing number.
 *
 * The same three-way test `HitRateValue` makes, in the same order and in the
 * same words, because a chart and a stat disagreeing about which kind of
 * nothing this is would be the original bug wearing a different hat. Nothing
 * published, no rule to judge by, or a rule with nothing decided under it yet:
 * the first is a shrug, the second sends an admin to a settings screen and the
 * third means come back on Thursday.
 */
function hitRateAbsence(pool: MarketPool): string {
  const { totalShorts, hits } = pool.metrics;
  if (totalShorts === 0) return NO_SHORTS_IN_PERIOD;
  if (hits.judged === 0 && hits.tally.pending === 0 && hits.tally.unknown === 0) {
    return UNCONFIGURED_RULE_SHORT;
  }
  return NOTHING_DECIDED_SHORT;
}

/**
 * Hit rate and median views, ours beside the market's.
 *
 * A NULL RATE IS NOT A ZERO-HEIGHT BAR. `?? 0` stood in both rows, so a side
 * whose Shorts were all still inside their windows drew a bar and labelled it
 * "0.0%" — this chart asserting that nothing hit, on the same screen as the
 * metric table above it passing the same null through to an em dash.
 * `formatPercent` was already guarding it correctly; the coalesce is what got
 * past the guard.
 *
 * So an absent value draws NO BAR AT ALL and states which kind of nothing it
 * is. Not an empty track either: an empty track is still a bar of zero length,
 * and a reader has to measure it against its neighbour to tell "unmeasured"
 * from "measured and scored nothing" — which is the distinction the whole
 * redesign exists to make unmissable. Where neither side has a figure there is
 * no axis worth drawing and the row collapses to the reason alone.
 *
 * A genuine 0 still draws its 2%-wide sliver, and that is the point of keeping
 * the two cases apart: zero is a real, earned measurement and deserves to be
 * visible as one.
 */
function HeadlineChart({ comparison }: { comparison: ReturnType<typeof compareToMarket> }) {
  const hitRate = comparison.metrics.find((m) => m.key === "hitRate");
  const medianViews = comparison.metrics.find((m) => m.key === "medianViews");

  const rows: {
    metric: string;
    isRate: boolean;
    sides: readonly [HeadlineSide, HeadlineSide];
  }[] = [
    {
      metric: "Hit rate (%)",
      isRate: true,
      sides: [
        {
          label: "Ours",
          value: hitRate?.ours ?? null,
          absence: hitRateAbsence(comparison.ours),
        },
        {
          label: "Market",
          value: hitRate?.market ?? null,
          absence: hitRateAbsence(comparison.market),
        },
      ],
    },
    {
      metric: "Median views",
      isRate: false,
      // A median is null for exactly one reason — the side published nothing
      // this period — so there is no verdict to interrogate for this row.
      sides: [
        {
          label: "Ours",
          value: medianViews?.ours ?? null,
          absence: NO_SHORTS_IN_PERIOD,
        },
        {
          label: "Market",
          value: medianViews?.market ?? null,
          absence: NO_SHORTS_IN_PERIOD,
        },
      ],
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {rows.map((row) => {
        // Scaled over the values that exist. An absent side contributes nothing
        // to the axis rather than pinning it at zero.
        const present = row.sides
          .map((side) => side.value)
          .filter((value): value is number => value !== null);
        const max = Math.max(...present, 1);

        return (
          <div key={row.metric}>
            <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-subtle-foreground">
              {row.metric}
            </div>

            {present.length === 0 ? (
              <p className="text-[12px] text-subtle-foreground">
                {row.sides[0].absence === row.sides[1].absence
                  ? row.sides[0].absence
                  : `${row.sides[0].label}: ${row.sides[0].absence} · ${row.sides[1].label}: ${row.sides[1].absence}`}
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {row.sides.map((side) => (
                  <div key={side.label} className="flex items-center gap-2.5">
                    <span className="w-12 shrink-0 text-[11px] text-muted-foreground">
                      {side.label}
                    </span>
                    {side.value === null ? (
                      <span className="min-w-0 flex-1 truncate text-[11px] text-subtle-foreground">
                        {side.absence}
                      </span>
                    ) : (
                      <div className="h-4 flex-1 overflow-hidden rounded bg-surface-sunken">
                        <div
                          className={cn(
                            "h-full rounded transition-[width] duration-500",
                            side.label === "Ours" ? "bg-accent" : "bg-border-strong",
                          )}
                          style={{ width: `${Math.max(2, (side.value / max) * 100)}%` }}
                        />
                      </div>
                    )}
                    <span
                      className={cn(
                        "tnum w-16 shrink-0 text-right text-[12px]",
                        side.value === null ? "text-subtle-foreground" : "text-foreground",
                      )}
                    >
                      {/* Both of these render an em dash for null, which is the
                          guard that was always working here. */}
                      {row.isRate
                        ? formatPercent(side.value)
                        : formatCompactNumber(side.value)}
                    </span>
                  </div>
                ))}
              </div>
            )}
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
  /**
   * The view bar, or `null` when the selected niche has none configured.
   *
   * Marks where the bar falls on a LIFETIME axis. It is not a hit zone: a Short
   * reaches the top bucket whether it took two days or two years, and only one
   * of those is a hit.
   */
  threshold: number | null;
}) {
  /*
   * `hit: null` on every row, and it is the honest value rather than a filler.
   *
   * This comparison is handed two plain arrays of view counts — the two pools
   * are already flattened by the time they arrive, with no ids and no verdicts
   * to carry. It draws SHAPE, which is a real and useful thing to compare, and
   * it reads no tally at all. Passing nulls rather than fabricating verdicts is
   * what stops a future reader of these bins counting them as misses.
   */
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
      hit: null,
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
      hit: null,
    })),
    threshold,
  );

  // Shares, not counts: the two pools are different sizes, so raw bars would
  // compare volume rather than shape.
  const data = ourBins.map((bin, i) => ({
    label: bin.label,
    Ours: Math.round(bin.share * 1000) / 10,
    Market: Math.round((marketBins[i]?.share ?? 0) * 1000) / 10,
    isAboveThreshold: bin.isAboveThreshold,
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
