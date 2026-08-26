import "server-only";

import { randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/server/db";
import { AppError, errors } from "@/server/errors";
import { authEnv, resolveAppUrl } from "@/server/auth/auth-env";
import { decryptSecret, encryptSecret } from "@/server/auth/crypto";
import { requireGoogleOAuthConfig } from "@/server/auth/google-oauth-env";
import type { YouTubeConnectionDTO } from "@/lib/dto";
import { upsertChannel } from "./channel-sync";
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
 * `yt-analytics.readonly` is not requested either. Nothing in the product reads
 * the Analytics API today, and asking for a scope "in case we need it later"
 * makes every admin approve access that is never used — which is also how a
 * consent screen stops being read.
 *
 * `openid email` identifies which Google account granted access, so the admin
 * screen can show whose authorisation a sync depends on.
 */
const OAUTH_SCOPES = ["https://www.googleapis.com/auth/youtube.readonly", "openid", "email"] as const;

/** The scope the integration cannot function without, checked after consent. */
const REQUIRED_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";

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
    // Google's error code goes in the internal message, which is logged and
    // never serialised: `error_description` can echo request material back.
    throw new AppError("UPSTREAM_ERROR", "Google rejected the sign-in. Start the connection again.", {
      internalMessage: `token exchange failed: ${result.body.error ?? `HTTP ${result.status}`}`,
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

async function markNeedsReauth(connectionId: string, lastError: string): Promise<void> {
  await prisma.youTubeConnection.update({
    where: { id: connectionId },
    data: {
      status: "needs_reauth",
      lastError: lastError.slice(0, 500),
      // The stored tokens are provably useless at this point. Clearing them
      // shrinks the window in which a database leak yields a live credential,
      // and removes any chance a later code path retries with them.
      accessTokenEnc: null,
      refreshTokenEnc: null,
      accessTokenExpiresAt: null,
    },
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
    // Either the token was never stored or APP_ENCRYPTION_KEY has changed.
    // Both are recovered the same way, so the message covers both rather than
    // guessing.
    await markNeedsReauth(
      connection.id,
      "The stored Google credentials could not be read. If APP_ENCRYPTION_KEY was changed or " +
        "restored from a different backup, reconnect the account.",
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
      await markNeedsReauth(
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
      ...(tokens.scope ? { scope: tokens.scope } : {}),
      status: "connected",
      lastError: null,
    },
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
 * The channel the authorising account owns, via `channels?mine=true`.
 *
 * Authorised with the bearer token, so it needs no API key and spends the
 * account's own quota rather than the shared one. Returns null when the account
 * has no channel — a real state for a Workspace account that was only ever a
 * viewer, and not an error worth failing a connection over.
 */
async function fetchOwnChannel(accessToken: string): Promise<YouTubeChannel | null> {
  const url = new URL(`${YOUTUBE_API_BASE}/channels`);
  url.searchParams.set("part", "snippet,statistics,contentDetails,brandingSettings");
  url.searchParams.set("mine", "true");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      throw new AppError(
        "UPSTREAM_ERROR",
        "YouTube would not say which channel this Google account owns. Try connecting again.",
        { internalMessage: `channels?mine=true returned HTTP ${response.status}` },
      );
    }

    const data = (await response.json()) as RawListResponse<RawChannelItem>;
    const item = data.items?.[0];
    return item ? normalizeChannel(item) : null;
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

  await prisma.youTubeConnection.update({
    where: { id: connection.id },
    data: { youtubeChannelId: resolved.channelId, channelTitle: resolved.title },
  });

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
  const existing = ownChannel
    ? await prisma.youTubeConnection.findUnique({
        where: {
          organizationId_youtubeChannelId: {
            organizationId: options.organizationId,
            youtubeChannelId: ownChannel.channelId,
          },
        },
        select: { id: true, refreshTokenEnc: true },
      })
    : // No channel to key on, so fall back to the Google account itself — still
      // scoped, so one workspace can never adopt another's connection row.
      // Guarded on a known account id: matching `googleUserId: null` would pair
      // this grant with whatever anonymous row happened to be there first.
      identity.googleUserId
      ? await prisma.youTubeConnection.findFirst({
          where: { organizationId: options.organizationId, googleUserId: identity.googleUserId },
          select: { id: true, refreshTokenEnc: true },
        })
      : null;

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

  const data = {
    googleAccountEmail: identity.email,
    googleUserId: identity.googleUserId,
    youtubeChannelId: ownChannel?.channelId ?? null,
    channelTitle: ownChannel?.title ?? null,
    accessTokenEnc: encryptSecret(tokens.accessToken),
    // Only overwrite the refresh token when Google actually sent one, for the
    // same reason as in `refreshAccessToken`.
    ...(tokens.refreshToken ? { refreshTokenEnc: encryptSecret(tokens.refreshToken) } : {}),
    accessTokenExpiresAt: tokens.expiresAt,
    scope: tokens.scope,
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
  createdAt: true,
  connectedBy: { select: { name: true, email: true } },
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
  readonly createdAt: Date;
  readonly connectedBy: { name: string | null; email: string | null } | null;
}

function toConnectionDTO(row: ConnectionRow): YouTubeConnectionDTO {
  return {
    id: row.id,
    googleAccountEmail: row.googleAccountEmail,
    channelTitle: row.channelTitle,
    youtubeChannelId: row.youtubeChannelId,
    scope: row.scope,
    status: row.status,
    lastError: row.lastError,
    // Epoch milliseconds, per the wire convention in lib/dto.ts.
    lastSyncAt: row.lastSyncAt?.getTime() ?? null,
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
  return toConnectionDTO(row);
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
  return rows.map(toConnectionDTO);
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
