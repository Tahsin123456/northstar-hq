import path from "node:path";
import { z } from "zod";

/**
 * Server-side environment. Parsed once, at import time, so a misconfiguration
 * surfaces as one clear message instead of a mystery `undefined` three layers
 * deep inside an API call.
 *
 * Nothing here is ever imported from a client component — the values are read
 * exclusively inside route handlers and services.
 */

const booleanish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .refine((v) => ["true", "false", "1", "0", "yes", "no", ""].includes(v), {
    message: 'expected a boolean-ish value ("true" / "false")',
  })
  .transform((v) => v === "true" || v === "1" || v === "yes");

const envSchema = z.object({
  /**
   * Deliberately optional. The app must boot, render, explain itself and let
   * the user reach Settings *without* a key — otherwise a missing key looks
   * like a crash instead of a setup step. Every code path that actually needs
   * the key checks `hasYouTubeApiKey()` and throws a typed, human-readable
   * ConfigurationError.
   */
  YOUTUBE_API_KEY: z.string().trim().optional(),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  SHORTS_PROBE_ENABLED: booleanish.optional(),
  SHORTS_PROBE_CONCURRENCY: z.coerce.number().int().min(1).max(32).optional(),
  SHORTS_PROBE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).optional(),

  YOUTUBE_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(3650).optional(),
  YOUTUBE_MAX_PAGES: z.coerce.number().int().min(1).max(200).optional(),
  REFRESH_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(20_160).optional(),

  /**
   * Shared secret for /api/cron/sync, the endpoint an external scheduler calls.
   *
   * Optional like the API key — the app is fully usable with no scheduler, and
   * demanding a secret for a feature nobody has switched on turns setup into a
   * scavenger hunt. The route refuses to run at all when it is missing rather
   * than falling back to no authentication.
   *
   * The length floor is enforced here rather than at the route because a
   * two-character secret survives a timing-safe comparison exactly as happily
   * as a strong one — the comparison protects the secret, it does not supply
   * entropy. Failing at boot beats discovering it from a scheduler nobody
   * watches. Empty is treated as unset (see `cronSecret` below) so a blank line
   * copied from .env.example does not crash the app.
   */
  CRON_SECRET: z
    .string()
    .trim()
    .refine((value) => value.length === 0 || value.length >= 32, {
      message:
        'CRON_SECRET must be at least 32 characters of randomness (or left empty to disable scheduled sync). Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    })
    .optional(),

  /**
   * Ceiling on channels refreshed in one scheduled run.
   *
   * THE SCHEDULE TRADE-OFF, IN ONE NUMBER
   * YouTube's default allowance is 10,000 units/day and a channel refresh costs
   * roughly 1 unit per 50 videos in the lookback window — call it 10–15 units
   * for a busy channel. Hourly runs of 25 channels is therefore ~9,000 units at
   * the absolute worst, and far less in practice because the staleness filter
   * skips anything already fresh. Fetching per page view has no such ceiling:
   * one enthusiastic afternoon of dashboard use would exhaust the day's quota
   * for everybody, which is the whole reason syncing is scheduled.
   */
  SYNC_MAX_CHANNELS_PER_RUN: z.coerce.number().int().min(1).max(500).optional(),

  NODE_ENV: z.enum(["development", "test", "production"]).optional(),
});

/**
 * Mirror of the normalisation in scripts/prisma-run.mjs.
 *
 * A relative SQLite path in DATABASE_URL is resolved by Prisma against the
 * schema file's directory. The generated SQLite schema lives in
 * prisma/.generated/, so "file:./prisma/dev.db" would resolve one level too
 * deep. Making the path absolute means the URL denotes the same file whether
 * it is read by the CLI or by the client at runtime.
 */
function normalizeDatabaseUrl(rawUrl: string): string {
  if (!rawUrl.startsWith("file:") && !rawUrl.startsWith("sqlite:")) return rawUrl;
  const rawPath = rawUrl.replace(/^file:/, "").replace(/^sqlite:/, "");
  if (/^([a-zA-Z]:[\\/]|\/)/.test(rawPath)) return `file:${rawPath.split(path.sep).join("/")}`;
  // The bundler's static analysis reads any `path.resolve(process.cwd(), …)` as
  // "this route may touch arbitrary project files" and traces the entire
  // project into the server bundle. This call is reached only for a relative
  // SQLite path — a local-development convenience that a PostgreSQL
  // deployment never executes — so the trace is opted out of explicitly.
  const absolute = path
    .resolve(/* turbopackIgnore: true */ process.cwd(), rawPath)
    .split(path.sep)
    .join("/");
  return `file:${absolute}`;
}

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  • ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  throw new Error(
    `Invalid environment configuration:\n${issues}\n\n` +
      "Copy .env.example to .env.local and fill in the values.",
  );
}

const raw = parsed.data;

const databaseUrl = normalizeDatabaseUrl(raw.DATABASE_URL);
// Prisma Client reads process.env.DATABASE_URL itself, so write the normalised
// value back before any client is constructed.
process.env.DATABASE_URL = databaseUrl;

export const env = {
  youtubeApiKey: raw.YOUTUBE_API_KEY && raw.YOUTUBE_API_KEY.length > 0 ? raw.YOUTUBE_API_KEY : null,
  databaseUrl,
  shortsProbeEnabled: raw.SHORTS_PROBE_ENABLED ?? true,
  shortsProbeConcurrency: raw.SHORTS_PROBE_CONCURRENCY ?? 6,
  shortsProbeTimeoutMs: raw.SHORTS_PROBE_TIMEOUT_MS ?? 8_000,
  lookbackDays: raw.YOUTUBE_LOOKBACK_DAYS ?? 400,
  maxUploadPages: raw.YOUTUBE_MAX_PAGES ?? 40,
  refreshIntervalMinutes: raw.REFRESH_INTERVAL_MINUTES ?? 360,
  // Normalised to null so callers have one falsy case to check, not two.
  cronSecret: raw.CRON_SECRET && raw.CRON_SECRET.length > 0 ? raw.CRON_SECRET : null,
  syncMaxChannelsPerRun: raw.SYNC_MAX_CHANNELS_PER_RUN ?? 25,
  isProduction: raw.NODE_ENV === "production",
  isSqlite: databaseUrl.startsWith("file:"),
} as const;

export function hasYouTubeApiKey(): boolean {
  return env.youtubeApiKey !== null;
}

/**
 * Whether scheduled synchronisation is configured at all.
 *
 * Deliberately reports existence, never the value — the same contract
 * `hasYouTubeApiKey` follows, so a status endpoint can say "the scheduler is
 * wired up" without handing anybody the credential that drives it.
 */
export function hasCronSecret(): boolean {
  return env.cronSecret !== null;
}

/**
 * Narrowing accessor. Callers that reach YouTube must go through this so the
 * "no key configured" case produces one consistent, actionable message.
 */
export function requireYouTubeApiKey(): string {
  if (env.youtubeApiKey === null) {
    throw new MissingApiKeyError();
  }
  return env.youtubeApiKey;
}

export class MissingApiKeyError extends Error {
  readonly code = "MISSING_API_KEY";
  constructor() {
    super(
      "No YouTube API key is configured. Add YOUTUBE_API_KEY to .env.local and restart the server.",
    );
    this.name = "MissingApiKeyError";
  }
}
