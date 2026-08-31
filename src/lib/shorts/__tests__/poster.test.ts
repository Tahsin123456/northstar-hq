import { describe, expect, it } from "vitest";
import { posterSourceFor } from "@/lib/shorts/poster";
import { youtubeShortsPosterUrl, youtubeThumbnailUrl } from "@/lib/format";

const ID = "5mU6SRS2Bxo";

/**
 * =========================================================================
 * A SHORT IS PORTRAIT, AND THE TILE HAS TO BE
 * =========================================================================
 *
 * The first version of the Shorts grid fixed the LAYOUT half of "display the
 * shorts vertically, not in horizontal long lines" and missed the SHAPE half.
 * Every tile was drawn from `mqdefault.jpg`, which is 320x180 whatever the
 * video is: for a 9:16 Short that is the real frame pillarboxed into a 101px
 * strip with stretched blur either side, so roughly two thirds of every tile
 * was filler. The code even argued for it in a comment, on the false premise
 * that no portrait thumbnail could be derived from a video id.
 *
 * It can. `oardefault.jpg` is the same frame at its original aspect ratio —
 * measured 1080x1920, exactly 9:16 — off the same id, with no API call, no key
 * and nothing stored. Verified against three real Shorts, and verified to 404
 * on a known landscape upload, which is what makes the fallback below reachable
 * rather than theoretical.
 */

describe("which frame of a Short gets drawn", () => {
  /**
   * The portrait frame is the DEFAULT, not an enhancement applied later. A
   * first paint that shows the letterboxed one and swaps is a visible flash of
   * the exact thing this change exists to remove.
   */
  it("asks for the portrait frame first, always", () => {
    const poster = posterSourceFor(ID, null);
    expect(poster.src).toBe(youtubeShortsPosterUrl(ID));
    expect(poster.src).toContain("oardefault");
    expect(poster.isPortrait).toBe(true);
  });

  /**
   * `oardefault` 404s for a video that is not really portrait — a sub-minute
   * landscape upload the Shorts detector accepted, or a Short since deleted or
   * made private. A tile with no image at all would be worse than a wide one.
   */
  it("falls back to the standard thumbnail once the portrait frame fails", () => {
    const poster = posterSourceFor(ID, youtubeShortsPosterUrl(ID));
    expect(poster.src).toBe(youtubeThumbnailUrl(ID));
    expect(poster.isPortrait).toBe(false);
  });

  /**
   * WHICH source failed, not a boolean. The card holds this as state and the
   * grid recycles cards, so a failure recorded against one Short must not
   * demote the next Short's perfectly good portrait frame. Keying on the URL is
   * what makes a new id count as untried without an effect or a `key`.
   */
  it("does not carry one Short's failure onto another", () => {
    const failed = youtubeShortsPosterUrl("someOtherId");
    expect(posterSourceFor(ID, failed).isPortrait).toBe(true);
    expect(posterSourceFor(ID, failed).src).toBe(youtubeShortsPosterUrl(ID));
  });

  /** Both sources come off the id alone — no stored URL ever becomes a `src`. */
  it("composes both sources from the video id alone", () => {
    for (const failedSrc of [null, youtubeShortsPosterUrl(ID)]) {
      const { src } = posterSourceFor(ID, failedSrc);
      expect(src.startsWith("https://i.ytimg.com/vi/")).toBe(true);
      expect(src).toContain(`/${ID}/`);
    }
  });
});

describe("how the frame is fitted", () => {
  /**
   * THE ONE THAT MATTERS FOR THE REVIEW.
   *
   * The box is 9:16 in both branches — changing it would reflow the whole grid
   * as images resolve — so the fallback is the case where the fit decides
   * whether the reader sees a whole frame or a cropped one. A 16:9 image told
   * to `cover` a portrait box loses about a third off EACH SIDE, which is
   * precisely the crop the old 40x54 row made in the other axis and which threw
   * away the sides of every hook. `contain` letterboxes it: small, obviously
   * wide, and complete.
   */
  it("letterboxes the wide fallback rather than cropping it", () => {
    expect(posterSourceFor(ID, youtubeShortsPosterUrl(ID)).fit).toBe("object-contain");
  });

  /** The portrait source is already exactly 9:16, so cover and contain agree — cover is stated for the pixel-rounding case. */
  it("fills the box with the portrait frame", () => {
    expect(posterSourceFor(ID, null).fit).toBe("object-cover");
  });

  /**
   * The intrinsic size of WHICHEVER source is showing, so the browser knows the
   * ratio before a byte arrives rather than inferring it from the class alone.
   * Handing a 320x180 `width`/`height` to a 1080x1920 image is how a tile
   * reserves the wrong space and settles by jumping.
   */
  it("declares the intrinsic size of the source it actually returns", () => {
    const portrait = posterSourceFor(ID, null);
    expect([portrait.width, portrait.height]).toEqual([1080, 1920]);
    expect(portrait.width / portrait.height).toBeCloseTo(9 / 16, 5);

    const wide = posterSourceFor(ID, youtubeShortsPosterUrl(ID));
    expect([wide.width, wide.height]).toEqual([320, 180]);
    expect(wide.width / wide.height).toBeCloseTo(16 / 9, 5);
  });
});
