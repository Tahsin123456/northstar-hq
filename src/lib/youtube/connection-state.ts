import type { GoogleOAuthStatusDTO, YouTubeConnectionDTO } from "@/lib/dto";

/**
 * =========================================================================
 * WHERE A CHANNEL'S OWN NUMBERS COME FROM, AS ONE SET OF SENTENCES
 * =========================================================================
 *
 * The owner asked for five states that read honestly — no Google OAuth
 * configured, configured but nothing connected, connected but no revenue scope,
 * connected but not in the Partner Programme, connected and syncing — and asked
 * that the ones already written on Admin → YouTube be REUSED rather than
 * rewritten somewhere else in slightly different words.
 *
 * That is what this module is. The connect flow now appears on four surfaces
 * (Admin → YouTube, the channels screen, the dashboard's empty state, the
 * Finance overview), and four copies of "reconnect the account and leave every
 * permission ticked" is four things to keep in step and three that will
 * eventually be wrong. So the state is DERIVED once, here, from the same
 * `google.configured` and `YouTubeConnectionDTO[]` every screen already has, and
 * the screens render it.
 *
 * PURE, AND CLIENT-SAFE. No `server-only`, no Prisma, no fetch: it reads two
 * DTOs and returns strings and enums. That is what lets the admin screen and a
 * card in the dashboard's empty state agree by construction rather than by
 * somebody remembering.
 *
 * ON THE NAMES, AND ONE THE OWNER GAVE THAT THIS DELIBERATELY DOES NOT USE
 * "connected but not in the Partner Programme" is `revenue_refused` here, and
 * the difference is not pedantry. What the app actually observes is Google
 * refusing to produce a revenue report for a connection whose grant provably
 * covers one — and Google answers exactly the same way for a channel outside the
 * programme AND for a channel the connected account no longer owns, without
 * saying which. `youtube-revenue-service.ts` is built around not conflating
 * those, and its message names both readings. Naming the state after one of them
 * here would quietly re-introduce the claim that file exists to avoid, one layer
 * up, where nobody would think to look for it.
 */

/**
 * The states, most urgent first — which is also the order `youTubeSetupState`
 * resolves them in when a workspace has several connections in different
 * conditions.
 *
 * `needs_reauth` is a sixth, and it is here because the owner's second request
 * requires it: a revoked or expired grant must not silently fall back to the
 * public API and must not silently stop updating either. That leaves exactly one
 * honest option — stop, and say so — and "say so" needs a state of its own with
 * its own next step. It is not a drift from the five; it is the state the five
 * had no room for.
 */
export type YouTubeSetupStateId =
  | "not_configured"
  | "not_connected"
  | "needs_reauth"
  | "no_revenue_scope"
  | "revenue_refused"
  | "syncing";

export interface YouTubeSetupState {
  readonly id: YouTubeSetupStateId;
  /** Drives the colour of whatever renders it. */
  readonly tone: "danger" | "warning" | "info" | "success";
  /** One line, sentence case, no trailing period — it is a heading. */
  readonly title: string;
  /**
   * What is true, and then what to do about it. Every state has a next step,
   * including the working one — a screen that speaks only when something is
   * broken leaves "it is working" and "nobody has told you yet" looking
   * identical.
   */
  readonly body: string;
  /** True when the fix is a fresh consent, so a surface can offer the button. */
  readonly offerConnect: boolean;
  /** The label that button should carry, since it differs per state. */
  readonly connectLabel: string;
}

/**
 * The scope that lets a connection read money. Mirrors `REVENUE_SCOPE` in
 * `youtube-oauth-service.ts`, which is server-only and cannot be imported here.
 *
 * Only used as a fallback: `YouTubeConnectionDTO.revenueScopeGranted` is the
 * server's own comparison against Google's answer and is what every caller
 * should read. This constant exists so a surface that has the scope string and
 * not the boolean is not tempted to invent a different comparison.
 */
export const REVENUE_SCOPE = "https://www.googleapis.com/auth/yt-analytics-monetary.readonly";

/** True only when Google's own scope string carries the monetary scope. */
export function grantsRevenueScope(scope: string): boolean {
  return scope.split(" ").filter(Boolean).includes(REVENUE_SCOPE);
}

/** A connection that can currently be used for anything at all. */
export function isHealthy(connection: YouTubeConnectionDTO): boolean {
  return connection.status === "connected";
}

/**
 * The workspace's state, as one answer.
 *
 * WHY THE WORST CONNECTION WINS. A studio with three channels and one expired
 * grant is a studio whose figures are wrong, and reporting "connected and
 * syncing" because two of the three are fine would bury the only fact on the
 * screen worth acting on. So the resolution walks the states in urgency order
 * and returns the first that any connection is in — which makes this function's
 * answer a prompt rather than a summary. Screens that need the per-connection
 * breakdown render the connections themselves; Admin → YouTube does exactly
 * that, underneath this.
 */
export function youTubeSetupState(input: {
  readonly configured: boolean;
  readonly connections: readonly YouTubeConnectionDTO[];
}): YouTubeSetupState {
  const { configured, connections } = input;

  if (!configured) {
    return {
      id: "not_configured",
      /*
       * Warning, not danger. Nothing is broken: connecting a Google account is
       * an optional feature and the app runs fully without it, so this panel
       * sits on the channels screen of every deployment that has not set it up.
       * A permanent red card for a feature somebody may have deliberately
       * declined is how people learn to ignore red cards — and the one place
       * danger IS right is after a click that could not proceed, which is the
       * admin page's own `error=not_configured` banner.
       */
      tone: "warning",
      title: "Google sign-in is not set up on this deployment",
      body:
        "Connecting a YouTube channel is optional, so the app runs without it — but the connect " +
        "flow cannot start until GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and APP_ENCRYPTION_KEY " +
        "are set. Admin → YouTube names the exact variables still missing and the redirect URI to " +
        "register with them.",
      // Deliberately no button: it would 302 straight back with
      // `error=not_configured`, which teaches nobody anything. Same reasoning as
      // `SetupCard` on the admin screen, which is where the fix actually is.
      offerConnect: false,
      connectLabel: "Connect YouTube Channel",
    };
  }

  if (connections.length === 0) {
    return {
      id: "not_connected",
      tone: "warning",
      title: "No YouTube channel is connected yet",
      body:
        "Connect the Google account that owns your channels. Until then every figure in the app " +
        "is the public one anybody can see, and there is no revenue to import. Northstar HQ asks " +
        "for read-only access and can never modify a channel.",
      offerConnect: true,
      connectLabel: "Connect YouTube Channel",
    };
  }

  if (connections.some((connection) => !isHealthy(connection))) {
    return {
      id: "needs_reauth",
      tone: "danger",
      title: "A connected account needs to be re-authorised",
      body:
        "Google has stopped honouring the stored authorisation for one of these accounts — usually " +
        "because the grant was removed in the Google account, the password changed, or it went " +
        "unused for six months. The channels behind it have STOPPED updating rather than quietly " +
        "falling back to the public API, so their figures are frozen at their last good sync. " +
        "Reconnect the account to start them again.",
      offerConnect: true,
      connectLabel: "Reconnect",
    };
  }

  if (connections.some((connection) => !connection.revenueScopeGranted)) {
    return {
      id: "no_revenue_scope",
      tone: "warning",
      title: "Connected, but revenue cannot be read",
      body:
        "A connection was authorised before Northstar HQ asked for the revenue permission, or the " +
        "separate YouTube Analytics permission was unticked on Google's consent screen. Reconnect " +
        "the account and leave every permission ticked to enable revenue — channel and video " +
        "syncing is unaffected either way.",
      offerConnect: true,
      connectLabel: "Reconnect to enable revenue",
    };
  }

  if (connections.some((connection) => connection.revenueSyncStatus === "not_monetized")) {
    return {
      id: "revenue_refused",
      tone: "info",
      title: "Connected, but YouTube will not produce a revenue report",
      body:
        "YouTube refused a revenue report for a connected channel even though the connection has " +
        "permission to read one. That refusal has two possible meanings and it does not say which: " +
        "either the Google account behind it no longer owns the channel — in which case reconnect " +
        "using the account that does — or the channel is not in the YouTube Partner Programme, in " +
        "which case there is genuinely nothing to report and figures will appear on their own if " +
        "it joins.",
      offerConnect: false,
      connectLabel: "Reconnect",
    };
  }

  return {
    id: "syncing",
    tone: "success",
    title:
      connections.length === 1
        ? "Connected and syncing"
        : `${connections.length} accounts connected and syncing`,
    body:
      "Your own channels are read with the connected account's own authorisation rather than the " +
      "public API, and their estimated revenue arrives in Finance as one entry per channel per " +
      "month — marked as an estimate, because YouTube revises these figures at month end.",
    offerConnect: false,
    connectLabel: "Connect another channel",
  };
}

/**
 * How many of this workspace's own channels the connections actually cover.
 *
 * Separate from the state above because it answers a different question, and
 * because it is the one the Finance overview has to ask: a revenue total that
 * silently omits an unconnected channel is worse than no total, so the screen
 * needs the count of channels NOT covered rather than a verdict on the
 * connections that exist.
 */
export interface OwnChannelCoverage {
  readonly ownChannelCount: number;
  readonly connectedCount: number;
  readonly unconnectedCount: number;
  /** Connected, but the grant has stopped working — covered on paper only. */
  readonly brokenCount: number;
}

/** Names the missing variables in the order the admin should set them. */
export function missingConfigSummary(google: GoogleOAuthStatusDTO): string | null {
  if (google.configured || google.missing.length === 0) return null;
  return google.missing.join(", ");
}
