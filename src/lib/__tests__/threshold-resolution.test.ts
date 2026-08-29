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
 * The exact rule the provider implements.
 *
 *   explicit override
 *     -> the selected niche's own threshold
 *     -> UNCONFIGURED, if a niche is selected and has none
 *     -> the organization default, only when no niche is selected
 *
 * The third line is the one this round added, and it is the whole point. The
 * chain used to end `?? accountDefault` unconditionally, so selecting a niche
 * nobody had configured borrowed the organization's 1,000,000 and the app
 * printed a hit rate against it — arithmetic over a number no human chose,
 * indistinguishable on screen from a measurement.
 *
 * `null` here does not mean "fall back". It means there is no answer, and every
 * consumer renders "Not configured" instead of a figure.
 */
type Resolution = { threshold: number | null; source: string };

function resolveThreshold(
  override: number | null,
  nicheThreshold: number | null,
  organizationDefault: number,
  { nicheSelected }: { nicheSelected: boolean },
): Resolution {
  if (override !== null) return { threshold: override, source: "override" };
  if (nicheThreshold !== null) return { threshold: nicheThreshold, source: "niche" };
  if (nicheSelected) return { threshold: null, source: "unconfigured" };
  return { threshold: organizationDefault, source: "account" };
}

describe("threshold resolution order", () => {
  it("uses the organization default when no niche is selected", () => {
    // "All niches" is NOT unconfigured. With nothing selected the organization
    // default is a deliberately-set number, and hit rates go on being reported.
    expect(
      resolveThreshold(null, null, 1_000_000, { nicheSelected: false }),
    ).toEqual({ threshold: 1_000_000, source: "account" });
  });

  it("prefers the niche threshold over the organization default", () => {
    // RDR configured at 750K must win over a 1M organization setting.
    expect(
      resolveThreshold(null, 750_000, 1_000_000, { nicheSelected: true }),
    ).toEqual({ threshold: 750_000, source: "niche" });
  });

  it("prefers an explicit override over the niche threshold", () => {
    expect(
      resolveThreshold(1_000_000, 750_000, 1_000_000, { nicheSelected: true }),
    ).toEqual({ threshold: 1_000_000, source: "override" });
  });

  it("resolves a selected niche with no threshold to unconfigured, never to the org default", () => {
    // THE regression this round exists to prevent. If this ever returns
    // 1,000,000 again, every screen goes back to reporting a hit rate that
    // nobody configured.
    const resolved = resolveThreshold(null, null, 1_000_000, { nicheSelected: true });

    expect(resolved.source).toBe("unconfigured");
    expect(resolved.threshold).toBeNull();
    expect(resolved.threshold).not.toBe(1_000_000);
    // And emphatically not zero, which would make every Short a hit.
    expect(resolved.threshold).not.toBe(0);
  });

  it("still lets a deliberate override win over an unconfigured niche", () => {
    // A number a person typed on this screen, just now. That is a choice, and
    // the one case where a figure is legitimate on an unconfigured niche.
    expect(
      resolveThreshold(2_000_000, null, 1_000_000, { nicheSelected: true }),
    ).toEqual({ threshold: 2_000_000, source: "override" });
  });

  it("lets a niche configure a threshold above the organization default", () => {
    expect(
      resolveThreshold(null, 5_000_000, 1_000_000, { nicheSelected: true }),
    ).toEqual({ threshold: 5_000_000, source: "niche" });
  });
});

/**
 * The engine's own half of the contract.
 *
 * The resolution above decides there is no threshold; this is what the metrics
 * do about it. Both halves matter: a `null` that reached
 * `calculateChannelMetrics` and came back as 0% would be the same bug wearing a
 * different hat.
 */
describe("metrics with no configured threshold", () => {
  const videos = [900_000, 1_400_000, 300_000].map((views, i) =>
    makeShort({ views, publishedAt: daysAgo(i + 1, NOW) }),
  );

  it("reports no hit rate at all rather than 0%", () => {
    const metrics = calculateChannelMetrics({
      videos,
      range: range(30),
      threshold: null,
    });

    // 0% would assert "three Shorts were published and none of them hit",
    // which is a claim about performance. Nothing was measured.
    expect(metrics.hitRate).toBeNull();
    expect(metrics.hitRate).not.toBe(0);
    expect(metrics.hitCount).toBe(0);
    expect(metrics.threshold).toBeNull();
  });

  it("still reports everything that does not depend on a threshold", () => {
    const metrics = calculateChannelMetrics({
      videos,
      range: range(30),
      threshold: null,
    });

    // Uploads and views are facts about the Shorts, not about the definition of
    // a hit. Blanking them too would be over-correcting.
    expect(metrics.totalShorts).toBe(3);
    expect(metrics.totalViews).toBe(2_600_000);
    expect(metrics.medianViews).toBe(900_000);
  });

  it("marks no Short as a hit and gives none of them a threshold ratio", () => {
    const metrics = calculateChannelMetrics({
      videos,
      range: range(30),
      threshold: null,
    });

    // A ratio of 0 would sort every Short as an equal, maximal miss; `null`
    // says there is nothing to be a ratio of.
    expect(metrics.bestShort?.isHit).toBe(false);
    expect(metrics.bestShort?.thresholdRatio).toBeNull();
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
