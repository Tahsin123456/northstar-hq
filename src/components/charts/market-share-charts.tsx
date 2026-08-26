"use client";

import * as React from "react";
import {
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MarketShare, MarketSharePoint } from "@/lib/analytics/market-share";
import { formatCompactNumber, formatPercent } from "@/lib/format";
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
 * Tracked market share, as a donut with the headline number in the middle.
 *
 * A donut rather than a pie specifically so the centre can hold the number.
 * Two slices is the most a share chart should ever have — anything more and a
 * bar chart reads better — and the middle is otherwise wasted space.
 *
 * The exact view counts sit beneath rather than as slice labels, which at two
 * slices would collide with each other at small widths.
 */
export function MarketShareDonut({
  share,
  ourLabel = "Northstar Studios",
  className,
  size = 168,
}: {
  share: MarketShare;
  ourLabel?: string;
  className?: string;
  size?: number;
}) {
  if (share.sharePercent === null) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-lg border border-dashed border-border px-4 text-center text-[13px] text-subtle-foreground",
          className,
        )}
        style={{ height: size }}
      >
        No tracked Shorts views in this period
      </div>
    );
  }

  const data = [
    { name: ourLabel, value: share.ourViews, fill: "var(--chart-1)" },
    { name: "Tracked competitors", value: share.competitorViews, fill: "var(--border-strong)" },
  ];

  return (
    <div className={cn("flex flex-col items-center gap-4", className)}>
      <div className="relative" style={{ width: size, height: size }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius="66%"
              outerRadius="100%"
              startAngle={90}
              endAngle={-270}
              paddingAngle={1.5}
              stroke="none"
              isAnimationActive={false}
            >
              {data.map((entry) => (
                <Cell key={entry.name} fill={entry.fill} />
              ))}
            </Pie>
            <Tooltip
              content={<ShareTooltip total={share.totalViews} />}
              {...TOOLTIP_CONTAINMENT}
            />
          </PieChart>
        </ResponsiveContainer>

        {/* The number the chart exists to communicate, dead centre. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="tnum text-[26px] font-semibold leading-none tracking-tight text-foreground">
            {formatPercent(share.sharePercent, 1)}
          </span>
          <span className="mt-1 max-w-[92px] text-center text-[9px] font-medium uppercase leading-tight tracking-wider text-subtle-foreground">
            Tracked market share
          </span>
        </div>
      </div>

      <div className="flex w-full flex-col gap-1.5">
        <ShareLegendRow
          color="var(--chart-1)"
          label={ourLabel}
          views={share.ourViews}
          shorts={share.ourShorts}
        />
        <ShareLegendRow
          color="var(--border-strong)"
          label="Tracked competitors"
          views={share.competitorViews}
          shorts={share.competitorShorts}
        />
      </div>
    </div>
  );
}

function ShareLegendRow({
  color,
  label,
  views,
  shorts,
}: {
  color: string;
  label: string;
  views: number;
  shorts: number;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-[11px]">
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-[2px]"
          style={{ background: color }}
        />
        <span className="truncate text-muted-foreground">{label}</span>
      </span>
      <span className="tnum shrink-0 text-foreground">
        {formatCompactNumber(views)}
        <span className="ml-1.5 text-subtle-foreground">
          {shorts} {shorts === 1 ? "Short" : "Shorts"}
        </span>
      </span>
    </div>
  );
}

function ShareTooltip({
  active,
  payload,
  total,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number }>;
  total: number;
}) {
  const entry = payload?.[0];
  if (!active || !entry) return null;

  const value = Number(entry.value ?? 0);
  return (
    <div className="rounded-md border border-border bg-surface-raised px-3 py-2 shadow-lg shadow-black/30">
      <div className="text-[11px] font-medium text-foreground">{entry.name}</div>
      <div className="tnum mt-1 text-[11px] text-muted-foreground">
        {formatCompactNumber(value)} views ·{" "}
        {formatPercent(total === 0 ? 0 : (value / total) * 100)}
      </div>
    </div>
  );
}

/**
 * Tracked market share over time.
 *
 * Buckets with no tracked output anywhere render as gaps, not zeros — the same
 * rule the hit-rate series uses. A week when the whole niche went quiet is a
 * hole in the data, not a collapse in share.
 */
export function MarketShareTrendChart({
  points,
  averageShare,
  className,
  height = 220,
}: {
  points: readonly MarketSharePoint[];
  averageShare: number | null;
  className?: string;
  height?: number;
}) {
  const hasData = points.some((p) => p.sharePercent !== null);

  if (!hasData) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-lg border border-dashed border-border px-4 text-center text-[13px] text-subtle-foreground",
          className,
        )}
        style={{ height }}
      >
        Not enough tracked output in this period to plot a share trend
      </div>
    );
  }

  const max = Math.max(...points.map((p) => p.sharePercent ?? 0), averageShare ?? 0);
  const yMax = Math.min(100, Math.max(20, Math.ceil((max * 1.3) / 10) * 10));

  const xLabels = points.map((p) => p.label);
  const yWidth = percentAxisWidth(yMax);
  const rightMargin = trailingLabelMargin(xLabels);

  return (
    <div className={className} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={points as MarketSharePoint[]}
          margin={{ top: 10, right: rightMargin, bottom: 0, left: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={AXIS_TICK_MARGIN}
            height={xAxisHeight(xLabels)}
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
          <Tooltip
            cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }}
            content={<ShareTrendTooltip />}
            {...TOOLTIP_CONTAINMENT}
          />
          <Line
            type="monotone"
            dataKey="sharePercent"
            stroke="var(--chart-1)"
            strokeWidth={2}
            connectNulls={false}
            dot={{ r: 2.5, fill: "var(--chart-1)", strokeWidth: 0 }}
            activeDot={{ r: 4, fill: "var(--chart-1)", stroke: "var(--surface)", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function ShareTrendTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: MarketSharePoint }>;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="max-w-[210px] rounded-md border border-border bg-surface-raised px-3 py-2 shadow-lg shadow-black/30">
      <div className="text-[11px] font-medium text-foreground">{point.label}</div>
      {point.sharePercent === null ? (
        <div className="mt-1 text-[11px] leading-relaxed text-subtle-foreground">
          No tracked Shorts published
        </div>
      ) : (
        <div className="mt-1.5 flex flex-col gap-0.5 text-[11px]">
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Share</span>
            <span className="tnum font-medium text-foreground">
              {formatPercent(point.sharePercent)}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Ours</span>
            <span className="tnum text-foreground">{formatCompactNumber(point.ourViews)}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Competitors</span>
            <span className="tnum text-foreground">
              {formatCompactNumber(point.competitorViews)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
