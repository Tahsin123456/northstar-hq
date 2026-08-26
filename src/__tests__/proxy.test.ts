import { describe, expect, it } from "vitest";

/**
 * Redirect behaviour of `src/proxy.ts`.
 *
 * These exist because of a real loop found in testing. A cookie carrying a
 * valid signature but a dead session — revoked, expired, deactivated account,
 * or a database that was reset — used to bounce forever: the proxy saw "signed
 * in" and sent the visitor to "/", the authenticated layout saw no session and
 * sent them to "/login", and the proxy sent them back. The person could not
 * reach the one page that would have fixed it.
 *
 * The lesson generalises beyond the bug: the proxy can verify a signature but
 * cannot see the database, so it must never make a decision that depends on
 * whether a session is still real. Every case below asserts that a chain
 * terminates.
 */

process.env.SESSION_SECRET = Buffer.alloc(32, 3).toString("base64");

const { proxy, config } = await import("@/proxy");
const { formatSessionCookie, generateToken, SESSION_COOKIE_NAME } = await import(
  "@/server/auth/tokens"
);

/** Minimal stand-in for the NextRequest shape the proxy actually reads. */
function requestFor(pathname: string, cookieValue?: string) {
  const url = new URL(`http://localhost:3000${pathname}`);
  return {
    nextUrl: url,
    url: url.toString(),
    cookies: {
      get: (name: string) =>
        name === SESSION_COOKIE_NAME && cookieValue ? { name, value: cookieValue } : undefined,
    },
  } as unknown as Parameters<typeof proxy>[0];
}

const destinationOf = (pathname: string, cookie?: string): string | null => {
  const response = proxy(requestFor(pathname, cookie));
  const location = response.headers.get("location");
  return location ? new URL(location).pathname + new URL(location).search : null;
};

describe("unauthenticated visitors", () => {
  it("sends a protected page to the login screen", () => {
    expect(destinationOf("/")).toBe("/login");
    expect(destinationOf("/finance")).toBe("/login?next=%2Ffinance");
    expect(destinationOf("/admin/users")).toBe("/login?next=%2Fadmin%2Fusers");
  });

  it("lets the public pages through", () => {
    for (const path of [
      "/login",
      "/setup",
      "/forgot-password",
      "/reset-password/abc",
      "/invite/abc",
    ]) {
      expect(destinationOf(path)).toBeNull();
    }
  });

  it("only ever carries a same-site path forward", () => {
    // `next` is echoed into the login URL, so an absolute or protocol-relative
    // value here would be an open redirect straight after authentication.
    const destination = destinationOf("/channels");
    expect(destination).toBe("/login?next=%2Fchannels");
    expect(destination).not.toContain("//");
  });
});

describe("a cookie whose session is dead", () => {
  // The exact shape of the bug: correctly signed, but the row behind it is gone.
  const staleCookie = formatSessionCookie(generateToken());

  it("does not bounce /login or /setup back to the app", () => {
    // If either of these redirected, the authenticated layout would redirect
    // straight back and the visitor would be stuck between the two forever.
    expect(destinationOf("/login", staleCookie)).toBeNull();
    expect(destinationOf("/setup", staleCookie)).toBeNull();
  });

  it("lets a protected page through so the layout can make the real decision", () => {
    // The proxy has no database. Passing the request on is correct: the DAL
    // resolves the session properly and redirects if it is not valid.
    expect(destinationOf("/", staleCookie)).toBeNull();
  });
});

describe("a garbage or tampered cookie", () => {
  it("is treated as no cookie at all", () => {
    for (const value of ["", "nonsense", "a.b", `${generateToken()}.notasignature`]) {
      expect(destinationOf("/", value)).toBe("/login");
    }
  });
});

describe("matcher", () => {
  it("excludes the API surface", () => {
    // /api must never be redirected: those routes answer a fetch with JSON, and
    // a 302 to an HTML login page surfaces as a parse error rather than a clean
    // 401. They authenticate themselves through the DAL instead.
    const pattern = config.matcher[0];
    expect(pattern).toContain("api");
    expect(pattern).toContain("_next/static");
  });
});
