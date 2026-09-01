"use client";

import * as React from "react";
import Link from "next/link";
import {
  EVIDENCE_LIMITED_EXPLANATION,
  EVIDENCE_LIMITED_LABEL,
  HIT_RATE_DEFINITION,
  UNCONFIGURED_RULE_EXPLANATION,
  UNCONFIGURED_RULE_SHORT,
  UPLOAD_VIEWS_LABEL_LONG,
  uploadViewsTip,
} from "@/lib/analytics/constants";
import { resolveHitDisplayState } from "@/lib/analytics/hit-display";
import type { ViewsDefinitionDTO } from "@/lib/dto";
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
  viewsDefinition,
  loading,
}: {
  summary: PortfolioSummary;
  previousSummary?: PortfolioSummary;
  /**
   * How much view history exists, for the Upload views tip. `null` while the
   * dataset is loading — the tip falls back to the definition alone rather
   * than claiming a history figure it does not have.
   */
  viewsDefinition?: ViewsDefinitionDTO | null;
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
  /**
   * Tracked channels the rate is NOT measured over.
   *
   * Channels sitting only in watchlist niches. They are counted in every volume
   * figure in this strip — those describe the tracker, and the table underneath
   * shows the same rows — and left out of the rate, which describes the studio.
   * The gap is stated rather than left to be noticed.
   */
  const watchlistExcluded = summary.channelCount - summary.scorecardChannelCount;
  /*
   * The same predicate the cards, the table cells and the page banner use, from
   * the analytics layer rather than a fourth private copy of it here — and read
   * against the SCORECARD's own Shorts count.
   *
   * `summary.totalShorts` counts every entry in scope, watchlist included,
   * while `pooled` is the scorecard's verdicts only. Where watchlist channels
   * published this period and studio channels did not, the tally is all zeros
   * against a positive count, which resolves to "notConfigured" and puts a
   * banner about a broken hit rule over niches that are configured correctly.
   * Two populations, one comparison — see `scorecardTotalShorts`.
   */
  const pooledState = resolveHitDisplayState(pooled, summary.scorecardTotalShorts);
  const nothingScoreable = pooledState === "notConfigured";
  const ruleConfigured = !nothingScoreable;
  /*
   * AND THE STATE THE HEADLINE ITSELF IS IN.
   *
   * `ruleConfigured` is a two-way split and this tile needs the five-way one.
   * An evidence-limited portfolio is "configured" — so the guard passed, and
   * the loudest number in the product printed `formatPercent(averageHitRate)`
   * as a flat 0.0% with "0 hits · 0.0% pooled over 1,530 decided" underneath,
   * directly above a table where every row read "0%–20%". The mean itself no
   * longer takes those channels in (`calculatePortfolioSummary` skips them);
   * this covers the case where EVERY scorecard channel is in that state, which
   * is precisely the state this deployment enters the moment somebody sets the
   * missing hit windows.
   */
  const evidenceLimited = pooledState === "evidenceLimited";
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
            /*
              The count is over EVERY channel in scope, watchlist included, and
              so is the table underneath it — a header that quietly counted 30
              rows while the list showed 48 would be lying about its own page.
              What the caption names instead is how many of them the rate is
              measured over, which is the fact a reader would otherwise have to
              infer from a percentage that moved for no visible reason.
            */
            watchlistExcluded > 0
              ? `${formatNumber(summary.scorecardChannelCount)} in the hit rate · ${formatNumber(watchlistExcluded)} watchlist`
              : summary.channelsWithData < summary.channelCount
                ? `${summary.channelsWithData} with a measured hit rate`
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
          /* One name for this quantity on every surface, in the long form
             because this surface has room for it.

             The short form is an abbreviation for a 100px column head, not a
             different metric, and it drops the word LIFETIME — which leaves
             "views our uploads got in the last 30 days" intact as a reading,
             and that reading is VidIQ's number. This card previously said
             "Views of period uploads"; a naming pass that made it say less on
             the exact screen in the bug report would be a regression wearing a
             consistency badge. */
          label={UPLOAD_VIEWS_LABEL_LONG}
          value={formatCompactNumber(summary.totalViews)}
          hint={
            <InfoTip>{uploadViewsTip(viewsDefinition?.snapshotDays ?? null)}</InfoTip>
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
            !ruleConfigured ? (
              UNCONFIGURED_RULE_SHORT
            ) : evidenceLimited ? (
              /* The pooled range, in the slot the 0.0% would have taken. It is
                 the pooled interval rather than a range around the mean for the
                 same reason the caption's figure is pooled: there is no honest
                 interval around an average of averages, and the mean has no
                 members left to average in this state anyway. */
              <span aria-label={EVIDENCE_LIMITED_LABEL}>
                {formatPercent(pooled.lowerBound, 0)}–
                {formatPercent(pooled.upperBound, 0)}
              </span>
            ) : (
              formatPercent(summary.averageHitRate)
            )
          }
          hint={
            <InfoTip>
              {!ruleConfigured ? (
                UNCONFIGURED_RULE_EXPLANATION
              ) : evidenceLimited ? (
                EVIDENCE_LIMITED_EXPLANATION
              ) : (
                <>
                  The mean of each channel&rsquo;s own hit rate, counting only
                  channels with a MEASURED rate this period.{" "}
                  {HIT_RATE_DEFINITION}
                  {/*
                    The other exclusion, stated for the same reason as the
                    watchlist one below it. A channel whose every Short cleared
                    its bar unwatched has no rate to average, and dropping it
                    silently would move this figure for a reason no reader could
                    see — the quiet version of the zero it was dropped to avoid.
                  */}
                  {summary.channelsEvidenceLimited > 0 ? (
                    <>
                      {" "}
                      {formatNumber(summary.channelsEvidenceLimited)}{" "}
                      {summary.channelsEvidenceLimited === 1
                        ? "channel is"
                        : "channels are"}{" "}
                      also left out: nothing on them was recorded clearing its bar
                      inside its window, so their rate is a range rather than a
                      figure and averaging a zero in would understate the whole
                      portfolio.
                    </>
                  ) : null}
                  {/*
                    Said in the tooltip rather than left implicit. A rate over 30
                    of 48 tracked channels is a different claim from a rate over
                    all of them, and this is the one place a reader can find out
                    which they are looking at — the volume tiles beside it
                    deliberately count everything.
                  */}
                  {watchlistExcluded > 0 ? (
                    <>
                      {" "}
                      {formatNumber(watchlistExcluded)} tracked{" "}
                      {watchlistExcluded === 1 ? "channel is" : "channels are"} left out:
                      they sit only in watchlist niches, which Northstar follows rather
                      than publishes into. Averaging them in would describe work the
                      studio does not do.
                    </>
                  ) : null}
                </>
              )}
            </InfoTip>
          }
          caption={
            // No trend either. A movement indicator against a metric that does
            // not exist would be two fabrications rather than one — and that
            // applies to the evidence-limited state for exactly the same
            // reason, so it is checked before the trend, not after it.
            !ruleConfigured ? (
              "No hit rule set for these niches"
            ) : evidenceLimited ? (
              /*
                `${pooled.hits} hits` USED TO PRINT HERE, and in this state that
                is the literal string "0 hits" beside a "0.0% pooled" — the
                sentence from the bug report, on the tool's number one KPI, in
                the caption of the tile whose value slot had just been fixed.
                What replaces it is the only count in the tally that is not
                pinned to zero by the evidence: how many Shorts cleared their
                bar with nobody recording when.
              */
              `${formatNumber(pooled.tally.unknown)} passed the bar, timing not recorded · ${formatNumber(pooled.judged)} decided`
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
                : summary.channelsEvidenceLimited > 0
                  ? // The contest has entrants and none of them has a rate to
                    // enter with. Naming a "top" channel out of a field of
                    // arithmetic zeros would crown whichever one sorted first.
                    "No channel has a measured hit rate this period"
                  : "No channel has Shorts this period"
          }
        />
      </div>
    </Card>
  );
}
