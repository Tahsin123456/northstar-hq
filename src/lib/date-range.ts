import { PERIOD_PRESET_BY_ID } from "@/lib/analytics/constants";
import type { DateRange, PeriodSelection } from "@/lib/analytics/types";

const MS_PER_DAY = 86_400_000;

/**
 * Turns a period selection into a concrete `[start, end)` window.
 *
 * Trailing presets are exact-duration windows anchored to *now*, not to
 * midnight: "last 7 days" means the last 168 hours. Anchoring to calendar days
 * would make a Short published this morning fall in or out of the window
 * depending on the hour, which reads as flicker in a live dashboard.
 *
 * Custom ranges are the opposite — the user picked calendar dates, so those
 * snap to local midnight and the end date is inclusive of its whole day.
 *
 * `now` is injectable so tests are deterministic.
 */
export function resolveDateRange(
  selection: PeriodSelection,
  now: number = Date.now(),
): DateRange {
  if (selection.preset === "custom") {
    const startMs = selection.customStartMs ?? now - 30 * MS_PER_DAY;
    const endMs = selection.customEndMs ?? now;
    // Tolerate a reversed range rather than returning something empty.
    return startMs <= endMs ? { startMs, endMs } : { startMs: endMs, endMs: startMs };
  }

  const preset = PERIOD_PRESET_BY_ID[selection.preset];
  const days = preset?.days ?? 30;
  return { startMs: now - days * MS_PER_DAY, endMs: now };
}

/** Local midnight at the start of the given date. */
export function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Local midnight at the *end* of the given date (exclusive upper bound). */
export function endOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

/** Builds a custom selection from two calendar dates, snapped to whole days. */
export function customRangeFromDates(start: Date, end: Date): PeriodSelection {
  return {
    preset: "custom",
    customStartMs: startOfLocalDay(start),
    customEndMs: endOfLocalDay(end),
  };
}

export function rangeDurationDays(range: DateRange): number {
  return Math.max(0, Math.round((range.endMs - range.startMs) / MS_PER_DAY));
}

/** `YYYY-MM-DD` in local time — the value shape `<input type="date">` wants. */
export function toDateInputValue(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parses `YYYY-MM-DD` as a *local* date. `new Date(str)` would read it as UTC. */
export function fromDateInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(date.getTime()) ? null : date;
}
