import { describe, expect, it } from "vitest";
import {
  customRangeFromDates,
  fromDateInputValue,
  rangeDurationDays,
  resolveDateRange,
  toDateInputValue,
} from "../date-range";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

describe("resolveDateRange — trailing presets", () => {
  it("produces exact-duration windows anchored to now", () => {
    for (const [preset, days] of [
      ["7d", 7],
      ["30d", 30],
      ["90d", 90],
      ["180d", 180],
    ] as const) {
      const range = resolveDateRange({ preset }, NOW);
      expect(range.endMs).toBe(NOW);
      expect(range.startMs).toBe(NOW - days * DAY);
      expect(rangeDurationDays(range)).toBe(days);
    }
  });

  it("gives every preset a distinct window, so rates are independent", () => {
    const starts = (["7d", "30d", "90d", "180d"] as const).map(
      (preset) => resolveDateRange({ preset }, NOW).startMs,
    );
    expect(new Set(starts).size).toBe(4);
  });
});

describe("resolveDateRange — custom ranges", () => {
  it("uses the supplied bounds", () => {
    const range = resolveDateRange(
      { preset: "custom", customStartMs: 1000, customEndMs: 5000 },
      NOW,
    );
    expect(range).toEqual({ startMs: 1000, endMs: 5000 });
  });

  it("normalises a reversed range instead of returning an empty window", () => {
    const range = resolveDateRange(
      { preset: "custom", customStartMs: 5000, customEndMs: 1000 },
      NOW,
    );
    expect(range).toEqual({ startMs: 1000, endMs: 5000 });
  });

  it("falls back to a sensible 30-day window when bounds are missing", () => {
    const range = resolveDateRange({ preset: "custom" }, NOW);
    expect(rangeDurationDays(range)).toBe(30);
  });
});

describe("customRangeFromDates", () => {
  it("snaps to local midnight and includes the whole end day", () => {
    const start = new Date(2026, 0, 10, 15, 30);
    const end = new Date(2026, 0, 12, 8, 15);
    const selection = customRangeFromDates(start, end);

    expect(new Date(selection.customStartMs!).getHours()).toBe(0);
    // The end bound is exclusive midnight of the *next* day, so a Short
    // uploaded at 23:59 on the final day is still inside the window.
    expect(selection.customEndMs).toBe(new Date(2026, 0, 13).getTime());
    expect(selection.customEndMs! - selection.customStartMs!).toBe(3 * DAY);
  });
});

describe("date input round-tripping", () => {
  it("formats and re-parses as the same local date", () => {
    const original = new Date(2026, 7, 26);
    const value = toDateInputValue(original.getTime());
    expect(value).toBe("2026-08-26");

    const parsed = fromDateInputValue(value);
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(7);
    expect(parsed?.getDate()).toBe(26);
  });

  it("parses YYYY-MM-DD as local, not UTC", () => {
    // `new Date("2026-08-26")` is midnight UTC, which is the previous calendar
    // day west of Greenwich — exactly the off-by-one that makes date pickers
    // drop a day's uploads.
    const parsed = fromDateInputValue("2026-08-26");
    expect(parsed?.getDate()).toBe(26);
  });

  it("rejects malformed values", () => {
    expect(fromDateInputValue("26/08/2026")).toBeNull();
    expect(fromDateInputValue("")).toBeNull();
    expect(fromDateInputValue("2026-13-45")).not.toBeNull(); // JS rolls over; still a Date
  });
});
