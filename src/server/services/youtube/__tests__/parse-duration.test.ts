import { describe, expect, it } from "vitest";
import { formatDurationSeconds, parseIsoDuration } from "../parse-duration";

describe("parseIsoDuration", () => {
  it("parses the forms YouTube actually emits", () => {
    expect(parseIsoDuration("PT59S")).toBe(59);
    expect(parseIsoDuration("PT1M")).toBe(60);
    expect(parseIsoDuration("PT1M2S")).toBe(62);
    expect(parseIsoDuration("PT3M")).toBe(180);
    expect(parseIsoDuration("PT1H2M10S")).toBe(3730);
    expect(parseIsoDuration("PT10H")).toBe(36000);
  });

  it("returns null rather than 0 for a missing or unparseable duration", () => {
    // Critical: a 0 would sail straight through the Shorts duration gate,
    // whereas null correctly leaves the classifier without a signal.
    expect(parseIsoDuration(null)).toBeNull();
    expect(parseIsoDuration(undefined)).toBeNull();
    expect(parseIsoDuration("")).toBeNull();
    expect(parseIsoDuration("not-a-duration")).toBeNull();
    expect(parseIsoDuration("5 minutes")).toBeNull();
  });

  it("returns null for P0D — the live-stream placeholder", () => {
    expect(parseIsoDuration("P0D")).toBeNull();
    expect(parseIsoDuration("PT0S")).toBeNull();
  });

  it("handles day and week designators", () => {
    expect(parseIsoDuration("P1D")).toBe(86400);
    expect(parseIsoDuration("P1DT1H")).toBe(90000);
    expect(parseIsoDuration("P1W")).toBe(604800);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseIsoDuration("  PT45S  ")).toBe(45);
  });

  it("rounds fractional seconds", () => {
    expect(parseIsoDuration("PT1.5S")).toBe(2);
  });
});

describe("formatDurationSeconds", () => {
  it("formats minutes and seconds", () => {
    expect(formatDurationSeconds(65)).toBe("1:05");
    expect(formatDurationSeconds(42)).toBe("0:42");
    expect(formatDurationSeconds(180)).toBe("3:00");
  });

  it("formats hours when present", () => {
    expect(formatDurationSeconds(3730)).toBe("1:02:10");
  });

  it("renders an em dash for invalid input", () => {
    expect(formatDurationSeconds(Number.NaN)).toBe("—");
    expect(formatDurationSeconds(-5)).toBe("—");
  });
});
