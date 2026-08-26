import { describe, expect, it } from "vitest";
import { probeShortsUrl } from "../shorts-detector";

/**
 * NETWORK INTEGRATION TEST — opt-in.
 *
 *   npm run test:integration
 *
 * Skipped by default so `npm test` stays hermetic and fast. Run this when you
 * want to confirm the single external assumption the Shorts classifier rests
 * on, or if YouTube ever changes how it serves the Shorts URL:
 *
 *   • a genuine Short answers 200
 *   • anything else 3xx-redirects to /watch
 *   • a missing video answers 404
 *
 * Reaches youtube.com but uses **no** API quota and needs no API key.
 */

const ENABLED = process.env.RUN_NETWORK_TESTS === "true";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * Discovers live Shorts ids from a channel's /shorts tab.
 *
 * Hard-coding ids would rot: videos get deleted and channels reorganise.
 * Discovering them each run keeps the positive case honest.
 */
async function discoverShortsIds(handle: string): Promise<string[]> {
  const response = await fetch(`https://www.youtube.com/${handle}/shorts`, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
  });
  const html = await response.text();

  const ids = new Set<string>();
  const reelPattern = /"reelWatchEndpoint":\{"videoId":"([A-Za-z0-9_-]{11})"/g;
  let match: RegExpExecArray | null;
  while ((match = reelPattern.exec(html)) !== null) ids.add(match[1]);
  return [...ids];
}

describe.skipIf(!ENABLED)("Shorts URL probe — live YouTube behaviour", () => {
  it(
    "classifies a long-form video as not a Short",
    async () => {
      // "Never Gonna Give You Up" — 3:33, landscape. Stable for a decade.
      expect(await probeShortsUrl("dQw4w9WgXcQ")).toBe("not_short");
    },
    30_000,
  );

  it(
    "rejects a short-DURATION video that is not a SHORT",
    async () => {
      // "Me at the zoo" — 19 seconds, landscape, uploaded in 2005.
      //
      // This is the case that makes the whole layered classifier necessary. A
      // naive `duration < 60s` rule counts this as a Short and corrupts the
      // denominator of every hit rate. YouTube redirects it to /watch, so the
      // probe correctly rejects it.
      expect(await probeShortsUrl("jNQXAC9IVRw")).toBe("not_short");
    },
    30_000,
  );

  it(
    "reports a missing video as unavailable rather than guessing",
    async () => {
      expect(await probeShortsUrl("aaaaaaaaaaa")).toBe("unavailable");
    },
    30_000,
  );

  it(
    "classifies genuine Shorts as Shorts",
    async () => {
      const ids = await discoverShortsIds("@MrBeast");
      expect(ids.length).toBeGreaterThan(0);

      const sample = ids.slice(0, 3);
      const outcomes = await Promise.all(sample.map((id) => probeShortsUrl(id)));

      // Every id came from a /shorts tab, so every one must probe as a Short.
      // A "blocked" result would mean we are being throttled, which is a
      // legitimate reason to retry rather than a failure of the logic.
      for (const outcome of outcomes) {
        expect(outcome, `unexpected verdict for sample ${sample.join(", ")}`).toBe("short");
      }
    },
    60_000,
  );
});
