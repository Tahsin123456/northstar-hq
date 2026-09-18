import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * =========================================================================
 * THE ONLY AGGREGATE BOUND ON SHORTS CLASSIFICATION
 * =========================================================================
 *
 * The owner added a channel and the request was killed by the platform after
 * 300 seconds with a 504 — the channel added, the roster never updated, and
 * nothing to show for five minutes of waiting.
 *
 * `classifyVideos` was the unbounded step. Its per-probe timeout caps ONE
 * probe; nothing capped the batch, and on a channel's first sync the batch is
 * every video it has — the playlist walk permits up to 2,000 — six at a time.
 * The hourly sweep's time budget does not help: that bounds how many CHANNELS
 * the sweep starts, not how long one channel takes, and the add path syncs
 * exactly one.
 *
 * What is pinned here:
 *   • past the deadline, no further probe is STARTED;
 *   • the videos that missed out are still classified, from duration and
 *     aspect ratio, exactly as a timed-out probe already leaves them;
 *   • no deadline still means no ceiling, which is what the sweep wants.
 *
 * The probe is stubbed at `fetch`. What matters is how many times it is
 * called, not what YouTube would say.
 */

const probeCalls: string[] = [];
/** Resolves after `ms` of FAKE time, so the clock moves only when we move it. */
let probeDelayMs = 0;

beforeEach(() => {
  vi.useFakeTimers();
  probeCalls.length = 0;
  probeDelayMs = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      probeCalls.push(String(url));
      if (probeDelayMs > 0) await vi.advanceTimersByTimeAsync(probeDelayMs);
      // A 303 to /watch is the detector's "not a Short" answer; the shape is
      // irrelevant here, only that the call happened.
      return new Response(null, { status: 303, headers: { location: "/watch?v=x" } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const { classifyVideos } = await import("../shorts-detector");

/**
 * A video the duration gate cannot settle for free, so it reaches the probe.
 *
 * 42 seconds is inside the Shorts maximum and the aspect ratio is absent, so
 * `classifyFromSignals` returns neither `duration_gate` nor `live_broadcast`
 * and the video is queued. If this fixture ever stops needing a probe the
 * tests below pass vacuously, so the first case asserts the queue is real.
 */
function probeable(videoId: string) {
  return {
    videoId,
    channelId: "UC_test",
    title: `Video ${videoId}`,
    description: "",
    publishedAt: new Date("2026-01-01T00:00:00.000Z"),
    durationIso: "PT42S",
    durationSeconds: 42,
    thumbnailUrl: null,
    viewCount: 0,
    likeCount: 0,
    commentCount: 0,
    // Absent dimensions mean no aspect-ratio evidence, which is what keeps
    // this fixture in the queue that needs a probe.
    playerWidth: null,
    playerHeight: null,
    liveBroadcastContent: "none",
  };
}

describe("classifyVideos under a deadline", () => {
  it("probes every video when no deadline is set", async () => {
    // The sweep's case, and the guard that the fixture really does need a probe.
    const videos = [probeable("a"), probeable("b"), probeable("c")];

    const result = await classifyVideos(videos, { probeEnabled: true });

    expect(probeCalls).toHaveLength(3);
    expect(result.size).toBe(3);
  });

  it("starts no probe once the deadline has passed", async () => {
    const videos = [probeable("a"), probeable("b"), probeable("c")];

    // Already expired: not one probe may begin.
    const result = await classifyVideos(videos, {
      probeEnabled: true,
      deadlineMs: Date.now() - 1,
    });

    expect(probeCalls).toHaveLength(0);
    // STILL CLASSIFIED, which is the half that makes the bound safe to have.
    // A skipped probe is the same input as a timed-out one, so these land as
    // "uncertain" and the next sync re-probes exactly them.
    expect(result.size).toBe(3);
    for (const video of videos) {
      expect(result.get(video.videoId)?.classification).toBe("uncertain");
    }
  });

  it("stops partway through when the clock runs out mid-batch", async () => {
    // Six videos, one probe's worth of budget. Concurrency 1 makes the order
    // deterministic; each probe burns the whole budget.
    const videos = ["a", "b", "c", "d", "e", "f"].map(probeable);
    probeDelayMs = 100;

    const result = await classifyVideos(videos, {
      probeEnabled: true,
      concurrency: 1,
      deadlineMs: Date.now() + 100,
    });

    // Fewer than all of them, and more than none: the deadline is consulted
    // per video, because the queue drains while the time elapses.
    expect(probeCalls.length).toBeGreaterThan(0);
    expect(probeCalls.length).toBeLessThan(videos.length);
    // Every video still has an answer.
    expect(result.size).toBe(videos.length);
  });

  it("spends nothing on probes when classification is disabled outright", async () => {
    const result = await classifyVideos([probeable("a")], { probeEnabled: false });

    expect(probeCalls).toHaveLength(0);
    expect(result.size).toBe(1);
  });
});
