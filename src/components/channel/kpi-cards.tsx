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
import {
  HitExclusions,
  HitRateBounds,
  HitRateInfo,
} from "@/components/metrics/hit-rate-value";
import { HitRuleNotConfigured } from "@/components/metrics/hit-rule-not-configured";
import {
  NOTHING_DECIDED_EXPLANATION,
  UNCONFIGURED_RULE_EXPLANATION,
} from "@/lib/analytics/constants";

/**
 * KPI strip for one channel.
 *
 * Hit rate gets its own full-height panel at the left, visibly larger than the
 * rest. The secondary metrics — average, median, best, top decile — are useful
 * context but must not compete with it; the spec is explicit that they should
 * not overpower the main metric, and the layout enforces that rather than
 * relying on restraint.
 *
 * THE HEADLINE HAS THREE WAYS OF BEING ABSENT and they are rendered as three
 * different things, because they ask the reader for three different responses:
 * no Shorts published (nothing to do), no rule configured (an admin has a niche
 * to finish), and a rule with nothing decided under it yet (wait). The old card
 * had two of those states and used the threshold's nullability to pick between
 * them, which cannot distinguish the third at all.
 */
export function KpiCards({
  metrics,
  trendDelta,
  className,
}: {
  metrics: ChannelMetrics;
  trendDelta: number | null;
  className?: string;
}) {
  const { hits } = metrics;
  /*
   * "Not configured" now means NO RULE REACHED THESE SHORTS, read off the
   * verdicts rather than off the threshold control.
   *
   * That control is a lens — it shades rows and scales the ratio column — and
   * has not decided a hit since the window arrived. Keying this card on it
   * would have made a niche with a perfectly good rule read "Not configured"
   * the moment somebody typed an override, and a niche with no window at all
   * read as a real 0%.
   */
  const nothingScoreable =
    metrics.totalShorts > 0 &&
    hits.judged === 0 &&
    hits.tally.pending === 0 &&
    hits.tally.unknown === 0;
  const nothingDecided = metrics.totalShorts > 0 && hits.judged === 0 && !nothingScoreable;
  const hasData = hits.rate !== null;

  return (
    <div className={className}>
      <div className="grid gap-4 lg:grid-cols-[minmax(240px,1fr)_2.2fr]">
        {/* --- The headline --- */}
        <Card className="flex flex-col justify-between p-5">
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
              Hit rate
            </span>
            <HitRateInfo side="right" />
          </div>

          <div className="mt-3">
            {nothingScoreable ? (
              /* The headline slot, filled with the truth rather than a figure.
                 No trend pill and no bar: both would be drawing a shape for a
                 measurement that does not exist. */
              <>
                <HitRuleNotConfigured size="xl" withTip={false} />
                <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
                  {UNCONFIGURED_RULE_EXPLANATION}
                </p>
              </>
            ) : (
              <>
                <div className="flex items-baseline gap-2.5">
                  <span
                    className={`tnum text-[40px] font-semibold leading-none tracking-tight ${
                      hasData ? "text-foreground" : "text-subtle-foreground"
                    }`}
                  >
                    {hasData ? formatPercent(hits.rate) : EM_DASH}
                  </span>
                  {/* The trend pill compares two windowed rates, so it is only
                      drawn once there is a rate to have moved. */}
                  {hasData ? <TrendPill delta={trendDelta} /> : null}
                  {hasData ? <HitRateBounds summary={hits} /> : null}
                </div>

                <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
                    style={{ width: `${Math.min(100, Math.max(0, hits.rate ?? 0))}%` }}
                  />
                </div>

                <p className="tnum mt-2.5 text-[12px] text-muted-foreground">
                  {hasData ? (
                    <>
                      {formatFraction(hits.hits, hits.judged)} decided Shorts reached
                      their niche&rsquo;s bar inside its hit window
                    </>
                  ) : nothingDecided ? (
                    NOTHING_DECIDED_EXPLANATION
                  ) : (
                    "No Shorts uploaded in this period"
                  )}
                </p>

                {/* The exclusions sit directly under the headline, not in a
                    tooltip. On this account they are frequently the larger
                    number, and a percentage that hides them is a different
                    claim from the one the data supports. */}
                <HitExclusions summary={hits} className="mt-2" />
              </>
            )}
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
              value={formatNumber(hits.hits)}
              caption={
                hits.judged > 0
                  ? `of ${formatNumber(hits.judged)} decided · ${formatNumber(metrics.totalShorts)} uploaded`
                  : EM_DASH
              }
              hint={
                hits.excluded > 0 ? (
                  <InfoTip>
                    {hits.excluded} of {metrics.totalShorts} Shorts uploaded in this
                    period are not in the rate: still inside their hit window,
                    published with no view history recorded during it, or filed
                    under a niche with no rule.
                  </InfoTip>
                ) : undefined
              }
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
