import { youtubeHqThumbnailUrl, youtubeMaxResThumbnailUrl } from "@/lib/format";
import type { PosterSource } from "./poster";

/**
 * Which frame of a LONG-FORM video to draw, and how to fit it — the 16:9
 * sibling of `posterSourceFor`, beside it in this directory because the two
 * are one rule with two source tables and must not drift apart in shape.
 *
 * THE RULE
 *
 * `maxresdefault.jpg` is the video's frame at 1280x720, and it is tried first
 * for the same reason `oardefault` is on the Shorts side: it is the only
 * source that matches the box's shape at a quality worth leading a card with.
 * It 404s for any upload whose source was not HD — common on older videos —
 * so the fallback is mandatory, not defensive.
 *
 * The fallback is `hqdefault.jpg`, which exists for EVERY video but is 480x360
 * — 4:3, the 16:9 frame letterboxed with black bars top and bottom. Drawn
 * `object-cover` into the 16:9 box, the crop removes exactly those bars: the
 * full frame survives, unlike the Shorts fallback where `contain` is the
 * honest fit because the fallback really is a different shape.
 *
 * THE BOX IS 16:9 IN BOTH BRANCHES (`LONGFORM_POSTER_FRAME`), for the reason
 * the Shorts box is 9:16 in both of its own: a box that changes shape as
 * images resolve reflows the whole grid.
 *
 * REUSES `PosterSource`, including its `isPortrait` field, which here reads as
 * "this is the PRIMARY source — the one state where an error is worth
 * handling, because there is somewhere left to fall back to". That is the
 * property the consumer (`PosterFrame`) actually keys its `onError` on; the
 * field's name comes from the Shorts side, where the primary source happens
 * to also be the portrait one.
 */
export function longformPosterSourceFor(
  videoId: string,
  failedSrc: string | null,
): PosterSource {
  const poster = youtubeMaxResThumbnailUrl(videoId);

  if (failedSrc === poster) {
    return {
      src: youtubeHqThumbnailUrl(videoId),
      isPortrait: false,
      width: 480,
      height: 360,
      // Cover, not contain: the 4:3 source is the 16:9 frame plus bars, and
      // the crop removes the bars. See the header.
      fit: "object-cover",
    };
  }

  return { src: poster, isPortrait: true, width: 1280, height: 720, fit: "object-cover" };
}
