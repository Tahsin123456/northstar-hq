import { handle } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { googleOAuthStatus } from "@/server/auth/google-oauth-env";
import { listConnections } from "@/server/services/youtube-oauth-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/youtube/connections
 *
 * The connected Google accounts, plus whether this deployment can offer the
 * connect button at all. Both in one response because the admin screen has to
 * render one of two entirely different states — "here are your connections" or
 * "here is what to put in .env.local" — and a second round trip to find out
 * which would show the wrong one first.
 */
export function GET() {
  return handle(async () => {
    // The same permission that connects and disconnects. This list names which
    // Google account authorised what, which is administrative information about
    // credentials rather than analytics anybody with a login should read.
    const actor = await requirePermission("youtube.manage");

    return {
      // Scoped to the caller's own workspace, taken from the session — never
      // from a query parameter.
      connections: await listConnections(actor.organizationId),
      google: googleOAuthStatus(),
    };
  });
}
