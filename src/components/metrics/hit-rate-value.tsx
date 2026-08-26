"use client";

import * as React from "react";
import { HIT_RATE_DEFINITION } from "@/lib/analytics/constants";
import { EM_DASH, formatCompactNumber, formatFraction, formatPercent } from "@/lib/format";
import { InfoTip } from "@/components/ui/tooltip";
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
   */
  threshold?: number;
  className?: string;
}) {
  const hasData = hitRate !== null;

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
