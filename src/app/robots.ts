import type { MetadataRoute } from "next";

import { PUBLIC_SITE } from "@/lib/public-site";

/**
 * /robots.txt
 *
 * Until now this file did not exist and /robots.txt returned a 404, which was
 * harmless while every page was behind a login. Now that three documents are
 * deliberately public, saying which three is worth doing explicitly: crawl the
 * public pages, leave the rest of the product alone.
 *
 * Disallow-then-allow is the right way round here. `Disallow: /` is the
 * default position and the three `Allow` lines carve out the exceptions;
 * robots.txt resolves conflicts by longest match, so the more specific Allow
 * wins for those paths and nothing else is opened. Written this way, adding a
 * new gated route needs no change here — a route is private unless somebody
 * adds it to PUBLIC_SITE.paths.
 *
 * This is documentation for well-behaved crawlers, not a security control. It
 * is the `(app)` layout and the data access layer that keep the application
 * private, and neither of them cares what this file says.
 *
 * No `sitemap` key: there is no sitemap.ts in this project, and pointing at a
 * URL that 404s is worse than omitting the line.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
      allow: [PUBLIC_SITE.paths.about, PUBLIC_SITE.paths.privacy, PUBLIC_SITE.paths.terms],
    },
    host: PUBLIC_SITE.origin,
  };
}
