import { describe, expect, it } from "vitest";
import {
  EM_DASH,
  formatCompactNumber,
  formatDelta,
  formatDuration,
  formatFraction,
  formatNumber,
  formatPercent,
  formatRelativeTime,
  formatThreshold,
  formatThresholdRatio,
} from "../format";

describe("formatCompactNumber", () => {
  it("scales through K, M and B", () => {
    expect(formatCompactNumber(999)).toBe("999");
    expect(formatCompactNumber(1200)).toBe("1.2K");
    expect(formatCompactNumber(1_000_000)).toBe("1M");
    expect(formatCompactNumber(2_400_000)).toBe("2.4M");
    expect(formatCompactNumber(1_270_000_000)).toBe("1.27B");
  });

  it("renders an em dash for absent values, never 0", () => {
    expect(formatCompactNumber(null)).toBe(EM_DASH);
    expect(formatCompactNumber(undefined)).toBe(EM_DASH);
    expect(formatCompactNumber(Number.NaN)).toBe(EM_DASH);
    // A real zero is still a zero.
    expect(formatCompactNumber(0)).toBe("0");
  });
});

describe("formatPercent", () => {
  it("renders a hit rate", () => {
    expect(formatPercent(31.58)).toBe("31.6%");
    expect(formatPercent(30)).toBe("30.0%");
    expect(formatPercent(0)).toBe("0.0%");
  });

  it("renders null as an em dash — the 'no Shorts' case", () => {
    // The whole point: an idle channel must not read as 0%.
    expect(formatPercent(null)).toBe(EM_DASH);
    expect(formatPercent(null)).not.toBe("0.0%");
  });
});

describe("formatDelta", () => {
  it("signs percentage-point movements", () => {
    expect(formatDelta(6.2)).toBe("+6.2 pts");
    expect(formatDelta(-3)).toBe("−3.0 pts");
    expect(formatDelta(0)).toBe("0.0 pts");
    expect(formatDelta(null)).toBe(EM_DASH);
  });
});

describe("formatThreshold and formatFraction", () => {
  it("renders the active threshold chip", () => {
    expect(formatThreshold(1_000_000)).toBe("≥ 1M");
    expect(formatThreshold(250_000)).toBe("≥ 250K");
  });

  it("renders the fraction behind a hit rate", () => {
    expect(formatFraction(12, 38)).toBe("12 / 38");
  });
});

describe("formatThresholdRatio", () => {
  it("expresses views as a multiple of the threshold", () => {
    expect(formatThresholdRatio(2.4)).toBe("2.4×");
    expect(formatThresholdRatio(0.87)).toBe("0.87×");
    expect(formatThresholdRatio(41)).toBe("41×");
    expect(formatThresholdRatio(null)).toBe(EM_DASH);
  });
});

describe("formatNumber", () => {
  it("groups digits and dashes absent values", () => {
    expect(formatNumber(1234567)).toBe(new Intl.NumberFormat().format(1234567));
    expect(formatNumber(null)).toBe(EM_DASH);
  });
});

describe("formatDuration", () => {
  it("formats Shorts-length durations", () => {
    expect(formatDuration(42)).toBe("0:42");
    expect(formatDuration(95)).toBe("1:35");
    expect(formatDuration(null)).toBe(EM_DASH);
    expect(formatDuration(0)).toBe(EM_DASH);
  });
});

describe("formatRelativeTime", () => {
  const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

  it("describes recent timestamps", () => {
    expect(formatRelativeTime(NOW - 5_000, NOW)).toBe("just now");
    expect(formatRelativeTime(NOW - 12 * 60_000, NOW)).toContain("12 minutes");
    expect(formatRelativeTime(NOW - 3 * 86_400_000, NOW)).toContain("3 days");
  });

  it("reports never for an unfetched channel", () => {
    expect(formatRelativeTime(null, NOW)).toBe("never");
    expect(formatRelativeTime(undefined, NOW)).toBe("never");
  });

  it("does not produce a negative duration for clock skew", () => {
    expect(formatRelativeTime(NOW + 60_000, NOW)).toBe("just now");
  });
});
