import { describe, expect, it } from "vitest";
import { addChannelRequest, createNicheRequest } from "../add-channel-request";

/**
 * The request shapes behind the add-channel dialog, pinned by value.
 *
 * Both facts here decide what the server is allowed to change, and both are
 * one refactor away from silently flipping: a helper that "tidies" the
 * ownership into every body would let the dialog's "competitor" default
 * demote an own channel filed from the other side; a picker that sends the
 * format for Shorts too would change every Shorts surface's request.
 */
describe("addChannelRequest", () => {
  const base = { youtubeChannelId: "UC1", ownershipType: "competitor" as const, nicheIds: ["n1"] };

  it("carries the ownership choice for a channel the tracker has never held", () => {
    expect(
      addChannelRequest({ ...base, alreadyTracked: false, previouslyRemoved: false }),
    ).toEqual({
      input: "UC1",
      ownershipType: "competitor",
      nicheIds: ["n1"],
    });
  });

  it("sends NO ownership key at all for a channel that is already tracked", () => {
    const body = addChannelRequest({ ...base, alreadyTracked: true, previouslyRemoved: false });
    expect(body).toEqual({ input: "UC1", nicheIds: ["n1"] });
    // Absent, not undefined-valued: JSON.stringify drops undefined, but the
    // pin is on the object so a stray `ownershipType: undefined` cannot creep
    // in and later be "fixed" into a value.
    expect(Object.keys(body)).toEqual(["input", "nicheIds"]);
  });

  /**
   * THE RESTORE, which is the case that shipped wrong. The selector cannot
   * show a stored "own" — the preview carries no ownership — so it renders
   * its "competitor" default, and sending that wrote "competitor" over "own"
   * on every restore, taking the channel out of every own-channel figure and
   * stopping its hits paying a bonus. The key has to be absent for the
   * service's "a restored row keeps what it had" branch to be reachable.
   */
  it("sends NO ownership key for a restore, even though the selector holds a value", () => {
    const body = addChannelRequest({
      ...base,
      alreadyTracked: false,
      previouslyRemoved: true,
      // Exactly what the dialog's default would have sent over a stored "own".
      ownershipType: "competitor",
    });
    expect(body).toEqual({ input: "UC1", nicheIds: ["n1"] });
    expect(Object.keys(body)).toEqual(["input", "nicheIds"]);
  });
});

describe("createNicheRequest", () => {
  it("sends only the name on the Shorts side, the request every Shorts surface always sent", () => {
    expect(createNicheRequest("GTA", "shorts")).toEqual({ name: "GTA" });
    expect(Object.keys(createNicheRequest("GTA", "shorts"))).toEqual(["name"]);
  });

  it("sends only the name when no format is known", () => {
    expect(createNicheRequest("GTA", undefined)).toEqual({ name: "GTA" });
  });

  it("names the list explicitly on the Long Form side", () => {
    expect(createNicheRequest("Docs", "longform")).toEqual({ name: "Docs", format: "longform" });
  });
});
