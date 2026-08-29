import { describe, expect, it } from "vitest";
import { calculateChannelMetrics } from "@/lib/analytics/channel-metrics";
import {
  DAY_MS,
  daysAgo,
  makeHit,
  makeMiss,
  makeShort,
  makeUnscoreable,
} from "@/lib/analytics/__tests__/factories";

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
 * The resolution above decides there is no rule; this is what the metrics do
 * about it. Both halves matter: a niche nobody has configured that reached
 * `calculateChannelMetrics` and came back as 0% would be the same bug wearing a
 * different hat.
 *
 * WHAT CHANGED HERE. These used to pass `threshold: null` and assert that the
 * rate came back null — which conflated two things that have since come apart.
 * "This niche has no rule" is now a property of the SHORTS' STORED VERDICTS
 * (unscoreable, with null rule columns), and the `threshold` argument is a
 * display bar that suppresses nothing. So the fixtures say it where it is now
 * true, and a separate test pins that the bar cannot suppress a rate that
 * exists.
 */
describe("metrics for Shorts no niche rule reaches", () => {
  const videos = [900_000, 1_400_000, 300_000].map((views, i) =>
    makeUnscoreable({ views, publishedAt: daysAgo(i + 1, NOW) }),
  );

  it("reports no hit rate at all rather than 0%", () => {
    const metrics = calculateChannelMetrics({
      videos,
      range: range(30),
      threshold: null,
    });

    // 0% would assert "three Shorts were judged and none of them hit", which is
    // a claim about performance. Nothing was judged.
    expect(metrics.hits.rate).toBeNull();
    expect(metrics.hits.rate).not.toBe(0);
    expect(metrics.hits.hits).toBe(0);
    expect(metrics.hits.tally.unscoreable).toBe(3);
    // And never as misses, which would drag a real rate down elsewhere.
    expect(metrics.hits.tally.misses).toBe(0);
    expect(metrics.threshold).toBeNull();
  });

  it("still reports everything that never depended on a rule", () => {
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

  it("gives no Short a lifetime ratio when there is no bar to be a ratio of", () => {
    const metrics = calculateChannelMetrics({
      videos,
      range: range(30),
      threshold: null,
    });

    // A ratio of 0 would sort every Short as an equal, maximal miss; `null`
    // says there is nothing to be a ratio of.
    expect(metrics.bestShort?.clearsThreshold).toBe(false);
    expect(metrics.bestShort?.lifetimeRatio).toBeNull();
    expect(metrics.bestShort?.windowRatio).toBeNull();
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

/**
 * =========================================================================
 * THE TEST THIS FILE USED TO CONTAIN ENCODED THE BUG
 * =========================================================================
 * It was called "per-niche thresholds change the reported hit rate", and it
 * asserted that handing `calculateChannelMetrics` the same five Shorts with a
 * different `threshold` produced 20%, 60% and 100%. That is a precise
 * description of the old rule — a hit rate that is a pure function of a view
 * count and a number typed into a control — and it is exactly what had to stop.
 * A hit is a bar reached inside a WINDOW; the verdict comes from the snapshot
 * series and is decided once, server-side, per Short.
 *
 * So the invariant inverts. Changing the display bar must change what is
 * highlighted and NOTHING about the rate. Changing a niche's actual rule still
 * changes the rate — via re-evaluation, which produces different stored
 * verdicts, which is what the second test here stands in for.
 */
describe("the display bar cannot move a hit rate", () => {
  // One channel, five Shorts, spread across the interesting range. Two of them
  // reached their niche's bar inside its window; three did not.
  const videos = [
    makeHit({ views: 900_000, publishedAt: daysAgo(1, NOW) }),
    makeMiss({ views: 800_000, publishedAt: daysAgo(2, NOW) }),
    makeMiss({ views: 600_000, publishedAt: daysAgo(3, NOW) }),
    makeMiss({ views: 300_000, publishedAt: daysAgo(4, NOW) }),
    makeHit({ views: 1_200_000, publishedAt: daysAgo(5, NOW) }),
  ];

  it("reports the same hit rate at every bar, including none at all", () => {
    const rates = [1_000_000, 750_000, 250_000, null].map(
      (threshold) =>
        calculateChannelMetrics({ videos, range: range(30), threshold }).hits.rate,
    );

    // 2 hits of 5 decided, whatever the control says.
    expect(rates).toEqual([40, 40, 40, 40]);
  });

  it("a Short over the bar today can still be a stored miss", () => {
    // The 900K Short is a HIT and the 800K one is a MISS, which no comparison
    // of views to a bar can produce. That inversion is the point: one got there
    // in time and the other did not.
    const metrics = calculateChannelMetrics({
      videos,
      range: range(30),
      threshold: 750_000,
    });

    expect(metrics.hits.hits).toBe(2);
    // Three Shorts clear a 750K bar on lifetime views; only two are hits.
    expect(
      [900_000, 800_000, 1_200_000].filter((v) => v >= 750_000),
    ).toHaveLength(3);
  });

  it("leaves bar-independent metrics untouched", () => {
    const a = calculateChannelMetrics({ videos, range: range(30), threshold: 1_000_000 });
    const b = calculateChannelMetrics({ videos, range: range(30), threshold: 250_000 });

    // Views, median and volume describe the output, not the bar it is displayed
    // against, so they must be identical.
    expect(a.totalViews).toBe(b.totalViews);
    expect(a.medianViews).toBe(b.medianViews);
    expect(a.averageViews).toBe(b.averageViews);
    expect(a.bestShort?.views).toBe(b.bestShort?.views);
  });

  it("keeps the bar comparison itself inclusive, for the display annotation", () => {
    // `clearsThreshold` is still exactly-inclusive — 750,000 clears a 750K bar
    // and 749,999 does not — and it still shades the table. It is no longer a
    // verdict, which is why this assertion moved off `hitCount`.
    const exact = calculateChannelMetrics({
      videos: [makeShort({ views: 750_000, publishedAt: daysAgo(1, NOW) })],
      range: range(30),
      threshold: 750_000,
    });
    const justUnder = calculateChannelMetrics({
      videos: [makeShort({ views: 749_999, publishedAt: daysAgo(1, NOW) })],
      range: range(30),
      threshold: 750_000,
    });

    expect(exact.bestShort?.clearsThreshold).toBe(true);
    expect(justUnder.bestShort?.clearsThreshold).toBe(false);
    // And neither is a hit: nothing here has a verdict.
    expect(exact.hits.hits).toBe(0);
    expect(justUnder.hits.hits).toBe(0);
  });
});
