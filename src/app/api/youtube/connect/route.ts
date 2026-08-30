import { NextResponse } from "next/server";
import { jsonError } from "@/server/http";
import { requirePermission } from "@/server/auth/dal";
import { googleOAuthRedirectUri, isGoogleOAuthConfigured } from "@/server/auth/google-oauth-env";
import {
  adminYouTubeUrl,
  buildAuthorizationUrl,
  clientCredentialsAccepted,
  issueOAuthState,
} from "@/server/services/youtube-oauth-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/youtube/connect — start the Google consent flow.
 *
 * WHY NOT `handle()`
 * Every other route in this app returns JSON through the wrapper, which is the
 * point of the wrapper. This one answers with a 302 to accounts.google.com,
 * which `handle()` cannot express — it serialises whatever the handler returns.
 * So the try/catch is written out, and failures still go through `jsonError()`
 * so the error shape does not drift from the rest of the API.
 *
 * The browser reaches this by navigating, not by fetch, so there is no Origin
 * header to check and `handleMutation` would not apply either. Nothing is
 * written except a short-lived CSRF cookie.
 */
export async function GET() {
  try {
    const actor = await requirePermission("youtube.manage");

    if (!isGoogleOAuthConfigured()) {
      // Redirected rather than thrown: a stale tab or a bookmarked link should
      // land on the admin page that explains which variables are missing, not
      // on a JSON error document.
      return NextResponse.redirect(adminYouTubeUrl({ error: "not_configured" }), { status: 302 });
    }

    /*
     * Refuse the trip if Google will not accept these credentials anyway.
     *
     * Without this, a stale client secret costs the full five screens — the
     * unverified-app warning, the account chooser, a second warning, the
     * permission list, Continue — before failing on the exchange behind them.
     * Nothing about those screens hints at the problem, because Google builds
     * them from the client id alone and the id is usually fine. So the natural
     * conclusion is "I clicked something wrong", and the natural response is to
     * do the whole thing again.
     *
     * One request to Google here replaces that with a sentence on the page they
     * are already on. It fails open — see `clientCredentialsAccepted` — so an
     * outage cannot block a connection that would have worked.
     */
    if (!(await clientCredentialsAccepted())) {
      return NextResponse.redirect(adminYouTubeUrl({ error: "credentials_rejected" }), {
        status: 302,
      });
    }

    const { state, cookie } = issueOAuthState(actor.userId);

    const response = NextResponse.redirect(
      buildAuthorizationUrl({ state, redirectUri: googleOAuthRedirectUri() }),
      { status: 302 },
    );
    // Set on this exact response, so the cookie and the redirect that depends
    // on it cannot become separated.
    response.cookies.set(cookie);
    return response;
  } catch (error) {
    // Authentication and authorisation failures land here and stay failures: an
    // unauthorised caller should not be handed a friendly redirect into an
    // admin screen.
    return jsonError(error);
  }
}
