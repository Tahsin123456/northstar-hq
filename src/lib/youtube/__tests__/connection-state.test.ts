import { describe, expect, it } from "vitest";
import type { YouTubeConnectionDTO } from "@/lib/dto";
import {
  grantsRevenueScope,
  isHealthy,
  missingConfigSummary,
  youTubeSetupState,
} from "@/lib/youtube/connection-state";
import { channelSourceCopy } from "@/components/youtube/channel-source";

/**
 * These two functions are where the owner's honesty requirements actually live.
 *
 * `youTubeSetupState` decides which of the five (six) states a workspace is in,
 * and every screen that offers the connect flow renders its answer — so a
 * regression here is not a cosmetic one: it is the app telling somebody their
 * channels are syncing when a grant has expired. `channelSourceCopy` decides
 * whether a channel says its figures are frozen.
 *
 * Both are pure, both are shared by three or more surfaces, and both encode
 * judgements ("the worst connection wins", "say nothing about a competitor on
 * the public API") that are easy to undo by accident while making a screen
 * tidier.
 */

function connection(overrides: Partial<YouTubeConnectionDTO> = {}): YouTubeConnectionDTO {
  return {
    id: "conn_1",
    googleAccountEmail: "studio@northstar.test",
    channelTitle: "Northstar Shorts",
    youtubeChannelId: "UC_northstar",
    scope:
      "https://www.googleapis.com/auth/youtube.readonly " +
      "https://www.googleapis.com/auth/yt-analytics.readonly " +
      "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
    status: "connected",
    lastError: null,
    lastSyncAt: 1_700_000_000_000,
    revenueScopeGranted: true,
    monetizationStatus: "monetized",
    revenueSyncStatus: "ok",
    revenueSyncError: null,
    lastRevenueSyncAt: 1_700_000_000_000,
    nextSyncAt: null,
    connectedByName: "Tahsin",
    createdAt: 1_600_000_000_000,
    ...overrides,
  };
}

describe("youTubeSetupState — the five states the owner asked to read honestly", () => {
  it("reports the unconfigured deployment and does NOT offer a button that would bounce", () => {
    const state = youTubeSetupState({ configured: false, connections: [] });

    expect(state.id).toBe("not_configured");
    // /api/youtube/connect 302s straight back with error=not_configured, so a
    // button here would teach nobody anything — the admin screen names the
    // missing variables instead.
    expect(state.offerConnect).toBe(false);
  });

  it("distinguishes 'nothing connected' from 'not configured'", () => {
    const state = youTubeSetupState({ configured: true, connections: [] });

    expect(state.id).toBe("not_connected");
    // The one state where connecting is genuinely the next action.
    expect(state.offerConnect).toBe(true);
  });

  it("reports a healthy workspace as syncing", () => {
    const state = youTubeSetupState({ configured: true, connections: [connection()] });

    expect(state.id).toBe("syncing");
    expect(state.tone).toBe("success");
  });

  it("reports a grant that has stopped working, and says the figures are frozen", () => {
    const state = youTubeSetupState({
      configured: true,
      connections: [connection({ status: "needs_reauth" })],
    });

    expect(state.id).toBe("needs_reauth");
    expect(state.offerConnect).toBe(true);
    // The whole point of choosing "stop" over "fall back": the person has to be
    // told the numbers are not moving, not merely that something needs a click.
    expect(state.body).toMatch(/STOPPED updating/);
    expect(state.body).not.toMatch(/public API instead/);
  });

  it("reports a connection that cannot read revenue as its own state", () => {
    const state = youTubeSetupState({
      configured: true,
      connections: [connection({ revenueScopeGranted: false })],
    });

    expect(state.id).toBe("no_revenue_scope");
    expect(state.offerConnect).toBe(true);
  });

  /**
   * The state the owner called "connected but not in the Partner Programme".
   *
   * It is named `revenue_refused` and its copy states BOTH readings, because
   * Google returns the identical 403 for a channel outside the programme and for
   * a channel the connected account no longer owns. Asserting the hedge here is
   * what stops a future tidy-up from quietly turning an observation back into a
   * finding.
   */
  it("states both readings of a refused revenue report and asserts neither", () => {
    const state = youTubeSetupState({
      configured: true,
      connections: [connection({ revenueSyncStatus: "not_monetized" })],
    });

    expect(state.id).toBe("revenue_refused");
    expect(state.body).toMatch(/no longer owns the channel/);
    expect(state.body).toMatch(/Partner Programme/);
    expect(state.body).toMatch(/does not say which/);
  });

  it("never files a window of zeros as a refusal", () => {
    // "reported_zero" is YouTube ANSWERING with nothing, which is not evidence
    // about the channel at all — a channel earning fractions of a cent a day
    // reports the same. It must not be promoted to the refusal state.
    const state = youTubeSetupState({
      configured: true,
      connections: [connection({ revenueSyncStatus: "reported_zero" })],
    });

    expect(state.id).toBe("syncing");
  });

  it("lets the worst connection decide, so one broken grant is not buried", () => {
    const state = youTubeSetupState({
      configured: true,
      connections: [
        connection({ id: "a" }),
        connection({ id: "b" }),
        connection({ id: "c", status: "needs_reauth" }),
      ],
    });

    // Two of three are fine, and reporting "connected and syncing" would hide
    // the only fact on the screen worth acting on.
    expect(state.id).toBe("needs_reauth");
  });

  it("ranks a dead grant above a missing revenue permission", () => {
    const state = youTubeSetupState({
      configured: true,
      connections: [
        connection({ id: "a", revenueScopeGranted: false }),
        connection({ id: "b", status: "needs_reauth" }),
      ],
    });

    // A channel that has stopped updating outranks one that merely cannot
    // report money: the first is wrong data, the second is absent data.
    expect(state.id).toBe("needs_reauth");
  });

  it("counts the accounts once several are connected and healthy", () => {
    const state = youTubeSetupState({
      configured: true,
      connections: [connection({ id: "a" }), connection({ id: "b" })],
    });

    expect(state.id).toBe("syncing");
    expect(state.title).toContain("2 accounts");
  });
});

describe("grantsRevenueScope", () => {
  it("matches the monetary scope only when Google actually returned it", () => {
    expect(
      grantsRevenueScope(
        "https://www.googleapis.com/auth/youtube.readonly " +
          "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
      ),
    ).toBe(true);
  });

  it("does not mistake the non-monetary analytics scope for it", () => {
    // The two differ by one word and grant completely different things; a
    // substring test would read the first as the second.
    expect(
      grantsRevenueScope(
        "https://www.googleapis.com/auth/youtube.readonly " +
          "https://www.googleapis.com/auth/yt-analytics.readonly",
      ),
    ).toBe(false);
  });

  it("treats an empty scope string as granting nothing", () => {
    expect(grantsRevenueScope("")).toBe(false);
  });
});

describe("isHealthy", () => {
  it("is true only for a live connection", () => {
    expect(isHealthy(connection())).toBe(true);
    expect(isHealthy(connection({ status: "needs_reauth" }))).toBe(false);
    expect(isHealthy(connection({ status: "revoked" }))).toBe(false);
    // An unrecognised status is not optimistically treated as working.
    expect(isHealthy(connection({ status: "something_new" }))).toBe(false);
  });
});

describe("missingConfigSummary", () => {
  it("names the variables still to set, in order", () => {
    expect(
      missingConfigSummary({
        configured: false,
        missing: ["GOOGLE_CLIENT_ID", "APP_ENCRYPTION_KEY"],
        redirectUri: null,
      }),
    ).toBe("GOOGLE_CLIENT_ID, APP_ENCRYPTION_KEY");
  });

  it("says nothing when the deployment is configured", () => {
    expect(
      missingConfigSummary({ configured: true, missing: [], redirectUri: "https://x/y" }),
    ).toBeNull();
  });
});

describe("channelSourceCopy — what a channel says about where its numbers came from", () => {
  it("says nothing about a competitor on the public API", () => {
    // Every competitor, forever. A caption on two dozen competitor cards would
    // train people to skip the one card where the same words matter.
    expect(channelSourceCopy("public", "competitor")).toBeNull();
  });

  it("tells an owner their own channel is only showing public figures", () => {
    const copy = channelSourceCopy("public", "own");

    expect(copy).not.toBeNull();
    expect(copy?.label).toMatch(/Public figures only/);
    expect(copy?.tone).toBe("muted");
  });

  it("warns — loudly — that a channel with a dead connection has stopped moving", () => {
    const copy = channelSourceCopy("connection_unavailable", "own");

    expect(copy?.tone).toBe("warning");
    expect(copy?.label).toMatch(/frozen/);
    // The refusal to substitute the public API is the decision this whole
    // change turns on, and the reader is told it outright.
    expect(copy?.detail).toMatch(/NOT being read from the public API/);
  });

  it("reports a working connection as the source", () => {
    const copy = channelSourceCopy("connection", "own");

    expect(copy?.label).toMatch(/connected account/);
    expect(copy?.tone).toBe("muted");
  });

  /**
   * A competitor should never be in either connection state — connections are
   * only ever made for channels the account owns. If one somehow is, the line
   * still speaks: a frozen competitor is still a channel whose numbers have
   * stopped, and silence there would be the same bug this file exists to catch.
   */
  it("still speaks for a broken connection even on a channel filed as a competitor", () => {
    expect(channelSourceCopy("connection_unavailable", "competitor")?.tone).toBe("warning");
  });
});
