import { describe, expect, it } from "vitest";
import { parseChannelInput } from "../channel-resolver";

describe("parseChannelInput — canonical channel IDs", () => {
  it("accepts a bare UC id", () => {
    const parsed = parseChannelInput("UCX6OQ3DkcsbYNE6H8uQQuVA");
    expect(parsed).toEqual({
      kind: "channelId",
      value: "UCX6OQ3DkcsbYNE6H8uQQuVA",
      raw: "UCX6OQ3DkcsbYNE6H8uQQuVA",
    });
  });

  it("accepts a /channel/ URL", () => {
    const parsed = parseChannelInput("https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA");
    expect(parsed?.kind).toBe("channelId");
    expect(parsed?.value).toBe("UCX6OQ3DkcsbYNE6H8uQQuVA");
  });

  it("rejects a malformed channel id", () => {
    expect(parseChannelInput("https://www.youtube.com/channel/NOTACHANNEL")).toBeNull();
  });
});

describe("parseChannelInput — handles", () => {
  it("accepts a bare @handle", () => {
    expect(parseChannelInput("@mrbeast")).toEqual({
      kind: "handle",
      value: "@mrbeast",
      raw: "@mrbeast",
    });
  });

  it("accepts a handle with no @ and normalises it", () => {
    expect(parseChannelInput("mrbeast")?.value).toBe("@mrbeast");
  });

  it("accepts a full handle URL", () => {
    const parsed = parseChannelInput("https://www.youtube.com/@mrbeast");
    expect(parsed?.kind).toBe("handle");
    expect(parsed?.value).toBe("@mrbeast");
  });

  it("accepts a protocol-less URL", () => {
    expect(parseChannelInput("youtube.com/@mrbeast")?.value).toBe("@mrbeast");
  });

  it("strips a trailing channel tab", () => {
    // Pasting from the Shorts tab is the single most likely way a user of
    // *this* tool arrives at a channel URL.
    for (const tab of ["shorts", "videos", "streams", "about", "playlists", "community"]) {
      const parsed = parseChannelInput(`https://www.youtube.com/@mrbeast/${tab}`);
      expect(parsed?.kind).toBe("handle");
      expect(parsed?.value).toBe("@mrbeast");
    }
  });

  it("handles the mobile host", () => {
    expect(parseChannelInput("https://m.youtube.com/@mrbeast")?.value).toBe("@mrbeast");
  });

  it("ignores query strings and fragments", () => {
    expect(parseChannelInput("https://www.youtube.com/@mrbeast?sub_confirmation=1")?.value).toBe(
      "@mrbeast",
    );
  });

  it("trims surrounding whitespace", () => {
    expect(parseChannelInput("   @mrbeast   ")?.value).toBe("@mrbeast");
  });

  it("accepts handles containing dots, hyphens and underscores", () => {
    expect(parseChannelInput("@some.channel_name-1")?.kind).toBe("handle");
  });
});

describe("parseChannelInput — legacy URL forms", () => {
  it("recognises /user/ URLs", () => {
    const parsed = parseChannelInput("https://www.youtube.com/user/PewDiePie");
    expect(parsed?.kind).toBe("customUrl");
    expect(parsed?.value).toBe("PewDiePie");
  });

  it("recognises /c/ vanity URLs", () => {
    const parsed = parseChannelInput("https://www.youtube.com/c/PewDiePie");
    expect(parsed?.value).toBe("PewDiePie");
  });
});

describe("parseChannelInput — video URLs", () => {
  it("extracts the video id from a watch URL", () => {
    const parsed = parseChannelInput("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(parsed).toEqual({ kind: "videoUrl", value: "dQw4w9WgXcQ", raw: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  });

  it("extracts the video id from a youtu.be link", () => {
    expect(parseChannelInput("https://youtu.be/dQw4w9WgXcQ")?.value).toBe("dQw4w9WgXcQ");
  });

  it("extracts the video id from a Shorts URL", () => {
    const parsed = parseChannelInput("https://www.youtube.com/shorts/dQw4w9WgXcQ");
    expect(parsed?.kind).toBe("videoUrl");
    expect(parsed?.value).toBe("dQw4w9WgXcQ");
  });

  it("does not mistake a handle's /shorts tab for a video URL", () => {
    // "/@name/shorts" and "/shorts/<id>" both contain the segment "shorts";
    // only the second is a video.
    const parsed = parseChannelInput("https://www.youtube.com/@mrbeast/shorts");
    expect(parsed?.kind).toBe("handle");
  });
});

describe("parseChannelInput — rejection", () => {
  it("rejects empty and whitespace-only input", () => {
    expect(parseChannelInput("")).toBeNull();
    expect(parseChannelInput("    ")).toBeNull();
  });

  it("rejects non-YouTube hosts", () => {
    expect(parseChannelInput("https://vimeo.com/channels/staffpicks")).toBeNull();
    expect(parseChannelInput("https://www.tiktok.com/@someone")).toBeNull();
    // A lookalike host must not be accepted.
    expect(parseChannelInput("https://youtube.com.evil.example/@mrbeast")).toBeNull();
  });

  it("rejects free text that is not an identifier", () => {
    expect(parseChannelInput("find me a good shorts channel")).toBeNull();
  });

  it("rejects handles that are too short to be valid", () => {
    expect(parseChannelInput("@ab")).toBeNull();
  });
});
