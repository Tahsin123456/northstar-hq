import { z } from "zod";
import { authenticateScheduler } from "@/server/auth/cron-auth";
import { handleMutation, readJson } from "@/server/http";
import { runScheduledSyncForAllOrganizations } from "@/server/services/sync-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * A sweep of a few dozen channels is minutes of upstream I/O, not milliseconds.
 * The default 10s serverless budget would kill it partway through and leave
 * half the tracker refreshed with no record of why.
 */
export const maxDuration = 300;

/**
 * ===========================================================================
 * POST/GET /api/cron/sync — the scheduled refresh entry point
 * ===========================================================================
 *
 * WHY THIS ROUTE IS EXEMPT FROM THE SESSION GATE
 * A scheduler has no cookie and never will. The full reasoning — and the
 * timing-safe secret comparison that replaces the session — lives in
 * `src/server/auth/cron-auth.ts`, shared with the payroll job so there is one
 * implementation of it rather than one per scheduled endpoint.
 *
 * WHY THE BLAST RADIUS IS SMALL HERE SPECIFICALLY
 * The worst case — someone holding the secret calling this repeatedly — is
 * bounded by the staleness filter and the per-run channel cap, which mean a
 * second call a minute later does almost no work. It is a quota nuisance, not
 * a data breach.
 */

const cronRequestSchema = z.object({
  /** Override for a one-off catch-up sweep; the scheduler omits it. */
  maxChannels: z.number().int().min(1).max(200).optional(),
});

async function runCronSync(request: Request) {
  // First statement of the handler, exactly as `requirePermission` is
  // everywhere else: nothing is read, parsed or queried before the caller has
  // been proven.
  authenticateScheduler(request, "Scheduled synchronisation");

  // A GET carries no body and a scheduler rarely sends one on POST either, so a
  // missing or malformed body is the normal case rather than an error.
  const parsed = cronRequestSchema.safeParse(
    request.method === "POST" ? await readJson(request) : {},
  );
  const maxChannels = parsed.success ? parsed.data.maxChannels : undefined;

  const result = await runScheduledSyncForAllOrganizations({
    trigger: "cron",
    maxChannels,
    request,
  });

  return {
    ok: true as const,
    ...result,
  };
}

/**
 * POST is the conventional verb for something that changes state, and what most
 * schedulers send.
 */
export function POST(request: Request) {
  return handleMutation(request, () => runCronSync(request));
}

/**
 * GET does the same thing, because schedulers disagree about which verb a cron
 * target should use — Vercel Cron issues GET, most queue workers POST, and a
 * plain `curl` in a crontab defaults to GET. Refusing one of them would make
 * this endpoint depend on the scheduler's taste.
 *
 * It uses `handleMutation` rather than `handle` despite being a GET, which is
 * against this codebase's usual convention and deliberate: the convention
 * exists so state-changing routes cannot forget the origin check, and this GET
 * changes state. Following the letter of the rule here would mean applying the
 * weaker wrapper to the request that needs the stronger one. (The check is a
 * no-op for a scheduler, which sends no Origin header — see `assertSameOrigin`
 * — so this costs nothing and closes the browser-driven case.)
 */
export function GET(request: Request) {
  return handleMutation(request, () => runCronSync(request));
}
