import { NextResponse } from "next/server";
import { jsonError } from "@/server/http";
import { AppError } from "@/server/errors";
import { requirePermission } from "@/server/auth/dal";
import { googleOAuthRedirectUri } from "@/server/auth/google-oauth-env";
import { recordAudit } from "@/server/audit/audit-service";
import {
  adminYouTubeUrl,
  completeConnection,
  expiredOAuthStateCookie,
  verifyOAuthState,
} from "@/server/services/youtube-oauth-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/youtube/callback — where Google sends the browser back.
 *
 * Answers with a redirect to /admin/youtube rather than JSON: this is a
 * top-level navigation a person is watching, and dumping an error document in
 * front of them at the end of a consent flow is not an outcome. `handle()`
 * cannot express a 302, so the wrapper is written out here — see the note in
 * ../connect/route.ts.
 *
 * The only failure that does *not* redirect is a failure to authorise the
 * caller. Someone without `youtube.manage` reaching this URL gets a 403, not a
 * tour of the admin area.
 */
export async function GET(request: Request) {
  let actor;
  try {
    actor = await requirePermission("youtube.manage");
  } catch (error) {
    return jsonError(error);
  }

  const params = new URL(request.url).searchParams;

  /**
   * Every exit from here clears the state cookie, so a `state` that has been
   * presented once — accepted, rejected or abandoned — can never be presented
   * again.
   */
  const finish = (query: Record<string, string>): NextResponse => {
    const response = NextResponse.redirect(adminYouTubeUrl(query), { status: 302 });
    response.cookies.set(expiredOAuthStateCookie());
    return response;
  };

  // Google reports a refused or cancelled consent here rather than by failing
  // the request, so this is a normal outcome and not an error state.
  const googleError = params.get("error");
  if (googleError) {
    return finish({ error: googleError === "access_denied" ? "denied" : "failed" });
  }

  // The CSRF check, before the code is worth anything. A code that arrives
  // without the matching cookie was not requested by this browser, which is
  // exactly the attack the state parameter exists to stop — so it is discarded
  // unredeemed rather than exchanged and then second-guessed.
  if (!(await verifyOAuthState(params.get("state"), actor.userId))) {
    return finish({ error: "invalid_state" });
  }

  const code = params.get("code");
  if (!code) return finish({ error: "missing_code" });

  try {
    const result = await completeConnection({
      code,
      // The same value the consent URL was built with, from APP_URL. Google
      // compares it against the one the code was issued for, and neither comes
      // from this request.
      redirectUri: googleOAuthRedirectUri(),
      organizationId: actor.organizationId,
      userId: actor.userId,
    });

    await recordAudit(
      {
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        actorLabel: actor.name ?? actor.email,
        // Passed so IP and user-agent are captured: connecting an account that
        // can read Northstar's channel data is a security-relevant event.
        request,
      },
      {
        action: "youtube.connected",
        summary: `${actor.name ?? actor.email ?? "An admin"} ${
          result.reconnected ? "re-authorised" : "connected"
        } the Google account ${result.connection.googleAccountEmail ?? "(email unknown)"}`,
        targetType: "youtube_connection",
        targetId: result.connection.id,
        targetLabel: result.connection.channelTitle ?? result.connection.googleAccountEmail,
        // The granted scopes are the record of what this authorisation can
        // actually do, which is the whole point of auditing it. No token, and
        // none of the token fields exist on the DTO to be reached by accident.
        metadata: {
          scope: result.connection.scope,
          youtubeChannelId: result.connection.youtubeChannelId,
          trackedChannelCreated: result.linkedChannel?.created ?? false,
          reconnected: result.reconnected,
        },
      },
    );

    return finish({
      connected: "1",
      // Distinguishes "connected and we know which channel is yours" from
      // "connected, but this Google account owns no channel" — a real state
      // that would otherwise look like a silent failure.
      linked: result.linkedChannel ? "1" : "0",
    });
  } catch (error) {
    // 5xx-class problems still deserve a server log; `jsonError` is not on this
    // path to do it.
    if (!(error instanceof AppError) || error.status >= 500) {
      // Message only, never the error object. This is the one code path whose
      // failures can carry an encrypted token in a serialised Prisma argument
      // list, and a server log is a far easier thing to read than the database.
      console.error(
        "[youtube-oauth] connection failed:",
        error instanceof Error ? error.message : "unknown error",
      );
    }

    // The message is one of this app's own fixed strings — Google's
    // `error_description` is deliberately kept out of anything user-facing —
    // so it is safe to carry in the URL for the admin page to render.
    return finish({
      error: "failed",
      ...(error instanceof AppError ? { message: error.userMessage.slice(0, 200) } : {}),
    });
  }
}
