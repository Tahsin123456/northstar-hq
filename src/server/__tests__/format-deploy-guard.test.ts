import { describe, expect, it } from "vitest";
import type { Niche } from "@prisma/client";
import { calculateChannelMetrics } from "@/lib/analytics/channel-metrics";
import {
  DAY_MS,
  daysAgo,
  makeHit,
  makeLongform,
  makeMiss,
  makePending,
  makeShort,
  makeUncertain,
} from "@/lib/analytics/__tests__/factories";
import { toNicheDTO } from "@/server/mappers";

/**
 * =========================================================================
 * THE BIT-FOR-BIT GUARD FOR THE FORMAT DEPLOY
 * =========================================================================
 *
 * The format deploy's one absolute requirement: the Shorts product is
 * unchanged for every user. This file states what that means as data, on the
 * two surfaces the deploy actually touched:
 *
 *   • channel metrics — the filter chain gained a format concept, and every
 *     number a dashboard consumes today is pinned here to the value the
 *     PRE-FORMAT code produced on the same fixture. The values below were
 *     computed from the old rules (Shorts = `isShort`, excluded = everything
 *     in range that is not a Short) and must never be regenerated from the
 *     implementation — that would turn the guard into a mirror.
 *
 *   • the niche DTO — it gained exactly one field, `format`, and everything
 *     the client consumed before the deploy is pinned byte-for-byte. The
 *     destructuring trick makes "one new field and nothing else" a hard
 *     assertion rather than a hope: strip `format`, and what remains must
 *     equal the pre-deploy payload exactly.
 */

const NOW = Date.UTC(2026, 5, 1);
const RANGE_30D = { startMs: NOW - 30 * DAY_MS, endMs: NOW };

describe("channel metrics are unchanged by the format plumbing", () => {
  it("reproduces the pre-format numbers on a fixture containing every population", () => {
    const videos = [
      // The Shorts the metrics are about.
      makeHit({ views: 2_000_000, publishedAt: daysAgo(5, NOW) }),
      makeMiss({ views: 300_000, publishedAt: daysAgo(6, NOW) }),
      makePending({ views: 50_000, publishedAt: daysAgo(1, NOW) }),
      // Long-form in range: excluded, counted in the exclusion caption.
      makeLongform({ views: 10_000_000, publishedAt: daysAgo(4, NOW) }),
      // Uncertain in range: excluded from Shorts AND counted in the same
      // caption — the pre-format behaviour the strict selector must not leak
      // into.
      makeUncertain({ views: 4_000_000, publishedAt: daysAgo(3, NOW) }),
      // A Short outside the window: invisible to everything.
      makeShort({ views: 999, publishedAt: daysAgo(45, NOW) }),
    ];

    const metrics = calculateChannelMetrics({
      videos,
      range: RANGE_30D,
      threshold: 1_000_000,
    });

    // Every value below is the PRE-DEPLOY answer, worked by hand from the old
    // rules. If any assertion here moves, a rendered number moved.
    expect(metrics.totalShorts).toBe(3);
    expect(metrics.totalViews).toBe(2_350_000);
    expect(metrics.averageViews).toBe(783_333);
    expect(metrics.medianViews).toBe(300_000);
    expect(metrics.viewsPerUpload).toBe(783_333);
    expect(metrics.bestShort?.views).toBe(2_000_000);
    expect(metrics.worstShort?.views).toBe(50_000);

    expect(metrics.hits.rate).toBe(50);
    expect(metrics.hits.hits).toBe(1);
    expect(metrics.hits.judged).toBe(2);
    expect(metrics.hits.excluded).toBe(1);
    expect(metrics.hits.tally).toEqual({
      hits: 1,
      misses: 1,
      pending: 1,
      unknown: 0,
      unscoreable: 0,
    });

    // The displayed exclusion: 1 long-form + 1 uncertain, exactly as the old
    // `!isShort` complement counted them. The strict long-form selector would
    // say 1, and 1 here is the regression this test exists to catch.
    expect(metrics.excludedLongform).toBe(2);
  });
});

describe("the niche DTO gained `format` and changed nothing else", () => {
  /** A row exactly as Prisma returns it after the migration. */
  const ROW: Niche = {
    id: "niche-1",
    organizationId: "org-1",
    createdById: "user-1",
    name: "GTA",
    slug: "gta",
    colorIndex: 3,
    kind: "production",
    // What the migration wrote onto every existing row.
    format: "shorts",
    hitPaymentMinor: 500,
    hitThreshold: 1_000_000,
    hitWindowHours: 168,
    sortOrder: 2,
    createdAt: new Date(Date.UTC(2026, 0, 10)),
    updatedAt: new Date(Date.UTC(2026, 0, 20)),
  };

  it("ships the pre-deploy payload byte-for-byte, plus exactly one new field", () => {
    const dto = toNicheDTO(ROW, 4, { name: "Tahsin", email: "t@example.com" }, {
      includePay: true,
    });

    // Strip the one field this deploy added…
    const { format, ...consumedToday } = dto;
    expect(format).toBe("shorts");

    // …and what remains must be the payload the client consumed before the
    // deploy, value for value. This object was written from the pre-format
    // mapper's output and must not be regenerated from the implementation.
    expect(consumedToday).toEqual({
      id: "niche-1",
      name: "GTA",
      colorIndex: 3,
      kind: "production",
      slug: "gta",
      hitPaymentMinor: 500,
      hitThreshold: 1_000_000,
      hitWindowHours: 168,
      sortOrder: 2,
      channelCount: 4,
      createdById: "user-1",
      createdByName: "Tahsin",
      createdAt: Date.UTC(2026, 0, 10),
    });
  });

  it("maps an unreadable stored format to shorts — the fail-closed direction", () => {
    const dto = toNicheDTO({ ...ROW, format: "widescreen" }, 0);
    expect(dto.format).toBe("shorts");
  });
});
