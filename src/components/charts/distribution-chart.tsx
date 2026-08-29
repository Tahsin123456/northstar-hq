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
import type { ViewDistributionBin } from "@/lib/analytics/types";
import { UNCONFIGURED_THRESHOLD_LABEL } from "@/lib/analytics/constants";
import { formatCompactNumber, formatPercent } from "@/lib/format";
import {
  AXIS_TICK,
  AXIS_TICK_MARGIN,
  categoryAxisWidth,
  TOOLTIP_CONTAINMENT,
} from "./chart-layout";
import { cn } from "@/lib/utils";

/**
 * Distribution of Shorts by view count.
 *
 * WHY IT EXISTS
 * Hit rate alone is ambiguous. Two channels can both sit at 20%: one clusters
 * just under the threshold and is a nudge away from doubling its rate, the
 * other has nothing between 3K and 40M and is living off two flukes. The shape
 * distinguishes them instantly.
 *
 * LAYOUT
 * Horizontal, not vertical. Ten buckets labelled "250K–500K" will not fit
 * along an x-axis at any realistic card width, and rotating them only degrades
 * further as the container narrows. Running them down the y-axis gives them
 * room to be read straight at every breakpoint, and the axis gutter is sized
 * from the widest label rather than guessed.
 *
 * COMPARISON MODE
 * When a comparison series is supplied, each bucket shows two bars — now and
 * then — as *shares* rather than counts, because the two periods rarely
 * contain the same number of Shorts and raw counts would compare volume
 * instead of shape.
 */
export function DistributionChart({
  bins,
  threshold,
  comparisonBins,
  comparisonLabel,
  className,
}: {
  bins: readonly ViewDistributionBin[];
  /** `null` when the niche in view has no configured threshold. */
  threshold: number | null;
  /** Optional second series, e.g. the same window 30 days ago. */
  comparisonBins?: readonly ViewDistributionBin[] | null;
  comparisonLabel?: string;
  className?: string;
}) {
  const total = bins.reduce((sum, bin) => sum + bin.count, 0);
  const comparing = Boolean(comparisonBins && comparisonBins.length > 0);

  if (total === 0) {
    return (
      <div
        className={cn(
          "flex h-[240px] items-center justify-center rounded-lg border border-dashed border-border px-4 text-center text-[13px] text-subtle-foreground",
          className,
        )}
      >
        No Shorts to distribute
      </div>
    );
  }

  const comparisonTotal = (comparisonBins ?? []).reduce((sum, b) => sum + b.count, 0);

  // Shares when comparing (different sample sizes), counts otherwise (more
  // directly meaningful when there is only one series).
  const data = bins.map((bin, i) => {
    const other = comparisonBins?.[i];
    return {
      ...bin,
      current: comparing
        ? Math.round((total === 0 ? 0 : bin.count / total) * 1000) / 10
        : bin.count,
      comparison:
        comparing && other
          ? Math.round((comparisonTotal === 0 ? 0 : other.count / comparisonTotal) * 1000) / 10
          : 0,
      comparisonCount: other?.count ?? 0,
    };
  });

  const maxValue = Math.max(
    ...data.map((d) => Math.max(d.current, d.comparison)),
    comparing ? 1 : 1,
  );

  const labels = bins.map((b) => b.label);
  const yWidth = categoryAxisWidth(labels);
  const anyHitBucket = bins.some((b) => b.isHitBucket);

  // A fixed row height keeps every bucket the same visual weight and lets the
  // chart grow with the data instead of squeezing ten rows into a fixed box.
  const rowHeight = comparing ? 34 : 24;
  const chartHeight = bins.length * rowHeight + 40;

  return (
    <div className={className}>
      {comparing ? (
        <div className="mb-3 flex flex-wrap items-center gap-4 text-[11px]">
          <LegendSwatch color="var(--chart-1)" label={`Current · ${total} Shorts`} />
          <LegendSwatch
            color="var(--border-strong)"
            label={`${comparisonLabel ?? "Earlier"} · ${comparisonTotal} Shorts`}
          />
        </div>
      ) : null}

      <div style={{ height: chartHeight }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout="vertical"
            // Right margin reserves room for the value label drawn past the end
            // of the longest bar; bottom for the x-axis tick text.
            margin={{ top: 4, right: 46, bottom: 0, left: 0 }}
            barCategoryGap={comparing ? 6 : 4}
          >
            <CartesianGrid strokeDasharray="3 3" horizontal={false} />

            <XAxis
              type="number"
              // Headroom so the longest bar plus its label stays inside.
              domain={[0, comparing ? Math.ceil(maxValue * 1.2) : Math.ceil(maxValue * 1.15)]}
              tickLine={false}
              axisLine={false}
              tickMargin={AXIS_TICK_MARGIN}
              height={26}
              allowDecimals={false}
              tickFormatter={(v: number) => (comparing ? `${v}%` : String(v))}
              tick={AXIS_TICK}
            />

            <YAxis
              type="category"
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={AXIS_TICK_MARGIN}
              // Derived from the widest bucket label, so "250K–500K" is never
              // truncated and a short-label chart does not waste the gutter.
              width={yWidth}
              tick={AXIS_TICK}
            />

            <Tooltip
              cursor={{ fill: "var(--surface-hover)" }}
              content={
                <DistributionTooltip
                  total={total}
                  comparisonTotal={comparisonTotal}
                  comparing={comparing}
                  comparisonLabel={comparisonLabel}
                />
              }
              {...TOOLTIP_CONTAINMENT}
            />

            {comparing ? (
              <Bar
                dataKey="comparison"
                radius={[0, 3, 3, 0]}
                isAnimationActive={false}
                barSize={10}
                fill="var(--border-strong)"
              />
            ) : null}

            <Bar
              dataKey="current"
              radius={[0, 3, 3, 0]}
              isAnimationActive={false}
              barSize={comparing ? 10 : 16}
            >
              {bins.map((bin) => (
                <Cell
                  key={bin.id}
                  // Emerald above the threshold, neutral below. Two states, no
                  // gradient — the reader only needs "hit or not".
                  fill={
                    comparing
                      ? "var(--chart-1)"
                      : bin.isHitBucket
                        ? "var(--chart-2)"
                        : "var(--border-strong)"
                  }
                />
              ))}
              <LabelList
                dataKey="current"
                position="right"
                offset={6}
                formatter={(value: unknown) => {
                  if (typeof value !== "number" || value <= 0) return "";
                  return comparing ? `${value}%` : String(value);
                }}
                style={{ fill: "var(--muted-foreground)", fontSize: 10 }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-subtle-foreground">
        <span
          className="mt-1 inline-block size-2 shrink-0 rounded-[2px]"
          style={{ background: comparing ? "var(--chart-1)" : "var(--chart-2)" }}
          aria-hidden
        />
        <span>
          {comparing ? (
            <>
              Shown as a share of each period&rsquo;s own output, so the shapes are
              comparable even when the volumes are not.
            </>
          ) : threshold === null ? (
            /* The shape is real and worth reading; the verdict is what is
               missing. Naming a threshold here would invent one. */
            <>
              {UNCONFIGURED_THRESHOLD_LABEL}, so no bucket is marked as a hit zone.
              The distribution itself is unaffected.
            </>
          ) : anyHitBucket ? (
            <>Buckets at or above {formatCompactNumber(threshold)} views count as hits.</>
          ) : (
            <>
              The current threshold of {formatCompactNumber(threshold)} views sits above
              every bucket shown.
            </>
          )}
        </span>
      </p>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-[2px]"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

interface TooltipPayloadItem {
  payload?: ViewDistributionBin & { comparisonCount?: number };
}

function DistributionTooltip({
  active,
  payload,
  total,
  comparisonTotal,
  comparing,
  comparisonLabel,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  total: number;
  comparisonTotal: number;
  comparing: boolean;
  comparisonLabel?: string;
}) {
  const bin = payload?.[0]?.payload;
  if (!active || !bin) return null;

  const currentShare = total === 0 ? 0 : (bin.count / total) * 100;
  const priorCount = bin.comparisonCount ?? 0;
  const priorShare = comparisonTotal === 0 ? 0 : (priorCount / comparisonTotal) * 100;
  const shift = currentShare - priorShare;

  return (
    <div className="max-w-[230px] rounded-md border border-border bg-surface-raised px-3 py-2 shadow-lg shadow-black/30">
      <div className="text-[11px] font-medium text-foreground">{bin.label} views</div>

      <div className="mt-1.5 flex flex-col gap-0.5 text-[11px]">
        <Row label="Current" value={`${bin.count} · ${formatPercent(currentShare)}`} strong />
        {comparing ? (
          <>
            <Row
              label={comparisonLabel ?? "Earlier"}
              value={`${priorCount} · ${formatPercent(priorShare)}`}
            />
            <Row
              label="Shift"
              value={`${shift > 0 ? "+" : shift < 0 ? "−" : ""}${Math.abs(shift).toFixed(1)} pp`}
              tone={Math.abs(shift) < 0.5 ? "muted" : shift > 0 ? "up" : "down"}
            />
          </>
        ) : null}
      </div>

      {bin.isHitBucket ? (
        <div className="mt-1.5 border-t border-border pt-1.5 text-[10px] uppercase tracking-wide text-success">
          Counts as a hit
        </div>
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  tone = "default",
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "default" | "muted" | "up" | "down";
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "tnum",
          strong && "font-medium",
          tone === "up" && "text-success",
          tone === "down" && "text-danger",
          tone === "muted" && "text-subtle-foreground",
          tone === "default" && "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}
