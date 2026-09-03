import "server-only";

import { randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/server/db";
import { AppError, errors, toAppError } from "@/server/errors";
import { authEnv, resolveAppUrl } from "@/server/auth/auth-env";
import { decryptSecret, encryptSecret } from "@/server/auth/crypto";
import { googleOAuthRedirectUri, requireGoogleOAuthConfig } from "@/server/auth/google-oauth-env";
import type {
  ChannelDataSource,
  OwnChannelDTO,
  YouTubeConnectionChannelDTO,
  YouTubeConnectionDTO,
} from "@/lib/dto";
import { youtubeChannelUrl } from "@/lib/format";
import { recordChannelReading, upsertChannel, type ChannelCredential } from "./channel-sync";
import { getCurrentOrgId } from "./user-service";
import type { RawChannelItem, RawListResponse, RawThumbnails, YouTubeChannel } from "./youtube/types";

/**
 * Google / YouTube OAuth — the Authorization Code flow, written out.
 *
 * Plain `fetch` against Google's four endpoints rather than the `googleapis`
 * package, matching how the rest of this codebase talks to YouTube (see
 * `services/youtube/client.ts`). The flow is four HTTP calls; pulling in a
 * client library that carries every Google product to save them would be a poor
 * trade in a server bundle, and it would hide exactly the parameters —
 * `access_type`, `prompt`, the scope list — that decide how safe this is.
 *
 * WHAT THE CONNECTION IS FOR
 * Reading Northstar's *own* channel and video data with the channel owner's
 * authorisation, so "our channels" reflects a real grant rather than somebody
 * ticking a box. It is never used to publish, edit or delete — see SCOPES.
 *
 * WHAT IS STORED
 * Access and refresh tokens, encrypted with AES-256-GCM by `auth/crypto.ts`.
 * They are decrypted at the moment of use and never cross a DTO, a response, a
 * log line or an audit metadata field.
 */

/**
 * The scopes requested at consent, and deliberately nothing beyond them.
 *
 * `youtube.readonly` is the entire job: list the authorising account's channels
 * and read their public video data. `youtube.force-ssl`, `youtube.upload` and
 * every other write scope are omitted on purpose. A refresh token that leaks
 * out of this database is bad; one that can delete Northstar's back catalogue
 * or publish to its channels is unrecoverable. The blast radius of a
 * compromised token is decided here, at consent, and nowhere else — no amount
 * of care further down the stack can narrow a grant that was already given.
 *
 * The two `yt-analytics` scopes were added when automatic revenue import was
 * built, and they are read-only in exactly the same sense: they permit
 * *reports* to be run against the YouTube Analytics API and nothing else. There
 * is no write counterpart to either of them to accidentally ask for.
 *
 * They are separate scopes because Google separates the data. Revenue is not in
 * the YouTube Data API this integration started with at all — no amount of
 * `youtube.readonly` returns a figure — and the monetary metrics
 * (`estimatedRevenue` and friends) sit behind `yt-analytics-monetary.readonly`
 * specifically, apart from views and watch time under `yt-analytics.readonly`.
 * Asking for the monetary scope without the non-monetary one would leave the
 * report endpoint unusable for anything but money.
 *
 * `openid email` identifies which Google account granted access, so the admin
 * screen can show whose authorisation a sync depends on.
 */
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
  "openid",
  "email",
] as const;

/** The scope the integration cannot function without, checked after consent. */
const REQUIRED_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

/**
 * The scope revenue cannot be read without.
 *
 * Checked against what Google ACTUALLY returned rather than against what was
 * asked for. Google's consent screen lets a person untick individual
 * permissions, and every connection made before revenue existed was granted
 * without this one — so assuming the list above was accepted whole would turn
 * two entirely different situations ("they said no" and "they were never
 * asked") into the same nightly 403.
 */
export const REVENUE_SCOPE = "https://www.googleapis.com/auth/yt-analytics-monetary.readonly";

/** True only when Google's own scope string contains the monetary scope. */
export function grantsRevenueScope(scope: string): boolean {
  return scope.split(" ").filter(Boolean).includes(REVENUE_SCOPE);
}

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * How close to expiry an access token is treated as already expired.
 *
 * Two minutes covers clock skew between this host and Google plus the time a
 * sync takes to get from "I have a token" to the API call that uses it. Without
 * the margin a token fetched at T-5s expires mid-run and the failure looks like
 * a permissions problem rather than a timing one.
 */
const EXPIRY_SKEW_MS = 2 * 60 * 1000;

/**
 * Where both ends of the flow send the browser.
 *
 * Absolute and built from `APP_URL`, for the same reason as the redirect URI:
 * a redirect target assembled from the request's own Host is a redirect target
 * an attacker can choose.
 */
export function adminYouTubeUrl(query: Record<string, string> = {}): string {
  const url = new URL("/admin/youtube", resolveAppUrl(null));
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

// ---------------------------------------------------------------------------
// CSRF: the `state` parameter
// ---------------------------------------------------------------------------

/**
 * The state cookie. `__Host-` in production pins it to this exact origin — no
 * `Domain` attribute, Secure and Path=/ required — so a subdomain an attacker
 * manages to stand up cannot plant one. The prefix is dropped in development
 * because it also requires HTTPS and http://localhost would silently drop the
 * cookie. Same reasoning as the session cookie in `auth/tokens.ts`.
 */
const STATE_COOKIE_NAME = authEnv.isProduction
  ? "__Host-northstar_yt_oauth_state"
  : "northstar_yt_oauth_state";

/** Long enough to read a consent screen, short enough not to sit around. */
const STATE_TTL_SECONDS = 10 * 60;

/**
 * A cookie the caller attaches to its own response.
 *
 * Both ends of this flow answer with a 302 they construct themselves, so the
 * cookie is returned as a value rather than written through `cookies()`. That
 * keeps "which response carries this Set-Cookie" explicit instead of relying on
 * the framework to merge a request-scoped mutation into a redirect.
 */
export interface OAuthStateCookie {
  readonly name: string;
  readonly value: string;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: "lax";
  readonly maxAge: number;
  readonly path: string;
}

function stateCookie(value: string, maxAge: number): OAuthStateCookie {
  return {
    name: STATE_COOKIE_NAME,
    value,
    httpOnly: true,
    secure: authEnv.isProduction,
    // Must be `lax`, not `strict`: the callback arrives as a top-level
    // navigation from accounts.google.com, and `strict` would withhold the
    // cookie on exactly the request that needs it, breaking every connection
    // attempt. `lax` still withholds it from cross-site POSTs, which is the
    // shape CSRF actually takes.
    sameSite: "lax",
    maxAge,
    // Required by the `__Host-` prefix, and required again on the clearing
    // cookie or the browser will refuse to match and the value will linger.
    path: "/",
  };
}

/**
 * Mints the `state` value and the short-lived httpOnly cookie that remembers it.
 *
 * WHY THIS IS NOT OPTIONAL
 * Without it, an attacker starts the flow with *their own* Google account,
 * stops before the callback, and lures a Northstar admin into loading the
 * resulting callback URL. The admin's session cookie rides along on the
 * top-level navigation, and the app faithfully links the ATTACKER'S YouTube
 * account to Northstar's workspace — after which everything the app reports as
 * "our channel" is a channel the attacker controls, and any future write scope
 * would be pointed at their property. The defence is that the code must arrive
 * together with a secret only the browser that *started* the flow holds.
 *
 * The value is also bound to the user id, so a state minted for one admin
 * cannot be completed under another's session: the connection is attributed to
 * whoever finishes it, and that attribution should not be transferable.
 */
export function issueOAuthState(userId: string): { state: string; cookie: OAuthStateCookie } {
  const nonce = randomBytes(32).toString("base64url");
  return { state: nonce, cookie: stateCookie(`${nonce}.${userId}`, STATE_TTL_SECONDS) };
}

/**
 * The cookie that erases the state.
 *
 * The callback attaches this on every path it can take — success, mismatch,
 * user cancellation, upstream failure — because a state that has been presented
 * once, rightly or wrongly, must never be accepted a second time.
 */
export function expiredOAuthStateCookie(): OAuthStateCookie {
  return stateCookie("", 0);
}

/** Validates the `state` Google echoed back against the cookie we set. */
export async function verifyOAuthState(provided: string | null, userId: string): Promise<boolean> {
  const cookieStore = await cookies();
  const stored = cookieStore.get(STATE_COOKIE_NAME)?.value ?? null;

  if (!stored || !provided) return false;

  const separator = stored.lastIndexOf(".");
  if (separator <= 0 || separator === stored.length - 1) return false;

  const expectedNonce = stored.slice(0, separator);
  const boundUserId = stored.slice(separator + 1);
  if (boundUserId !== userId) return false;

  // Constant-time so the nonce cannot be recovered a byte at a time by timing
  // repeated callbacks.
  const expected = Buffer.from(expectedNonce, "utf8");
  const actual = Buffer.from(provided, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// Step 1 — the consent screen
// ---------------------------------------------------------------------------

export function buildAuthorizationUrl(options: { state: string; redirectUri: string }): string {
  const { clientId } = requireGoogleOAuthConfig();

  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", options.state);

  // Offline access is what mints a refresh token. Without it the grant dies
  // with the first access token an hour later and every background sync stops
  // until somebody notices and reconnects by hand.
  url.searchParams.set("access_type", "offline");

  // Google returns a refresh token only on the *first* consent for a given
  // client/account pair. Reconnecting after a disconnect would otherwise yield
  // an access token and no refresh token — a connection that works for an hour
  // and then silently dies. Forcing the consent screen is the documented way to
  // get one reliably, and the small friction is worth a connection that lasts.
  url.searchParams.set("prompt", "consent");

  // Preserves scopes this account has already granted the client, so
  // reconnecting never quietly narrows an existing grant.
  url.searchParams.set("include_granted_scopes", "true");

  return url.toString();
}

// ---------------------------------------------------------------------------
// Step 2 — code → tokens
// ---------------------------------------------------------------------------

export interface GoogleTokenSet {
  readonly accessToken: string;
  /** Absent on a refresh unless Google chose to rotate it. */
  readonly refreshToken: string | null;
  readonly expiresAt: Date;
  /** Space-separated scopes actually granted, which may be fewer than asked. */
  readonly scope: string;
  readonly idToken: string | null;
}

interface GoogleTokenBody {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
  readonly id_token?: string;
  readonly error?: string;
  readonly error_description?: string;
}

interface TokenEndpointResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: GoogleTokenBody;
}

/**
 * One place where a token-endpoint request happens.
 *
 * Nothing from the response body is ever logged: on success it is a pair of
 * live credentials, and on failure `error_description` can echo parts of the
 * request back. Callers get the parsed `error` code and decide what to say.
 */
async function postToTokenEndpoint(form: Record<string, string>): Promise<TokenEndpointResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
      signal: controller.signal,
      cache: "no-store",
    });

    let body: GoogleTokenBody = {};
    try {
      body = (await response.json()) as GoogleTokenBody;
    } catch {
      // A non-JSON body from Google is an outage, not a protocol we should try
      // to interpret; `ok` alone carries the outcome.
    }

    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new AppError("NETWORK_ERROR", "Google did not respond in time. Try connecting again.", {
        cause: error,
      });
    }
    throw errors.network(error);
  } finally {
    clearTimeout(timeout);
  }
}

function toTokenSet(body: GoogleTokenBody): GoogleTokenSet {
  const accessToken = body.access_token;
  if (!accessToken) {
    throw errors.upstream("Google returned a token response with no access token.");
  }

  // Google always sends `expires_in`; the fallback exists so a missing value
  // produces a token treated as short-lived rather than one treated as eternal.
  const expiresInSeconds = typeof body.expires_in === "number" ? body.expires_in : 3600;

  return {
    accessToken,
    refreshToken: body.refresh_token ?? null,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    scope: body.scope ?? "",
    idToken: body.id_token ?? null,
  };
}

/**
 * Asks Google whether this deployment's client id and secret are a valid pair,
 * BEFORE sending anybody through the consent screens.
 *
 * WHY THIS IS WORTH A ROUND TRIP. A rejected client is indistinguishable from a
 * working one until the very last step: Google renders consent from the client
 * id alone, so a stale secret produces an unverified-app warning, an account
 * chooser, a second warning, a permission list, and a Continue — and only then
 * fails. Every single retry costs all of that. Checking first turns a five-screen
 * dead end into one sentence on the page they are already looking at.
 *
 * HOW. It sends a deliberately invalid authorization code. Google validates the
 * CLIENT before the code, so the error names which half is wrong:
 *   `invalid_client` — the pair is bad, and consent cannot possibly succeed.
 *   `invalid_grant`  — the pair is fine; only the fake code was refused.
 * A fake code can grant nothing, so this consumes and changes nothing.
 *
 * FAILS OPEN, deliberately. Only an explicit `invalid_client` reports false.
 * A timeout, an outage or an unrecognised error returns true and lets the real
 * flow proceed: blocking a working connection because a probe could not reach
 * Google would be a worse failure than the one this prevents, and the real
 * exchange is still the authority.
 */
export async function clientCredentialsAccepted(): Promise<boolean> {
  const { clientId, clientSecret } = requireGoogleOAuthConfig();

  try {
    const result = await postToTokenEndpoint({
      code: "preflight-probe-not-a-real-code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: googleOAuthRedirectUri(),
      grant_type: "authorization_code",
    });

    return result.body.error !== "invalid_client";
  } catch {
    return true;
  }
}

/**
 * What to tell an administrator when Google refuses the code exchange.
 *
 * Exported for tests: the mapping is the whole value of this function, and a
 * wrong branch here is invisible until somebody is already stuck.
 */
export function explainTokenExchangeFailure(code: string | null): string {
  switch (code) {
    /*
     * Client authentication failed — the id and secret are not a valid pair.
     *
     * Worth being emphatic that retrying cannot help, because everything the
     * person just did looked like it worked: Google renders the consent screen
     * from the client id alone, so a valid id with a stale secret produces a
     * flawless approval flow and then fails on the exchange behind it. The
     * natural reading of that is "I clicked something wrong", and the natural
     * response is to do it all again.
     */
    case "invalid_client":
      return (
        "Google rejected this deployment's credentials, so connecting again will not help. " +
        "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be a matching pair from the same " +
        "OAuth client — a secret that was replaced in the Google console will fail here " +
        "while the consent screen still works. Add a new secret to the OAuth client, update " +
        "GOOGLE_CLIENT_SECRET, and redeploy."
      );

    /*
     * The redirect URI sent with the exchange did not match the one the code was
     * issued for. Both come from `googleOAuthRedirectUri()`, so they cannot
     * disagree with each other — which means the registered URI is what differs,
     * and the www/apex distinction is how that almost always happens.
     */
    case "redirect_uri_mismatch":
      return (
        `Google does not recognise this deployment's callback address. Register exactly ` +
        `"${googleOAuthRedirectUri()}" as an authorised redirect URI on the OAuth client. ` +
        "It is matched character for character, so www and non-www count as different addresses."
      );

    /*
     * The one case where starting again IS the fix: the code is single-use and
     * short-lived, so a refresh, a back button or a slow approval spends it.
     */
    case "invalid_grant":
      return (
        "That sign-in has already been used or has expired. Start the connection again, and " +
        "complete Google's screens without reloading or going back."
      );

    default:
      return "Google rejected the sign-in. Start the connection again.";
  }
}

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
): Promise<GoogleTokenSet> {
  const { clientId, clientSecret } = requireGoogleOAuthConfig();

  const result = await postToTokenEndpoint({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    // Google re-checks this against the URI the code was issued for. It is the
    // same constant used to build the consent URL, never a request-derived
    // value — see `googleOAuthRedirectUri`.
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  if (!result.ok) {
    const code = result.body.error ?? null;
    // Google's own `error_description` is still withheld — it can echo request
    // material back — but the error CODE is a fixed enum from Google's spec, and
    // three of its values name a specific misconfiguration with a specific fix.
    //
    // Collapsing them all into "start the connection again" was actively
    // harmful: `invalid_client` means the deployment's credentials are wrong, so
    // starting again produces the identical failure forever, and the only
    // remaining clue sat in a server log the person hitting the error cannot
    // read. That is a loop with no exit from inside the product.
    //
    // Naming an environment variable is appropriate here in a way it would not
    // be on a public screen: connecting an account requires `youtube.manage`,
    // so the only person who can reach this message is the one who can fix it.
    throw new AppError("UPSTREAM_ERROR", explainTokenExchangeFailure(code), {
      internalMessage: `token exchange failed: ${code ?? `HTTP ${result.status}`}`,
    });
  }

  return toTokenSet(result.body);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

interface GoogleIdentity {
  readonly email: string | null;
  readonly googleUserId: string | null;
}

/**
 * Reads `email` and `sub` out of the ID token without verifying its signature.
 *
 * Safe *only* because of where this token came from: it arrived in the body of
 * our own TLS request to Google's token endpoint, authenticated with the client
 * secret. It was never handled by the browser, so there is no attacker in the
 * path to forge it — which is precisely the case Google's own documentation
 * exempts from validation. If an ID token ever reaches this app by any other
 * route, it must be verified against Google's JWKS before a single claim is
 * trusted.
 */
function decodeIdentity(idToken: string | null): GoogleIdentity {
  const empty: GoogleIdentity = { email: null, googleUserId: null };
  if (!idToken) return empty;

  const payload = idToken.split(".")[1];
  if (!payload) return empty;

  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!decoded || typeof decoded !== "object") return empty;

    const claims = decoded as { email?: unknown; sub?: unknown };
    return {
      email: typeof claims.email === "string" ? claims.email : null,
      googleUserId: typeof claims.sub === "string" ? claims.sub : null,
    };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Token lifecycle
// ---------------------------------------------------------------------------

/**
 * A connection that cannot mint tokens any more is a configuration problem an
 * admin has to fix, not a server fault — 503 with a setup message, the same
 * shape `errors.missingApiKey()` uses, so the UI can prompt instead of showing
 * a failure state.
 */
function needsReauthError(): AppError {
  return new AppError(
    "MISSING_API_KEY",
    "This YouTube connection needs to be reconnected before it can be used again. " +
      "An admin can reconnect the Google account from Admin → YouTube.",
  );
}

/**
 * Google says the grant is gone: record it AND destroy the tokens.
 *
 * The stored tokens are provably useless at this point. Clearing them shrinks
 * the window in which a database leak yields a live credential, and removes any
 * chance a later code path retries with them.
 *
 * Reserved for exactly that case. See `markCredentialsUnreadable` for the one
 * that used to share this function and must not.
 */
async function markGrantRevoked(connectionId: string, lastError: string): Promise<void> {
  await prisma.youTubeConnection.update({
    where: { id: connectionId },
    data: {
      status: "needs_reauth",
      lastError: lastError.slice(0, 500),
      accessTokenEnc: null,
      refreshTokenEnc: null,
      accessTokenExpiresAt: null,
    },
    // Nothing reads the result, and the default would materialise the very
    // ciphertext columns this file is careful never to hold.
    select: { id: true },
  });
}

/**
 * We cannot READ the stored tokens — and the ciphertext is deliberately kept.
 *
 * WHY THIS IS NOT `markGrantRevoked`.
 * These two failures used to be the same function, and treating them alike did
 * real damage in the one case that matters. "Google revoked the grant" means the
 * ciphertext is worthless, so destroying it is free. "The ciphertext will not
 * decrypt" means something happened to APP_ENCRYPTION_KEY — it was rotated, or
 * the environment was restored from a different backup — and the tokens
 * themselves may be perfectly good.
 *
 * Deleting them there had two consequences, both bad. Restoring the correct key
 * could no longer recover the connection, which flatly contradicted the message
 * this very function writes telling the admin to do exactly that. And the grant
 * is still LIVE at Google with the only credential that could revoke it now
 * gone — the outcome `disconnect`'s ordering exists to prevent.
 *
 * So the columns are left alone. A connection in this state cannot be used
 * (nothing can decrypt it), it is visibly `needs_reauth`, and reconnecting still
 * fixes it — but restoring the key fixes it too, and `disconnect` can still hand
 * Google back its token.
 *
 * It is also the precondition for ever rotating APP_ENCRYPTION_KEY safely.
 */
async function markCredentialsUnreadable(
  connectionId: string,
  lastError: string,
): Promise<void> {
  await prisma.youTubeConnection.update({
    where: { id: connectionId },
    data: { status: "needs_reauth", lastError: lastError.slice(0, 500) },
    select: { id: true },
  });
}

/**
 * Mints a fresh access token from the stored refresh token.
 *
 * Returns `null` — having already recorded `needs_reauth` and a readable
 * `lastError` — when Google says the grant is gone. That case is permanent
 * until a human reconnects, so throwing would mean every scheduled sync raises
 * the same error forever; recording it once and reporting it in the admin UI is
 * the useful behaviour. Genuine faults (network, 5xx) still throw, because
 * those are worth retrying.
 */
export async function refreshAccessToken(connectionId: string): Promise<string | null> {
  const connection = await prisma.youTubeConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, refreshTokenEnc: true },
  });
  if (!connection) throw errors.notFound("YouTube connection");

  const refreshToken = decryptSecret(connection.refreshTokenEnc);
  if (!refreshToken) {
    // Either the token was never stored or APP_ENCRYPTION_KEY has changed. The
    // message covers both because nothing here can tell them apart — but the
    // ciphertext is KEPT either way, so restoring the right key recovers the
    // connection instead of leaving a live grant at Google with no way to
    // revoke it. See `markCredentialsUnreadable`.
    await markCredentialsUnreadable(
      connection.id,
      "The stored Google credentials could not be read. If APP_ENCRYPTION_KEY was changed or " +
        "restored from a different backup, restore the original key or reconnect the account.",
    );
    return null;
  }

  const { clientId, clientSecret } = requireGoogleOAuthConfig();
  const result = await postToTokenEndpoint({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  if (!result.ok) {
    // `invalid_grant` is Google's answer for "this grant no longer exists":
    // revoked in the account's security settings, the password changed, the
    // account was suspended, or six months went by without use.
    if (result.body.error === "invalid_grant") {
      await markGrantRevoked(
        connection.id,
        "Google has revoked this authorisation. It usually means the grant was removed from the " +
          "Google account, the password changed, or the connection went unused for six months. " +
          "Reconnect the account to restore syncing.",
      );
      return null;
    }

    throw new AppError(
      "UPSTREAM_ERROR",
      "Google could not refresh this connection. Try again shortly.",
      { internalMessage: `token refresh failed: ${result.body.error ?? `HTTP ${result.status}`}` },
    );
  }

  const tokens = toTokenSet(result.body);

  await prisma.youTubeConnection.update({
    where: { id: connection.id },
    data: {
      accessTokenEnc: encryptSecret(tokens.accessToken),
      accessTokenExpiresAt: tokens.expiresAt,
      // A refresh response usually omits the refresh token, and an omission
      // means "keep using the one you have" — writing `null` here would destroy
      // a working grant on the first successful refresh.
      ...(tokens.refreshToken ? { refreshTokenEnc: encryptSecret(tokens.refreshToken) } : {}),
      // A refresh response restates the scopes the grant still carries, which
      // makes this the one place that notices a grant NARROWED after the fact —
      // somebody removing the monetary permission in their Google account
      // settings. Recording it here means revenue stops with "reconnect to
      // enable revenue" on the admin screen rather than with a 403 a night
      // later that nobody can explain.
      ...(tokens.scope
        ? { scope: tokens.scope, revenueScopeGranted: grantsRevenueScope(tokens.scope) }
        : {}),
      status: "connected",
      lastError: null,
    },
    select: { id: true },
  });

  return tokens.accessToken;
}

/**
 * A token that is live now, refreshing first if the stored one is close to
 * expiring.
 *
 * Deliberately takes no session: background syncs call it. Every caller reaches
 * it through a connection id that was itself resolved from an org-scoped query,
 * which is where the tenancy check belongs — repeating it here would require
 * threading an organization into the scheduled jobs that have no user at all.
 *
 * Two concurrent callers can both decide to refresh. That is harmless: Google
 * issues independent access tokens for the same refresh token, the last write
 * wins, and both callers hold something valid. A lock would cost more than the
 * duplicate request it prevents.
 */
export async function getValidAccessToken(connectionId: string): Promise<string> {
  const connection = await prisma.youTubeConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, status: true, accessTokenEnc: true, accessTokenExpiresAt: true },
  });
  if (!connection) throw errors.notFound("YouTube connection");

  // Short-circuit rather than asking Google again: a connection already known
  // to need re-authorisation will not start working because something retried.
  if (connection.status === "needs_reauth") throw needsReauthError();

  const stored = decryptSecret(connection.accessTokenEnc);
  const expiresAt = connection.accessTokenExpiresAt?.getTime() ?? 0;
  if (stored && expiresAt - Date.now() > EXPIRY_SKEW_MS) return stored;

  const refreshed = await refreshAccessToken(connection.id);
  if (!refreshed) throw needsReauthError();
  return refreshed;
}

// ---------------------------------------------------------------------------
// Reading the authorising account's own channel
// ---------------------------------------------------------------------------

function pickThumbnail(thumbnails: RawThumbnails | undefined): string | null {
  if (!thumbnails) return null;
  return (
    thumbnails.maxres?.url ??
    thumbnails.standard?.url ??
    thumbnails.high?.url ??
    thumbnails.medium?.url ??
    thumbnails.default?.url ??
    null
  );
}

function parseCount(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalises a channel item into the shape the rest of the app consumes.
 *
 * A near-twin of the private normaliser in `youtube/client.ts`, and separate on
 * purpose: that client authenticates every call with the shared API key and
 * charges a quota ledger, neither of which applies to an OAuth `mine=true`
 * request made on behalf of one account. Exporting its internals to share ten
 * lines would couple the key-based read path to the delegated one.
 */
function normalizeChannel(item: RawChannelItem): YouTubeChannel | null {
  const channelId = item.id;
  if (!channelId) return null;

  const customUrl = item.snippet?.customUrl ?? null;
  const handle = customUrl ? (customUrl.startsWith("@") ? customUrl : `@${customUrl}`) : null;

  return {
    channelId,
    title: item.snippet?.title?.trim() || "Untitled channel",
    description: item.snippet?.description ?? "",
    handle,
    customUrl,
    avatarUrl: pickThumbnail(item.snippet?.thumbnails),
    bannerUrl: item.brandingSettings?.image?.bannerExternalUrl ?? null,
    country: item.snippet?.country ?? null,
    subscriberCount: parseCount(item.statistics?.subscriberCount),
    hiddenSubscriberCount: item.statistics?.hiddenSubscriberCount === true,
    viewCount: parseCount(item.statistics?.viewCount),
    videoCount: parseCount(item.statistics?.videoCount),
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads ?? null,
    publishedAt: item.snippet?.publishedAt ? new Date(item.snippet.publishedAt) : null,
  };
}

/**
 * EVERY channel the authorising account owns, via `channels?mine=true`.
 *
 * Authorised with the bearer token, so it needs no API key and is charged to the
 * OAuth client's own project rather than to the shared key every competitor
 * refresh is also spending.
 *
 * WHY THE LIST AND NOT `items[0]`
 * This used to take the first item and discard the rest, which is right for the
 * overwhelmingly common case — Google's consent screen makes the person choose
 * ONE channel, and the token is scoped to it — and silently wrong for the case
 * that matters most to a studio: an account that comes back with more than one.
 * Reading the whole list costs nothing extra (it is the same single response)
 * and it is what lets the owner add their channels without pasting an id, which
 * they asked for by name. Callers that genuinely want one channel — the callback
 * keying a connection row — take the first from this list and say so.
 *
 * An empty array is a real state, not an error: a Workspace account that was
 * only ever a viewer owns no channel, and that is not worth failing a connection
 * over.
 */
async function fetchOwnChannels(accessToken: string): Promise<YouTubeChannel[]> {
  const url = new URL(`${YOUTUBE_API_BASE}/channels`);
  url.searchParams.set("part", "snippet,statistics,contentDetails,brandingSettings");
  url.searchParams.set("mine", "true");
  // The API's own ceiling. `mine=true` realistically returns one channel, but
  // asking for one would make "the account owns several" indistinguishable from
  // "the account owns one" in the response we get back.
  url.searchParams.set("maxResults", "50");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      /*
       * Google answers this one endpoint with several unrelated problems, and
       * two of them are permanent — so a single "try connecting again" is wrong
       * advice for exactly the cases where the admin most needs right advice.
       * Retrying costs the whole consent flow and cannot possibly help.
       *
       * 401 is the one that matters most here. A Google account that has never
       * created a channel does NOT come back as an empty `items` array, which is
       * what the code below is written for — YouTube refuses the request
       * outright. Reported as a failure, that reads as "the app is broken" when
       * the truth is "you signed in with the wrong Google account", which is the
       * single easiest mistake to make when a channel lives on a Brand Account
       * and Google's chooser offers the personal account first.
       *
       * 403 is almost always the YouTube Data API not being enabled on the Cloud
       * project that issued the OAuth client — a separate console step from
       * creating the client, and easy to miss when a different project holds the
       * API key the competitor pipeline uses.
       */
      const guidance =
        response.status === 401
          ? "This Google account does not have a YouTube channel, so there is nothing to connect. " +
            "If your channel is on a Brand Account, start again and choose the CHANNEL at Google's " +
            "chooser rather than the personal Google account it sits under."
          : response.status === 403
            ? "YouTube refused to list this account's channels, so connecting again will not help. " +
              "This usually means the YouTube Data API v3 is not enabled on the Google Cloud project " +
              "that issued this app's OAuth client — enabling it is a separate step from creating " +
              "the client. It can also mean the project's daily quota is exhausted."
            : "YouTube would not say which channels this Google account owns. Try connecting again.";

      throw new AppError("UPSTREAM_ERROR", guidance, {
        internalMessage: `channels?mine=true returned HTTP ${response.status}`,
      });
    }

    const data = (await response.json()) as RawListResponse<RawChannelItem>;
    const channels: YouTubeChannel[] = [];
    for (const item of data.items ?? []) {
      const channel = normalizeChannel(item);
      if (channel) channels.push(channel);
    }
    return channels;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new AppError("NETWORK_ERROR", "YouTube did not respond in time. Try again.", {
        cause: error,
      });
    }
    throw errors.network(error);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The one channel a connection ROW is keyed on.
 *
 * `channels?mine=true` returns the channels the token can act as, and the
 * connection row holds exactly one `youtubeChannelId` because that is what the
 * `(organization, channel)` unique is for. Taking the first is therefore not an
 * arbitrary choice — it is the same channel Google scoped the consent to, and
 * the one every subsequent Analytics call names explicitly.
 */
async function fetchOwnChannel(accessToken: string): Promise<YouTubeChannel | null> {
  return (await fetchOwnChannels(accessToken))[0] ?? null;
}

// ---------------------------------------------------------------------------
// Linking the connection to the tracker
// ---------------------------------------------------------------------------

export interface LinkedChannel {
  readonly trackedChannelId: string;
  readonly youtubeChannelId: string;
  readonly title: string;
  /** False when the channel was already in the tracker and was re-scoped. */
  readonly created: boolean;
}

/**
 * Marks the connected account's own channel as one of Northstar's.
 *
 * This is what makes "our channels" mean something. Before OAuth, ownership was
 * a manual toggle anybody could set on any channel; a channel marked "own" here
 * is one Google has confirmed the connected account actually operates, which is
 * the difference between a label and a fact.
 *
 * Returns null when the account owns no channel — the connection is still
 * valid and still worth keeping, it simply has nothing to link.
 *
 * `channel` may be supplied by a caller that has just fetched it (the callback
 * has), so the common path does not make the same request twice.
 */
export async function linkConnectionToTrackedChannel(
  connectionId: string,
  channel?: YouTubeChannel | null,
): Promise<LinkedChannel | null> {
  const connection = await prisma.youTubeConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, organizationId: true, connectedById: true },
  });
  if (!connection) throw errors.notFound("YouTube connection");

  // `undefined` means nobody has looked yet; an explicit `null` means the
  // caller already asked and this account owns no channel. Collapsing the two
  // would make the callback repeat a request it has just made.
  const resolved =
    channel === undefined
      ? await fetchOwnChannel(await getValidAccessToken(connection.id))
      : channel;
  if (!resolved) return null;

  // The globally deduplicated Channel row, shared with competitor tracking —
  // the same channel must not exist twice because one route to it was OAuth.
  const channelRow = await upsertChannel(resolved);
  // And its first channel-level reading, so the views-gained series starts
  // the moment the channel is known rather than at its first sweep.
  await recordChannelReading(channelRow, new Date());

  /*
   * READABILITY BEFORE OWNERSHIP. These two writes come first, and the order
   * is the point — `trackOwnChannel` documents the same ordering as
   * load-bearing, and this path had it backwards.
   *
   * `ownershipType: "own"` is a promise that this channel's data comes from the
   * authorised connection rather than the shared public key, and the sync
   * enforces it: an own channel with no credential behind it is refused, not
   * quietly downgraded. So flipping the flag before the grant can actually read
   * the channel opens a window where a failure — a pool timeout, the function
   * duration expiring — leaves a channel marked as the studio's own that
   * nothing is able to sync, and no screen explains why.
   *
   * Reversed, the same interruption leaves a channel that is simply not marked
   * own yet. That is a state the product already handles, and the next connect
   * completes it.
   */
  await prisma.youTubeConnection.update({
    where: { id: connection.id },
    data: { youtubeChannelId: resolved.channelId, channelTitle: resolved.title },
    select: { id: true },
  });

  // The coverage table is what the credential lookup actually reads. The
  // connection column above keys the row; this is what makes the channel
  // READABLE through the grant.
  await recordCoveredChannel({
    organizationId: connection.organizationId,
    connectionId: connection.id,
    youtubeChannelId: resolved.channelId,
    title: resolved.title,
  });

  const existing = await prisma.trackedChannel.findUnique({
    where: {
      organizationId_channelId: {
        organizationId: connection.organizationId,
        channelId: channelRow.id,
      },
    },
    select: { id: true },
  });

  const tracking = existing
    ? await prisma.trackedChannel.update({
        where: { id: existing.id },
        // Reactivated as well as re-scoped: connecting the account that owns a
        // previously removed channel is an unambiguous statement that it
        // belongs in the tracker.
        data: { ownershipType: "own", isActive: true, removedAt: null },
        select: { id: true },
      })
    : await prisma.trackedChannel.create({
        data: {
          organizationId: connection.organizationId,
          // Attribution only, as everywhere else: the row belongs to the
          // organization, not to whoever connected the account.
          createdById: connection.connectedById,
          channelId: channelRow.id,
          ownershipType: "own",
        },
        select: { id: true },
      });

  // Deliberately no video sync here. This runs inside a browser redirect that
  // has to complete promptly, and a full history walk takes tens of seconds on
  // a large channel. The scheduled refresh picks the new channel up on its next
  // pass, and an admin who cannot wait can refresh it from the channel page.

  return {
    trackedChannelId: tracking.id,
    youtubeChannelId: resolved.channelId,
    title: resolved.title,
    created: existing === null,
  };
}

// ---------------------------------------------------------------------------
// Completing a connection
// ---------------------------------------------------------------------------

export interface CompleteConnectionResult {
  readonly connection: YouTubeConnectionDTO;
  readonly linkedChannel: LinkedChannel | null;
  /**
   * True when this replaced an existing grant rather than creating one.
   *
   * Reported so the audit entry can say which happened while still using the
   * `youtube.connected` action — that action is on the list that captures IP
   * and user-agent, and re-authorising an account that reads Northstar's data
   * is exactly as security-relevant as authorising it the first time.
   */
  readonly reconnected: boolean;
}

/**
 * Everything between "Google handed us a code" and "the workspace has a working
 * connection": exchange, identify, store encrypted, link the channel.
 *
 * The state check is the caller's job and has already happened by the time this
 * runs — see `verifyOAuthState`.
 */
export async function completeConnection(options: {
  code: string;
  redirectUri: string;
  organizationId: string;
  userId: string;
}): Promise<CompleteConnectionResult> {
  const tokens = await exchangeCodeForTokens(options.code, options.redirectUri);

  // Google's consent screen lets a user untick individual permissions. Catching
  // a downgraded grant now produces one clear message; letting it through
  // produces a connection that looks healthy and fails with an opaque 403 on
  // its first sync, hours later, with nobody watching.
  if (!tokens.scope.split(" ").includes(REQUIRED_SCOPE)) {
    throw errors.invalidInput(
      "The connection was not granted permission to read YouTube data. Connect again and leave " +
        "the YouTube permission ticked.",
    );
  }

  const identity = decodeIdentity(tokens.idToken);

  // Resolved before the row is written so the connection can be keyed on the
  // channel it belongs to, which is what the (organization, channel) unique
  // exists to enforce — reconnecting the same channel must update one row
  // rather than collide with it.
  const ownChannel = await fetchOwnChannel(tokens.accessToken);

  // `refreshTokenEnc` is selected only to answer "is one already stored?"; the
  // ciphertext is reduced to a boolean below and never held, returned or logged.
  const keyed = ownChannel
    ? await prisma.youTubeConnection.findUnique({
        where: {
          organizationId_youtubeChannelId: {
            organizationId: options.organizationId,
            youtubeChannelId: ownChannel.channelId,
          },
        },
        select: { id: true, refreshTokenEnc: true, revenueSyncStatus: true },
      })
    : null;

  /*
   * Fall back to the Google account itself, and — this is the part that was
   * missing — do so even when a channel DID resolve but matched no row.
   *
   * The gap it closes is a first-run sequence this deployment is likely to hit.
   * Connecting a Brand Account's personal Google identity resolves no channel,
   * so a row is written with `youtubeChannelId: null`. The banner correctly says
   * "connected, but no channel was found", so the obvious next move is to
   * connect again and pick the channel this time. On that second pass a channel
   * resolves, the keyed lookup misses (the orphan's channel id is null), and the
   * account lookup was never consulted — so a SECOND row is created for the same
   * Google account. The (organization, channel) unique cannot stop it, because
   * Postgres does not consider two NULLs equal, so the orphan collides with
   * nothing. The result is two live connections for one account, one of them
   * permanently channel-less, both holding valid tokens.
   *
   * Restricted to channel-less rows when a channel resolved: a row already keyed
   * to a DIFFERENT channel is a different connection and must not be hijacked by
   * an account that happens to own both.
   */
  const existing =
    keyed ??
    // Guarded on a known account id: matching `googleUserId: null` would pair
    // this grant with whatever anonymous row happened to be there first.
    (identity.googleUserId
      ? await prisma.youTubeConnection.findFirst({
          where: {
            organizationId: options.organizationId,
            googleUserId: identity.googleUserId,
            ...(ownChannel ? { youtubeChannelId: null } : {}),
          },
          select: { id: true, refreshTokenEnc: true, revenueSyncStatus: true },
        })
      : null);

  // A connection with no refresh token — neither newly issued nor already on
  // file — works for one hour and then stops, which reads as a random failure
  // the next morning rather than as the setup problem it is. Google withholds
  // one when the account has already consented and `prompt=consent` was somehow
  // not honoured, and the fix is for the user to revoke the old grant.
  if (!tokens.refreshToken && !existing?.refreshTokenEnc) {
    throw errors.invalidInput(
      "Google did not issue a long-lived credential for this account, so the connection would stop " +
        "working within the hour. Remove Northstar HQ from the account's third-party access at " +
        "myaccount.google.com/permissions, then connect again.",
    );
  }

  /**
   * Whether this grant can read money, decided from Google's own answer.
   *
   * Deliberately NOT a hard failure the way a missing `REQUIRED_SCOPE` is. A
   * connection without the monetary scope still does everything the integration
   * did before revenue existed, so refusing it would break channel syncing to
   * punish a missing feature. It is recorded instead, and the admin screen says
   * "reconnect to enable revenue" — a sentence about one capability rather than
   * an error about the whole connection.
   */
  const revenueScopeGranted = grantsRevenueScope(tokens.scope);

  const data = {
    googleAccountEmail: identity.email,
    googleUserId: identity.googleUserId,
    /*
     * Written only when this attempt actually resolved a channel — never
     * blanked back to null.
     *
     * `?? null` meant a reconnection that resolved nothing ERASED the channel a
     * working connection already had. That is not a rare path: the prompt to
     * reconnect and grant the revenue scope is the app's own advice, and
     * `channels?mine=true` intermittently answers with an empty list. Once
     * blanked, nothing restores it — `linkConnectionToTrackedChannel` returns
     * early with no channel to link — so a healthy connection silently becomes
     * one the admin screen describes as owning no channel.
     *
     * Same idiom, and the same reasoning, as `refreshTokenEnc` below: an absent
     * value from Google means "unchanged", never "deleted".
     */
    ...(ownChannel ? { youtubeChannelId: ownChannel.channelId, channelTitle: ownChannel.title } : {}),
    accessTokenEnc: encryptSecret(tokens.accessToken),
    // Only overwrite the refresh token when Google actually sent one, for the
    // same reason as in `refreshAccessToken`.
    ...(tokens.refreshToken ? { refreshTokenEnc: encryptSecret(tokens.refreshToken) } : {}),
    accessTokenExpiresAt: tokens.expiresAt,
    scope: tokens.scope,
    revenueScopeGranted,
    // The revenue verdict is only ever *cleared* by reconnecting, never
    // invented. "no_scope" is the one status a new grant can genuinely
    // invalidate, so it is reset to "never" and the next run decides. A channel
    // previously found to be outside the Partner Programme, or a run that
    // failed for its own reasons, is not made true or false by re-authorising —
    // overwriting those here would replace a fact with an optimistic guess.
    ...(revenueScopeGranted
      ? existing?.revenueSyncStatus === "no_scope"
        ? { revenueSyncStatus: "never", revenueSyncError: null }
        : {}
      : {
          revenueSyncStatus: "no_scope",
          revenueSyncError:
            "This connection was not granted permission to read YouTube revenue. Reconnect the " +
            "account and leave every permission ticked on Google's consent screen.",
        }),
    status: "connected",
    lastError: null,
    connectedById: options.userId,
  };

  const connection = existing
    ? await prisma.youTubeConnection.update({ where: { id: existing.id }, data, select: { id: true } })
    : await prisma.youTubeConnection.create({
        data: { organizationId: options.organizationId, ...data },
        select: { id: true },
      });

  const linkedChannel = await linkConnectionToTrackedChannel(connection.id, ownChannel);

  return {
    connection: await getConnectionDTO(connection.id, options.organizationId),
    linkedChannel,
    reconnected: existing !== null,
  };
}

// ---------------------------------------------------------------------------
// Reading and removing connections
// ---------------------------------------------------------------------------

/**
 * The columns a connection DTO is built from.
 *
 * Explicit, and containing no `*Enc` field, so the ciphertext never enters the
 * process on a read path at all — a stronger guarantee than remembering to
 * strip it from the object afterwards.
 */
const CONNECTION_DTO_SELECT = {
  id: true,
  googleAccountEmail: true,
  channelTitle: true,
  youtubeChannelId: true,
  scope: true,
  status: true,
  lastError: true,
  lastSyncAt: true,
  channelSyncStatus: true,
  channelSyncError: true,
  lastChannelSyncAt: true,
  revenueScopeGranted: true,
  monetizationStatus: true,
  revenueSyncStatus: true,
  revenueSyncError: true,
  lastRevenueSyncAt: true,
  nextSyncAt: true,
  createdAt: true,
  connectedBy: { select: { name: true, email: true } },
  /**
   * Every channel this grant covers, not just the one the row is keyed on.
   *
   * Joined rather than fetched from Google. `listOwnChannels` asks Google live
   * and is the right source for "what could be ADDED", but it answers only for
   * connections that can still mint a token — so it says nothing at all about a
   * `needs_reauth` account, which on this screen is the one whose coverage a
   * reader most needs to see. It also spends one Data API call per connection
   * per page load. These rows cost nothing and survive a broken grant.
   */
  coveredChannels: {
    select: { youtubeChannelId: true, title: true, confirmedAt: true },
    // Oldest confirmation first, so the list does not reshuffle between loads
    // and a re-confirmed channel does not jump to the top of somebody's card.
    orderBy: { confirmedAt: "asc" },
  },
} as const;

interface ConnectionRow {
  readonly id: string;
  readonly googleAccountEmail: string | null;
  readonly channelTitle: string | null;
  readonly youtubeChannelId: string | null;
  readonly scope: string;
  readonly status: string;
  readonly lastError: string | null;
  readonly lastSyncAt: Date | null;
  readonly channelSyncStatus: string;
  readonly channelSyncError: string | null;
  readonly lastChannelSyncAt: Date | null;
  readonly revenueScopeGranted: boolean;
  readonly monetizationStatus: string;
  readonly revenueSyncStatus: string;
  readonly revenueSyncError: string | null;
  readonly lastRevenueSyncAt: Date | null;
  readonly nextSyncAt: Date | null;
  readonly createdAt: Date;
  readonly connectedBy: { name: string | null; email: string | null } | null;
  readonly coveredChannels: readonly {
    youtubeChannelId: string;
    title: string | null;
    confirmedAt: Date;
  }[];
}

/**
 * The display facts a covered channel gets from the globally deduplicated
 * `Channel` row, when one exists.
 *
 * The coverage table stores a title and nothing else, by design — it is a
 * statement about a GRANT, not a copy of a channel. But `upsertChannel` runs in
 * both paths that write coverage, so a `Channel` row keyed on the same YouTube
 * id is there for every channel that got as far as being tracked, carrying the
 * avatar and handle that let a reader recognise it. Optional throughout: a
 * coverage row whose channel was never synced still has to render, with a name
 * and nothing more.
 *
 * IDENTITY ONLY, AND THAT LIMIT IS THE POINT. `Channel.youtubeChannelId` is
 * `@unique` globally rather than per organisation, so this single row is shared
 * with every other workspace that tracks the same channel, and `upsertChannel`
 * (channel-sync.ts) rewrites it from whichever workspace synced most recently —
 * a workspace with no connection to this account included, running on the
 * shared public API key (`options.credential ?? { source: "public" }`). Nothing
 * on the row records which credential last wrote it.
 *
 * Name, handle and avatar survive that: they are the same strings whichever
 * credential read them, and a stale one is a cosmetic wrong label on a row
 * whose YouTube id — the identifier this card actually asserts — is read from
 * the coverage table and cannot be touched by another workspace. A subscriber
 * count does not survive it. It is a measurement, it differs by credential and
 * by freshness, and putting it here would print another workspace's public-key
 * number under this card's sentence about this account's own authorisation.
 * `ChannelDTO` carries `dataSource` precisely so numbers are never shown
 * without that provenance, and there is no honest `dataSource` to attach here:
 * `channelDataSources` reports which credential THIS workspace's next sync
 * would use, which for a covered channel is "connection" by construction — it
 * would restate the assumption as a badge rather than check it. So the figures
 * are not selected at all, and the row links to the channels screen, which owns
 * that question and answers it with the label attached.
 */
interface CoveredChannelFacts {
  readonly title: string;
  readonly handle: string | null;
  readonly avatarUrl: string | null;
}

/**
 * The channels one connection covers, merged from the two places that know.
 *
 * TWO SOURCES, AND THEY OVERLAP BY CONSTRUCTION. The connection's own
 * `youtubeChannelId` column and its first coverage row are written in
 * consecutive statements by `linkConnectionToTrackedChannel`, so the primary
 * channel is normally in both. The merge is keyed on the YouTube id for that
 * reason: a naive concatenation renders the studio's main channel twice and
 * makes one account look like two.
 *
 * The column is still read rather than trusting coverage alone, because a
 * deployment whose backfill has not run — every local SQLite database, since
 * `db push` applies the schema and never the migration SQL — has connections
 * with no coverage rows at all. Dropping the column would blank those cards.
 *
 * Titles prefer the synced `Channel` row over the coverage row's captured
 * title, so a renamed channel is not called one thing here and another on the
 * channels screen. The connection's `channelTitle` is used ONLY for the primary
 * channel: it names the channel the connection row is keyed on, so applying it
 * to a second channel from the same account would name the wrong channel.
 */
function toCoveredChannelDTOs(
  row: ConnectionRow,
  facts: ReadonlyMap<string, CoveredChannelFacts>,
): readonly YouTubeConnectionChannelDTO[] {
  const build = (
    youtubeChannelId: string,
    coverageTitle: string | null,
    confirmedAt: Date | null,
  ): YouTubeConnectionChannelDTO => {
    const known = facts.get(youtubeChannelId);
    const isPrimary = youtubeChannelId === row.youtubeChannelId;
    return {
      youtubeChannelId,
      title: known?.title ?? coverageTitle ?? (isPrimary ? row.channelTitle : null),
      handle: known?.handle ?? null,
      avatarUrl: known?.avatarUrl ?? null,
      channelUrl: youtubeChannelUrl(known?.handle ?? null, youtubeChannelId),
      isPrimary,
      confirmedAt: confirmedAt?.getTime() ?? null,
    };
  };

  const covered = row.coveredChannels.map((channel) =>
    build(channel.youtubeChannelId, channel.title, channel.confirmedAt),
  );

  const keyed =
    row.youtubeChannelId !== null &&
    !covered.some((channel) => channel.youtubeChannelId === row.youtubeChannelId)
      ? [build(row.youtubeChannelId, row.channelTitle, null)]
      : [];

  // Primary first. It is the channel the account was connected as and the one
  // the owner is looking for; ordering by confirmation time alone would bury it
  // under channels added later.
  return [...keyed, ...covered].sort(
    (a, b) => Number(b.isPrimary) - Number(a.isPrimary),
  );
}

/**
 * The `Channel` rows for every channel these connections cover, by YouTube id.
 *
 * One query for the whole page rather than one per connection. `Channel` is the
 * globally deduplicated row shared with competitor tracking and so is not
 * org-scoped — the scoping here is that every id fed to it came out of a
 * connection row already filtered to one workspace, so no other workspace's
 * connections can put an id into this query.
 */
async function coveredChannelFacts(
  rows: readonly ConnectionRow[],
): Promise<ReadonlyMap<string, CoveredChannelFacts>> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.youtubeChannelId !== null) ids.add(row.youtubeChannelId);
    for (const channel of row.coveredChannels) ids.add(channel.youtubeChannelId);
  }
  if (ids.size === 0) return new Map();

  const channels = await prisma.channel.findMany({
    where: { youtubeChannelId: { in: [...ids] } },
    // Identity columns only. The counters are deliberately not selected — see
    // `CoveredChannelFacts` for why a figure off this globally shared row would
    // be unprovenanced on this particular card.
    select: {
      youtubeChannelId: true,
      title: true,
      handle: true,
      avatarUrl: true,
    },
  });

  return new Map(channels.map((channel) => [channel.youtubeChannelId, channel]));
}

function toConnectionDTO(
  row: ConnectionRow,
  /**
   * Defaults to empty rather than to "look it up", following the house rule for
   * an optional relation: a caller that has not joined the channels still gets
   * a correct DTO — names only — instead of a silent extra query per row.
   */
  facts: ReadonlyMap<string, CoveredChannelFacts> = new Map(),
): YouTubeConnectionDTO {
  return {
    id: row.id,
    coveredChannels: toCoveredChannelDTOs(row, facts),
    googleAccountEmail: row.googleAccountEmail,
    channelTitle: row.channelTitle,
    youtubeChannelId: row.youtubeChannelId,
    scope: row.scope,
    status: row.status,
    lastError: row.lastError,
    // Epoch milliseconds, per the wire convention in lib/dto.ts.
    lastSyncAt: row.lastSyncAt?.getTime() ?? null,
    channelSyncStatus: row.channelSyncStatus,
    channelSyncError: row.channelSyncError,
    lastChannelSyncAt: row.lastChannelSyncAt?.getTime() ?? null,
    revenueScopeGranted: row.revenueScopeGranted,
    monetizationStatus: row.monetizationStatus,
    revenueSyncStatus: row.revenueSyncStatus,
    revenueSyncError: row.revenueSyncError,
    lastRevenueSyncAt: row.lastRevenueSyncAt?.getTime() ?? null,
    nextSyncAt: row.nextSyncAt?.getTime() ?? null,
    // Prefer the live name so a rename shows, falling back to the address when
    // the account has no name and to null when it has been deleted.
    connectedByName: row.connectedBy?.name ?? row.connectedBy?.email ?? null,
    createdAt: row.createdAt.getTime(),
  };
}

async function getConnectionDTO(
  connectionId: string,
  organizationId: string,
): Promise<YouTubeConnectionDTO> {
  const row = await prisma.youTubeConnection.findFirst({
    where: { id: connectionId, organizationId },
    select: CONNECTION_DTO_SELECT,
  });
  if (!row) throw errors.notFound("YouTube connection");
  return toConnectionDTO(row, await coveredChannelFacts([row]));
}

/**
 * Every connection in one workspace.
 *
 * Takes the organization explicitly rather than reading the session, so the
 * caller has to have obtained it from `requireActor()` — a request body can
 * never reach this parameter.
 */
export async function listConnections(
  organizationId: string,
): Promise<readonly YouTubeConnectionDTO[]> {
  const rows = await prisma.youTubeConnection.findMany({
    where: { organizationId },
    orderBy: { createdAt: "asc" },
    select: CONNECTION_DTO_SELECT,
  });
  // One lookup for the whole page. Passed explicitly rather than read inside
  // the mapper so `rows.map` cannot turn into a query per connection.
  const facts = await coveredChannelFacts(rows);
  return rows.map((row) => toConnectionDTO(row, facts));
}

export interface DisconnectResult {
  readonly id: string;
  /** Human label for the audit entry, captured before the row is deleted. */
  readonly label: string;
  /** False when Google could not be reached; the local tokens are gone either way. */
  readonly revokedAtGoogle: boolean;
}

/**
 * Revokes the grant at Google, then removes it here.
 *
 * ORDER MATTERS. Deleting our copy first and failing to revoke would leave a
 * live authorisation sitting in the user's Google account with nothing in this
 * app that could ever cancel it — the token is gone from the database but the
 * *access* is not gone from Google, and the only remaining way to withdraw it
 * is for the account owner to find it by hand in their security settings.
 * Revoking the refresh token withdraws the whole grant, including every access
 * token derived from it.
 *
 * Best-effort: a Google outage must not leave an admin unable to remove a
 * connection they have decided to remove. The outcome is reported so the audit
 * entry can record that the remote revocation did not happen.
 */
export async function disconnect(connectionId: string): Promise<DisconnectResult> {
  // Scoped, so an id guessed or copied from another workspace resolves to
  // nothing rather than deleting somebody else's connection.
  const organizationId = await getCurrentOrgId();

  const connection = await prisma.youTubeConnection.findFirst({
    where: { id: connectionId, organizationId },
    select: {
      id: true,
      channelTitle: true,
      googleAccountEmail: true,
      accessTokenEnc: true,
      refreshTokenEnc: true,
    },
  });
  if (!connection) throw errors.notFound("YouTube connection");

  const token = decryptSecret(connection.refreshTokenEnc) ?? decryptSecret(connection.accessTokenEnc);
  const revokedAtGoogle = token ? await revokeAtGoogle(token) : false;

  // Deleted rather than kept as a tombstone: the row's whole purpose is to hold
  // credentials and the link they proved, and a tokenless husk in the admin
  // list reads as a broken connection. The audit trail is the durable record
  // that this account was connected and when it was removed.
  await prisma.youTubeConnection.delete({ where: { id: connection.id } });

  // The TrackedChannel keeps ownershipType "own" on purpose. Disconnecting is
  // about credentials, not about the team's research: wiping the ownership
  // label would silently drop the channel out of every "our channels" chart and
  // rewrite historical comparisons.

  return {
    id: connection.id,
    label: connection.channelTitle ?? connection.googleAccountEmail ?? "Google account",
    revokedAtGoogle,
  };
}

async function revokeAtGoogle(token: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(GOOGLE_REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: controller.signal,
      cache: "no-store",
    });
    // Google answers 400 `invalid_token` for a grant that is already gone,
    // which is the desired end state rather than a failure.
    return response.ok || response.status === 400;
  } catch (error) {
    // Logged without the token or the response body.
    console.warn(
      "[youtube-oauth] could not revoke the grant at Google",
      error instanceof Error ? error.name : "unknown error",
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// WHICH CHANNELS ARE OURS, AND WHAT READS THEM
// ---------------------------------------------------------------------------

/**
 * =========================================================================
 * THE OWNER'S RULE, AND THE ONE DECISION IT FORCES
 * =========================================================================
 *
 * "My own channels data should only come from that, not from external API or
 * sources." A channel reached through a connection is therefore read with that
 * connection's grant — authoritative, not limited to what YouTube shows the
 * public, and charged to the OAuth client's project rather than to the shared
 * key every competitor refresh is also spending. Competitors are unchanged:
 * there is no other way to see them.
 *
 * THE HARD CASE IS A CONNECTION THAT HAS STOPPED WORKING, and it has exactly two
 * possible answers, both of which the brief names as unacceptable if done
 * silently: fall back to the public key, or stop updating.
 *
 * This picks STOP, and makes it loud.
 *
 * Falling back is the worse of the two and it is not close. It would answer a
 * revoked grant by going and reading the same channel through precisely the
 * source the owner said not to use for their own channels — and it would do it
 * invisibly, because a public read SUCCEEDS. The dashboard would fill with
 * plausible numbers, subtly different from the private ones, with nothing
 * anywhere to say the source had changed underneath them. A studio would find
 * out when a figure failed to match YouTube Studio and nobody could say why.
 *
 * Stopping is visible by construction: the sync records the failure on the
 * channel, `lastFetchStatus` goes to "error", the channel's `dataSource` becomes
 * "connection_unavailable", and the channels screen, the channel page and the
 * connect panel all say the figures are frozen and name reconnection as the fix.
 * Nothing is lost that reconnecting does not restore, and nothing on screen is a
 * number from a source the reader did not agree to.
 *
 * A channel with NO connection is a different question and gets a different
 * answer: nothing has been withdrawn, the public API is the only source that
 * ever applied, and it keeps reading exactly as before. The screen still says
 * so, because "these are the public figures" is worth knowing about a channel
 * you own.
 */

/**
 * Record that a grant provably covers a channel, so that channel can be READ
 * with it.
 *
 * Called at the two moments Google itself has just confirmed the ownership: the
 * callback resolving the account's channel, and `trackOwnChannel` matching a
 * requested id against `channels?mine=true`. Never called from a request body.
 *
 * The upsert on (organization, channel) means the most recent grant to prove
 * ownership wins, rather than a second connection colliding with the first. Two
 * Google accounts claiming one channel is a real situation — an owner who moved
 * a channel between accounts — and the last one to demonstrate it is the one
 * whose token will actually work.
 */
async function recordCoveredChannel(options: {
  organizationId: string;
  connectionId: string;
  youtubeChannelId: string;
  title: string | null;
}): Promise<void> {
  const { organizationId, connectionId, youtubeChannelId, title } = options;
  await prisma.youTubeConnectionChannel.upsert({
    where: { organizationId_youtubeChannelId: { organizationId, youtubeChannelId } },
    create: { organizationId, connectionId, youtubeChannelId, title },
    update: { connectionId, title, confirmedAt: new Date() },
    select: { id: true },
  });
}

/**
 * Connections in one workspace that cover a channel, keyed by YouTube id.
 *
 * TWO SOURCES, AND THE SECOND IS THE REPAIR. The connection row itself names one
 * channel — the one Google scoped the consent to — and that has always been
 * read here. `YouTubeConnectionChannel` names every channel the same grant was
 * shown to own, which is what makes channels two through N of one account
 * resolve to a real credential instead of falling through to `{source: "public"}`
 * and being read with the shared API key while labelled as ours.
 *
 * The link table wins where both speak, because it is the more specific record
 * and the more recently confirmed one. The connection column is still read so a
 * deployment that has not run the backfill resolves exactly as it did before.
 */
async function connectionsByChannel(
  organizationId: string,
): Promise<Map<string, { id: string; status: string; label: string }>> {
  const [rows, covered] = await Promise.all([
    prisma.youTubeConnection.findMany({
      where: { organizationId, youtubeChannelId: { not: null } },
      select: {
        id: true,
        status: true,
        youtubeChannelId: true,
        channelTitle: true,
        googleAccountEmail: true,
      },
      // Oldest first, so a duplicate — which the (organization, channel) unique
      // makes impossible today — would resolve to the same connection on every
      // run rather than alternating between them.
      orderBy: { createdAt: "asc" },
    }),
    prisma.youTubeConnectionChannel.findMany({
      where: { organizationId },
      select: {
        youtubeChannelId: true,
        title: true,
        connection: { select: { id: true, status: true, googleAccountEmail: true } },
      },
      orderBy: { confirmedAt: "asc" },
    }),
  ]);

  const byChannel = new Map<string, { id: string; status: string; label: string }>();
  for (const row of rows) {
    if (!row.youtubeChannelId || byChannel.has(row.youtubeChannelId)) continue;
    byChannel.set(row.youtubeChannelId, {
      id: row.id,
      status: row.status,
      label: row.channelTitle ?? row.googleAccountEmail ?? "Google account",
    });
  }

  for (const row of covered) {
    byChannel.set(row.youtubeChannelId, {
      id: row.connection.id,
      status: row.connection.status,
      // This channel's own title, never the connection's `channelTitle` — that
      // names the channel the row is keyed on, which for a second channel from
      // the same account is a different channel entirely.
      label: row.title ?? row.connection.googleAccountEmail ?? "Google account",
    });
  }

  return byChannel;
}

/**
 * Where each channel's figures come from, for a whole tracker at once.
 *
 * DELIBERATELY MINTS NO TOKENS. This runs on every dataset read to fill in
 * `ChannelDTO.dataSource`, and a version that proved each grant still worked
 * would put one or more Google round trips on the path of every dashboard load.
 * It reports the STORED condition of the connection, which is what a screen
 * needs: "connected" means the last thing that used it succeeded, and the moment
 * one does not, `refreshAccessToken` writes `needs_reauth` and this starts
 * saying so. The sync path is the one that has to be certain, and it is the one
 * that actually asks — see `resolveChannelCredential`.
 */
export async function channelDataSources(
  organizationId: string,
  youtubeChannelIds: readonly string[],
): Promise<Map<string, ChannelDataSource>> {
  const sources = new Map<string, ChannelDataSource>(
    youtubeChannelIds.map((id) => [id, "public" as ChannelDataSource]),
  );
  if (youtubeChannelIds.length === 0) return sources;

  const byChannel = await connectionsByChannel(organizationId);
  for (const youtubeChannelId of youtubeChannelIds) {
    const connection = byChannel.get(youtubeChannelId);
    if (!connection) continue;
    sources.set(
      youtubeChannelId,
      connection.status === "connected" ? "connection" : "connection_unavailable",
    );
  }
  return sources;
}

/**
 * The credential one channel's sync should actually use, resolved for real.
 *
 * Unlike `channelDataSources` this DOES mint a token, because the sync is about
 * to spend a request on it and "the row says connected" is not the same claim as
 * "Google will still honour it". `getValidAccessToken` refreshes when the stored
 * access token is near expiry and records `needs_reauth` when the grant is gone,
 * so a connection that died since the last run is discovered here — once — and
 * the channel is reported as frozen rather than quietly re-read with the shared
 * key.
 *
 * Never throws for a broken connection. A dead grant is a state to report, not
 * an exception to unwind a scheduled sweep with: the other channels in the run
 * are unaffected and must still be refreshed.
 */
export async function resolveChannelCredential(
  organizationId: string,
  youtubeChannelId: string,
): Promise<ChannelCredential> {
  const byChannel = await connectionsByChannel(organizationId);
  const connection = byChannel.get(youtubeChannelId);

  // No connection has ever been made for this channel, so nothing has been
  // withdrawn and the public API is not a fallback — it is the only source that
  // was ever in play. Competitors take this path, and so does an own channel
  // somebody added by pasting a link before the account was connected.
  if (!connection) return { source: "public" };

  if (connection.status !== "connected") {
    return {
      source: "connection_unavailable",
      connectionId: connection.id,
      label: connection.label,
      reason:
        `The Google account behind ${connection.label} needs to be reconnected. This channel is ` +
        "read with that account's own authorisation and is not read from the public API instead, " +
        "so its figures stay frozen at the last successful sync until the account is reconnected " +
        "from Admin → YouTube.",
    };
  }

  try {
    const accessToken = await getValidAccessToken(connection.id);
    return {
      source: "connection",
      label: connection.label,
      credential: { accessToken, connectionId: connection.id },
    };
  } catch (caught) {
    // `getValidAccessToken` has already written `needs_reauth` and a readable
    // reason on the connection when the grant is gone. Its message is reused
    // rather than replaced, so the channel and the admin screen say the same
    // thing about the same failure.
    return {
      source: "connection_unavailable",
      connectionId: connection.id,
      label: connection.label,
      reason: toAppError(caught).userMessage,
    };
  }
}

// ---------------------------------------------------------------------------
// DISCOVERING THE CONNECTED ACCOUNT'S OWN CHANNELS
// ---------------------------------------------------------------------------

/**
 * Every channel this workspace's connections own, with what the tracker already
 * knows about each.
 *
 * THE POINT OF CONNECTING. The owner asked, in this round and the last, that
 * after connecting their channels be discoverable and addable without anybody
 * pasting a channel id — and they are right that pasting one is the weak link:
 * it asks a person to re-type something Google has already told us, and a
 * mistyped id tracks a stranger's channel as your own with no signal that
 * anything went wrong.
 *
 * One Data API call per connection, and only when somebody opens a screen that
 * offers the list. A connection that cannot currently mint a token contributes
 * nothing rather than failing the whole list: one expired grant must not hide
 * the channels of three working ones.
 */
export async function listOwnChannels(
  organizationId: string,
): Promise<readonly OwnChannelDTO[]> {
  const connections = await prisma.youTubeConnection.findMany({
    where: { organizationId, status: "connected" },
    select: { id: true, googleAccountEmail: true },
    orderBy: { createdAt: "asc" },
  });
  if (connections.length === 0) return [];

  const discovered: {
    connectionId: string;
    email: string | null;
    channel: YouTubeChannel;
  }[] = [];

  for (const connection of connections) {
    try {
      const accessToken = await getValidAccessToken(connection.id);
      for (const channel of await fetchOwnChannels(accessToken)) {
        discovered.push({
          connectionId: connection.id,
          email: connection.googleAccountEmail,
          channel,
        });
      }
    } catch (error) {
      // Logged without the token or the response body, and skipped. The
      // connection's own row already carries the reason — `getValidAccessToken`
      // records it — and Admin → YouTube is where that gets read.
      console.warn(
        "[youtube-oauth] could not list channels for a connection",
        error instanceof Error ? error.name : "unknown error",
      );
    }
  }

  if (discovered.length === 0) return [];

  // What the tracker already holds, in one query rather than one per channel.
  const tracked = await prisma.trackedChannel.findMany({
    where: {
      organizationId,
      channel: { youtubeChannelId: { in: discovered.map((row) => row.channel.channelId) } },
    },
    select: {
      isActive: true,
      ownershipType: true,
      channel: { select: { youtubeChannelId: true } },
    },
  });
  const trackedByChannel = new Map(tracked.map((row) => [row.channel.youtubeChannelId, row]));

  return discovered.map(({ connectionId, email, channel }) => {
    const existing = trackedByChannel.get(channel.channelId) ?? null;
    return {
      connectionId,
      googleAccountEmail: email,
      youtubeChannelId: channel.channelId,
      title: channel.title,
      handle: channel.handle,
      avatarUrl: channel.avatarUrl,
      // Null rather than 0 when hidden, exactly as `toChannelDTO` does: a
      // hidden count is not a count of zero.
      subscriberCount: channel.hiddenSubscriberCount ? null : channel.subscriberCount,
      hiddenSubscriberCount: channel.hiddenSubscriberCount,
      videoCount: channel.videoCount,
      alreadyTracked: existing?.isActive === true && existing.ownershipType === "own",
      previouslyRemoved: existing !== null && existing.isActive === false,
      trackedAsCompetitor: existing?.isActive === true && existing.ownershipType !== "own",
    };
  });
}

export interface TrackOwnChannelResult {
  /** The internal `Channel.id`, so the caller can sync it and link to it. */
  readonly channelId: string;
  readonly title: string;
  /** False when the row already existed and was re-scoped or reactivated. */
  readonly created: boolean;
  readonly restored: boolean;
  /** It was in the tracker as a competitor and has been corrected. */
  readonly reclassified: boolean;
}

/**
 * Add one of the connected account's own channels to the tracker.
 *
 * The channel is identified by its YouTube id, and that id is NOT taken from the
 * request and trusted: it is matched against the channels the connection itself
 * reports owning, and anything else is refused. That check is the whole security
 * property of this endpoint — without it, "add my channel" would be an arbitrary
 * "mark any channel on YouTube as ours", and `ownershipType: "own"` is the flag
 * that decides which figures the studio reports as its own work.
 *
 * The channel row is written from the OAuth payload rather than re-fetched with
 * the shared key, which is the same rule the rest of this change follows: an own
 * channel's data comes from the connection, including on the very first write.
 */
export async function trackOwnChannel(options: {
  organizationId: string;
  userId: string;
  connectionId: string;
  youtubeChannelId: string;
}): Promise<TrackOwnChannelResult> {
  const connection = await prisma.youTubeConnection.findFirst({
    // Org-scoped, so a connection id from another workspace resolves to nothing
    // rather than lending its grant to this one.
    where: { id: options.connectionId, organizationId: options.organizationId },
    select: { id: true },
  });
  if (!connection) throw errors.notFound("YouTube connection");

  const owned = await fetchOwnChannels(await getValidAccessToken(connection.id));
  const resolved = owned.find((channel) => channel.channelId === options.youtubeChannelId);
  if (!resolved) {
    throw errors.invalidInput(
      "That channel is not one this connected Google account owns, so it cannot be added as one " +
        "of yours from here. Reconnect using the account that owns it, or add it as a competitor " +
        "from the Add Channel dialog.",
    );
  }

  /**
   * Record the coverage BEFORE the tracker row exists.
   *
   * This is the line that closes the hole the multi-channel path used to have.
   * `owned` is Google's own answer to "what does this token own", and this
   * channel is in it — so the grant genuinely covers it, whether or not it is
   * the one channel the connection row is keyed on. Without this, channels two
   * through N were marked "own" and then read with the shared public API key,
   * silently, because a public read succeeds.
   *
   * Ordered first so there is no window in which a channel is tracked as ours
   * with no credential resolving to it: a failure here refuses the whole
   * addition rather than producing exactly that state.
   */
  await recordCoveredChannel({
    organizationId: options.organizationId,
    connectionId: connection.id,
    youtubeChannelId: resolved.channelId,
    title: resolved.title,
  });

  const channelRow = await upsertChannel(resolved);
  // Same as every other path that upserts a channel: the reading is filed at
  // once, so the delta series has its first point today rather than at the
  // next sweep.
  await recordChannelReading(channelRow, new Date());

  const existing = await prisma.trackedChannel.findUnique({
    where: {
      organizationId_channelId: {
        organizationId: options.organizationId,
        channelId: channelRow.id,
      },
    },
    select: { id: true, isActive: true, ownershipType: true },
  });

  if (!existing) {
    await prisma.trackedChannel.create({
      data: {
        organizationId: options.organizationId,
        // Attribution only, as everywhere else: the row belongs to the
        // organization, not to whoever pressed the button.
        createdById: options.userId,
        channelId: channelRow.id,
        ownershipType: "own",
      },
    });
    return {
      channelId: channelRow.id,
      title: resolved.title,
      created: true,
      restored: false,
      reclassified: false,
    };
  }

  await prisma.trackedChannel.update({
    where: { id: existing.id },
    // Reactivated as well as re-scoped, for the same reason
    // `linkConnectionToTrackedChannel` does it: adding a channel the connected
    // account provably owns is an unambiguous statement that it belongs here.
    data: { ownershipType: "own", isActive: true, removedAt: null },
  });

  return {
    channelId: channelRow.id,
    title: resolved.title,
    created: false,
    restored: existing.isActive === false,
    // Worth reporting separately: nothing was added, a mislabelled channel was
    // corrected — and that correction is what makes it start reading through
    // the connection instead of the public API.
    reclassified: existing.isActive === true && existing.ownershipType !== "own",
  };
}
