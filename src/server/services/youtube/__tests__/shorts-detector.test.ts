import { describe, expect, it } from "vitest";
import {
  classifyFromSignals,
  MIN_SHORT_CONFIDENCE,
  SHORTS_HARD_MAX_SECONDS,
  SHORTS_MAX_DURATION_SECONDS,
  VERTICAL_ASPECT_MAX,
  type ClassificationSignals,
} from "../shorts-detector";

const signals = (overrides: Partial<ClassificationSignals> = {}): ClassificationSignals => ({
  durationSeconds: 42,
  aspectRatio: null,
  probe: null,
  liveBroadcastContent: "none",
  ...overrides,
});

/** Vertical 1080x1920. */
const VERTICAL = 1080 / 1920;
/** Landscape 1920x1080. */
const LANDSCAPE = 1920 / 1080;

describe("duration gate — the free, definitive exclusion", () => {
  it("rejects anything past the Shorts maximum with full confidence", () => {
    const result = classifyFromSignals(signals({ durationSeconds: 600 }));
    expect(result.classification).toBe("not_short");
    expect(result.isShort).toBe(false);
    expect(result.confidence).toBe(1);
    expect(result.method).toBe("duration_gate");
  });

  it("overrides even a positive probe — no Short can exceed the platform limit", () => {
    const result = classifyFromSignals(
      signals({ durationSeconds: 900, probe: "short", aspectRatio: VERTICAL }),
    );
    expect(result.isShort).toBe(false);
    expect(result.method).toBe("duration_gate");
  });

  it("allows the post-2024 three-minute window through the gate", () => {
    // The old "under 60 seconds" rule would wrongly discard this.
    const result = classifyFromSignals(
      signals({ durationSeconds: 170, aspectRatio: VERTICAL }),
    );
    expect(result.isShort).toBe(true);
  });

  it("tolerates rounding right at the boundary", () => {
    expect(
      classifyFromSignals(signals({ durationSeconds: SHORTS_HARD_MAX_SECONDS, aspectRatio: VERTICAL })).isShort,
    ).toBe(true);
    expect(
      classifyFromSignals(signals({ durationSeconds: SHORTS_HARD_MAX_SECONDS + 1, aspectRatio: VERTICAL })).isShort,
    ).toBe(false);
  });

  it("keeps the tolerance tight enough to be meaningful", () => {
    expect(SHORTS_HARD_MAX_SECONDS - SHORTS_MAX_DURATION_SECONDS).toBeLessThanOrEqual(10);
  });
});

describe("live broadcasts", () => {
  it("excludes live and upcoming content", () => {
    for (const state of ["live", "upcoming"]) {
      const result = classifyFromSignals(
        signals({ liveBroadcastContent: state, aspectRatio: VERTICAL }),
      );
      expect(result.isShort).toBe(false);
      expect(result.method).toBe("live_broadcast");
    }
  });

  it("does not exclude ordinary uploads", () => {
    const result = classifyFromSignals(
      signals({ liveBroadcastContent: "none", aspectRatio: VERTICAL }),
    );
    expect(result.isShort).toBe(true);
  });
});

describe("URL probe — the authoritative signal", () => {
  it("trusts a positive probe over a landscape aspect ratio", () => {
    const result = classifyFromSignals(
      signals({ probe: "short", aspectRatio: LANDSCAPE }),
    );
    expect(result.isShort).toBe(true);
    expect(result.method).toBe("url_probe");
    expect(result.confidence).toBeGreaterThan(0.95);
  });

  it("trusts a negative probe over a vertical aspect ratio", () => {
    // A 45-second vertical clip uploaded normally is NOT a Short. This is the
    // exact case a duration-plus-aspect heuristic gets wrong, and the reason
    // the probe outranks it.
    const result = classifyFromSignals(
      signals({ probe: "not_short", aspectRatio: VERTICAL, durationSeconds: 45 }),
    );
    expect(result.isShort).toBe(false);
    expect(result.classification).toBe("not_short");
    expect(result.method).toBe("url_probe");
  });

  it("treats an unavailable video as unclassifiable, not as a Short", () => {
    const result = classifyFromSignals(signals({ probe: "unavailable" }));
    expect(result.classification).toBe("uncertain");
    expect(result.isShort).toBe(false);
  });

  it("never lets throttling become a verdict", () => {
    // A 429 must degrade to the heuristic path, not silently reclassify a
    // whole channel's back catalogue.
    const blocked = classifyFromSignals(
      signals({ probe: "blocked", aspectRatio: VERTICAL, durationSeconds: 30 }),
    );
    expect(blocked.method).toBe("duration_aspect");
    expect(blocked.isShort).toBe(true);

    const errored = classifyFromSignals(
      signals({ probe: "error", aspectRatio: LANDSCAPE, durationSeconds: 30 }),
    );
    expect(errored.method).toBe("duration_aspect");
    expect(errored.isShort).toBe(false);
  });
});

describe("aspect-ratio fallback", () => {
  it("accepts vertical video inside the duration window", () => {
    const result = classifyFromSignals(
      signals({ durationSeconds: 58, aspectRatio: VERTICAL }),
    );
    expect(result.isShort).toBe(true);
    expect(result.method).toBe("duration_aspect");
    expect(result.confidence).toBeGreaterThanOrEqual(MIN_SHORT_CONFIDENCE);
  });

  it("accepts square video — Shorts allow 1:1", () => {
    const result = classifyFromSignals(signals({ durationSeconds: 30, aspectRatio: 1 }));
    expect(result.isShort).toBe(true);
  });

  it("rejects landscape video regardless of how short it is", () => {
    const result = classifyFromSignals(
      signals({ durationSeconds: 12, aspectRatio: LANDSCAPE }),
    );
    expect(result.isShort).toBe(false);
    expect(result.classification).toBe("not_short");
  });

  it("applies the vertical cutoff consistently", () => {
    expect(
      classifyFromSignals(signals({ durationSeconds: 30, aspectRatio: VERTICAL_ASPECT_MAX })).isShort,
    ).toBe(true);
    expect(
      classifyFromSignals(signals({ durationSeconds: 30, aspectRatio: VERTICAL_ASPECT_MAX + 0.01 })).isShort,
    ).toBe(false);
  });
});

describe("conservative handling of weak signals", () => {
  it("refuses to call a short-duration video a Short on duration alone", () => {
    // The naive heuristic this product explicitly rejects. Duration with no
    // corroboration is not enough.
    const result = classifyFromSignals(
      signals({ durationSeconds: 30, aspectRatio: null, probe: null }),
    );
    expect(result.classification).toBe("uncertain");
    expect(result.isShort).toBe(false);
    expect(result.confidence).toBeLessThan(MIN_SHORT_CONFIDENCE);
    expect(result.method).toBe("duration_only");
  });

  it("records a reason for every uncertain verdict", () => {
    const result = classifyFromSignals(signals({ durationSeconds: 30 }));
    expect(result.reason.length).toBeGreaterThan(10);
    expect(result.reason).toMatch(/excluded/i);
  });

  it("is uncertain when there is no duration at all", () => {
    const result = classifyFromSignals(
      signals({ durationSeconds: null, aspectRatio: null, probe: null }),
    );
    expect(result.classification).toBe("uncertain");
    expect(result.isShort).toBe(false);
  });

  it("never sets isShort true below the confidence floor", () => {
    const cases: ClassificationSignals[] = [
      signals({ durationSeconds: 30, aspectRatio: null, probe: null }),
      signals({ durationSeconds: null }),
      signals({ probe: "unavailable" }),
      signals({ durationSeconds: 5000 }),
      signals({ liveBroadcastContent: "live" }),
    ];
    for (const input of cases) {
      const result = classifyFromSignals(input);
      if (result.isShort) {
        expect(result.confidence).toBeGreaterThanOrEqual(MIN_SHORT_CONFIDENCE);
      }
    }
  });

  it("only ever sets isShort true alongside a 'short' classification", () => {
    const permutations: ClassificationSignals[] = [];
    for (const durationSeconds of [null, 5, 59, 120, 180, 186, 3600]) {
      for (const aspectRatio of [null, VERTICAL, 1, LANDSCAPE]) {
        for (const probe of [null, "short", "not_short", "unavailable", "blocked", "error"] as const) {
          for (const live of ["none", "live", null]) {
            permutations.push({
              durationSeconds,
              aspectRatio,
              probe,
              liveBroadcastContent: live,
            });
          }
        }
      }
    }

    // Exhaustive invariant check across the whole signal space.
    for (const input of permutations) {
      const result = classifyFromSignals(input);
      expect(result.isShort).toBe(result.classification === "short");
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
      expect(result.reason).toBeTruthy();
      if (result.isShort) {
        expect(result.confidence).toBeGreaterThanOrEqual(MIN_SHORT_CONFIDENCE);
        // An over-long video can never be classified as a Short, whatever
        // else the signals say.
        if (input.durationSeconds !== null) {
          expect(input.durationSeconds).toBeLessThanOrEqual(SHORTS_HARD_MAX_SECONDS);
        }
      }
    }
  });
});
