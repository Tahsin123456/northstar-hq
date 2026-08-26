import { formatAxisNumber } from "@/lib/format";

/**
 * =========================================================================
 * CHART LAYOUT
 * =========================================================================
 *
 * Shared axis sizing for every chart in the app.
 *
 * WHY CLIPPING KEPT HAPPENING
 * Recharts draws axis ticks *inside* the chart SVG and never measures the text
 * it is about to render. `YAxis width` and the chart `margin` are pure
 * reservations: if the formatted tick is wider than the space reserved, the SVG
 * simply clips it. A hardcoded `width={44}` is therefore correct for "100%" and
 * silently wrong for "1.27B".
 *
 * The fix is to derive the reservation from the actual strings that will be
 * drawn, for the actual data on screen — which is what these helpers do. That
 * is also why the answer is not "shrink the chart": the plot area stays as
 * large as it can be, and only the space genuinely needed by the labels is
 * taken.
 */

/**
 * The tick font size every reservation below is computed against.
 *
 * This has to be *applied*, not merely assumed. Recharts ticks inherit the
 * page font when nothing sets them, which here meant 16px while the helpers
 * reserved space for 11px — every axis was then short by roughly 45%, which is
 * precisely how labels kept getting sliced by the SVG edge even after the
 * widths were being derived from the text. Pass `AXIS_TICK` to every axis so
 * the drawn size and the reserved size cannot drift apart again.
 */
export const AXIS_TICK_FONT_SIZE = 11;

/** Spread onto every `XAxis`/`YAxis` `tick` prop. */
export const AXIS_TICK = {
  fontSize: AXIS_TICK_FONT_SIZE,
  fill: "var(--muted-foreground)",
} as const;

/**
 * Ratio of rendered advance width to font size, per character.
 *
 * Calibrated by measuring real ticks in the running app rather than assumed:
 * at 11px Geist, "100%" renders ~28px (0.636/char) and "250K–500K" ~64px
 * (0.647/char) — the en-dash and the digits are both wider than a naive 0.6
 * suggests, which left labels clipped by a few pixels even once the font size
 * was pinned. 0.68 sits above every measured value, and erring high only costs
 * a couple of invisible pixels of gutter.
 */
const CHAR_WIDTH_RATIO = 0.68;

/**
 * Approximate rendered width of a label, in pixels.
 *
 * Deliberately an overestimate — a few wasted pixels are invisible, a clipped
 * label is not.
 */
export function approximateTextWidth(text: string, fontSize: number = AXIS_TICK_FONT_SIZE): number {
  return text.length * fontSize * CHAR_WIDTH_RATIO;
}

/** Widest label in a set, in pixels. */
export function widestLabelWidth(
  labels: readonly string[],
  fontSize: number = AXIS_TICK_FONT_SIZE,
): number {
  let max = 0;
  for (const label of labels) {
    const width = approximateTextWidth(label, fontSize);
    if (width > max) max = width;
  }
  return max;
}

/** Gap between the tick text and the plot area. */
export const AXIS_TICK_MARGIN = 8;

/**
 * Width to reserve for a numeric Y axis, from the values it will actually show.
 *
 * Bounded below so a tiny chart still has a readable gutter, and above so one
 * enormous outlier cannot eat half the plot.
 */
export function numericAxisWidth(
  values: readonly (number | null | undefined)[],
  suffix = "",
): number {
  const labels = values
    .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v))
    .map((v) => `${formatAxisNumber(v)}${suffix}`);

  if (labels.length === 0) return 40;
  return clamp(Math.ceil(widestLabelWidth(labels)) + AXIS_TICK_MARGIN + 4, 40, 78);
}

/**
 * Width for a percentage Y axis.
 *
 * Percentages top out at "100%", so this is stable — but it is still computed
 * rather than hardcoded so a future change to the tick format cannot silently
 * reintroduce clipping.
 */
export function percentAxisWidth(maxValue = 100): number {
  const label = `${Math.ceil(maxValue)}%`;
  return clamp(Math.ceil(approximateTextWidth(label)) + AXIS_TICK_MARGIN + 4, 40, 64);
}

/** Width for a categorical Y axis (bucket names, channel names). */
export function categoryAxisWidth(labels: readonly string[]): number {
  if (labels.length === 0) return 60;
  return clamp(Math.ceil(widestLabelWidth(labels)) + AXIS_TICK_MARGIN + 4, 56, 150);
}

/**
 * Height to reserve for the X axis.
 *
 * Horizontal labels need one line plus the tick gap. Rotated labels need the
 * vertical projection of the text, which is what was previously being
 * guessed — and getting wrong for long bucket names.
 */
export function xAxisHeight(
  labels: readonly string[],
  options: { rotated?: boolean } = {},
): number {
  if (!options.rotated) return Math.ceil(AXIS_TICK_FONT_SIZE * 1.35) + AXIS_TICK_MARGIN + 4;
  const widest = widestLabelWidth(labels);
  // sin(35°) ≈ 0.574 for the vertical component of the rotated text.
  return clamp(Math.ceil(widest * 0.574) + AXIS_TICK_MARGIN + 8, 34, 88);
}

/**
 * Right margin so the final X tick is not sliced by the SVG edge.
 *
 * Recharts centres tick text on its data point, so the last label overhangs the
 * plot by half its width.
 */
export function trailingLabelMargin(labels: readonly string[]): number {
  if (labels.length === 0) return 12;
  const last = labels[labels.length - 1] ?? "";
  return clamp(Math.ceil(approximateTextWidth(last) / 2) + 8, 12, 48);
}

/**
 * Minimum horizontal gap between X ticks.
 *
 * Recharts drops colliding ticks rather than overlapping them. Feeding it the
 * real label width means it thins by exactly as much as the text requires —
 * so labels stay readable at any width without arbitrarily hiding values.
 */
export function xAxisMinTickGap(labels: readonly string[]): number {
  return clamp(Math.ceil(widestLabelWidth(labels)) + 12, 20, 90);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Concise date label for a time axis: "Aug 1", "Aug 8".
 *
 * Long-form dates are what force ticks to be dropped in the first place.
 */
export function formatDateTick(ms: number, granularity: "day" | "week" | "month"): string {
  const date = new Date(ms);
  if (granularity === "month") {
    return date.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Tooltip props shared by every chart, so none can escape its container. */
export const TOOLTIP_CONTAINMENT = {
  allowEscapeViewBox: { x: false, y: false },
  wrapperStyle: { outline: "none", zIndex: 30 },
} as const;
