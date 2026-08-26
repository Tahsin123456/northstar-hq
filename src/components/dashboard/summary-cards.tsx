"use client";

import * as React from "react";
import Link from "next/link";
import {
  HIT_RATE_DEFINITION,
  TOTAL_VIEWS_DEFINITION,
  TOTAL_VIEWS_VS_STUDIO,
} from "@/lib/analytics/constants";
import type { PortfolioSummary } from "@/lib/analytics";
import { calculateTrend } from "@/lib/analytics/trends";
import { EM_DASH, formatCompactNumber, formatNumber, formatPercent } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/tooltip";
import { Stat, StatSkeleton } from "@/components/metrics/stat";
import { TrendIndicator } from "@/components/metrics/trend-indicator";

/**
 * Portfolio-level summary.
 *
 * One card, five figures, hairline dividers — rather than five separate cards.
 * The spec explicitly warns against making every fact a giant coloured card,
 * and a single strip also reads correctly as "these numbers describe one thing"
 * instead of five unrelated metrics that happen to be adjacent.
 *
 * Every figure carries movement against the previous equivalent period.
 * Direction is declared per metric: hit rate and views are better when higher,
 * upload volume is neither, so it shows movement without a verdict.
 */
export function SummaryCards({
  summary,
  previousSummary,
  loading,
}: {
  summary: PortfolioSummary;
  previousSummary?: PortfolioSummary;
  loading?: boolean;
}) {
  const trends = React.useMemo(() => {
    const prev = previousSummary;
    return {
      shorts: calculateTrend(summary.totalShorts, prev?.totalShorts ?? null, {
        // Publishing more is a strategy choice, not an achievement.
        direction: "neutral",
        unit: "relativePercent",
      }),
      views: calculateTrend(summary.totalViews, prev?.totalViews ?? null, {
        direction: "higherIsBetter",
        unit: "relativePercent",
      }),
      hitRate: calculateTrend(summary.averageHitRate, prev?.averageHitRate ?? null, {
        direction: "higherIsBetter",
        unit: "percentagePoints",
      }),
    };
  }, [summary, previousSummary]);

  if (loading) {
    return (
      <Card className="grid grid-cols-2 gap-x-6 gap-y-6 p-5 md:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <StatSkeleton key={i} emphasis={i === 3 ? "strong" : "normal"} />
        ))}
      </Card>
    );
  }

  return (
    <Card className="grid grid-cols-2 divide-border md:grid-cols-3 lg:grid-cols-5 lg:divide-x">
      <div className="border-b border-border p-5 md:border-b-0 lg:border-b-0">
        <Stat
          label="Tracked channels"
          value={formatNumber(summary.channelCount)}
          caption={
            summary.channelsWithData < summary.channelCount
              ? `${summary.channelsWithData} with Shorts this period`
              : "All active this period"
          }
        />
      </div>

      <div className="border-b border-border p-5 md:border-b-0 lg:border-b-0">
        <Stat
          label="Shorts uploaded"
          value={formatNumber(summary.totalShorts)}
          caption={
            previousSummary ? (
              <TrendIndicator trend={trends.shorts} valueFormat="count" />
            ) : (
              "In the selected period"
            )
          }
        />
      </div>

      <div className="border-b border-border p-5 md:border-b-0">
        <Stat
          label="Views of period uploads"
          value={formatCompactNumber(summary.totalViews)}
          hint={
            <InfoTip>
              {TOTAL_VIEWS_DEFINITION} {TOTAL_VIEWS_VS_STUDIO}
            </InfoTip>
          }
          caption={
            previousSummary ? (
              <TrendIndicator trend={trends.views} valueFormat="views" />
            ) : summary.totalShorts > 0 ? (
              `${formatCompactNumber(summary.totalViews / summary.totalShorts)} per Short`
            ) : (
              "No Shorts in period"
            )
          }
        />
      </div>

      <div className="border-b border-border p-5 md:border-b-0">
        <Stat
          label="Average hit rate"
          emphasis="strong"
          value={formatPercent(summary.averageHitRate)}
          hint={
            <InfoTip>
              The mean of each channel&rsquo;s own hit rate, counting only
              channels that uploaded Shorts this period. {HIT_RATE_DEFINITION}
            </InfoTip>
          }
          caption={
            previousSummary ? (
              <TrendIndicator trend={trends.hitRate} valueFormat="percent" />
            ) : summary.pooledHitRate !== null ? (
              `${formatNumber(summary.totalHits)} hits · ${formatPercent(summary.pooledHitRate)} pooled`
            ) : (
              "No Shorts in period"
            )
          }
        />
      </div>

      <div className="p-5">
        <Stat
          label="Top channel"
          value={
            summary.topChannel ? (
              <Link
                href={`/channels/${summary.topChannel.id}`}
                className="block truncate transition-colors hover:text-accent"
                title={summary.topChannel.name}
              >
                {summary.topChannel.name}
              </Link>
            ) : (
              EM_DASH
            )
          }
          caption={
            summary.topChannel
              ? `${formatPercent(summary.topChannel.hitRate)} hit rate`
              : "No channel has Shorts this period"
          }
        />
      </div>
    </Card>
  );
}
