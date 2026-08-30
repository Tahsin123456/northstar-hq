import type { NextConfig } from "next";

/**
 * Security headers.
 *
 * Applied here rather than in the proxy so they cover every response —
 * including API routes, which the proxy matcher deliberately excludes, and
 * static assets, which never reach it at all.
 *
 * A note on Content-Security-Policy: the strongest form of it (nonce-based,
 * no `unsafe-inline`) is not compatible with how this app currently loads —
 * Next injects inline bootstrap scripts, and the pre-paint theme script in
 * src/app/layout.tsx is inline by necessity, because deferring it would cause
 * a flash of the wrong theme. The policy below is therefore written to be
 * honestly enforceable rather than aspirational: it locks down the things that
 * matter most for this threat model (framing, object embedding, base URI, form
 * targets, and where connections may go) instead of shipping a script policy
 * that would have to be disabled the first time it broke a page.
 */
const CSP_DIRECTIVES = [
  "default-src 'self'",
  // 'unsafe-inline' is required by Next's inline bootstrap and the theme
  // script; 'unsafe-eval' is NOT included, which is the part that matters for
  // blocking injected code execution paths.
  "script-src 'self' 'unsafe-inline'",
  // Tailwind and the chart library both set inline styles.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  // YouTube avatars and thumbnails.
  "img-src 'self' data: blob: https://yt3.ggpht.com https://i.ytimg.com https://*.googleusercontent.com",
  // The app talks only to itself. Widen this if a rate provider is configured.
  "connect-src 'self' https://oauth2.googleapis.com https://www.googleapis.com",
  // Nothing in this app should ever be framed — clickjacking protection that
  // supersedes X-Frame-Options in modern browsers.
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  // Stops an injected <base> tag redirecting every relative URL on the page.
  "base-uri 'self'",
  // Stops an injected form posting credentials to an attacker's host.
  "form-action 'self'",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP_DIRECTIVES },
  // Legacy equivalent of frame-ancestors, for browsers that predate CSP3.
  { key: "X-Frame-Options", value: "DENY" },
  // Stops a browser second-guessing a Content-Type, which is how a JSON
  // response gets executed as script.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Do not leak internal paths or query strings to third parties.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // This app needs none of these; denying them limits what injected code can do.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  // Isolates the origin from cross-origin popups and embedding.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

/**
 * HSTS is added only in production.
 *
 * Sending it over plain-HTTP local development would pin localhost to HTTPS in
 * the developer's browser and break every other local project on that port —
 * a genuinely painful thing to undo.
 */
const PRODUCTION_HEADERS = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

/**
 * Where the screens that moved used to live.
 *
 * Bookmarks, pasted links in chat and the browser's own autocomplete all
 * outlive a rearrangement of the navigation, and the alternative to this list
 * is somebody landing on a 404 for a page that is very much still there. Every
 * in-app link was repointed at the same time; these exist purely for the URLs
 * already out in the world.
 *
 * `permanent: true` (308) rather than 307: these paths are not coming back, and
 * caching the redirect means the second visit costs nothing. Redirects are
 * checked before the filesystem and carry the query string through, which is
 * what keeps `/admin/payroll/history?year=2026&month=3` landing on the month it
 * named.
 *
 * NOT a substitute for authorization. A redirect only moves somebody to the new
 * URL; the layout there still decides whether they may see it.
 */
const MOVED_ROUTES = [
  // Payroll is money, so it now sits beside revenue and expenses rather than
  // beside user administration. `:path*` covers /admin/payroll/history and
  // anything added under it later.
  { source: "/admin/payroll", destination: "/finance/payroll", permanent: true },
  {
    source: "/admin/payroll/:path*",
    destination: "/finance/payroll/:path*",
    permanent: true,
  },
  // Users and Employees were two descriptions of the same colleagues. One
  // screen now, so both old paths land on it.
  { source: "/admin/users", destination: "/admin/people", permanent: true },
  { source: "/admin/employees", destination: "/admin/people", permanent: true },
  // One person's profile kept its shape and changed its parent.
  {
    source: "/admin/employees/:id",
    destination: "/admin/people/:id",
    permanent: true,
  },
  // Compare was deleted rather than moved, which makes it the one entry here
  // that is not a rename. It still belongs: it was a top-level route with a
  // sidebar item for months, so it is in bookmarks and in browser autocomplete,
  // and the block above exists precisely so those do not land on a 404.
  //
  // Overview is the honest destination. Compare ranked up to six channels on
  // hit rate, Shorts, views and consistency; the Overview table ranks ALL of
  // them on the same metrics and sorts by any column, which is what made
  // Compare redundant rather than merely unfashionable.
  { source: "/compare", destination: "/", permanent: true },
];

const nextConfig: NextConfig = {
  // Do not advertise the framework version to scanners.
  poweredByHeader: false,

  async redirects() {
    return MOVED_ROUTES;
  },

  async headers() {
    const headers = [
      ...SECURITY_HEADERS,
      ...(process.env.NODE_ENV === "production" ? PRODUCTION_HEADERS : []),
    ];

    return [
      {
        source: "/:path*",
        headers,
      },
      {
        // Belt and braces: the API layer already sets no-store on every
        // response, but a cached authenticated payload in a shared proxy is
        // bad enough to be worth stating twice.
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, no-cache, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
