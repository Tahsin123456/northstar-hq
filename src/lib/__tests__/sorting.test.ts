import { describe, expect, it } from "vitest";
import { calculateChannelMetrics } from "@/lib/analytics/channel-metrics";
import type { ChannelMetrics, DateRange, JudgedVideo } from "@/lib/analytics/types";
import type { ChannelDTO } from "@/lib/dto";
import { sortRows, type SortableRow } from "@/lib/sorting";
import {
  DAY_MS,
  daysAgo,
  makeMiss,
  makePending,
  makeShortsWithHits,
  makeUnknown,
  makeUnscoreable,
} from "@/lib/analytics/__tests__/factories";

/**
 * WHERE AN UNMEASURED CHANNEL RANKS.
 *
 * The table opens sorted by hit rate, descending, because that is the question
 * the product exists to answer. A channel whose zero belongs to the evidence
 * rather than to its work has an arithmetic rate of 0 — so left alone it sinks
 * to the very bottom of the default view, ranked below every measured
 * competitor, on the one screen an owner opens to go looking for it. It is
 * unmeasured, not worst, and it belongs with the other unmeasured rows.
 */

const NOW = Date.UTC(2026, 5, 1);
const range: DateRange = { startMs: NOW - 30 * DAY_MS, endMs: NOW };
const BAR = 1_000_000;

function channel(name: string): ChannelDTO {
  // Only the fields the comparator reads. Cast because a full ChannelDTO is
  // forty fields of YouTube metadata none of which sorting looks at.
  return {
    id: name,
    displayName: name,
    ownershipType: "competitor",
    subscriberCount: 0,
    lastFetchedAt: NOW,
  } as unknown as ChannelDTO;
}

function row(name: string, videos: readonly JudgedVideo[]): SortableRow {
  const metrics: ChannelMetrics = calculateChannelMetrics({
    videos: [...videos],
    range,
    threshold: BAR,
  });
  return { channel: channel(name), metrics };
}

const published = daysAgo(15, NOW);

describe("hit-rate sorting parks unmeasured channels, not just empty ones", () => {
  /*
   * Four channels, one of each kind:
   *   strong  — 12 of 40 decided. A real 40-decided measurement.
   *   weak    — 0 of 12 decided, every one a fair miss. A real zero.
   *   blind   — 0 of 6 decided with 5 unrecorded. Evidence-limited.
   *   norule  — a niche with half a rule. Nothing scoreable.
   */
  const strong = row("strong", makeShortsWithHits(40, 12, BAR, published));
  const weak = row(
    "weak",
    Array.from({ length: 12 }, () => makeMiss({ views: 40_000, publishedAt: published })),
  );
  const blind = row("blind", [
    ...Array.from({ length: 6 }, () => makeMiss({ publishedAt: published })),
    ...Array.from({ length: 5 }, () =>
      makeUnknown({ views: 5_000_000, publishedAt: published }),
    ),
  ]);
  const norule = row(
    "norule",
    Array.from({ length: 4 }, () => makeUnscoreable({ publishedAt: published })),
  );

  const all = [weak, blind, norule, strong];

  it("keeps the evidence-limited channel out of the measured ranking, descending", () => {
    /*
     * `thin` is the discriminating fixture: a REAL zero over only two decided
     * Shorts. Left as an arithmetic 0, `blind` ties with it on rate and wins
     * the tie-break — more decided Shorts — so it lands ABOVE a channel that
     * genuinely was measured and genuinely failed. Parked, it drops into the
     * unmeasured group where it belongs, and the measured rows keep the
     * ranking to themselves.
     */
    const thin = row(
      "thin",
      Array.from({ length: 2 }, () => makeMiss({ publishedAt: published })),
    );
    const ordered = sortRows([...all, thin], {
      key: "hitRate",
      direction: "desc",
    }).map((r) => r.channel.displayName);

    // Measured rows first, best to worst; then everything with no number.
    expect(ordered.slice(0, 3)).toEqual(["strong", "weak", "thin"]);
    expect(ordered.slice(3).sort()).toEqual(["blind", "norule"]);
  });

  it("does not float it to the top of an ascending sort either", () => {
    // The failure this guards against in the other direction: a 0 sorting as
    // the smallest number would make an unmeasured channel look like the very
    // worst performer the moment somebody clicks the header twice.
    const ordered = sortRows(all, { key: "hitRate", direction: "asc" }).map(
      (r) => r.channel.displayName,
    );

    expect(ordered.slice(0, 2)).toEqual(["weak", "strong"]);
    expect(ordered.slice(2)).toContain("blind");
  });

  it("still ranks a genuine zero as a genuine zero", () => {
    // `weak` is not parked. It has a measured rate of 0 and sorts as one, below
    // `strong` descending and above it ascending. Softening this would be the
    // same fabrication in the opposite direction.
    expect(weak.metrics.hits.rate).toBe(0);
    expect(weak.metrics.hits.evidenceLimited).toBe(false);

    const ordered = sortRows([strong, weak], {
      key: "hitRate",
      direction: "desc",
    }).map((r) => r.channel.displayName);
    expect(ordered).toEqual(["strong", "weak"]);
  });

  it("groups the evidence-limited row with the other unmeasured ones", () => {
    // The point of parking rather than reordering: "we could not measure this"
    // is one bucket, whatever the reason. A channel waiting on its windows to
    // close belongs there too.
    const waiting = row(
      "waiting",
      Array.from({ length: 3 }, () => makePending({ publishedAt: published })),
    );
    const ordered = sortRows([blind, waiting, strong], {
      key: "hitRate",
      direction: "desc",
    }).map((r) => r.channel.displayName);

    expect(ordered[0]).toBe("strong");
    expect(ordered.slice(1).sort()).toEqual(["blind", "waiting"]);
  });

  it("leaves the upload-views column sorting on the raw figure", () => {
    // Nothing in this change touches what "Upload views" sorts by — it is a
    // real number in every state, including the ones where the hit rate is not.
    const ordered = sortRows(all, { key: "totalViews", direction: "desc" });
    expect(ordered[0].metrics.totalViews).toBeGreaterThanOrEqual(
      ordered[ordered.length - 1].metrics.totalViews,
    );
  });
});
