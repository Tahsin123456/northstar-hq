import { describe, expect, it } from "vitest";
import type { YouTubeConnectionDTO } from "@/lib/dto";
import {
  coveredChannelsState,
  grantsRevenueScope,
  isHealthy,
  missingConfigSummary,
  ownChannelPickerState,
  youTubeSetupState,
} from "@/lib/youtube/connection-state";
import {
  IMPORTED_FIELD_GROUPS,
  IMPORT_COVERAGE_SUMMARY,
  UNAVAILABLE_FIELDS,
} from "@/lib/youtube/import-coverage";
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
    // The one channel a freshly connected account has. Nothing in this file
    // reads the list; it is here because the DTO is exact, and a fixture that
    // drifts from the type is a test that stops compiling for the wrong reason.
    coveredChannels: [
      {
        youtubeChannelId: "UC_northstar",
        title: "Northstar Shorts",
        handle: "@northstar",
        avatarUrl: null,
        channelUrl: "https://www.youtube.com/@northstar",
        isPrimary: true,
        confirmedAt: 1_700_000_000_000,
      },
    ],
    scope:
      "https://www.googleapis.com/auth/youtube.readonly " +
      "https://www.googleapis.com/auth/yt-analytics.readonly " +
      "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
    status: "connected",
    lastError: null,
    lastSyncAt: 1_700_000_000_000,
    channelSyncStatus: "ok",
    channelSyncError: null,
    lastChannelSyncAt: 1_700_000_000_000,
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

  /**
   * A FAILED SYNC IS NOT A FAILED AUTHORISATION, and the product used to have no
   * way to say the first.
   *
   * A channel sync that fails for a reason that is not the token — the channel
   * was deleted, the quota is spent, a 403 that is not a dead grant — wrote
   * nothing to the connection at all, so its card was indistinguishable from a
   * healthy one while nothing had updated for days.
   */
  it("reports a failed sync on a connection whose grant is still good", () => {
    const state = youTubeSetupState({
      configured: true,
      connections: [
        connection({
          channelSyncStatus: "error",
          channelSyncError: "YouTube no longer returns this channel.",
        }),
      ],
    });

    expect(state.id).toBe("sync_failed");
    // And does NOT send somebody through Google's consent screen for a problem
    // consent cannot fix. That is `needs_reauth`'s job and this is not it.
    expect(state.offerConnect).toBe(false);
    expect(state.body).toMatch(/authorisation is still good/i);
  });

  it("ranks a dead grant above a failed sync, and a failed sync above a missing scope", () => {
    expect(
      youTubeSetupState({
        configured: true,
        connections: [
          connection({ id: "a", channelSyncStatus: "error" }),
          connection({ id: "b", status: "needs_reauth" }),
        ],
      }).id,
    ).toBe("needs_reauth");

    expect(
      youTubeSetupState({
        configured: true,
        connections: [
          connection({ id: "a", revenueScopeGranted: false }),
          connection({ id: "b", channelSyncStatus: "error" }),
        ],
      }).id,
      // Stale figures outrank absent money: the first is wrong data on screen,
      // the second is a feature nobody has turned on.
    ).toBe("sync_failed");
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

/**
 * THE PICKER'S EMPTY CASES, WHICH USED TO RENDER NOTHING AT ALL.
 *
 * A Google account that owns no YouTube channel is real and unremarkable — a
 * Workspace account that only ever watched, or somebody who authorised with the
 * wrong address. The panel answered it with a blank area under a green
 * "connected and syncing" heading, which reads as a screen that failed to load.
 * The fact was stated only in the one-time banner immediately after the
 * callback, which nobody ever sees twice.
 */
describe("ownChannelPickerState", () => {
  it("says an account owns no channel instead of rendering nothing", () => {
    const state = ownChannelPickerState({
      discoveredCount: 0,
      offerableCount: 0,
      connectionCount: 1,
    });

    expect(state.id).toBe("none_owned");
    expect(state.title).toMatch(/owns no YouTube channel/i);
    // And names the way out, rather than leaving somebody to guess whether it
    // is broken.
    expect(state.body).toMatch(/Connect the account that actually owns your channels/i);
  });

  it("uses the plural when several accounts are connected", () => {
    const state = ownChannelPickerState({
      discoveredCount: 0,
      offerableCount: 0,
      connectionCount: 2,
    });

    expect(state.title).toMatch(/accounts own no YouTube channel/i);
  });

  it("confirms the finished state rather than falling silent", () => {
    const state = ownChannelPickerState({
      discoveredCount: 3,
      offerableCount: 0,
      connectionCount: 1,
    });

    expect(state.id).toBe("all_tracked");
    expect(state.title).toContain("3");
  });

  it("offers what is left, counted", () => {
    const state = ownChannelPickerState({
      discoveredCount: 3,
      offerableCount: 1,
      connectionCount: 1,
    });

    expect(state.id).toBe("offering");
    expect(state.title).toMatch(/^1 channel /);
  });
});

/**
 * THE CONNECTION CARD'S CHANNEL LIST, AND ESPECIALLY ITS EMPTY CASE.
 *
 * The owner connected an account and could not see the channel on Admin →
 * YouTube. Whatever else this list does, the sentence over an empty one has to
 * distinguish three situations that need three different actions: this account
 * genuinely owns no channel, this account's authorisation has died, and the
 * screen has simply not been told. A bare "No channels" reads as the last one
 * whichever is true, which is why the copy is decided here and tested.
 */
describe("coveredChannelsState", () => {
  it("explains an empty list on a working connection instead of just saying none", () => {
    const state = coveredChannelsState({ channelCount: 0, healthy: true });

    expect(state.id).toBe("none_confirmed");
    // States that the connection itself is fine, so nobody spends an afternoon
    // reconnecting a healthy account looking for a fault that is not there.
    expect(state.body).toMatch(/authorisation itself worked/i);
    // And names the one action that would change the answer.
    expect(state.body).toMatch(/reconnect the account/i);
  });

  it("gives a broken connection the different reason and the same action", () => {
    const state = coveredChannelsState({ channelCount: 0, healthy: false });

    expect(state.id).toBe("none_confirmed");
    // NOT "the authorisation worked": here it demonstrably has not, and saying
    // so would be the screen contradicting the red badge above it.
    expect(state.body).not.toMatch(/authorisation itself worked/i);
    expect(state.body).toMatch(/stopped working/i);
    expect(state.body).toMatch(/reconnect it/i);
  });

  it("counts the channels, singular and plural", () => {
    expect(coveredChannelsState({ channelCount: 1, healthy: true }).title).toBe(
      "1 channel confirmed on this account",
    );
    expect(coveredChannelsState({ channelCount: 3, healthy: true }).title).toBe(
      "3 channels confirmed on this account",
    );
  });

  /**
   * The count is a fact about the GRANT's confirmations, not about the account.
   *
   * Connecting records exactly one coverage row — the callback links
   * `fetchOwnChannel`, i.e. `fetchOwnChannels(...)[0] ?? null` — so an account
   * owning three channels sits at a count of one until the other two are added.
   * "Channel on this account" would state that one as a fact about the account,
   * which is the same confident quarter-truth the old singular "Channel" field
   * was removed for; the hedge is what makes the heading true at a count of one.
   */
  it("hedges the count as confirmations rather than as what the account owns", () => {
    for (const channelCount of [1, 2, 5]) {
      for (const healthy of [true, false]) {
        expect(coveredChannelsState({ channelCount, healthy }).title).toMatch(/confirmed/i);
      }
    }

    // The same word the empty heading uses, so the two do not read as claims of
    // different strengths about the same thing.
    expect(coveredChannelsState({ channelCount: 0, healthy: true }).title).toMatch(/confirmed/i);
  });

  /**
   * No figure is displayed on this card, so no copy on it may vouch for one.
   *
   * The channel names and avatars come from the globally shared `Channel` row,
   * which another workspace's public-API-key sync can rewrite; the counts were
   * dropped for exactly that reason. A sentence promising the reader that "these
   * figures" are connection-sourced would re-create the claim the removal was
   * meant to retire. The copy talks about what REACHES the channels — the grant
   * — which is what these rows actually know.
   */
  it("makes its provenance claim about the grant, never about displayed figures", () => {
    const healthy = coveredChannelsState({ channelCount: 2, healthy: true }).body;

    expect(healthy).toMatch(/public API/i);
    expect(healthy).not.toMatch(/figures/i);

    // The broken card may still say the CHANNELS are frozen — that is a fact
    // about syncing, not a claim about a number printed beside it.
    expect(coveredChannelsState({ channelCount: 2, healthy: false }).body).not.toMatch(
      /their figures/i,
    );
  });

  it("only sends somebody to add a channel while the grant can still do it", () => {
    // Adding an own channel asks Google what the account owns and refuses
    // anything it will not confirm, so on a dead grant that instruction points
    // at a button that cannot work. The broken card says reconnect instead.
    expect(coveredChannelsState({ channelCount: 2, healthy: true }).body).toMatch(
      /add them from the\s+Channels page/i,
    );
    expect(coveredChannelsState({ channelCount: 2, healthy: false }).body).not.toMatch(
      /Channels page/i,
    );
  });
});

/**
 * The unavailable list is a promise about honesty, so it is worth a test that
 * fails if somebody quietly deletes an entry to make a screen tidier — or adds
 * one to both lists, which would have the product claiming a field both arrives
 * and does not.
 */
describe("import coverage", () => {
  it("says out loud that connecting does not widen the field set", () => {
    expect(IMPORT_COVERAGE_SUMMARY).toMatch(/who asks, not what is asked for/i);
  });

  it("names watch time and click-through rate as unavailable, with a reason", () => {
    const analytics = UNAVAILABLE_FIELDS.find((field) => /watch time/i.test(field.label));

    expect(analytics).toBeDefined();
    expect(analytics?.kind).toBe("different_api");
    // Specifically: not estimated from something else. That is the rule the
    // owner set, and the one a helpful future edit is most likely to break.
    expect(analytics?.reason).toMatch(/not estimated/i);
  });

  it("says subscriber history cannot be drawn, even retroactively", () => {
    const subscribers = UNAVAILABLE_FIELDS.find((field) =>
      /subscriber count over time/i.test(field.label),
    );

    expect(subscribers?.kind).toBe("not_stored");
    expect(subscribers?.reason).toMatch(/retroactively/i);
  });

  it("never lists the same thing as both imported and unavailable", () => {
    for (const field of UNAVAILABLE_FIELDS) {
      for (const group of IMPORTED_FIELD_GROUPS) {
        expect(group.fields.toLowerCase()).not.toContain(field.label.toLowerCase());
      }
    }
  });
});
