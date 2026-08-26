import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, readSessionCookie } from "@/server/auth/tokens";

/**
 * =========================================================================
 * THIS FILE IS NOT A SECURITY BOUNDARY
 * =========================================================================
 *
 * Read that again before adding anything to it. Proxy exists here for one
 * reason: so somebody who is not signed in lands on the login page instead of
 * an empty dashboard that then fires a dozen 401s. It is a redirect
 * convenience.
 *
 * The actual authorization boundary is `src/server/auth/dal.ts`, called by
 * every route handler. Three reasons this file cannot be that:
 *
 *   1. Its matcher deliberately excludes `/api`, which is where 100% of this
 *      application's data lives. Every page under src/app is a client
 *      component fetching through TanStack Query.
 *   2. It runs on every request including prefetches, so it must not query the
 *      database — meaning it cannot see `revokedAt`, `deactivatedAt`, or a
 *      role. It knows only that a cookie carries our signature.
 *   3. Next.js documents proxy as an optimistic check for exactly this reason
 *      and directs authorization to a data access layer instead.
 *
 * A valid signature here proves the cookie was issued by this deployment. It
 * does not prove the session still exists, has not been revoked, or belongs to
 * an active employee. Only the DAL can say that, and it re-checks on every
 * single request.
 *
 * NOTE FOR NEXT.JS VERSION: in Next 16 the `middleware.ts` convention was
 * renamed to `proxy.ts` with an exported `proxy` function. Creating a
 * `middleware.ts` alongside this file is a hard build error, and adding
 * `export const runtime` here is also a build error.
 */

/** Routes reachable without a session. Everything else requires one. */
const PUBLIC_PATHS = [
  "/login",
  "/setup",
  "/forgot-password",
  "/reset-password",
  "/invite",
] as const;

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  // Signature-only check. No database, no role, no expiry — see the note above.
  const hasSignedCookie =
    readSessionCookie(request.cookies.get(SESSION_COOKIE_NAME)?.value) !== null;

  if (isPublicPath(pathname)) {
    // Deliberately NOT redirecting a cookie-bearing visitor away from /login or
    // /setup, even though it would be a nicer greeting.
    //
    // Doing that caused an infinite redirect loop, and the reason is worth
    // keeping: a signature proves the cookie was issued here, not that the
    // session behind it still exists. Hold a well-formed cookie whose session
    // was revoked, expired, or belongs to a deactivated account, and the proxy
    // would send you to "/", the authenticated layout would find no valid
    // session and send you to /login, and the proxy would send you back — with
    // no way to reach the page that would have fixed it.
    //
    // The pages themselves already do the honest version of this check:
    // /login and /setup call getActor(), which hits the database, and redirect
    // to "/" only when there is genuinely somebody signed in.
    return NextResponse.next();
  }

  if (!hasSignedCookie) {
    const loginUrl = new URL("/login", request.nextUrl);
    // Preserve where they were going so signing in returns them to it. Only
    // the path and query are carried, never an absolute URL, so this cannot be
    // turned into an open redirect to another host.
    const intended = `${pathname}${search}`;
    if (intended !== "/" && !intended.startsWith("//")) {
      loginUrl.searchParams.set("next", intended);
    }
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Everything except API routes, Next's own assets, and static files.
   *
   * `/api` is excluded on purpose: those routes return JSON to a fetch call, so
   * a 302 to an HTML login page would surface as a confusing parse error rather
   * than a clean 401. They authenticate themselves through the DAL instead.
   */
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf)$).*)",
  ],
};
