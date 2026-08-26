"use client";

import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { FinanceBreakdownSlice, FinanceSeriesPoint } from "@/lib/finance/types";
import { formatMoney, formatMoneyCompact } from "@/lib/finance/money";
import { formatNumber, formatPercent } from "@/lib/format";
import {
  approximateTextWidth,
  AXIS_TICK,
  AXIS_TICK_MARGIN,
  categoryAxisWidth,
  TOOLTIP_CONTAINMENT,
  trailingLabelMargin,
  widestLabelWidth,
  xAxisHeight,
  xAxisMinTickGap,
} from "./chart-layout";
import { cn } from "@/lib/utils";

/**
 * =========================================================================
 * FINANCE CHARTS
 * =========================================================================
 *
 * The four charts the Finance overview is allowed to have. Kept out of the page
 * for the same reason `market-share-charts.tsx` is: axis-sizing and tooltip
 * detail is a lot of code that has nothing to say about the screen's layout.
 *
 * COLOUR HAS ONE JOB HERE
 * Revenue takes the success hue and expenses the danger hue — the same two the
 * net-profit figure above them is coloured with — so money-in and money-out
 * read identically everywhere on the page. The accent is reserved for the
 * derived series (net profit), and the six-colour cycle appears only where a
 * breakdown genuinely has unordered categories to tell apart. Nothing here is
 * coloured for decoration.
 */

const REVENUE_COLOR = "var(--chart-2)";
const EXPENSE_COLOR = "var(--chart-6)";
const NET_COLOR = "var(--chart-1)";

/** Cycle for categorical breakdowns, in the order the tokens are defined. */
const CATEGORY_COLORS = [
  "var(--chart-1)",
  "var(--chart-3)",
  "var(--chart-5)",
  "var(--chart-4)",
  "var(--chart-2)",
  "var(--chart-6)",
] as const;

function categoryColor(index: number): string {
  return CATEGORY_COLORS[index % CATEGORY_COLORS.length] ?? CATEGORY_COLORS[0];
}

// ---------------------------------------------------------------------------
// SHARED PIECES
// ---------------------------------------------------------------------------

/**
 * Width to reserve for an axis whose ticks are money.
 *
 * `numericAxisWidth` derives its reservation from `formatAxisNumber`, which has
 * no currency symbol in it — reserve with that and the axis then draws "₺1.2M"
 * into space measured for "1.2M". A one-or-two character shortfall is precisely
 * the few-pixel slice `chart-layout` exists to prevent, so this does the same
 * derivation against the strings that will actually be drawn.
 *
 * Recharts picks its own round ticks and pads the domain past the data, so the
 * candidate set carries a headroom value too. Compacting usually makes the
 * padded tick *shorter* ("$9.5K" becomes "$10K"), but reserving for it costs a
 * few invisible pixels and removes the question.
 */
function moneyAxisWidth(values: readonly number[], currency: string): number {
  const peak = values.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const candidates = [...values, peak * 1.25];
  // Only when the axis actually crosses zero: the minus sign is real width, and
  // reserving it on an all-positive axis just steals plot area.
  if (values.some((value) => value < 0)) candidates.push(-peak * 1.25);

  const labels = candidates.map((value) => formatMoneyCompact(value, currency));
  return Math.min(96, Math.max(44, Math.ceil(widestLabelWidth(labels)) + AXIS_TICK_MARGIN + 4));
}

const ELLIPSIS = "…";

/**
 * Shortens a label so the text actually drawn fits the gutter reserved for it.
 *
 * `categoryAxisWidth` clamps at a ceiling on purpose — one long channel name
 * must not eat half the plot — but Recharts does not know about the clamp and
 * will draw the name straight past the reservation and out through the SVG
 * edge. Since the clamp is the right call, the string is what has to give: an
 * ellipsis is a visible, honest truncation, and the full name is one hover away
 * in the tooltip and spelled out in full in the table below the charts.
 *
 * `maxWidth` is derived from whatever `categoryAxisWidth` returned rather than
 * from a repeated constant, so this cannot drift out of step with the clamp.
 */
function fitLabel(text: string, maxWidth: number): string {
  if (approximateTextWidth(text) <= maxWidth) return text;

  const budget = maxWidth - approximateTextWidth(ELLIPSIS);
  let kept = text;
  while (kept.length > 1 && approximateTextWidth(kept) > budget) {
    kept = kept.slice(0, -1);
  }
  return `${kept.trimEnd()}${ELLIPSIS}`;
}

/** The house's "this chart has nothing to draw" box. */
function ChartEmpty({
  height,
  children,
  className,
}: {
  height: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-lg border border-dashed border-border px-4 text-center text-[13px] text-subtle-foreground",
        className,
      )}
      style={{ height }}
    >
      {children}
    </div>
  );
}

/**
 * A legend written by hand rather than Recharts'.
 *
 * Recharts' own `<Legend>` is laid out inside the SVG and takes its height out
 * of the plot, which is the one thing every helper in `chart-layout` is trying
 * to stop happening by accident. Two swatches above the chart cost nothing and
 * leave the reserved plot height exactly as calculated.
 */
function ChartLegend({ items }: { items: readonly { color: string; label: string }[] }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-[2px]"
            style={{ background: item.color }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}

/** One label/amount line inside a tooltip. */
function TooltipRow({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "success" | "danger";
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "tnum font-medium",
          tone === "success"
            ? "text-success"
            : tone === "danger"
              ? "text-danger"
              : "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function TooltipShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="max-w-[230px] rounded-md border border-border bg-surface-raised px-3 py-2 shadow-lg shadow-black/30">
      <div className="text-[11px] font-medium text-foreground">{title}</div>
      <div className="mt-1.5 flex flex-col gap-0.5 text-[11px]">{children}</div>
    </div>
  );
}

/** Sign-driven tone, shared by every net figure a tooltip shows. */
function netTone(minor: number): "default" | "success" | "danger" {
  if (minor > 0) return "success";
  if (minor < 0) return "danger";
  return "default";
}

// ---------------------------------------------------------------------------
// 1 — REVENUE VS EXPENSES OVER TIME
// ---------------------------------------------------------------------------

/**
 * Grouped bars rather than two lines.
 *
 * These are two independent quantities measured over the same buckets, not one
 * quantity trending — a line implies continuity between the points, and money
 * booked in March does not flow into April. Side-by-side bars also make the gap
 * between the pair, which is the net profit the next chart plots, readable
 * directly.
 */
export function RevenueExpenseChart({
  points,
  currency,
  height = 236,
  className,
}: {
  points: readonly FinanceSeriesPoint[];
  currency: string;
  height?: number;
  className?: string;
}) {
  const data = React.useMemo(() => points.map((point) => ({ ...point })), [points]);

  if (data.length === 0) {
    return <ChartEmpty height={height}>No entries in this period</ChartEmpty>;
  }

  const labels = data.map((point) => point.label);
  const yWidth = moneyAxisWidth(
    data.flatMap((point) => [point.revenueMinor, point.expenseMinor]),
    currency,
  );
  const xHeight = xAxisHeight(labels);

  return (
    <div className={className}>
      <ChartLegend
        items={[
          { color: REVENUE_COLOR, label: "Revenue" },
          { color: EXPENSE_COLOR, label: "Expenses" },
        ]}
      />
      <div style={{ height: height + xHeight }}>
        <ResponsiveContainer width="100%" height="100%">
          {/* top: 10 rather than 4 — the highest Y tick is centred on the top
              gridline, so half of its line box sits above the plot area and a
              smaller margin lets the SVG edge shave it. */}
          <BarChart data={data} margin={{ top: 10, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={AXIS_TICK_MARGIN}
              height={xHeight}
              interval="preserveStartEnd"
              minTickGap={xAxisMinTickGap(labels)}
              tick={AXIS_TICK}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={AXIS_TICK_MARGIN}
              width={yWidth}
              tickFormatter={(value: number) => formatMoneyCompact(value, currency)}
              tick={AXIS_TICK}
            />
            <Tooltip
              cursor={{ fill: "var(--surface-hover)" }}
              content={<SeriesTooltip currency={currency} />}
              {...TOOLTIP_CONTAINMENT}
            />
            <Bar
              dataKey="revenueMinor"
              name="Revenue"
              fill={REVENUE_COLOR}
              radius={[3, 3, 0, 0]}
              isAnimationActive={false}
            />
            <Bar
              dataKey="expenseMinor"
              name="Expenses"
              fill={EXPENSE_COLOR}
              radius={[3, 3, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2 — NET PROFIT OVER TIME
// ---------------------------------------------------------------------------

/**
 * Net profit per bucket, with zero drawn in.
 *
 * The reference line is not decoration: on a profit chart the only threshold
 * that matters is the one between making money and losing it, and without an
 * explicit zero a series sitting entirely below it reads as an ordinary dip.
 * Recharts would also happily choose a domain that never shows zero at all.
 */
export function NetProfitChart({
  points,
  currency,
  height = 236,
  className,
}: {
  points: readonly FinanceSeriesPoint[];
  currency: string;
  height?: number;
  className?: string;
}) {
  const data = React.useMemo(() => points.map((point) => ({ ...point })), [points]);

  if (data.length === 0) {
    return <ChartEmpty height={height}>No entries in this period</ChartEmpty>;
  }

  const labels = data.map((point) => point.label);
  const nets = data.map((point) => point.netMinor);
  const yWidth = moneyAxisWidth(nets, currency);
  const xHeight = xAxisHeight(labels);

  return (
    <div className={className} style={{ height: height + xHeight }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={{ top: 10, right: trailingLabelMargin(labels), bottom: 0, left: 0 }}
        >
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={AXIS_TICK_MARGIN}
            height={xHeight}
            interval="preserveStartEnd"
            minTickGap={xAxisMinTickGap(labels)}
            tick={AXIS_TICK}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tickMargin={AXIS_TICK_MARGIN}
            width={yWidth}
            tickFormatter={(value: number) => formatMoneyCompact(value, currency)}
            tick={AXIS_TICK}
          />
          {/* Break-even. Solid and slightly stronger than the grid, because it
              is a real boundary rather than another gridline. */}
          <ReferenceLine y={0} stroke="var(--border-strong)" strokeWidth={1} />
          <Tooltip
            cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }}
            content={<SeriesTooltip currency={currency} />}
            {...TOOLTIP_CONTAINMENT}
          />
          <Line
            type="monotone"
            dataKey="netMinor"
            name="Net profit"
            stroke={NET_COLOR}
            strokeWidth={2}
            dot={{ r: 2.5, fill: NET_COLOR, strokeWidth: 0 }}
            activeDot={{ r: 4, fill: NET_COLOR, stroke: "var(--surface)", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Shared by both time series, so a bucket reads the same whichever you hover. */
function SeriesTooltip({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: Array<{ payload?: FinanceSeriesPoint }>;
  currency: string;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <TooltipShell title={point.label}>
      <TooltipRow label="Revenue" value={formatMoney(point.revenueMinor, currency)} />
      <TooltipRow label="Expenses" value={formatMoney(point.expenseMinor, currency)} />
      <TooltipRow
        label="Net"
        value={formatMoney(point.netMinor, currency, { signDisplay: "always" })}
        tone={netTone(point.netMinor)}
      />
    </TooltipShell>
  );
}

// ---------------------------------------------------------------------------
// 3 — REVENUE BY CHANNEL
// ---------------------------------------------------------------------------

interface ChannelBarDatum extends FinanceBreakdownSlice {
  /** What the axis draws: `label`, shortened if the gutter cannot hold it. */
  readonly axisLabel: string;
}

/**
 * Horizontal bars, because the labels are channel names.
 *
 * Rotated vertical-bar labels are the commonest way a chart in this app loses
 * its axis to the SVG edge; laid on its side, a name gets a real gutter sized
 * by `categoryAxisWidth` and stays horizontal. The gutter has a ceiling, so a
 * name past it is ellipsised to fit rather than allowed to run out through the
 * edge — the tooltip and the table below both carry it in full.
 */
export function RevenueByChannelChart({
  slices,
  currency,
  maxBars = 8,
  className,
}: {
  slices: readonly FinanceBreakdownSlice[];
  currency: string;
  maxBars?: number;
  className?: string;
}) {
  const { data, axisWidth } = React.useMemo(() => {
    const collapsed = collapseTail(slices, maxBars, "channels");
    // Reserve first, then fit the strings to the reservation — the reverse of
    // the order that clips, and the reason nothing here needs a magic width.
    const width = categoryAxisWidth(collapsed.map((slice) => slice.label));
    const textBudget = width - AXIS_TICK_MARGIN - 4;
    return {
      axisWidth: width,
      data: collapsed.map<ChannelBarDatum>((slice) => ({
        ...slice,
        axisLabel: fitLabel(slice.label, textBudget),
      })),
    };
  }, [slices, maxBars]);

  if (data.length === 0) {
    return <ChartEmpty height={200}>No revenue recorded in this period</ChartEmpty>;
  }

  // The X axis here is the numeric one — this chart is on its side — so its
  // height is measured against the money ticks, not the channel names.
  const xHeight = xAxisHeight(data.map((slice) => formatMoneyCompact(slice.amountMinor, currency)));
  // One row per bar plus breathing space, floored so a single-channel chart is
  // not a lone bar in a letterbox.
  const plotHeight = Math.max(140, data.length * 32 + 16);

  return (
    <div className={className} style={{ height: plotHeight + xHeight }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          // The rightmost X tick is centred on the final gridline, so half its
          // text sits past the plot area. Reserve exactly that half rather than
          // a fixed 12px, which is ample for "$0" and one pixel short of
          // "$120K" — the kind of margin that looks fine until the numbers grow.
          margin={{
            top: 10,
            right: trailingLabelMargin(
              data.map((slice) => formatMoneyCompact(slice.amountMinor, currency)),
            ),
            bottom: 0,
            left: 0,
          }}
          barCategoryGap={8}
        >
          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
          <XAxis
            type="number"
            tickLine={false}
            axisLine={false}
            tickMargin={AXIS_TICK_MARGIN}
            height={xHeight}
            tickFormatter={(value: number) => formatMoneyCompact(value, currency)}
            tick={AXIS_TICK}
          />
          <YAxis
            type="category"
            dataKey="axisLabel"
            tickLine={false}
            axisLine={false}
            tickMargin={AXIS_TICK_MARGIN}
            width={axisWidth}
            tick={AXIS_TICK}
          />
          <Tooltip
            cursor={{ fill: "var(--surface-hover)" }}
            content={<SliceTooltip currency={currency} unit="Revenue" />}
            {...TOOLTIP_CONTAINMENT}
          />
          <Bar
            dataKey="amountMinor"
            name="Revenue"
            fill={REVENUE_COLOR}
            radius={[0, 3, 3, 0]}
            isAnimationActive={false}
            barSize={18}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4 — EXPENSE BREAKDOWN
// ---------------------------------------------------------------------------

/**
 * Where the money went, as a donut with the total in the middle.
 *
 * A donut rather than a pie so the hole can hold the figure every other reading
 * is a share of. The exact amounts sit in the legend beneath rather than as
 * slice labels, which collide with each other on any slice under a few percent.
 */
export function ExpenseBreakdownDonut({
  slices,
  currency,
  totalMinor,
  maxSlices = 6,
  size = 176,
  className,
}: {
  slices: readonly FinanceBreakdownSlice[];
  currency: string;
  /** The expense total the shares are of — passed in so it is the page's figure, not a re-sum. */
  totalMinor: number;
  maxSlices?: number;
  size?: number;
  className?: string;
}) {
  const data = React.useMemo(
    () => collapseTail(slices, maxSlices, "categories"),
    [slices, maxSlices],
  );

  if (data.length === 0) {
    return <ChartEmpty height={size}>No expenses recorded in this period</ChartEmpty>;
  }

  return (
    <div className={cn("flex flex-col items-center gap-4", className)}>
      <div className="relative" style={{ width: size, height: size }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="amountMinor"
              nameKey="label"
              innerRadius="64%"
              outerRadius="100%"
              startAngle={90}
              endAngle={-270}
              paddingAngle={1.5}
              stroke="none"
              isAnimationActive={false}
            >
              {data.map((slice, index) => (
                <Cell key={slice.id ?? slice.label} fill={categoryColor(index)} />
              ))}
            </Pie>
            <Tooltip
              content={<SliceTooltip currency={currency} unit="Spent" />}
              {...TOOLTIP_CONTAINMENT}
            />
          </PieChart>
        </ResponsiveContainer>

        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="tnum max-w-[104px] truncate text-[19px] font-semibold leading-none tracking-tight text-foreground">
            {formatMoneyCompact(totalMinor, currency)}
          </span>
          <span className="mt-1.5 text-[9px] font-medium uppercase leading-tight tracking-wider text-subtle-foreground">
            Total expenses
          </span>
        </div>
      </div>

      <div className="flex w-full flex-col gap-1.5">
        {data.map((slice, index) => (
          <div
            key={slice.id ?? slice.label}
            className="flex items-center justify-between gap-3 text-[11px]"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-[2px]"
                style={{ background: categoryColor(index) }}
              />
              <span className="truncate text-muted-foreground">{slice.label}</span>
            </span>
            <span className="tnum shrink-0 text-foreground">
              {formatMoney(slice.amountMinor, currency)}
              <span className="ml-1.5 text-subtle-foreground">
                {formatPercent(slice.share * 100, 0)}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Tooltip for either breakdown chart — a slice reads the same in both. */
function SliceTooltip({
  active,
  payload,
  currency,
  unit,
}: {
  active?: boolean;
  payload?: Array<{ payload?: FinanceBreakdownSlice }>;
  currency: string;
  unit: string;
}) {
  const slice = payload?.[0]?.payload;
  if (!active || !slice) return null;

  return (
    <TooltipShell title={slice.label}>
      <TooltipRow label={unit} value={formatMoney(slice.amountMinor, currency)} />
      <TooltipRow label="Share" value={formatPercent(slice.share * 100, 1)} />
      <TooltipRow label="Entries" value={formatNumber(slice.entryCount)} />
    </TooltipShell>
  );
}

// ---------------------------------------------------------------------------
// BREAKDOWN TAIL
// ---------------------------------------------------------------------------

/**
 * Keeps a breakdown legible without dropping money out of it.
 *
 * Past a handful of slices a donut is a colour-matching exercise and a bar
 * chart is a scroll, but simply cutting the list would leave a chart whose
 * parts no longer add up to the total printed beside it. So the tail is summed
 * into one labelled bucket instead — an exact sum of real slices, never an
 * estimate, and it says how many it stands for.
 *
 * The sum is skipped when it would replace a single row with a bucket of one,
 * which is strictly worse than just showing the row.
 */
function collapseTail(
  slices: readonly FinanceBreakdownSlice[],
  keep: number,
  noun: string,
): FinanceBreakdownSlice[] {
  if (slices.length <= keep + 1) return slices.map((slice) => ({ ...slice }));

  const tail = slices.slice(keep);
  return [
    ...slices.slice(0, keep).map((slice) => ({ ...slice })),
    {
      // A sentinel rather than `null`: null is already taken by the
      // company-wide / uncategorised bucket, and React keys must stay distinct.
      id: "__collapsed_tail__",
      label: `${tail.length} smaller ${noun}`,
      amountMinor: tail.reduce((sum, slice) => sum + slice.amountMinor, 0),
      share: tail.reduce((sum, slice) => sum + slice.share, 0),
      entryCount: tail.reduce((sum, slice) => sum + slice.entryCount, 0),
    },
  ];
}
