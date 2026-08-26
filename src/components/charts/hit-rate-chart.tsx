"use client";

import * as React from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { HitRateSeriesPoint, SeriesGranularity } from "@/lib/analytics/types";
import {
  formatAxisNumber,
  formatCompactNumber,
  formatFraction,
  formatPercent,
} from "@/lib/format";
import {
  AXIS_TICK,
  AXIS_TICK_MARGIN,
  percentAxisWidth,
  TOOLTIP_CONTAINMENT,
  trailingLabelMargin,
  xAxisHeight,
  xAxisMinTickGap,
} from "./chart-layout";
import { cn } from "@/lib/utils";

/**
 * Hit rate over time.
 *
 * TWO THINGS THIS GETS RIGHT
 *
 * 1. `connectNulls={false}`.
 *    A bucket with no uploads has a `null` hit rate, not zero. Plotting zero
 *    would draw a dive to the floor and read as "this channel collapsed", when
 *    the truth is "this channel published nothing that week". A visible gap is
 *    the honest rendering, and it is exactly the signal someone judging
 *    consistency needs: gaps mean irregular output.
 *
 * 2. Nothing is clipped.
 *    Axis widths and margins are derived from the actual formatted tick text
 *    rather than guessed. Recharts does not measure its own labels, so a fixed
 *    `width` either truncates "100%" or wastes a third of the plot area. The
 *    x-axis thins its own ticks by available width instead of overlapping, and
 *    the right margin reserves room for the final label so it cannot be cut in
 *    half by the container edge.
 */
export function HitRateChart({
  points,
  granularity,
  averageHitRate,
  className,
  height = 260,
}: {
  points: readonly HitRateSeriesPoint[];
  granularity: SeriesGranularity;
  averageHitRate: number | null;
  className?: string;
  height?: number;
}) {
  const hasAnyData = points.some((p) => p.totalShorts > 0);

  // Headroom above the peak so the line never touches the frame, but never
  // below 20% or a flat low series looks dramatic.
  const maxRate = Math.max(...points.map((p) => p.hitRate ?? 0), 0);
  const yMax = Math.min(100, Math.max(20, Math.ceil((maxRate * 1.25) / 10) * 10));

  const data = points.map((point) => ({ ...point, value: point.hitRate }));

  // Axis space is derived from the labels that will actually be drawn, so a
  // wide value can never be clipped and a narrow one never wastes plot area.
  const xLabels = points.map((p) => p.label);
  const yWidth = percentAxisWidth(yMax);
  const rightMargin = trailingLabelMargin(xLabels);

  if (!hasAnyData) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-lg border border-dashed border-border px-4 text-center text-[13px] text-subtle-foreground",
          className,
        )}
        style={{ height }}
      >
        No Shorts published in this period
      </div>
    );
  }

  return (
    <div className={className} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          // Right margin reserves space for the final x tick; bottom for the
          // tick text itself. Left is 0 because YAxis owns its own width.
          margin={{ top: 10, right: rightMargin, bottom: 0, left: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" vertical={false} />

          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={AXIS_TICK_MARGIN}
            height={xAxisHeight(xLabels)}
            // Thins by exactly the measured label width rather than a guess, so
            // ticks are only dropped when they genuinely would not fit.
            interval="preserveStartEnd"
            minTickGap={xAxisMinTickGap(xLabels)}
            tick={AXIS_TICK}
          />

          <YAxis
            domain={[0, yMax]}
            tickLine={false}
            axisLine={false}
            tickMargin={AXIS_TICK_MARGIN}
            width={yWidth}
            tickFormatter={(value: number) => `${value}%`}
            tick={AXIS_TICK}
          />

          {averageHitRate !== null ? (
            <ReferenceLine
              y={averageHitRate}
              stroke="var(--subtle-foreground)"
              strokeDasharray="4 4"
              strokeOpacity={0.55}
              label={{
                value: `avg ${formatPercent(averageHitRate, 0)}`,
                position: "insideTopRight",
                fill: "var(--subtle-foreground)",
                fontSize: 10,
                // Nudged clear of the plot edge so it cannot sit half outside.
                dy: -4,
                dx: -2,
              }}
            />
          ) : null}

          <Tooltip
            cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }}
            content={<HitRateTooltip granularity={granularity} />}
            {...TOOLTIP_CONTAINMENT}
          />

          <Line
            type="monotone"
            dataKey="value"
            stroke="var(--chart-1)"
            strokeWidth={2}
            connectNulls={false}
            dot={{ r: 2.5, fill: "var(--chart-1)", strokeWidth: 0 }}
            activeDot={{
              r: 4,
              fill: "var(--chart-1)",
              stroke: "var(--surface)",
              strokeWidth: 2,
            }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

interface TooltipPayloadItem {
  payload?: HitRateSeriesPoint;
}

function HitRateTooltip({
  active,
  payload,
  granularity,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  granularity: SeriesGranularity;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  const periodWord =
    granularity === "day" ? "day" : granularity === "week" ? "week" : "month";

  return (
    <div className="max-w-[220px] rounded-md border border-border bg-surface-raised px-3 py-2 shadow-lg shadow-black/30">
      <div className="text-[11px] font-medium text-foreground">{point.label}</div>

      {point.totalShorts === 0 ? (
        <div className="mt-1 text-[11px] leading-relaxed text-subtle-foreground">
          No Shorts published this {periodWord}
        </div>
      ) : (
        <div className="mt-1.5 flex flex-col gap-0.5 text-[11px]">
          <Row label="Hit rate" value={formatPercent(point.hitRate)} strong />
          <Row label="Hits" value={formatFraction(point.hitCount, point.totalShorts)} />
          {/* Exact figures live here; the axis only has to convey scale. */}
          <Row label="Views" value={formatCompactNumber(point.totalViews)} />
          <Row label="Median" value={formatCompactNumber(point.medianViews)} />
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("tnum", strong ? "font-medium text-foreground" : "text-foreground")}>
        {value}
      </span>
    </div>
  );
}

export { formatAxisNumber };
