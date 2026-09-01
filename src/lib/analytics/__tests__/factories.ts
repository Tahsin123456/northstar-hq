import type { HitOutcome, StoredHitVerdict } from "../hit-rate";
import type { JudgedVideo } from "../types";

/**
 * Test fixtures.
 *
 * These build the analytics engine's *input* shape directly. They are not mock
 * YouTube data standing in for a missing integration — the real pipeline
 * produces exactly this shape from live API responses, and these exist so the
 * pure maths can be tested without a network or a database.
 *
 * =========================================================================
 * EVERY FIXTURE NOW CARRIES A VERDICT, AND THE DEFAULT IS "NONE"
 * =========================================================================
 * A hit is a threshold reached within a window. That is decided from a snapshot
 * series and materialised on `VideoHitEvaluation`; nothing in this directory
 * derives it from a view count any more. So a fixture that only sets `views`
 * describes a Short NOBODY HAS JUDGED — `hit: null`, contributing to no rate —
 * and that default is deliberate: a test that means to assert something about
 * hits has to say which Shorts hit, rather than getting an answer for free out
 * of a number that no longer decides anything.
 *
 * `makeHit` / `makeMiss` / `makePending` / `makeUnknown` are the four ways to
 * say it. The view count on them is free to disagree with the verdict, and
 * several tests use that on purpose — a Short with 5M views and a stored miss
 * is the exact case the old lifetime rule got wrong.
 */

let counter = 0;

export function makeVideo(overrides: Partial<JudgedVideo> = {}): JudgedVideo {
  counter += 1;
  // `classification` follows the FINAL `isShort` unless the test pins it,
  // matching the real classifier's invariant that `isShort: true` only ever
  // pairs with "short". The false side defaults to "uncertain" rather than
  // "not_short" on purpose: a bare `isShort: false` fixture has said nothing
  // about being long-form, and defaulting it into the long-form population
  // would hand tests the exact conflation `isVideoOfFormat` exists to refuse.
  // `makeLongform` states "not_short" explicitly.
  const isShort = overrides.isShort ?? true;
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
    classification: isShort ? "short" : "uncertain",
    // No verdict unless the test asks for one. See the header.
    hit: null,
    ...overrides,
  };
}

export function makeShort(overrides: Partial<JudgedVideo> = {}): JudgedVideo {
  return makeVideo({ ...overrides, isShort: true });
}

export function makeLongform(overrides: Partial<JudgedVideo> = {}): JudgedVideo {
  return makeVideo({
    durationSeconds: 620,
    classification: "not_short",
    ...overrides,
    isShort: false,
  });
}

/**
 * A video the classifier could not resolve. In NEITHER format's analytics:
 * `isShort` is false so it never enters a Shorts metric, and "uncertain" is
 * not "not_short" so it never enters a long-form one either.
 */
export function makeUncertain(overrides: Partial<JudgedVideo> = {}): JudgedVideo {
  return makeVideo({
    classification: "uncertain",
    ...overrides,
    isShort: false,
  });
}

/** The rule most fixtures are judged by: a million views inside seven days. */
export const TEST_THRESHOLD = 1_000_000;
export const TEST_WINDOW_HOURS = 168;

/**
 * A stored verdict, as the evaluator would have written it.
 *
 * `viewsAtWindow` and `observedAtHours` default to null — the state most Shorts
 * on the real account are in, because a miss inferred from "lifetime is still
 * under the bar" never observed anything inside the window.
 */
export function makeVerdict(
  outcome: HitOutcome,
  overrides: Partial<StoredHitVerdict> = {},
): StoredHitVerdict {
  return {
    outcome,
    thresholdApplied: TEST_THRESHOLD,
    windowHoursApplied: TEST_WINDOW_HOURS,
    viewsAtWindow: null,
    observedAtHours: null,
    ...overrides,
  };
}

/** A Short judged to have reached the bar inside its window. */
export function makeHit(overrides: Partial<JudgedVideo> = {}): JudgedVideo {
  const short = makeShort(overrides);
  return {
    ...short,
    hit:
      overrides.hit ??
      makeVerdict("hit", {
        // A hit is only ever declared from something actually seen, so these
        // two are never null on one — mirroring `HitVerdict`, where the union
        // makes that structural.
        viewsAtWindow: Math.max(short.views, TEST_THRESHOLD),
        observedAtHours: 24,
      }),
  };
}

/** A Short whose window shut with it short of the bar. */
export function makeMiss(overrides: Partial<JudgedVideo> = {}): JudgedVideo {
  return { ...makeShort(overrides), hit: overrides.hit ?? makeVerdict("miss") };
}

/** A Short still inside its window. In neither half of any rate. */
export function makePending(overrides: Partial<JudgedVideo> = {}): JudgedVideo {
  return { ...makeShort(overrides), hit: overrides.hit ?? makeVerdict("pending") };
}

/** Window shut, nobody was recording, and it did eventually pass the bar. */
export function makeUnknown(overrides: Partial<JudgedVideo> = {}): JudgedVideo {
  return { ...makeShort(overrides), hit: overrides.hit ?? makeVerdict("unknown") };
}

/**
 * A Short in a niche with no complete rule.
 *
 * Stored as "unknown" with NO rule beside it, which is exactly what the
 * evaluator writes and what `hitContributionOf` keys on to separate "nobody was
 * watching" from "nobody has configured this niche".
 */
export function makeUnscoreable(overrides: Partial<JudgedVideo> = {}): JudgedVideo {
  return {
    ...makeShort(overrides),
    hit: makeVerdict("unknown", { thresholdApplied: null, windowHoursApplied: null }),
  };
}

/**
 * `n` DECIDED Shorts, the first `hits` of which reached the bar in time.
 *
 * The view counts still straddle `threshold`, so fixtures that also assert on
 * views and medians keep working — but the verdicts are what the rate is
 * counted from, and the two are set independently on purpose.
 */
export function makeShortsWithHits(
  n: number,
  hits: number,
  threshold: number,
  publishedAt: number = Date.UTC(2026, 0, 15),
): JudgedVideo[] {
  return Array.from({ length: n }, (_, i) => {
    const views = i < hits ? threshold + i : Math.max(0, threshold - 1000 - i);
    return i < hits
      ? makeHit({ views, publishedAt })
      : makeMiss({ views, publishedAt });
  });
}

export const DAY_MS = 86_400_000;

/** `daysAgo` days before `now`, as epoch ms. */
export function daysAgo(days: number, now: number = Date.UTC(2026, 5, 1)): number {
  return now - days * DAY_MS;
}
