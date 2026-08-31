import { youtubeShortsPosterUrl, youtubeThumbnailUrl } from "@/lib/format";

/**
 * =========================================================================
 * WHICH FRAME OF A SHORT TO DRAW, AND HOW TO FIT IT
 * =========================================================================
 *
 * A pure function for the same reason `frameFor` is one: this is a RULE, and
 * the test runner has no DOM to observe the rule being followed in. Stated as a
 * value, "the portrait frame is tried first and the wide one is letterboxed
 * rather than cropped" is something a test can hold; left inline in the
 * component it is three ternaries that any later edit can quietly invert.
 *
 * THE RULE
 *
 * `oardefault.jpg` is the Short's own frame at its own aspect ratio — measured
 * 1080x1920, exactly 9:16. `mqdefault.jpg` is 320x180 WHATEVER THE VIDEO IS, so
 * for a Short it is that same frame pillarboxed into a 101px strip with
 * stretched blur either side. Drawing the second one as the lead element of a
 * browsing tile is how a grid the owner asked to be vertical ends up a wall of
 * wide boxes two thirds filled with filler.
 *
 * The portrait source is therefore tried first and always. It 404s when the
 * video is not really portrait — this app calls a video a Short from its
 * duration, and a sub-minute landscape upload is an ordinary thing for a
 * competitor to publish — so the fallback is mandatory, not defensive.
 *
 * THE BOX IS 9:16 IN BOTH BRANCHES. Only the fit changes. A 16:9 image told to
 * `cover` a portrait box loses a third off each side, which is exactly the crop
 * the old 40x54 row made in the other axis and threw away the sides of every
 * hook; `contain` letterboxes it instead, small and obviously wide, which is
 * honest. Changing the BOX to match the fallback would reflow the entire grid
 * as images resolve, which is worse than either.
 */
export interface PosterSource {
  readonly src: string;
  /**
   * Whether `src` is the portrait frame.
   *
   * Two jobs beyond the fit: it is the only state in which an error is worth
   * handling — once the fallback itself fails there is nothing left to try —
   * and it selects the intrinsic dimensions below.
   */
  readonly isPortrait: boolean;
  /** The intrinsic size of THIS source, so the browser has the ratio before a byte arrives. */
  readonly width: number;
  readonly height: number;
  /** The Tailwind object-fit for this source inside the fixed 9:16 box. */
  readonly fit: "object-cover" | "object-contain";
}

/**
 * @param failedSrc The URL that has already failed to load, or `null`.
 *
 * WHICH SOURCE FAILED, NOT A BOOLEAN, and that is what makes this total. The
 * caller holds it as state keyed to the URL, so a card recycled by the grid
 * onto a different Short gets a `videoId` whose poster no longer equals the
 * recorded failure and is considered untried again — without an effect, and
 * without the caller needing a `key`. A boolean would carry the previous
 * Short's failure onto the next one and permanently demote a perfectly good
 * portrait frame.
 */
export function posterSourceFor(videoId: string, failedSrc: string | null): PosterSource {
  const poster = youtubeShortsPosterUrl(videoId);

  if (failedSrc === poster) {
    return {
      src: youtubeThumbnailUrl(videoId),
      isPortrait: false,
      width: 320,
      height: 180,
      fit: "object-contain",
    };
  }

  return { src: poster, isPortrait: true, width: 1080, height: 1920, fit: "object-cover" };
}
