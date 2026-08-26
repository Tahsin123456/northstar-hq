"use client";

import * as React from "react";
import { ExternalLink } from "lucide-react";
import type { ChannelMetrics } from "@/lib/analytics/types";
import {
  EM_DASH,
  formatCompactNumber,
  formatFraction,
  formatNumber,
  formatPercent,
  youtubeShortsUrl,
} from "@/lib/format";
import { Card } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/tooltip";
import { Stat, TrendPill } from "@/components/metrics/stat";
import { HitRateInfo } from "@/components/metrics/hit-rate-value";

/**
 * KPI strip for one channel.
 *
 * Hit rate gets its own full-height panel at the left, visibly larger than the
 * rest. The secondary metrics — average, median, best, top decile — are useful
 * context but must not compete with it; the spec is explicit that they should
 * not overpower the main metric, and the layout enforces that rather than
 * relying on restraint.
 */
export function KpiCards({
  metrics,
  trendDelta,
  threshold,
  className,
}: {
  metrics: ChannelMetrics;
  trendDelta: number | null;
  /** Stated on the card, because a hit means different things per niche. */
  threshold: number;
  className?: string;
}) {
  const hasData = metrics.totalShorts > 0;

  return (
    <div className={className}>
      <div className="grid gap-4 lg:grid-cols-[minmax(240px,1fr)_2.2fr]">
        {/* --- The headline --- */}
        <Card className="flex flex-col justify-between p-5">
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
              Hit rate ≥{formatCompactNumber(threshold)}
            </span>
            <HitRateInfo side="right" />
          </div>

          <div className="mt-3">
            <div className="flex items-baseline gap-2.5">
              <span
                className={`tnum text-[40px] font-semibold leading-none tracking-tight ${
                  hasData ? "text-foreground" : "text-subtle-foreground"
                }`}
              >
                {hasData ? formatPercent(metrics.hitRate) : EM_DASH}
              </span>
              <TrendPill delta={trendDelta} />
            </div>

            <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
                style={{ width: `${Math.min(100, Math.max(0, metrics.hitRate ?? 0))}%` }}
              />
            </div>

            <p className="tnum mt-2.5 text-[12px] text-muted-foreground">
              {hasData ? (
                <>
                  {formatFraction(metrics.hitCount, metrics.totalShorts)} Shorts reached{" "}
                  {formatCompactNumber(threshold)} views
                </>
              ) : (
                "No Shorts uploaded in this period"
              )}
            </p>
          </div>
        </Card>

        {/* --- Supporting metrics --- */}
        <Card className="grid grid-cols-2 divide-border sm:grid-cols-3 lg:grid-cols-3">
          <div className="border-b border-r border-border p-5">
            <Stat
              label="Shorts uploaded"
              value={formatNumber(metrics.totalShorts)}
              caption={
                metrics.uploadsPerWeek
                  ? `${metrics.uploadsPerWeek.toFixed(1)} per week`
                  : "In the selected period"
              }
              hint={
                metrics.excludedLongform > 0 ? (
                  <InfoTip>
                    {metrics.excludedLongform} long-form{" "}
                    {metrics.excludedLongform === 1 ? "video was" : "videos were"}{" "}
                    published in this period and excluded from every figure on
                    this page.
                  </InfoTip>
                ) : undefined
              }
            />
          </div>

          <div className="border-b border-border p-5 sm:border-r">
            <Stat
              label="Shorts that hit"
              value={formatNumber(metrics.hitCount)}
              caption={hasData ? `of ${formatNumber(metrics.totalShorts)} uploaded` : EM_DASH}
            />
          </div>

          <div className="border-b border-r border-border p-5 sm:border-r-0 lg:border-r-0">
            <Stat
              label="Total Shorts views"
              value={formatCompactNumber(metrics.totalViews)}
              caption={
                metrics.viewsPerUpload !== null
                  ? `${formatCompactNumber(metrics.viewsPerUpload)} per upload`
                  : EM_DASH
              }
            />
          </div>

          <div className="border-r border-border p-5">
            <Stat
              label="Average views"
              value={formatCompactNumber(metrics.averageViews)}
              caption="Mean per Short"
            />
          </div>

          <div className="border-border p-5 sm:border-r">
            <Stat
              label="Median views"
              value={formatCompactNumber(metrics.medianViews)}
              caption="The typical Short"
              hint={
                <InfoTip>
                  Half of this channel&rsquo;s Shorts did better than this and
                  half did worse. Unlike the average, one viral outlier
                  can&rsquo;t drag it upward.
                </InfoTip>
              }
            />
          </div>

          <div className="border-t border-border p-5 sm:border-t-0">
            <Stat
              label="Best Short"
              value={
                metrics.bestShort ? (
                  <a
                    href={youtubeShortsUrl(metrics.bestShort.youtubeVideoId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 transition-colors hover:text-accent"
                    title={metrics.bestShort.title}
                  >
                    {formatCompactNumber(metrics.bestShort.views)}
                    <ExternalLink className="size-3 opacity-50" />
                  </a>
                ) : (
                  EM_DASH
                )
              }
              caption={
                metrics.topDecileAverageViews !== null
                  ? `Top 10% avg ${formatCompactNumber(metrics.topDecileAverageViews)}`
                  : EM_DASH
              }
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
