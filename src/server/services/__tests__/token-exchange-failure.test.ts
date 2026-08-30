import { describe, expect, it, vi } from "vitest";

/**
 * What an administrator is told when Google refuses the code exchange.
 *
 * This exists because the generic version of this message cost a real day. A
 * wrong client secret fails at the LAST step of the flow: Google renders the
 * consent screen from the client id alone, so the approval is flawless and the
 * exchange behind it fails with `invalid_client`. Told only "start the
 * connection again", the admin does exactly that — through two warning screens
 * and a permission list — and gets the identical failure, with the one useful
 * word sitting in a server log they cannot read.
 *
 * So the mapping is the product here, and these tests are about the DISTINCTION
 * rather than about wording: each branch has to say something the others do not,
 * and in particular the two "do not retry" cases must not tell anyone to retry.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 7).toString("base64");
process.env.APP_URL = "https://www.northstarstudios.cc";

vi.mock("@/server/db", () => ({ prisma: {} }));

const { explainTokenExchangeFailure } = await import("../youtube-oauth-service");

describe("explaining a refused Google token exchange", () => {
  it("says retrying cannot help when the credentials are wrong", () => {
    const message = explainTokenExchangeFailure("invalid_client");

    expect(message).toMatch(/will not help/i);
    expect(message).toContain("GOOGLE_CLIENT_SECRET");
    // The trap this whole mapping exists for: a consent screen that works
    // perfectly is not evidence the credentials are good, and the message has to
    // say so or the admin keeps re-approving.
    expect(message).toMatch(/consent screen still works/i);
  });

  it("names the exact callback address when Google does not recognise it", () => {
    const message = explainTokenExchangeFailure("redirect_uri_mismatch");

    // The literal string to paste into Google, not a description of it. An admin
    // who has to reconstruct this by hand is who gets www wrong in the first
    // place.
    expect(message).toContain("https://www.northstarstudios.cc/api/youtube/callback");
    expect(message).toMatch(/www and non-www/i);
  });

  it("does tell them to start again when the code is spent, because there it works", () => {
    const message = explainTokenExchangeFailure("invalid_grant");

    expect(message).toMatch(/start the connection again/i);
    expect(message).toMatch(/without reloading or going back/i);
  });

  it("falls back to the generic message for a code it does not know", () => {
    expect(explainTokenExchangeFailure("something_new_from_google")).toBe(
      "Google rejected the sign-in. Start the connection again.",
    );
    expect(explainTokenExchangeFailure(null)).toBe(
      "Google rejected the sign-in. Start the connection again.",
    );
  });

  /**
   * Asserted as a set rather than per-branch: the failure mode being guarded is
   * a copy-paste between cases, which leaves every individual test above passing
   * while two branches say the same thing and the mapping stops distinguishing
   * anything.
   */
  it("gives each known cause its own distinct message", () => {
    const messages = [
      explainTokenExchangeFailure("invalid_client"),
      explainTokenExchangeFailure("redirect_uri_mismatch"),
      explainTokenExchangeFailure("invalid_grant"),
      explainTokenExchangeFailure(null),
    ];

    expect(new Set(messages).size).toBe(messages.length);
  });

  /**
   * Google's `error_description` can echo request material, so it is logged and
   * never shown. These messages are ours, and must stay free of anything that
   * could carry a code, a token or a URL parameter.
   */
  it("never leaks credential material into a user-facing string", () => {
    for (const code of ["invalid_client", "redirect_uri_mismatch", "invalid_grant", null]) {
      const message = explainTokenExchangeFailure(code);
      expect(message).not.toMatch(/GOCSPX-/);
      expect(message).not.toMatch(/code=/);
      expect(message).not.toMatch(/access_token|refresh_token/);
    }
  });
});
