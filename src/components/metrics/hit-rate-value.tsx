"use client";

import * as React from "react";
import { HIT_RATE_DEFINITION } from "@/lib/analytics/constants";
import {
  EM_DASH,
  formatCompactNumber,
  formatFraction,
  formatNumber,
  formatPercent,
} from "@/lib/format";
import { InfoTip } from "@/components/ui/tooltip";
import { ThresholdNotConfigured } from "@/components/metrics/threshold-not-configured";
import { cn } from "@/lib/utils";

/**
 * The product's headline number.
 *
 * Three deliberate choices:
 *
 *  1. `null` renders as an em dash with a "no Shorts" caption, never 0%.
 *     A channel that published nothing has no hit rate; claiming 0% would
 *     accuse it of publishing and failing.
 *
 *  2. The fraction ("12 / 38") sits directly beneath the percentage. A rate
 *     without its denominator is not interpretable — 100% from one upload and
 *     100% from forty are different facts — and putting them together removes
 *     the need to go looking.
 *
 *  3. The bar is a single accent colour at fixed opacity, not a red-to-green
 *     gradient. Hit rate is already a number; colour-coding it would add
 *     judgement the data does not support.
 *
 *  4. `threshold === null` renders "Not configured", not a percentage and not
 *     an em dash. The niche in view has no definition of a hit, so there is no
 *     rate to report — a figure here would be arithmetic over a number nobody
 *     chose, and an em dash would be indistinguishable from "no Shorts".
 */
export function HitRateValue({
  hitRate,
  hitCount,
  totalShorts,
  size = "md",
  showBar = true,
  showFraction = true,
  threshold,
  className,
}: {
  hitRate: number | null;
  hitCount: number;
  totalShorts: number;
  size?: "sm" | "md" | "lg" | "xl";
  showBar?: boolean;
  showFraction?: boolean;
  /**
   * Shown alongside the fraction. Since niches can define a hit differently,
   * a bare "12 / 43" is ambiguous across niches — the threshold makes each
   * number self-describing.
   *
   * `null` is the fourth possibility and the one that matters: the active niche
   * has no threshold, so this component renders "Not configured" instead of a
   * percentage. `undefined` still means "the caller has a threshold but does not
   * want it printed here", which is a different statement.
   */
  threshold?: number | null;
  className?: string;
}) {
  /*
   * Two distinct absences, and conflating them is the bug this whole round is
   * about. `threshold === null` means nobody has said what a hit is, so no rate
   * can exist. `hitRate === null` with a threshold present means the channel
   * published nothing in the window. The first renders as words, the second as
   * an em dash, and neither renders as 0%.
   */
  const isUnconfigured = threshold === null;
  const hasData = !isUnconfigured && hitRate !== null;

  if (isUnconfigured) {
    return (
      <div className={cn("flex flex-col gap-1", className)}>
        <ThresholdNotConfigured size={size} />
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
          {hasData ? formatPercent(hitRate) : EM_DASH}
        </span>
      </div>

      {showBar ? (
        <div
          className="h-[3px] w-full overflow-hidden rounded-full bg-border"
          role="presentation"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
            style={{ width: `${Math.min(100, Math.max(0, hitRate ?? 0))}%` }}
          />
        </div>
      ) : null}

      {showFraction ? (
        <span className="tnum text-[11px] leading-none text-subtle-foreground">
          {hasData ? (
            <>
              {formatFraction(hitCount, totalShorts)}
              <span className="ml-1 text-subtle-foreground/70">
                {threshold === undefined
                  ? "Shorts"
                  : `Shorts ≥${formatCompactNumber(threshold)}`}
              </span>
            </>
          ) : (
            "No Shorts in period"
          )}
        </span>
      ) : null}
    </div>
  );
}

/** Reusable "what does hit rate mean?" tooltip. */
export function HitRateInfo({ side }: { side?: "top" | "right" | "bottom" | "left" }) {
  return <InfoTip side={side}>{HIT_RATE_DEFINITION}</InfoTip>;
}
