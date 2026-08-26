import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Empty environment variables must be treated as "not set".
 *
 * This is not a hypothetical. Vercel's import screen reads `.env.example` and
 * pre-creates every key it finds — nineteen of them here — so a deployment
 * routinely arrives with a dozen variables present and blank. If a blank is
 * parsed as a value rather than as an absence, two things go wrong:
 *
 *   • A numeric setting coerces `""` to 0 and fails its own minimum, so the
 *     app refuses to boot with a validation error naming a variable the
 *     operator never deliberately set.
 *   • A boolean-ish setting reads `""` as false, silently switching a feature
 *     off — worse than crashing, because nothing announces it.
 *
 * Both failures land on whoever is deploying, usually somebody who did not
 * write the config, with an error message that reads like their mistake.
 */

const REQUIRED = {
  DATABASE_URL: "postgresql://user:pass@host:5432/db",
  SESSION_SECRET: Buffer.alloc(32, 1).toString("base64"),
  APP_URL: "https://northstarstudios.cc",
  NODE_ENV: "production",
};

/** The thirteen a Vercel import creates but nobody fills in. */
const BLANK_ON_IMPORT = [
  "YOUTUBE_API_KEY",
  "APP_ENCRYPTION_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "CRON_SECRET",
  "SYNC_MAX_CHANNELS_PER_RUN",
  "SESSION_TTL_HOURS",
  "SESSION_IDLE_TIMEOUT_MINUTES",
  "SHORTS_PROBE_ENABLED",
  "SHORTS_PROBE_CONCURRENCY",
  "SHORTS_PROBE_TIMEOUT_MS",
  "YOUTUBE_LOOKBACK_DAYS",
  "YOUTUBE_MAX_PAGES",
  "REFRESH_INTERVAL_MINUTES",
];

function applyEnv(overrides: Record<string, string> = {}) {
  for (const key of [...Object.keys(REQUIRED), ...BLANK_ON_IMPORT]) {
    delete process.env[key];
  }
  Object.assign(process.env, REQUIRED, overrides);
}

beforeEach(() => {
  vi.resetModules();
});

describe("a deployment where every optional variable is blank", () => {
  it("boots, rather than failing validation on a value nobody chose", async () => {
    applyEnv(Object.fromEntries(BLANK_ON_IMPORT.map((key) => [key, ""])));

    // The whole point: importing these must not throw.
    const { env } = await import("@/server/env");
    const { authEnv } = await import("@/server/auth/auth-env");

    expect(env).toBeDefined();
    expect(authEnv).toBeDefined();
  });

  it("falls back to the documented defaults", async () => {
    applyEnv(Object.fromEntries(BLANK_ON_IMPORT.map((key) => [key, ""])));
    const { env } = await import("@/server/env");

    expect(env.lookbackDays).toBe(400);
    expect(env.maxUploadPages).toBe(40);
    expect(env.refreshIntervalMinutes).toBe(360);
    expect(env.shortsProbeConcurrency).toBe(6);
    expect(env.shortsProbeTimeoutMs).toBe(8_000);
  });

  it("does not read a blank as a switched-off feature", async () => {
    applyEnv(Object.fromEntries(BLANK_ON_IMPORT.map((key) => [key, ""])));
    const { env } = await import("@/server/env");

    // The dangerous one. `""` coerced to false would disable Shorts detection's
    // most reliable signal on every deployment that left the box empty, and
    // nothing would say so — hit rates would just quietly be computed from a
    // worse classifier.
    expect(env.shortsProbeEnabled).toBe(true);
  });

  it("treats a blank optional credential as absent", async () => {
    applyEnv(Object.fromEntries(BLANK_ON_IMPORT.map((key) => [key, ""])));
    const { env, hasYouTubeApiKey } = await import("@/server/env");
    const { authEnv } = await import("@/server/auth/auth-env");

    expect(env.youtubeApiKey).toBeNull();
    expect(hasYouTubeApiKey()).toBe(false);
    expect(authEnv.encryptionKey).toBeNull();
  });

  it("still rejects a genuinely invalid value", async () => {
    // Blank means "unset"; nonsense still has to fail, or the leniency above
    // would swallow a real misconfiguration.
    applyEnv({ YOUTUBE_MAX_PAGES: "banana" });
    await expect(import("@/server/env")).rejects.toThrow(/YOUTUBE_MAX_PAGES/);
  });

  it("still rejects a blank where the value is genuinely required", async () => {
    applyEnv({ SESSION_SECRET: "" });
    await expect(import("@/server/auth/auth-env")).rejects.toThrow(/SESSION_SECRET/);
  });
});

describe("values that are actually set", () => {
  it("are used", async () => {
    applyEnv({
      YOUTUBE_LOOKBACK_DAYS: "180",
      SHORTS_PROBE_ENABLED: "false",
      REFRESH_INTERVAL_MINUTES: "120",
    });
    const { env } = await import("@/server/env");

    expect(env.lookbackDays).toBe(180);
    expect(env.shortsProbeEnabled).toBe(false);
    expect(env.refreshIntervalMinutes).toBe(120);
  });
});
