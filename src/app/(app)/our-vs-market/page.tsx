"use client";

import * as React from "react";
import Link from "next/link";
import { Eye, Minus, Swords, TrendingDown, TrendingUp, Users } from "lucide-react";
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
import { resolveHitDisplayState } from "@/lib/analytics/hit-display";
import {
  nicheSelection,
  scopeMarketComparison,
  type MarketScopeKind,
} from "@/lib/analytics/market-scope";
import {
  calculateMarketShare,
  calculateMarketShareSeries,
  pickShareGranularity,
  TRACKED_MARKET_SHARE_DEFINITION,
} from "@/lib/analytics/market-share";
import { NICHE_KIND_LABEL } from "@/lib/niches/niche-kind";
import type { NicheDTO } from "@/lib/dto";
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

/** Stable identity for the "dataset has not arrived" case, so the memos hold. */
const EMPTY_NICHES: readonly NicheDTO[] = [];

/**
 * Our vs Market — are we beating the field in this niche?
 *
 * Splits the active niche into our channels and the competitor pool and
 * compares them on the metrics that describe output quality. Deliberately
 * scoped to one niche at a time: comparing our GTA channels against the
 * combined average of GTA, Finance and Minecraft competitors would be
 * meaningless.
 *
 * AND SPLIT BY NICHE KIND, LIKE EVERY OTHER AGGREGATE. This screen's entire job
 * is "how are we doing against the field", which makes it the last place a
 * watchlist niche belongs in the pooled answer — a channel nobody at Northstar
 * is trying to be is not part of our output and is not part of the field we are
 * measured against either. `scopeMarketComparison` makes that decision once,
 * for BOTH pools, and hands back what to call the result; the module comment
 * beside it argues why splitting only the "ours" half would have been worse
 * than not splitting at all.
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

  /*
   * The catalogue read straight off the payload rather than through a `?? []`
   * fallback: a fresh empty array every render would be a new memo key every
   * render, and the scope below feeds every chart on the page.
   */
  const nicheCatalogue = data?.niches;
  const selection = React.useMemo(
    () => nicheSelection(niche, nicheCatalogue ?? EMPTY_NICHES),
    [niche, nicheCatalogue],
  );
  const scope = React.useMemo(
    () => scopeMarketComparison(inNiche, selection),
    [inNiche, selection],
  );

  /*
   * ONE SCOPED LIST, SPLIT BY OWNERSHIP AFTERWARDS.
   *
   * Both halves therefore come from the same population by construction, which
   * is the property that has to survive every future edit to this file: a
   * difference in hit rate between two differently-shaped pools is not a fact
   * about our output. Memoised because they key the six comparisons below —
   * they used to be bare `.filter()` calls, and a new array each render made
   * every one of those `useMemo`s decorative.
   */
  const ourChannels = React.useMemo(
    () => scope.rows.filter((r) => r.channel.ownershipType === "own"),
    [scope],
  );
  const competitorChannels = React.useMemo(
    () => scope.rows.filter((r) => r.channel.ownershipType !== "own"),
    [scope],
  );

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

  /*
   * What this page is a comparison OF, in one sentence.
   *
   * Three genuinely different claims, and the header has to make the right one
   * before anything below it is read. "All niches" stopped being true the
   * moment the watchlist channels came out of both pools, so the description
   * names the population rather than the filter — and a watchlist niche gets
   * told, up front, that what follows is not the studio's scorecard.
   */
  const description =
    scope.kind === "watchlist"
      ? `How your channels compare to the competitor pool in ${nicheName} — a niche Northstar follows rather than publishes into.`
      : scope.watchlistExcluded > 0
        ? `How your channels compare to the competitor pool across the niches Northstar publishes into. ${channelPhrase(scope.watchlistExcluded)} sitting only in watchlist niches ${scope.watchlistExcluded === 1 ? "is" : "are"} left out of both sides.`
        : `How your channels compare to the competitor pool in ${nicheName}.`;

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
        description={description}
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
              <>
                {ourChannels.length === 0 ? (
                  <>
                    This page compares your channels against the market. Mark at least one
                    channel as <strong className="text-foreground">Our channel</strong>{" "}
                    from its row menu, then come back.
                  </>
                ) : (
                  <>
                    There is nothing to compare against yet. Add a competitor channel to{" "}
                    {nicheName} to see how you stack up.
                  </>
                )}
                {/*
                  "Nothing here" is a lie whenever the scope did the emptying.
                  A viewer who can see the channels on the Channels page needs
                  to know they were left out on purpose and where to go to look
                  at them — otherwise this reads as the tracker having lost
                  them.
                */}
                {scope.watchlistExcluded > 0 ? (
                  <>
                    {" "}
                    {channelPhrase(scope.watchlistExcluded)}{" "}
                    {scope.watchlistExcluded === 1 ? "sits" : "sit"} only in watchlist
                    niches and {scope.watchlistExcluded === 1 ? "is" : "are"} left out of
                    both sides here. Select a watchlist niche above to compare inside one.
                  </>
                ) : null}
              </>
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

          {/* Above the scoreboard, not below it: by the time somebody has read
              "you're outperforming the market in 4 of 6", the label has arrived
              too late to change how they read it. */}
          {scope.kind === "watchlist" ? (
            <WatchlistComparisonNotice nicheName={nicheName} />
          ) : null}

          <Scoreboard
            comparison={comparison}
            nicheName={nicheName}
            ourCount={ourChannels.length}
            marketCount={competitorChannels.length}
            scopeKind={scope.kind}
            watchlistExcluded={scope.watchlistExcluded}
          />

          <div className="grid gap-4 xl:grid-cols-[minmax(260px,1fr)_1.6fr]">
            <Card>
              <CardHeader>
                <div className="flex items-center gap-1.5">
                  <CardTitle>Tracked market share</CardTitle>
                  <InfoTip>
                    {TRACKED_MARKET_SHARE_DEFINITION}
                    {/* The denominator moved with the split, so the sentence
                        that exists to describe the denominator has to say so.
                        A share diluted by views from niches Northstar does not
                        publish into would understate exactly the thing this
                        donut is read for. */}
                    {scope.watchlistExcluded > 0 ? (
                      <>
                        {" "}
                        It is also scoped to the niches Northstar publishes into:{" "}
                        {channelPhrase(scope.watchlistExcluded).toLowerCase()} sitting
                        only in watchlist niches{" "}
                        {scope.watchlistExcluded === 1 ? "contributes" : "contribute"} to
                        neither half of it.
                      </>
                    ) : null}
                  </InfoTip>
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

/**
 * "1 channel" / "4 channels".
 *
 * Four captions on this page count the same excluded set — the header, the
 * empty state, the market-share tooltip and the scoreboard's scope line — and
 * four hand-rolled ternaries is four chances for one of them to say
 * "1 channels".
 */
function channelPhrase(count: number): string {
  return `${count} ${count === 1 ? "channel" : "channels"}`;
}

/**
 * The label on a comparison that is real but is NOT the studio's scorecard.
 *
 * "How does our stuff compare inside a niche we only watch" is a fair question
 * and the product answers it — refusing would be excluding a watchlist niche
 * from the app rather than from the average, which is not what the split is
 * for. What the answer must never do is arrive wearing the scorecard's clothes,
 * because this screen is the one people quote. So the page states the kind of
 * niche before the numbers, in the owner's own word.
 *
 * Deliberately not styled as a warning. Nothing is wrong and nobody has to go
 * and fix anything — the same tone `HitRuleNotConfiguredNotice` reaches for and
 * one step calmer, since this state is not even waiting on a decision.
 */
function WatchlistComparisonNotice({ nicheName }: { nicheName: string }) {
  return (
    <div
      className="flex flex-wrap items-start gap-3 rounded-lg border border-border bg-surface-sunken px-4 py-3"
      role="status"
    >
      <Eye className="mt-px size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">
          {NICHE_KIND_LABEL.watchlist} niche
          <span className="font-normal text-muted-foreground"> · {nicheName}</span>
        </p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
          Everything below is a real comparison inside {nicheName} — same period, same
          rule, both sides judged alike. It is not part of how {BRAND.company} is doing:
          this is a niche the studio follows rather than publishes into, so nobody is
          measured on these numbers and no hit in them is paid. The scorecard is the
          all-niches view.
        </p>
      </div>
    </div>
  );
}

function Scoreboard({
  comparison,
  nicheName,
  ourCount,
  marketCount,
  scopeKind,
  watchlistExcluded,
}: {
  comparison: ReturnType<typeof compareToMarket>;
  nicheName: string;
  ourCount: number;
  marketCount: number;
  scopeKind: MarketScopeKind;
  watchlistExcluded: number;
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

  /**
   * Who this tally is over, said in the line under it.
   *
   * The counts above it — "3 of your channels vs 11 competitor channels" —
   * describe the pools honestly but cannot say why a channel the viewer knows
   * about is absent, or why the win/loss line is not the studio's report card.
   * Both facts live here, one sentence each, in the same place so a future edit
   * cannot add a scope without a caption.
   */
  const scopeNote =
    scopeKind === "watchlist"
      ? "Watchlist niche: measured on the same rule as everywhere else, and deliberately outside how Northstar is doing. Nobody is judged on this and no hit in it is paid."
      : watchlistExcluded > 0
        ? `${channelPhrase(watchlistExcluded)} sitting only in watchlist niches ${watchlistExcluded === 1 ? "is" : "are"} excluded from BOTH sides — a channel nobody at Northstar is trying to be belongs in neither our output nor the field we measure it against.`
        : null;

  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border",
            /*
              A watchlist comparison gets NO VERDICT COLOUR.
              Green and amber here mean "good for us" and "bad for us", which is
              a judgement on work the studio is accountable for. Painting a
              niche nobody publishes into in the scorecard's colours is the
              cheapest possible way to make it look like the scorecard, and it
              would happen below the reading level of the banner above.
            */
            scopeKind === "watchlist"
              ? "border-border bg-surface-sunken text-muted-foreground"
              : comparison.outperformingCount * 2 >= comparison.comparableCount
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
            ) : scopeKind === "watchlist" ? (
              /*
                "You're outperforming" is a claim about the studio. Inside a
                niche the studio only watches it is the same arithmetic and a
                different sentence — the channels lead the field there, which is
                worth knowing and is not an achievement anybody is measured on.
              */
              <>
                Your channels lead the {marketLabel} field on{" "}
                <span className="text-accent">
                  {comparison.outperformingCount} of {comparison.comparableCount}
                </span>{" "}
                scored metrics — inside a niche Northstar watches.
              </>
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
          {scopeNote ? (
            <p className="mt-1 text-[11px] leading-relaxed text-subtle-foreground">
              {scopeNote}
            </p>
          ) : null}

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
 * `resolveHitDisplayState`, NOT A SIXTH PRIVATE COPY. This function used to
 * make its own three-way test and its docblock used to claim it was "the same
 * three-way test `HitRateValue` makes, in the same order and in the same
 * words" — which stopped being true the moment that component grew a fifth
 * state, and the drift showed up exactly where the comment promised it could
 * not. An evidence-limited pool has an arithmetic rate of `0` rather than
 * `null`, so it never reached this function at all: the chart drew its
 * 2%-wide sliver and labelled it 0.0%, under a comment explaining that the
 * sliver exists to mark "a real, earned measurement".
 *
 * `compareToMarket` now nulls that rate at source, so the pool arrives here and
 * gets the range as its reason. Nothing published, no rule to judge by, a rule
 * with nothing decided under it yet, or a rule whose verdicts cannot support a
 * figure: a shrug, a settings screen, come back on Thursday, and read the
 * interval.
 */
function hitRateAbsence(pool: MarketPool): string {
  const { totalShorts, hits } = pool.metrics;
  switch (resolveHitDisplayState(hits, totalShorts)) {
    case "noShorts":
      return NO_SHORTS_IN_PERIOD;
    case "notConfigured":
      return UNCONFIGURED_RULE_SHORT;
    case "evidenceLimited":
      return `${formatPercent(hits.lowerBound, 0)}–${formatPercent(hits.upperBound, 0)} · ${hits.tally.unknown} unrecorded`;
    default:
      return NOTHING_DECIDED_SHORT;
  }
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
 * visible as one. A zero that belongs to the evidence is not one, and it no
 * longer reaches the sliver — `compareToMarket` hands this row a `null` for
 * that side, and `hitRateAbsence` prints the interval in the bar's place.
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
