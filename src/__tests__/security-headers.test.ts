import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { YOUTUBE_EMBED_ORIGIN } from "@/lib/format";

/**
 * =========================================================================
 * THE ONE DIRECTIVE THAT MOVED, AND EVERYTHING THAT MUST NOT
 * =========================================================================
 *
 * The in-app Shorts player required exactly one change to the content security
 * policy: `frame-src` went from `'none'` to a single YouTube host. That is a
 * deliberate hole in a header whose entire job is to be closed, so it is pinned
 * here — both that it is open exactly that far, and that nothing else drifted
 * open beside it.
 *
 * These read the real exported config rather than a copy of the string, so the
 * test fails on the file that ships rather than on a fixture that agrees with
 * it.
 */

async function cspFor(path: string): Promise<string> {
  const headers = await nextConfig.headers?.();
  const rule = headers?.find((entry) => entry.source === path);
  const csp = rule?.headers.find((h) => h.key === "Content-Security-Policy");
  // Not an optional chain into `expect`: a missing header must fail loudly
  // here rather than let every assertion below pass vacuously against "".
  if (typeof csp?.value !== "string") {
    throw new Error(`No Content-Security-Policy is set for ${path}`);
  }
  return csp.value;
}

function directive(csp: string, name: string): string | undefined {
  return csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
}

describe("content security policy", () => {
  it("is applied to every path, not only to pages", async () => {
    // The policy lives in next.config rather than the proxy precisely because
    // the proxy matcher excludes API routes and never sees static assets.
    await expect(cspFor("/:path*")).resolves.toContain("default-src 'self'");
  });

  /**
   * The widening, stated exactly.
   *
   * One origin, https, no wildcard, no second host. `frame-src *` would let any
   * injected markup frame a phishing page inside a screen a signed-in member of
   * staff already trusts, which is the whole attack this directive exists to
   * stop — so the shape of the value is asserted, not merely that YouTube
   * appears in it.
   */
  it("permits framing the Shorts player host and nothing else", async () => {
    const csp = await cspFor("/:path*");
    expect(directive(csp, "frame-src")).toBe(`frame-src ${YOUTUBE_EMBED_ORIGIN}`);
  });

  /**
   * The player's `src` and this header have to agree character for character or
   * the browser blocks every embed with nothing in the UI to say why. One
   * constant feeds both; this is what stops somebody inlining a literal into
   * either side and leaving them to drift.
   */
  it("names the same host the player actually loads", async () => {
    const csp = await cspFor("/:path*");
    expect(csp).toContain(YOUTUBE_EMBED_ORIGIN);
    expect(YOUTUBE_EMBED_ORIGIN.startsWith("https://")).toBe(true);
    expect(YOUTUBE_EMBED_ORIGIN).not.toContain("*");
  });

  /**
   * `frame-ancestors` is not `frame-src` and the two are one word apart.
   * `frame-ancestors 'none'` is what stops another site framing THIS app, which
   * is clickjacking protection for an authenticated internal tool; the player
   * needed nothing from it. Losing it while editing the line above would be a
   * silent, serious regression, so it gets its own failing assertion.
   */
  it("still refuses to be framed by anybody", async () => {
    const csp = await cspFor("/:path*");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");

    const headers = await nextConfig.headers?.();
    const rule = headers?.find((entry) => entry.source === "/:path*");
    expect(rule?.headers).toContainEqual({ key: "X-Frame-Options", value: "DENY" });
  });

  /**
   * The player is a plain <iframe> for this reason. The YouTube IFrame Player
   * API would have needed `script-src https://www.youtube.com` — a far larger
   * hole than a frame source — and the only thing it buys is stopping playback
   * on close, which unmounting the element already does.
   */
  it("did not widen script-src for a player API", async () => {
    const csp = await cspFor("/:path*");
    expect(directive(csp, "script-src")).toBe("script-src 'self' 'unsafe-inline'");
    expect(csp).not.toContain("unsafe-eval");
  });

  /**
   * Nothing else moved. `connect-src` is not involved in a plain iframe — the
   * frame is a separate browsing context with its own policy — and `img-src`
   * already allowed the thumbnail CDN before any of this.
   */
  it("left the other fetch directives where they were", async () => {
    const csp = await cspFor("/:path*");
    expect(directive(csp, "connect-src")).toBe(
      "connect-src 'self' https://oauth2.googleapis.com https://www.googleapis.com",
    );
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'self'");
    expect(directive(csp, "form-action")).toBe("form-action 'self'");
  });

  /**
   * The player needs `autoplay`, `encrypted-media` and fullscreen, and gets
   * them by delegation on the iframe element rather than by loosening the
   * site-wide policy. Camera, microphone, geolocation, payment and USB stay
   * denied to everything, embedded player included.
   */
  it("keeps the permissions policy fully closed", async () => {
    const headers = await nextConfig.headers?.();
    const rule = headers?.find((entry) => entry.source === "/:path*");
    const policy = rule?.headers.find((h) => h.key === "Permissions-Policy")?.value ?? "";
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) {
      expect(policy).toContain(`${feature}=()`);
    }
  });
});
