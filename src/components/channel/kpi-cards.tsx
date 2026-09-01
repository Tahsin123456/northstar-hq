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
  youtubeWatchUrl,
} from "@/lib/format";
import type { NicheFormat } from "@/lib/niches/niche-format";
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
  EVIDENCE_LIMITED_EXPLANATION,
  EVIDENCE_LIMITED_LABEL,
  NOTHING_DECIDED_EXPLANATION,
  NOTHING_DECIDED_SHORT,
  UNCONFIGURED_RULE_EXPLANATION,
  UPLOAD_VIEWS_LABEL_LONG,
  uploadViewsTip,
  uploadViewsTipLongform,
} from "@/lib/analytics/constants";
import { resolveHitDisplayState } from "@/lib/analytics/hit-display";
import type { ViewsDefinitionDTO } from "@/lib/dto";

/**
 * KPI strip for one channel.
 *
 * Hit rate gets its own full-height panel at the left, visibly larger than the
 * rest. The secondary metrics — average, median, best, top decile — are useful
 * context but must not compete with it; the spec is explicit that they should
 * not overpower the main metric, and the layout enforces that rather than
 * relying on restraint.
 *
 * THE HEADLINE HAS FOUR WAYS OF NOT BEING A PERCENTAGE and they are rendered
 * as four different things, because they ask the reader for four different
 * responses: no Shorts published (nothing to do), no rule configured (an admin
 * has a niche to finish), a rule with nothing decided under it yet (wait), and
 * a rate whose zero belongs to the evidence rather than to the channel (read
 * the range, and turn on automatic refresh). The old card had two of those
 * states and used the threshold's nullability to pick between them, which
 * cannot distinguish the third at all — and the fourth is what the obvious fix
 * for the third would have created.
 *
 * EVERY TILE IN THIS COMPONENT OBEYS THE SAME STATE. That is the whole point of
 * `resolveHitDisplayState` living in the analytics layer: the "Shorts that hit"
 * tile used to sit outside the headline's guard and print a bare 0 beside it.
 */
export function KpiCards({
  metrics,
  trendDelta,
  viewsDefinition,
  format = "shorts",
  className,
}: {
  metrics: ChannelMetrics;
  trendDelta: number | null;
  /**
   * How much view history exists, for the Upload views tip. `null` while the
   * dataset is still loading — the tip falls back to the definition alone
   * rather than claiming a history figure it does not have.
   */
  viewsDefinition?: ViewsDefinitionDTO | null;
  /**
   * Which format's metrics these are. Every figure is already the right one —
   * the caller computed `metrics` with the same format — so what this decides
   * is only the words beside them, the Best-video link's destination, and
   * which sentence explains the exclusion count.
   */
  format?: NicheFormat;
  className?: string;
}) {
  const { hits } = metrics;
  // The unit noun, once. "Short(s)" for the product that always said so,
  // "video(s)" for Long Form — never "Longform", which is a setting name,
  // not a word the studio owner uses.
  const one = format === "shorts" ? "Short" : "video";
  const many = format === "shorts" ? "Shorts" : "videos";
  /*
   * "Not configured" now means NO RULE REACHED THESE SHORTS, read off the
   * verdicts rather than off the threshold control.
   *
   * That control is a lens — it shades rows and scales the ratio column — and
   * has not decided a hit since the window arrived. Keying this card on it
   * would have made a niche with a perfectly good rule read "Not configured"
   * the moment somebody typed an override, and a niche with no window at all
   * read as a real 0%.
   *
   * RESOLVED ONCE AND SHARED WITH THE TILE BESIDE IT. These predicates used to
   * live only around the headline, and the "Shorts that hit" tile sat outside
   * them printing `formatNumber(hits.hits)` — so this card group could read
   * "Hit rate: Not configured" and "Shorts that hit: 0" at the same time, from
   * the same object. The second half is the fabrication the owner reported.
   */
  const state = resolveHitDisplayState(hits, metrics.totalShorts);
  const nothingScoreable = state === "notConfigured";
  const nothingDecided = state === "nothingDecided";
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
            ) : state === "evidenceLimited" ? (
              /*
               * The range, not the 0.0% the arithmetic would print.
               *
               * Nothing here was ever seen clearing its bar inside its window,
               * and Shorts exist that passed the bar while nobody was
               * recording — so the numerator is pinned to zero by the evidence
               * rather than by the work. Same treatment as the unconfigured
               * state above: no trend pill, because there is no figure to have
               * moved, and no bar, because a bar at 0% contradicts the range
               * printed above it. The exclusions still ride underneath, since
               * the unrecorded population is the entire reason for this state.
               */
              <>
                <div className="flex items-baseline gap-2.5">
                  <span
                    className="tnum text-[40px] font-semibold leading-none tracking-tight text-foreground"
                    aria-label={EVIDENCE_LIMITED_LABEL}
                  >
                    {formatPercent(hits.lowerBound, 0)}–
                    {formatPercent(hits.upperBound, 0)}
                  </span>
                </div>
                <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
                  {EVIDENCE_LIMITED_EXPLANATION}
                </p>
                <HitExclusions summary={hits} className="mt-2" />
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
                      {formatFraction(hits.hits, hits.judged)} decided {many} reached
                      their niche&rsquo;s bar inside its hit window
                    </>
                  ) : nothingDecided ? (
                    NOTHING_DECIDED_EXPLANATION
                  ) : (
                    `No ${many} uploaded in this period`
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
              label={format === "shorts" ? "Shorts uploaded" : "Videos uploaded"}
              value={formatNumber(metrics.totalShorts)}
              caption={
                metrics.uploadsPerWeek
                  ? `${metrics.uploadsPerWeek.toFixed(1)} per week`
                  : "In the selected period"
              }
              hint={
                metrics.excludedLongform > 0 ? (
                  <InfoTip>
                    {/* `excludedLongform` is the in-range complement of THIS
                        page's format, whatever its name says — for a Long Form
                        page that is Shorts plus anything unresolved. */}
                    {format === "shorts" ? (
                      <>
                        {metrics.excludedLongform} long-form{" "}
                        {metrics.excludedLongform === 1 ? "video was" : "videos were"}{" "}
                        published in this period and excluded from every figure on
                        this page.
                      </>
                    ) : (
                      <>
                        {metrics.excludedLongform}{" "}
                        {metrics.excludedLongform === 1 ? "upload" : "uploads"} in
                        this period {metrics.excludedLongform === 1 ? "is" : "are"}{" "}
                        not long-form — Shorts, or videos the classifier could not
                        confirm — and excluded from every figure on this page.
                      </>
                    )}
                  </InfoTip>
                ) : undefined
              }
            />
          </div>

          <div className="border-b border-border p-5 sm:border-r">
            <Stat
              label={format === "shorts" ? "Shorts that hit" : "Videos that hit"}
              /*
               * THE LITERAL "0 HITS" FROM THE BUG REPORT WAS HERE.
               *
               * This tile printed `formatNumber(hits.hits)` unconditionally and
               * sat outside the guard protecting the headline four inches to
               * its left, so a channel whose niche had no hit window showed
               * "Hit rate: Not configured" and "Shorts that hit: 0" together. A
               * studio owner reads that 0 as "the channel failed". The truth
               * was that the app had never asked the question.
               *
               * A count is only meaningful beside a denominator that exists, so
               * it is printed in exactly one of the five states and the caption
               * carries the reason in the other four. In the evidence-limited
               * state the em dash is shown even though `hits.hits` is literally
               * 0, because that 0 is the count of hits somebody OBSERVED, not
               * the count of hits — and printing it is the exact sentence that
               * produced this bug report.
               */
              value={
                state === "measured" ? formatNumber(hits.hits) : EM_DASH
              }
              caption={
                state === "measured"
                  ? `of ${formatNumber(hits.judged)} decided · ${formatNumber(metrics.totalShorts)} uploaded`
                  : state === "noShorts"
                    ? `No ${many} in this period`
                    : state === "notConfigured"
                      ? "No hit rule set for these niches"
                      : state === "nothingDecided"
                        ? NOTHING_DECIDED_SHORT
                        : `${formatNumber(hits.tally.unknown)} passed the bar, timing not recorded`
              }
              hint={
                hits.excluded > 0 ? (
                  <InfoTip>
                    {hits.excluded} of {metrics.totalShorts} {many} uploaded in this
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
              label={UPLOAD_VIEWS_LABEL_LONG}
              value={formatCompactNumber(metrics.totalViews)}
              /* One of the two roomy surfaces that also carries the reason the
                 Studio-style figure is absent rather than approximated. */
              hint={
                <InfoTip>
                  {format === "shorts"
                    ? uploadViewsTip(viewsDefinition?.snapshotDays ?? null)
                    : uploadViewsTipLongform(viewsDefinition?.snapshotDays ?? null)}
                </InfoTip>
              }
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
              caption={`Mean per ${one}`}
            />
          </div>

          <div className="border-border p-5 sm:border-r">
            <Stat
              label="Median views"
              value={formatCompactNumber(metrics.medianViews)}
              caption={`The typical ${one}`}
              hint={
                <InfoTip>
                  Half of this channel&rsquo;s {many} did better than this and
                  half did worse. Unlike the average, one viral outlier
                  can&rsquo;t drag it upward.
                </InfoTip>
              }
            />
          </div>

          <div className="border-t border-border p-5 sm:border-t-0">
            <Stat
              label={format === "shorts" ? "Best Short" : "Best video"}
              value={
                metrics.bestShort ? (
                  <a
                    href={
                      format === "shorts"
                        ? youtubeShortsUrl(metrics.bestShort.youtubeVideoId)
                        : youtubeWatchUrl(metrics.bestShort.youtubeVideoId)
                    }
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
