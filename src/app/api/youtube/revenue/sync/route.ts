import { z } from "zod";
import { handleMutation, readJson } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { errors } from "@/server/errors";
import { RATE_LIMITS, enforceRateLimit } from "@/server/auth/rate-limit";
import { syncRevenueForOrganization } from "@/server/services/youtube-revenue-service";

/**
 * An optional body, and the only thing in it narrows the run.
 *
 * `connectionId` says which account to read; omitting it reads them all. It
 * cannot widen anything and it cannot name an organization — the workspace
 * still comes from the session, and the service applies this id as an extra
 * filter on top of that scope rather than instead of it.
 *
 * `.optional()` on a nullable field so the two ways a client can say "all of
 * them" — omitting the key, or sending `null` — both mean the same thing.
 */
const syncRequestSchema = z.object({
  connectionId: z.string().min(1).max(64).nullish(),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * One Analytics call per connected account plus a monthly rollup. Minutes of
 * upstream I/O in the worst case, not milliseconds, so the default serverless
 * budget would kill it partway and leave the connection statuses half written.
 */
export const maxDuration = 120;

/**
 * POST /api/youtube/revenue/sync — read revenue now, without waiting for the
 * scheduler.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE CRON ROUTE
 * The scheduled path is authenticated by a shared secret and sweeps every
 * organization; this one is authenticated by a session and touches exactly the
 * caller's own workspace. They are the same work behind different doors, which
 * is why both call `syncRevenueForOrganization` rather than each having their
 * own idea of what a revenue sync is.
 *
 * It is the button an admin presses after connecting an account, or after
 * fixing an exchange rate the last run complained about — the two moments where
 * waiting up to six hours to find out whether the fix worked is the difference
 * between a setup that feels finished and one that feels broken.
 *
 * An optional `connectionId` reads one account instead of all of them, which is
 * what the per-connection button on the admin screen sends. It narrows the run;
 * it never redirects it.
 */
export function POST(request: Request) {
  return handleMutation(request, async () => {
    // First statement, before anything is read or queried. `youtube.manage` is
    // the permission that connects and disconnects these accounts, and this
    // spends their authorisation — it belongs to the same people.
    const actor = await requirePermission("youtube.manage");

    // Permission says who may sync; the limiter says how often. Shared with the
    // channel refresh deliberately: both spend a finite upstream allowance on
    // this app's behalf, and a per-endpoint budget would let one permitted
    // account drain the day by alternating between them.
    await enforceRateLimit(RATE_LIMITS.syncByUser, actor.userId);

    const parsed = syncRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.invalidInput("That is not a connection this can sync.");
    }

    // Scoped to the caller's own workspace, from the session. The body may say
    // WHICH of that workspace's connections to read, never whose — the
    // organization is not a request parameter and cannot be made into one.
    const summary = await syncRevenueForOrganization(actor.organizationId, {
      trigger: "manual",
      request,
      connectionId: parsed.data.connectionId ?? null,
    });

    return { ok: true as const, ...summary };
  });
}
