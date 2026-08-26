"use client";

import * as React from "react";
import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react";
import type { Trend } from "@/lib/analytics/trends";
import { formatTrendDelta, TREND_MATURATION_CAVEAT } from "@/lib/analytics/trends";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCompactNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The movement indicator used everywhere a metric has a previous period.
 *
 * Colour follows *meaning*, not direction. `isImprovement` is computed from the
 * metric's declared direction, so a rise in a neutral metric (upload frequency)
 * renders grey with a plain arrow rather than green — the arrow says what
 * happened, the colour says whether it was good, and for some metrics only the
 * first of those is knowable.
 *
 * No baseline renders an em dash. A fabricated direction is worse than silence.
 */
export function TrendIndicator({
  trend,
  size = "sm",
  showGlyph = true,
  valueFormat,
  className,
}: {
  trend: Trend;
  size?: "xs" | "sm" | "md";
  showGlyph?: boolean;
  /** How to render the raw previous value inside the tooltip. */
  valueFormat?: "percent" | "views" | "count" | "decimal";
  className?: string;
}) {
  const textClass = { xs: "text-[10px]", sm: "text-[11px]", md: "text-[12px]" }[size];
  const iconClass = { xs: "size-2.5", sm: "size-3", md: "size-3.5" }[size];

  if (!trend.hasComparison) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "tnum inline-flex cursor-default items-center text-subtle-foreground",
              textClass,
              className,
            )}
          >
            —
          </span>
        </TooltipTrigger>
        <TooltipContent>
          No comparable data in the previous period, so no trend is shown.
        </TooltipContent>
      </Tooltip>
    );
  }

  const tone =
    trend.isImprovement === true
      ? "text-success"
      : trend.isImprovement === false
        ? "text-danger"
        : "text-muted-foreground";

  const Icon =
    trend.movement === "up" ? ArrowUp : trend.movement === "down" ? ArrowDown : ArrowRight;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "tnum inline-flex cursor-default items-center gap-0.5 whitespace-nowrap",
            textClass,
            tone,
            className,
          )}
        >
          {showGlyph ? <Icon className={cn(iconClass, "shrink-0")} /> : null}
          {formatTrendDelta(trend)}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <span className="block">
          Previous period: {formatTrendValue(trend.previous, valueFormat ?? inferFormat(trend))}
          {" → "}
          {formatTrendValue(trend.current, valueFormat ?? inferFormat(trend))}
        </span>
        {trend.direction === "neutral" ? (
          <span className="mt-1 block text-subtle-foreground">
            Shown without a verdict: higher is not inherently better for this metric.
          </span>
        ) : null}
        <span className="mt-1 block text-subtle-foreground">{TREND_MATURATION_CAVEAT}</span>
      </TooltipContent>
    </Tooltip>
  );
}

function inferFormat(trend: Trend): "percent" | "views" {
  return trend.unit === "percentagePoints" ? "percent" : "views";
}

function formatTrendValue(
  value: number | null,
  format: "percent" | "views" | "count" | "decimal",
): string {
  if (value === null) return "—";
  switch (format) {
    case "percent":
      return formatPercent(value);
    case "decimal":
      return value.toFixed(1);
    case "count":
      return String(Math.round(value));
    case "views":
    default:
      return formatCompactNumber(value);
  }
}

/**
 * A metric value with its trend underneath — the standard KPI presentation.
 */
export function TrendedValue({
  value,
  trend,
  size = "md",
  valueFormat,
  className,
}: {
  value: React.ReactNode;
  trend: Trend;
  size?: "sm" | "md" | "lg";
  valueFormat?: "percent" | "views" | "count" | "decimal";
  className?: string;
}) {
  const valueClass = {
    sm: "text-[15px]",
    md: "text-[19px]",
    lg: "text-[26px]",
  }[size];

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <span
        className={cn(
          "tnum truncate font-semibold leading-none tracking-tight text-foreground",
          valueClass,
        )}
      >
        {value}
      </span>
      <TrendIndicator trend={trend} valueFormat={valueFormat} />
    </div>
  );
}
