import { describe, expect, it } from "vitest";
import { toVideoDTO, type VideoProjection } from "@/server/mappers";
import { hitContributionOf } from "@/lib/analytics/hit-rate";

/**
 * =========================================================================
 * THE VERDICT'S TRIP ACROSS THE WIRE
 * =========================================================================
 *
 * The evaluator decides an outcome once and writes it to `VideoHitEvaluation`.
 * Everything the browser draws — the dashboard, the charts, the PDF — counts
 * those verdicts, so this mapper is the single seam between the decision and
 * every reader of it. What matters here is not arithmetic; it is that nothing
 * is INVENTED on the way through:
 *
 *   • an absent evaluation stays absent rather than becoming a miss,
 *   • an outcome string this build does not recognise is not guessed at,
 *   • and the rule columns survive as a pair, because a null pair is the only
 *     thing that distinguishes "nobody was recording" from "nobody has
 *     configured this niche".
 */

const BASE: Omit<VideoProjection, "hitEvaluations"> = {
  id: "row-1",
  youtubeVideoId: "vid00000001",
  title: "A Short",
  publishedAt: new Date(Date.UTC(2026, 0, 15)),
  viewCount: BigInt(2_400_000),
  likeCount: BigInt(1_000),
  commentCount: BigInt(50),
  durationSeconds: 30,
  isShort: true,
  classification: "short",
  classificationConfidence: 0.99,
  isAvailable: true,
  contentTypes: [],
};

const project = (
  hitEvaluations: VideoProjection["hitEvaluations"],
): VideoProjection => ({ ...BASE, hitEvaluations });

describe("toVideoDTO — the hit verdict", () => {
  it("ships the verdict with the rule that produced it", () => {
    const dto = toVideoDTO(
      project([
        {
          outcome: "hit",
          thresholdApplied: 1_000_000,
          windowHoursApplied: 168,
          viewsAtWindow: BigInt(1_200_000),
          observedAtHours: 14,
        },
      ]),
    );

    expect(dto.hit).toEqual({
      outcome: "hit",
      thresholdApplied: 1_000_000,
      windowHoursApplied: 168,
      viewsAtWindow: 1_200_000,
      observedAtHours: 14,
    });
    // BigInt out of the database, number on the wire — a Short's counter can
    // exceed 2^31 and the column carries that honestly.
    expect(typeof dto.hit?.viewsAtWindow).toBe("number");
  });

  it("ships null when no evaluation exists, and that is unscoreable, not a miss", () => {
    const dto = toVideoDTO(project([]));

    expect(dto.hit).toBeNull();
    // The evaluator runs on the sync cron, so a Short discovered ten minutes
    // ago genuinely has no answer. Reading that as a failure would let the hit
    // rate fall every time somebody published.
    expect(hitContributionOf(dto.hit)).toBe("unscoreable");
  });

  it("keeps the unscoreable verdict distinguishable from an evidential unknown", () => {
    const noRule = toVideoDTO(
      project([
        {
          outcome: "unknown",
          thresholdApplied: null,
          windowHoursApplied: null,
          viewsAtWindow: null,
          observedAtHours: null,
        },
      ]),
    );
    const nobodyWatching = toVideoDTO(
      project([
        {
          outcome: "unknown",
          thresholdApplied: 1_000_000,
          windowHoursApplied: 168,
          viewsAtWindow: null,
          observedAtHours: null,
        },
      ]),
    );

    // Both say "unknown" in the column — there are four outcomes and no fifth.
    expect(noRule.hit?.outcome).toBe("unknown");
    expect(nobodyWatching.hit?.outcome).toBe("unknown");
    // The rule columns are what send a reader to two different places.
    expect(hitContributionOf(noRule.hit)).toBe("unscoreable");
    expect(hitContributionOf(nobodyWatching.hit)).toBe("unknown");
  });

  it("does not guess at an outcome string it has never heard of", () => {
    // The column is a plain String for SQLite/PostgreSQL portability, so a
    // value written by a future migration this build predates is possible.
    // Treating it as "unknown" re-decides it rather than trusting it, and in
    // particular never promotes it to a hit or condemns it to a miss.
    const dto = toVideoDTO(
      project([
        {
          outcome: "probably_a_hit",
          thresholdApplied: 1_000_000,
          windowHoursApplied: 168,
          viewsAtWindow: null,
          observedAtHours: null,
        },
      ]),
    );

    expect(dto.hit?.outcome).toBe("unknown");
  });

  it("carries a miss with no in-window reading, which is most of the library", () => {
    // A miss inferred from "lifetime is still under the bar" observed nothing.
    // The nulls are the honest answer, and a screen that showed the lifetime
    // total in that slot would be dressing an inference as a measurement.
    const dto = toVideoDTO(
      project([
        {
          outcome: "miss",
          thresholdApplied: 5_000_000,
          windowHoursApplied: 168,
          viewsAtWindow: null,
          observedAtHours: null,
        },
      ]),
    );

    expect(dto.hit?.outcome).toBe("miss");
    expect(dto.hit?.viewsAtWindow).toBeNull();
    expect(dto.hit?.observedAtHours).toBeNull();
    expect(hitContributionOf(dto.hit)).toBe("miss");
  });

  it("does not derive the verdict from the view count on the row", () => {
    // 2.4M lifetime views against a 1M bar, stored as a miss because it took
    // too long. The mapper must pass that through untouched — this is the
    // central bug of the old rule, at the one seam where it could reappear.
    const dto = toVideoDTO(
      project([
        {
          outcome: "miss",
          thresholdApplied: 1_000_000,
          windowHoursApplied: 168,
          viewsAtWindow: null,
          observedAtHours: null,
        },
      ]),
    );

    expect(dto.views).toBe(2_400_000);
    expect(dto.hit?.outcome).toBe("miss");
  });
});
