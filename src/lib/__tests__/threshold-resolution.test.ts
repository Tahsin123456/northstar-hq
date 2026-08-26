import { describe, expect, it } from "vitest";
import { calculateChannelMetrics } from "@/lib/analytics/channel-metrics";
import { DAY_MS, daysAgo, makeShort } from "@/lib/analytics/__tests__/factories";

/**
 * Niche-specific hit thresholds.
 *
 * The resolution order lives in the filters provider, but it is a pure rule and
 * worth pinning down independently of React: a wrong precedence here silently
 * changes the headline number on every screen at once.
 */

const NOW = Date.UTC(2026, 5, 1);
const range = (days: number) => ({ startMs: NOW - days * DAY_MS, endMs: NOW });

/**
 * The exact rule the provider implements:
 *   explicit override -> niche default -> account default.
 */
function resolveThreshold(
  override: number | null,
  nicheDefault: number | null,
  accountDefault: number,
): number {
  return override ?? nicheDefault ?? accountDefault;
}

describe("threshold resolution order", () => {
  it("uses the account default when nothing else is configured", () => {
    expect(resolveThreshold(null, null, 1_000_000)).toBe(1_000_000);
  });

  it("prefers the niche default over the account default", () => {
    // RDR configured at 750K must win over a 1M account setting.
    expect(resolveThreshold(null, 750_000, 1_000_000)).toBe(750_000);
  });

  it("prefers an explicit override over the niche default", () => {
    expect(resolveThreshold(1_000_000, 750_000, 1_000_000)).toBe(1_000_000);
  });

  it("treats a null niche threshold as inherit, not as zero", () => {
    // A niche that has never been configured must follow the account default,
    // not silently make every Short a hit.
    expect(resolveThreshold(null, null, 250_000)).toBe(250_000);
    expect(resolveThreshold(null, null, 250_000)).not.toBe(0);
  });

  it("lets a niche configure a threshold above the account default", () => {
    expect(resolveThreshold(null, 5_000_000, 1_000_000)).toBe(5_000_000);
  });
});

/**
 * The rule `useChannelThreshold` implements for a channel viewed on its own
 * page, where there is frequently no niche selected at all.
 */
function resolveChannelThreshold(
  channelNiches: readonly { hitThreshold: number | null }[],
  selectedNicheThreshold: number | null,
  accountDefault: number,
): number {
  if (selectedNicheThreshold !== null) return selectedNicheThreshold;

  const configured = channelNiches.filter((n) => n.hitThreshold !== null);
  const distinct = new Set(configured.map((n) => n.hitThreshold));
  if (configured.length > 0 && distinct.size === 1) {
    return configured[0].hitThreshold as number;
  }
  return accountDefault;
}

describe("channel-scoped threshold", () => {
  it("uses the channel's own niche when no niche is selected", () => {
    // Opening an RDR channel directly must not judge it at the 1M account
    // default while the RDR niche defines a hit as 750K.
    expect(resolveChannelThreshold([{ hitThreshold: 750_000 }], null, 1_000_000)).toBe(750_000);
  });

  it("prefers the selected niche over the channel's own", () => {
    expect(resolveChannelThreshold([{ hitThreshold: 750_000 }], 500_000, 1_000_000)).toBe(
      500_000,
    );
  });

  it("falls back to the account default when the channel's niches disagree", () => {
    // No principled way to choose between them, so it does not pretend.
    expect(
      resolveChannelThreshold(
        [{ hitThreshold: 750_000 }, { hitThreshold: 500_000 }],
        null,
        1_000_000,
      ),
    ).toBe(1_000_000);
  });

  it("uses the shared value when several niches agree", () => {
    expect(
      resolveChannelThreshold(
        [{ hitThreshold: 750_000 }, { hitThreshold: 750_000 }],
        null,
        1_000_000,
      ),
    ).toBe(750_000);
  });

  it("falls back to the account default for an unconfigured channel", () => {
    expect(resolveChannelThreshold([{ hitThreshold: null }], null, 1_000_000)).toBe(1_000_000);
    expect(resolveChannelThreshold([], null, 1_000_000)).toBe(1_000_000);
  });
});

describe("per-niche thresholds change the reported hit rate", () => {
  // One channel, five Shorts, spread across the interesting range.
  const videos = [900_000, 800_000, 600_000, 300_000, 1_200_000].map((views, i) =>
    makeShort({ views, publishedAt: daysAgo(i + 1, NOW) }),
  );

  it("reports a different hit rate for the same Shorts at different thresholds", () => {
    const atOneMillion = calculateChannelMetrics({
      videos,
      range: range(30),
      threshold: 1_000_000,
    });
    const atSevenFifty = calculateChannelMetrics({
      videos,
      range: range(30),
      threshold: 750_000,
    });
    const atTwoFifty = calculateChannelMetrics({
      videos,
      range: range(30),
      threshold: 250_000,
    });

    // Only the 1.2M Short clears 1M.
    expect(atOneMillion.hitCount).toBe(1);
    expect(atOneMillion.hitRate).toBe(20);

    // 1.2M, 900K and 800K clear 750K.
    expect(atSevenFifty.hitCount).toBe(3);
    expect(atSevenFifty.hitRate).toBe(60);

    // Everything clears 250K.
    expect(atTwoFifty.hitCount).toBe(5);
    expect(atTwoFifty.hitRate).toBe(100);

    // The denominator never moves — only the definition of a hit does.
    expect(atOneMillion.totalShorts).toBe(atSevenFifty.totalShorts);
    expect(atSevenFifty.totalShorts).toBe(atTwoFifty.totalShorts);
  });

  it("leaves threshold-independent metrics untouched", () => {
    const a = calculateChannelMetrics({ videos, range: range(30), threshold: 1_000_000 });
    const b = calculateChannelMetrics({ videos, range: range(30), threshold: 250_000 });

    // Views, median and volume describe the output, not the bar it is judged
    // against, so they must be identical.
    expect(a.totalViews).toBe(b.totalViews);
    expect(a.medianViews).toBe(b.medianViews);
    expect(a.averageViews).toBe(b.averageViews);
    expect(a.bestShort?.views).toBe(b.bestShort?.views);
  });

  it("keeps the boundary inclusive at any threshold", () => {
    const exact = [makeShort({ views: 750_000, publishedAt: daysAgo(1, NOW) })];
    const justUnder = [makeShort({ views: 749_999, publishedAt: daysAgo(1, NOW) })];

    expect(
      calculateChannelMetrics({ videos: exact, range: range(30), threshold: 750_000 }).hitCount,
    ).toBe(1);
    expect(
      calculateChannelMetrics({ videos: justUnder, range: range(30), threshold: 750_000 })
        .hitCount,
    ).toBe(0);
  });
});
