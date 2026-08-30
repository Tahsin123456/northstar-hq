import { NextResponse } from "next/server";
import { AppError, errors, serializeError, toAppError } from "./errors";
import { describeCauseForLog } from "./log-safety";
import type { ApiErrorDTO } from "@/lib/dto";

/**
 * Route-handler plumbing.
 *
 * One wrapper, used by every route, so error handling cannot drift between
 * endpoints. The contract it enforces:
 *   • successes return the payload as-is,
 *   • failures return `{ error: { code, message } }` with a sensible status,
 *   • the full error — stack, upstream body, cause chain — is logged server-side
 *     and *never* serialised to the client.
 */

/**
 * Every API response is explicitly uncacheable.
 *
 * `dynamic = "force-dynamic"` controls Next's *own* render cache; it does not
 * promise a `Cache-Control` header, and without one a browser is free to apply
 * heuristic caching to a 200 with no validators. For a product whose central
 * claim is "these are the current view counts", silently serving a stale
 * payload would be worse than an error — the number would look authoritative
 * and be wrong. Setting the header here means no route can forget.
 */
const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
} as const;

export function jsonOk<T>(data: T, init?: ResponseInit): NextResponse<T> {
  return NextResponse.json(data, {
    ...init,
    headers: { ...NO_STORE_HEADERS, ...(init?.headers ?? {}) },
  });
}

export function jsonError(error: unknown): NextResponse<ApiErrorDTO> {
  const appError = toAppError(error);

  // 5xx means we broke something; log the whole thing. 4xx is the caller's
  // problem and would only be log noise.
  if (appError.status >= 500) {
    // Through `describeCauseForLog` rather than raw: a Prisma validation error
    // carries the failing query's serialised arguments, and on the token-writing
    // paths those arguments are encrypted Google credentials. See log-safety.ts.
    console.error(`[api] ${appError.code}: ${appError.message}`, describeCauseForLog(appError.cause));
  } else {
    console.warn(`[api] ${appError.code}: ${appError.message}`);
  }

  return NextResponse.json(
    { error: serializeError(appError) },
    { status: appError.status, headers: NO_STORE_HEADERS },
  );
}

/** Wraps a handler so any throw becomes a well-formed error response. */
export function handle<T>(
  fn: () => Promise<T>,
): Promise<NextResponse<T> | NextResponse<ApiErrorDTO>> {
  return fn().then(
    (data) => jsonOk(data),
    (error: unknown) => jsonError(error),
  );
}

/** Reads and parses a JSON body, turning malformed input into a clean 400. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/**
 * Cross-site request forgery defence for state-changing requests.
 *
 * The session cookie is already `SameSite=Lax`, which is the primary control:
 * a browser will not attach it to a cross-site POST, so the classic CSRF shape
 * — a hidden form on evil.com submitting to our API — cannot authenticate.
 *
 * This adds a second, independent check because relying on one mechanism for
 * CSRF has a history of aging badly: `Lax` has documented gaps (some browsers
 * historically allowed top-level POSTs within a two-minute window of cookie
 * creation), and a future change to `SameSite=None` for an embedding use case
 * would silently remove the only protection. Comparing the Origin header to the
 * host we were actually reached on costs nothing and fails closed.
 *
 * `Origin` is set by the browser on every cross-origin request and on all POSTs;
 * it cannot be forged by page JavaScript. Requests with no Origin at all are
 * allowed through because non-browser callers (curl, a cron job, a health
 * check) legitimately omit it — and those carry no ambient cookie to abuse,
 * which is the thing CSRF depends on.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;

  const host = request.headers.get("host");
  if (!host) throw errors.forbidden("submit this request");

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw errors.forbidden("submit this request");
  }

  if (originHost !== host) {
    throw new AppError(
      "FORBIDDEN",
      "That request looked like it came from another site, so it was blocked.",
      { internalMessage: `CSRF: origin ${originHost} does not match host ${host}` },
    );
  }
}

/**
 * Wrapper for any handler that changes state.
 *
 * Every POST/PATCH/PUT/DELETE route uses this instead of `handle()`, so the
 * origin check cannot be forgotten on a new endpoint.
 */
export function handleMutation<T>(
  request: Request,
  fn: () => Promise<T>,
): Promise<NextResponse<T> | NextResponse<ApiErrorDTO>> {
  return handle(async () => {
    assertSameOrigin(request);
    return fn();
  });
}
