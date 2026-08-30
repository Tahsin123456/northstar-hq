/**
 * The signed-out surface: /about, /privacy and /terms.
 *
 * These three pages exist for one reason. Google will not move an OAuth app
 * from "Testing" to "In production" until the Branding form carries a homepage
 * URL and a privacy policy URL, and it rejects both if they sit behind a login.
 * Everything else in this product is staff-only; these are the only pages a
 * stranger is ever meant to read, so their identity details are collected here
 * rather than inlined three times. Changing the support address in one file is
 * the difference between "update the contact email" and "hope you found all of
 * them".
 */

export const PUBLIC_SITE = {
  /**
   * ⚠ UNRESOLVED — THIS IS A GUESS AND MUST BE REPLACED BEFORE PUBLISHING.
   *
   * Nobody has confirmed that this mailbox exists. It was invented to make the
   * pages render; it is not a value anyone verified. It is deliberately left
   * wrong-and-loud rather than quietly plausible, because the failure it causes
   * is silent:
   *
   *   - Brand verification for the sensitive YouTube scopes involves a human
   *     reviewer who may write to this address. Mail into a mailbox that does
   *     not exist bounces or vanishes, and the review stalls with no visible
   *     error to debug.
   *   - The privacy policy tells readers to write here to have their data
   *     erased. Naming a dead channel for a data request is worse than naming
   *     none at all, because it looks like a route and is not one.
   *
   * Replace with the real mailbox — ideally the exact address already entered
   * as "User support email" on the Google Branding page, so a reviewer never
   * has to reconcile two different contacts for one app. It is one constant,
   * read by the footer of all three public pages and by three body paragraphs,
   * so this single edit is the whole change.
   */
  contactEmail: "hello@northstarstudios.cc",

  /**
   * The canonical origin, used to build the absolute URLs pasted into Google.
   *
   * Deliberately `www`, not the apex, and this was measured rather than
   * assumed. On 30 August 2026, `https://northstarstudios.cc/about` answered
   * `308` with `location: https://www.northstarstudios.cc/about`. So `www` is
   * the host the browser finally lands on, and the apex is the one that
   * redirects. Google's homepage check fails a URL that redirects to a
   * different host, so `www` is the only correct value to hand it.
   *
   * DO NOT "make this agree" with APP_URL by changing APP_URL to www.
   * APP_URL is not a cosmetic setting: `googleOAuthRedirectUri()` in
   * src/server/auth/google-oauth-env.ts builds the OAuth redirect URI from it,
   * and that URI must match one registered on the OAuth client byte for byte.
   * Editing APP_URL without registering the matching redirect URI in the Google
   * console first breaks the YouTube connection outright. The two values differ
   * on purpose and are read by unrelated code paths; this one is never used to
   * build a redirect URI.
   */
  origin: "https://www.northstarstudios.cc",

  /** Paths of the three public documents. Kept together so a rename cannot
   * update the navigation and quietly leave robots.ts or the proxy allowlist
   * pointing at a route that no longer exists. */
  paths: {
    about: "/about",
    privacy: "/privacy",
    terms: "/terms",
  },

  /** Shown to readers at the top of the privacy policy and the terms. */
  lastUpdated: "30 August 2026",
  /** Machine-readable form of the same date, for <time dateTime>. */
  lastUpdatedIso: "2026-08-30",
} as const;

/** Absolute URL for a public path, e.g. for the Google Branding form. */
export function publicUrl(path: string): string {
  return `${PUBLIC_SITE.origin}${path}`;
}
