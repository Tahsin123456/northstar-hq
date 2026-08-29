"use client";

import * as React from "react";
import {
  HIT_RATE_BOUNDS_EXPLANATION,
  HIT_RATE_DEFINITION,
  HIT_RATE_PENDING_EXPLANATION,
  HIT_RATE_UNKNOWN_EXPLANATION,
  HIT_RATE_UNSCOREABLE_EXPLANATION,
  NOTHING_DECIDED_SHORT,
} from "@/lib/analytics/constants";
import type { HitRateSummary } from "@/lib/analytics/hit-rate";
import { formatHitWindow } from "@/lib/analytics/hit-rate";
import {
  EM_DASH,
  formatCompactNumber,
  formatFraction,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import { InfoTip } from "@/components/ui/tooltip";
import { HitRuleNotConfigured } from "@/components/metrics/hit-rule-not-configured";
import { cn } from "@/lib/utils";

/**
 * The product's headline number.
 *
 * =========================================================================
 * WHAT IT TAKES, AND WHY IT IS ONE OBJECT
 * =========================================================================
 * A `HitRateSummary`, not a percentage and a count. That is deliberate
 * friction. The rate is computed over DECIDED Shorts only — a Short still
 * inside its window is in neither half, and one whose window closed with no
 * reading inside it is excluded too — and on this account those exclusions are
 * large enough that the percentage alone is a materially different claim from
 * the one the data supports. There is no prop to pass a bare number through, so
 * no surface can quote the figure and lose what it left out.
 *
 * Five deliberate choices:
 *
 *  1. `rate === null` renders as an em dash with a caption saying WHICH kind of
 *     nothing it is, never 0%. Three different situations produce a null rate
 *     and they mean opposite things: no Shorts at all, Shorts that all have a
 *     rule but none decided yet, and Shorts with no rule to be judged by. The
 *     old component conflated the last two into "Not configured"; the middle
 *     one did not exist before there was a clock.
 *
 *  2. The fraction ("12 / 38 decided") sits directly beneath the percentage.
 *     A rate without its denominator is not interpretable — 100% from one
 *     decided Short and 100% from forty are different facts — and the word
 *     "decided" is what stops 38 being read as "uploaded".
 *
 *  3. The exclusions ride along underneath rather than living in a tooltip.
 *     "22% over 40 decided, 374 excluded" is the honest sentence and it does
 *     not fit in a number.
 *
 *  4. The bar is a single accent colour at fixed opacity, not a red-to-green
 *     gradient. Hit rate is already a number; colour-coding it would add
 *     judgement the data does not support.
 *
 *  5. The bounds show only when there is genuine ambiguity to show. With no
 *     unrecorded Shorts the range collapses onto the rate, and printing
 *     "22%–22%" would manufacture the appearance of uncertainty where the
 *     answer is actually clean.
 */
export function HitRateValue({
  summary,
  totalShorts,
  size = "md",
  showBar = true,
  showFraction = true,
  showExclusions = true,
  rule,
  className,
}: {
  /** The rate and everything it excluded. From `metrics.hits`. */
  summary: HitRateSummary;
  /** Shorts uploaded in the period, decided or not. The context for the rate. */
  totalShorts: number;
  size?: "sm" | "md" | "lg" | "xl";
  showBar?: boolean;
  showFraction?: boolean;
  /** The excluded populations, under the fraction. */
  showExclusions?: boolean;
  /**
   * The rule these Shorts were judged by, when a single one applies.
   *
   * Printed as "1M in 7 days", because a bare "12 / 38" is ambiguous across
   * niches that define a hit differently. Omitted where several rules are in
   * play — a portfolio spanning four niches has no single bar to name, and
   * naming one of them would be worse than naming none.
   */
  rule?: { threshold: number; windowHours: number } | null;
  className?: string;
}) {
  const { rate, hits, judged, tally } = summary;

  /*
   * The three distinguishable kinds of "no rate", in order of specificity.
   *
   * Nothing published is the plainest. Then: Shorts exist, and either none of
   * them has a rule to be judged by (an admin has a niche to finish
   * configuring) or they have one and none has been decided yet (a wait, not a
   * gap). Collapsing those two would send somebody to the settings screen to
   * fix a niche that is already correct.
   */
  const hasShorts = totalShorts > 0;
  const nothingScoreable =
    hasShorts && judged === 0 && tally.pending === 0 && tally.unknown === 0;
  const nothingDecided = hasShorts && judged === 0 && !nothingScoreable;
  const hasData = rate !== null;

  if (nothingScoreable) {
    return (
      <div className={cn("flex flex-col gap-1", className)}>
        <HitRuleNotConfigured size={size} />
        {showFraction ? (
          <span className="text-[11px] leading-none text-subtle-foreground">
            {formatNumber(totalShorts)} Shorts in period
          </span>
        ) : null}
      </div>
    );
  }

  const valueClass = {
    sm: "text-[13px]",
    md: "text-[15px]",
    lg: "text-[22px]",
    xl: "text-[32px]",
  }[size];

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-baseline gap-1.5">
        <span
          className={cn(
            "tnum font-semibold leading-none tracking-tight",
            valueClass,
            hasData ? "text-foreground" : "text-subtle-foreground",
          )}
        >
          {hasData ? formatPercent(rate) : EM_DASH}
        </span>
        {hasData && summary.tally.unknown > 0 ? <HitRateBounds summary={summary} /> : null}
      </div>

      {showBar ? (
        <div
          className="h-[3px] w-full overflow-hidden rounded-full bg-border"
          role="presentation"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
            style={{ width: `${Math.min(100, Math.max(0, rate ?? 0))}%` }}
          />
        </div>
      ) : null}

      {showFraction ? (
        <span className="tnum text-[11px] leading-none text-subtle-foreground">
          {hasData ? (
            <>
              {formatFraction(hits, judged)}
              <span className="ml-1 text-subtle-foreground/70">
                {rule
                  ? `decided · ${formatCompactNumber(rule.threshold)} in ${formatHitWindow(rule.windowHours)}`
                  : "decided"}
              </span>
            </>
          ) : nothingDecided ? (
            NOTHING_DECIDED_SHORT
          ) : (
            "No Shorts in period"
          )}
        </span>
      ) : null}

      {showExclusions ? <HitExclusions summary={summary} /> : null}
    </div>
  );
}

/**
 * What the rate left out, said in one line.
 *
 * The three populations never merge into a single "excluded" count, because
 * they are three different messages to three different readers. A pending Short
 * is a wait — come back on Thursday. An unrecorded one is a permanent loss, and
 * waiting will not settle it. An unscoreable one is a niche somebody has to
 * finish configuring. Summing them would say "38 excluded" and leave every one
 * of those readers to guess which applies to them.
 *
 * Renders nothing at all when there is nothing to report, rather than a row of
 * zeroes: a clean measurement should look clean.
 */
export function HitExclusions({
  summary,
  className,
}: {
  summary: HitRateSummary;
  className?: string;
}) {
  const { pending, unknown, unscoreable } = summary.tally;
  if (pending === 0 && unknown === 0 && unscoreable === 0) return null;

  return (
    <span
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-none text-subtle-foreground",
        className,
      )}
    >
      {pending > 0 ? (
        <span className="tnum inline-flex items-center gap-1">
          {formatNumber(pending)} pending
          <InfoTip>{HIT_RATE_PENDING_EXPLANATION}</InfoTip>
        </span>
      ) : null}
      {unknown > 0 ? (
        <span className="tnum inline-flex items-center gap-1">
          {formatNumber(unknown)} unrecorded
          <InfoTip>{HIT_RATE_UNKNOWN_EXPLANATION}</InfoTip>
        </span>
      ) : null}
      {unscoreable > 0 ? (
        <span className="tnum inline-flex items-center gap-1">
          {formatNumber(unscoreable)} no rule
          <InfoTip>{HIT_RATE_UNSCOREABLE_EXPLANATION}</InfoTip>
        </span>
      ) : null}
    </span>
  );
}

/**
 * The range the true rate lies in, given what the unrecorded Shorts might have
 * been.
 *
 * Shown only when there are unrecorded Shorts to be uncertain about. Every one
 * of them DID eventually pass the bar — that is what makes it unrecorded rather
 * than a miss — so each is a potential hit whose timing nobody captured. On
 * this account 374 of them sit against 1,530 confident misses, which is not a
 * rounding error and must not be presented as one.
 *
 * MOUNT THIS RATHER THAN PRINTING A BARE PERCENTAGE. It is silent by
 * construction when `tally.unknown === 0`, which is what lets every surface
 * carry it unconditionally: most rows will disclose nothing once real history
 * accumulates, and a caveat that shows when it does not apply is how people
 * learn to stop reading caveats.
 */
export function HitRateBounds({
  summary,
  compact = false,
  className,
}: {
  summary: HitRateSummary;
  /**
   * For a picker row, a card footer, a caption — anywhere the full form and its
   * info button will not fit.
   *
   * Whole percentages and a `title` in place of the tooltip: about a third of
   * the width, and no nested control. That second part is not cosmetic — the
   * surfaces that need this sit inside a `<label>` wrapping a checkbox, or
   * under a card's stretched link, where an info BUTTON would respectively
   * toggle the checkbox and be unreachable.
   *
   * WHY THE RANGE AND NOT A ONE-GLYPH "THIS IS A FLOOR" MARKER, which is the
   * obvious way to spend even less width: the rate is not a floor. The low end
   * of this range sits BELOW the printed percentage — the unrecorded Shorts
   * enter the denominator whether or not they enter the numerator — so a marker
   * reading "at least 22%" would be a fresh false claim, printed to fix a
   * different false claim. Seven characters buys the true statement.
   */
  compact?: boolean;
  className?: string;
}) {
  if (summary.lowerBound === null || summary.upperBound === null) return null;
  if (summary.tally.unknown === 0) return null;

  if (compact) {
    return (
      <span
        className={cn(
          "tnum shrink-0 text-[11px] leading-none text-subtle-foreground",
          className,
        )}
        // The full-precision range leads, so hovering never contradicts the
        // rounded figure the reader is looking at.
        title={`${formatPercent(summary.lowerBound)}–${formatPercent(summary.upperBound)}. ${HIT_RATE_BOUNDS_EXPLANATION}`}
      >
        {formatPercent(summary.lowerBound, 0)}–{formatPercent(summary.upperBound, 0)}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "tnum inline-flex items-center gap-1 text-[11px] leading-none text-subtle-foreground",
        className,
      )}
    >
      {formatPercent(summary.lowerBound)}–{formatPercent(summary.upperBound)}
      <InfoTip>{HIT_RATE_BOUNDS_EXPLANATION}</InfoTip>
    </span>
  );
}

/** Reusable "what does hit rate mean?" tooltip. */
export function HitRateInfo({ side }: { side?: "top" | "right" | "bottom" | "left" }) {
  return <InfoTip side={side}>{HIT_RATE_DEFINITION}</InfoTip>;
}
