import { prisma } from "@/server/db";
import { getActor } from "@/server/auth/dal";
import { env, hasYouTubeApiKey } from "@/server/env";
import { handle } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *
 * Reports each dependency separately rather than a single boolean, because
 * "the database is fine but no API key is set" is a completely different
 * situation from "the database is unreachable" and needs a different fix.
 *
 * The detail is privileged, the liveness answer is not. A load balancer carries
 * no cookie and must still get a 200, so this endpoint stays open — but the
 * driver's error text, which database is behind it and whether an API key
 * exists are reconnaissance for a stranger, so an anonymous caller learns only
 * whether the service is up. Same probe, two audiences.
 */
export function GET() {
  return handle(async () => {
    let database: "ok" | "error" = "ok";
    let databaseError: string | null = null;

    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      database = "error";
      databaseError = error instanceof Error ? error.message : "Unknown database error";
    }

    // `getActor` rather than `requirePermission`: it returns null for a missing
    // or expired session instead of throwing, which keeps the anonymous path a
    // 200 rather than a 401 the load balancer would read as an outage.
    //
    // Resolving it also costs a session query, so it is guarded: when the
    // database is the thing that is down, failing to identify the caller must
    // still leave a health answer rather than a 500 from the one endpoint whose
    // job is to report the outage. An unidentified caller is treated as
    // anonymous, which fails closed.
    let privileged = false;
    try {
      const actor = await getActor();
      privileged = actor?.permissions.has("settings.manage") ?? false;
    } catch {
      privileged = false;
    }

    if (!privileged) {
      return { status: database === "ok" ? ("ok" as const) : ("error" as const) };
    }

    return {
      status: database === "ok" ? "ok" : "degraded",
      database,
      databaseError,
      databaseProvider: env.isSqlite ? "sqlite" : "postgresql",
      youtubeApiKey: hasYouTubeApiKey() ? "configured" : "missing",
      shortsProbeEnabled: env.shortsProbeEnabled,
      timestamp: Date.now(),
    };
  });
}
