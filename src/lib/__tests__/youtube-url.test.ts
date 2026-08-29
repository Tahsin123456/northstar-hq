import { describe, expect, it } from "vitest";
import {
  canonicalShortUrl,
  parseYouTubeVideoId,
  readExternalShortInput,
} from "@/lib/youtube-url";

/**
 * The parser is the security boundary for external Short links — whatever it
 * returns is what gets composed into an `href`. So the rejections below are not
 * tidiness; each one is a value that would otherwise reach a link.
 */

/** A well-formed id that exercises every character class an id may contain. */
const ID = "dQw4w9WgXcQ";
const ID_WITH_SYMBOLS = "a_B-9zZ0x-Y";

describe("parseYouTubeVideoId — accepted forms", () => {
  it.each([
    ["canonical Shorts URL", `https://www.youtube.com/shorts/${ID}`],
    ["Shorts URL without www", `https://youtube.com/shorts/${ID}`],
    ["Shorts URL with no scheme", `youtube.com/shorts/${ID}`],
    ["Shorts URL with no scheme and www", `www.youtube.com/shorts/${ID}`],
    ["mobile Shorts URL", `https://m.youtube.com/shorts/${ID}`],
    ["mobile URL with no scheme", `m.youtube.com/shorts/${ID}`],
    ["music host", `https://music.youtube.com/watch?v=${ID}`],
    ["watch URL", `https://www.youtube.com/watch?v=${ID}`],
    ["watch URL with no scheme", `www.youtube.com/watch?v=${ID}`],
    ["short link", `https://youtu.be/${ID}`],
    ["short link with no scheme", `youtu.be/${ID}`],
    ["http rather than https", `http://www.youtube.com/shorts/${ID}`],
    ["uppercase scheme and host", `HTTPS://WWW.YOUTUBE.COM/shorts/${ID}`],
    ["surrounding whitespace", `   https://www.youtube.com/shorts/${ID}\n`],
    ["trailing slash", `https://www.youtube.com/shorts/${ID}/`],
    // Nobody sets out to copy these; everybody ends up with one. A premiere
    // that became an ordinary video, a link lifted from an iframe, a URL old
    // enough to predate the current player. Each names a real video, so
    // refusing them would be fussing about where the link came from rather
    // than whether it points at something.
    ["live URL", `https://www.youtube.com/live/${ID}`],
    ["embed URL", `https://www.youtube.com/embed/${ID}`],
    ["legacy /v/ URL", `https://www.youtube.com/v/${ID}`],
  ])("reads the id from a %s", (_label, input) => {
    expect(parseYouTubeVideoId(input)).toBe(ID);
  });

  it.each([
    ["share tracking on youtu.be", `https://youtu.be/${ID}?si=Xa1b2C3d4E5f`],
    ["a feature parameter", `https://www.youtube.com/shorts/${ID}?feature=share`],
    ["a timestamp on a watch URL", `https://www.youtube.com/watch?v=${ID}&t=17s`],
    ["parameters before v=", `https://www.youtube.com/watch?app=desktop&v=${ID}&t=3`],
    ["a fragment", `https://www.youtube.com/shorts/${ID}#t=5`],
  ])("ignores %s", (_label, input) => {
    expect(parseYouTubeVideoId(input)).toBe(ID);
  });

  it("accepts every character an id is allowed to contain", () => {
    expect(parseYouTubeVideoId(`https://www.youtube.com/shorts/${ID_WITH_SYMBOLS}`)).toBe(
      ID_WITH_SYMBOLS,
    );
  });
});

describe("parseYouTubeVideoId — rejections", () => {
  it.each([
    ["a javascript: payload", "javascript:alert(document.cookie)"],
    ["a javascript: payload dressed as a link", "javascript:alert('youtube.com/shorts/x')"],
    ["a javascript: payload with whitespace", "  javascript:void(0)  "],
    ["a data: URL", "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="],
    ["a vbscript: URL", "vbscript:msgbox(1)"],
    ["a file: URL", "file:///etc/passwd"],
  ])("rejects %s", (_label, input) => {
    expect(parseYouTubeVideoId(input)).toBeNull();
  });

  it.each([
    ["a different site entirely", "https://vimeo.com/123456789"],
    ["a lookalike host", `https://youtube.com.evil.test/shorts/${ID}`],
    ["a host with youtube in the path", `https://evil.test/youtube.com/shorts/${ID}`],
    ["a host youtube appears inside", `https://notyoutube.com/shorts/${ID}`],
    ["an @-confused authority", `https://www.youtube.com@evil.test/shorts/${ID}`],
  ])("rejects %s", (_label, input) => {
    expect(parseYouTubeVideoId(input)).toBeNull();
  });

  it.each([
    ["an id that is too short", "https://www.youtube.com/shorts/abc123"],
    ["an id that is too long", `https://www.youtube.com/shorts/${ID}extra`],
    ["an id with illegal characters", "https://www.youtube.com/shorts/abc!def*ghi"],
    ["path traversal wearing an id's length", "https://www.youtube.com/shorts/../../etc"],
    ["a channel page", "https://www.youtube.com/@mrbeast"],
    ["a channel's Shorts tab", "https://www.youtube.com/@mrbeast/shorts"],
    ["a watch URL with no v parameter", "https://www.youtube.com/watch?list=PL123"],
    ["a watch URL with an empty v parameter", "https://www.youtube.com/watch?v="],
    ["the bare host", "https://www.youtube.com/"],
    ["youtu.be with no id", "https://youtu.be/"],
  ])("rejects %s", (_label, input) => {
    expect(parseYouTubeVideoId(input)).toBeNull();
  });

  it.each([
    ["an empty string", ""],
    ["whitespace", "   \n "],
    ["a sentence", "watch this short it is really good"],
    // A bare id is deliberately not accepted: "hello_world" is eleven legal
    // characters, and silently turning a typo into a link to a video nobody
    // chose is worse than asking for the URL the field is labelled with.
    ["a bare video id", ID],
    ["eleven characters that are not an id", "hello_world"],
  ])("rejects %s", (_label, input) => {
    expect(parseYouTubeVideoId(input)).toBeNull();
  });
});

describe("canonicalShortUrl", () => {
  it("composes the URL from the id rather than from anything pasted", () => {
    expect(canonicalShortUrl(ID)).toBe(`https://www.youtube.com/shorts/${ID}`);
  });

  it("normalises every accepted form to the same stored URL", () => {
    const forms = [
      `https://youtu.be/${ID}?si=abc`,
      `https://www.youtube.com/watch?v=${ID}&t=9`,
      `m.youtube.com/shorts/${ID}`,
    ];
    for (const form of forms) {
      const videoId = parseYouTubeVideoId(form);
      expect(videoId).not.toBeNull();
      expect(canonicalShortUrl(videoId as string)).toBe(
        `https://www.youtube.com/shorts/${ID}`,
      );
    }
  });
});

describe("readExternalShortInput", () => {
  it("treats an empty field as empty, not as an error", () => {
    expect(readExternalShortInput("")).toEqual({ status: "empty" });
    expect(readExternalShortInput("   ")).toEqual({ status: "empty" });
  });

  it("reports the id and the canonical URL for a good link", () => {
    expect(readExternalShortInput(`youtu.be/${ID}`)).toEqual({
      status: "valid",
      videoId: ID,
      url: `https://www.youtube.com/shorts/${ID}`,
    });
  });

  it("says what a good link looks like when the link is not YouTube", () => {
    const result = readExternalShortInput("https://vimeo.com/123456789");
    expect(result.status).toBe("invalid");
    expect(result.status === "invalid" && result.message).toContain("youtube.com/shorts");
  });

  it("distinguishes a YouTube page with no video from a non-YouTube link", () => {
    const noVideo = readExternalShortInput("https://www.youtube.com/@mrbeast");
    const notYouTube = readExternalShortInput("https://vimeo.com/123");
    expect(noVideo.status).toBe("invalid");
    expect(notYouTube.status).toBe("invalid");
    expect(noVideo.status === "invalid" && noVideo.message).not.toBe(
      notYouTube.status === "invalid" && notYouTube.message,
    );
  });

  it("refuses a javascript: URL with a message rather than accepting it", () => {
    const result = readExternalShortInput("javascript:alert(1)");
    expect(result.status).toBe("invalid");
  });
});
