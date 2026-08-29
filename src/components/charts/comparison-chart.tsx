"use client";

import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AXIS_TICK,
  AXIS_TICK_MARGIN,
  categoryAxisWidth,
  TOOLTIP_CONTAINMENT,
  xAxisHeight,
} from "./chart-layout";
import { formatCompactNumber, formatFraction, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface ComparisonDatum {
  readonly id: string;
  readonly name: string;
  readonly hitRate: number | null;
  readonly hitCount: number;
  /**
   * Shorts with a decided outcome. THE DENOMINATOR OF `hitRate`.
   *
   * Separate from `totalShorts` because the two diverge, often widely: a bar
   * showing 60% where three of five decided Shorts hit, out of forty published,
   * is a real and useful number attached to a very thin base. Pairing the rate
   * with the upload count would misstate it by an order of magnitude.
   */
  readonly judged: number;
  /** Shorts uploaded in the period, decided or not. */
  readonly totalShorts: number;
  /** Uploaded but in neither half: pending, unrecorded, or with no rule. */
  readonly excluded: number;
  readonly medianViews: number | null;
  readonly colorIndex: number;
}

const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];

export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length];
}

/**
 * Side-by-side hit rate.
 *
 * Horizontal bars rather than vertical: channel names are long and legible
 * running along a y-axis, whereas vertical bars force them to rotate or
 * truncate. Channels with no Shorts in the window are excluded rather than
 * drawn as zero-length bars, which would read as "measured and terrible"
 * instead of "not measured".
 */
export function ComparisonChart({
  data,
  className,
  height,
}: {
  data: readonly ComparisonDatum[];
  className?: string;
  height?: number;
}) {
  const measurable = data.filter((d) => d.hitRate !== null);
  const chartHeight = height ?? Math.max(140, measurable.length * 44 + 40);

  if (measurable.length === 0) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-lg border border-dashed border-border text-[13px] text-subtle-foreground",
          className,
        )}
        style={{ height: 140 }}
      >
        None of the selected channels published Shorts in this period
      </div>
    );
  }

  const maxRate = Math.max(...measurable.map((d) => d.hitRate ?? 0));
  const xMax = Math.min(100, Math.max(10, Math.ceil((maxRate * 1.2) / 5) * 5));

  return (
    <div className={className} style={{ height: chartHeight }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={measurable as ComparisonDatum[]}
          layout="vertical"
          margin={{ top: 4, right: 44, bottom: 4, left: 4 }}
          barCategoryGap={12}
        >
          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
          <XAxis
            type="number"
            domain={[0, xMax]}
            tickLine={false}
            axisLine={false}
            tickMargin={AXIS_TICK_MARGIN}
            height={xAxisHeight([])}
            tickFormatter={(value: number) => `${value}%`}
            tick={AXIS_TICK}
          />
          {/* Derived from the channel names actually on screen. A hardcoded
              width is correct until somebody tracks a channel with a longer
              name, at which point the label is silently sliced off by the SVG
              edge — the exact regression chart-layout.ts exists to prevent. */}
          <YAxis
            type="category"
            dataKey="name"
            tickLine={false}
            axisLine={false}
            tickMargin={AXIS_TICK_MARGIN}
            width={categoryAxisWidth(measurable.map((datum) => datum.name))}
            tick={AXIS_TICK}
          />
          <Tooltip
            cursor={{ fill: "var(--surface-hover)" }}
            content={<ComparisonTooltip />}
            {...TOOLTIP_CONTAINMENT}
          />

          <Bar dataKey="hitRate" radius={[0, 3, 3, 0]} isAnimationActive={false} barSize={22}>
            {measurable.map((datum) => (
              <Cell key={datum.id} fill={seriesColor(datum.colorIndex)} />
            ))}
            <LabelList
              dataKey="hitRate"
              position="right"
              formatter={(value: unknown) =>
                typeof value === "number" ? formatPercent(value) : ""
              }
              style={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

interface TooltipPayloadItem {
  payload?: ComparisonDatum;
}

function ComparisonTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
}) {
  const datum = payload?.[0]?.payload;
  if (!active || !datum) return null;

  return (
    <div className="rounded-md border border-border bg-surface-raised px-3 py-2 shadow-lg shadow-black/30">
      <div className="text-[11px] font-medium text-foreground">{datum.name}</div>
      <div className="mt-1 flex flex-col gap-0.5 text-[11px]">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">Hit rate</span>
          <span className="tnum text-foreground">{formatPercent(datum.hitRate)}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">Hits</span>
          <span className="tnum text-foreground">
            {formatFraction(datum.hitCount, datum.judged)} decided
          </span>
        </div>
        {/* The bar's height is a rate over decided Shorts. Two bars of equal
            height built on 50 decided Shorts and on 3 are not equally
            convincing, and this line is the only thing on the chart that can
            say so. */}
        {datum.excluded > 0 ? (
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Not decided</span>
            <span className="tnum text-subtle-foreground">
              {datum.excluded} of {datum.totalShorts} uploaded
            </span>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">Median views</span>
          <span className="tnum text-foreground">
            {formatCompactNumber(datum.medianViews)}
          </span>
        </div>
      </div>
    </div>
  );
}
