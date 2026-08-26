import type { AnalyticsVideo } from "../types";

/**
 * Test fixtures.
 *
 * These build the analytics engine's *input* shape directly. They are not mock
 * YouTube data standing in for a missing integration — the real pipeline
 * produces exactly this shape from live API responses, and these exist so the
 * pure maths can be tested without a network or a database.
 */

let counter = 0;

export function makeVideo(overrides: Partial<AnalyticsVideo> = {}): AnalyticsVideo {
  counter += 1;
  return {
    id: `row-${counter}`,
    youtubeVideoId: `vid${String(counter).padStart(8, "0")}`,
    title: `Video ${counter}`,
    publishedAt: Date.UTC(2026, 0, 15),
    views: 0,
    likes: null,
    comments: null,
    durationSeconds: 30,
    isShort: true,
    ...overrides,
  };
}

export function makeShort(overrides: Partial<AnalyticsVideo> = {}): AnalyticsVideo {
  return makeVideo({ ...overrides, isShort: true });
}

export function makeLongform(overrides: Partial<AnalyticsVideo> = {}): AnalyticsVideo {
  return makeVideo({ durationSeconds: 620, ...overrides, isShort: false });
}

/** `n` Shorts, the first `hits` of which clear `threshold`. */
export function makeShortsWithHits(
  n: number,
  hits: number,
  threshold: number,
  publishedAt: number = Date.UTC(2026, 0, 15),
): AnalyticsVideo[] {
  return Array.from({ length: n }, (_, i) =>
    makeShort({
      views: i < hits ? threshold + i : Math.max(0, threshold - 1000 - i),
      publishedAt,
    }),
  );
}

export const DAY_MS = 86_400_000;

/** `daysAgo` days before `now`, as epoch ms. */
export function daysAgo(days: number, now: number = Date.UTC(2026, 5, 1)): number {
  return now - days * DAY_MS;
}
