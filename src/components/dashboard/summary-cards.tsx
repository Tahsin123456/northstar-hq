"use client";

import * as React from "react";
import Link from "next/link";
import {
  HIT_RATE_DEFINITION,
  TOTAL_VIEWS_DEFINITION,
  TOTAL_VIEWS_VS_STUDIO,
  UNCONFIGURED_RULE_EXPLANATION,
  UNCONFIGURED_RULE_SHORT,
} from "@/lib/analytics/constants";
import type { PortfolioSummary } from "@/lib/analytics";
import { calculateTrend } from "@/lib/analytics/trends";
import { EM_DASH, formatCompactNumber, formatNumber, formatPercent } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/tooltip";
import { Stat, StatSkeleton } from "@/components/metrics/stat";
import { HitRateBounds } from "@/components/metrics/hit-rate-value";
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
  /*
   * "Not configured" is read off the POOLED VERDICTS, not off the threshold
   * control.
   *
   * Nothing in this strip is judged by that control any more — it shades rows
   * and scales a ratio column. What makes this tile read "Not configured" is
   * that every Short in scope came back unscoreable: no niche with both halves
   * of a rule reached any of them. That is a statement about configuration and
   * it is different again from the em dash, which means "no Shorts in this
   * period", and from "nothing decided yet", which means the rules are fine and
   * the windows have not shut.
   */
  const pooled = summary.pooled;
  const nothingScoreable =
    summary.totalShorts > 0 &&
    pooled.judged === 0 &&
    pooled.tally.pending === 0 &&
    pooled.tally.unknown === 0;
  const ruleConfigured = !nothingScoreable;
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
          value={
            ruleConfigured
              ? formatPercent(summary.averageHitRate)
              : UNCONFIGURED_RULE_SHORT
          }
          hint={
            <InfoTip>
              {ruleConfigured ? (
                <>
                  The mean of each channel&rsquo;s own hit rate, counting only
                  channels with at least one DECIDED Short this period.{" "}
                  {HIT_RATE_DEFINITION}
                </>
              ) : (
                UNCONFIGURED_RULE_EXPLANATION
              )}
            </InfoTip>
          }
          caption={
            // No trend either. A movement indicator against a metric that does
            // not exist would be two fabrications rather than one.
            !ruleConfigured ? (
              "No hit rule set for these niches"
            ) : previousSummary ? (
              <TrendIndicator trend={trends.hitRate} valueFormat="percent" />
            ) : pooled.rate !== null ? (
              /*
                THE POOLED FIGURE CARRIES ITS RANGE; THE HEADLINE ABOVE CANNOT.
                The value in this tile is the mean of per-channel rates, and
                there is no honest interval to print beside an average of
                averages — the bounds are computed over the pooled tally and
                bound the pooled rate, which is the number in this caption.
                Attaching them upstairs would be a range for a different
                statistic, which is a worse fault than the bare figure.

                The prose truncates before the range does: what a reader can
                reconstruct from the tile is the wording, not the interval.
              */
              <span className="flex items-baseline gap-1.5">
                <span className="min-w-0 truncate">
                  {`${formatNumber(pooled.hits)} hits · ${formatPercent(pooled.rate)} pooled over ${formatNumber(pooled.judged)} decided`}
                </span>
                <HitRateBounds summary={pooled} compact />
              </span>
            ) : pooled.excluded > 0 ? (
              `Nothing decided yet · ${formatNumber(pooled.excluded)} excluded`
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
            // "Top channel" is ranked *by* hit rate, so with no threshold there
            // is no ranking and `topChannel` is already null — this caption just
            // has to say why, rather than blaming an empty period.
            !ruleConfigured
              ? "Ranked by hit rate, which needs a configured hit rule"
              : summary.topChannel
                ? `${formatPercent(summary.topChannel.hitRate)} hit rate`
                : "No channel has Shorts this period"
          }
        />
      </div>
    </Card>
  );
}
