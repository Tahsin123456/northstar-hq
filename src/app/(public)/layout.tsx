import type { Metadata } from "next";
import Link from "next/link";

import { BRAND } from "@/lib/brand";
import { PUBLIC_SITE } from "@/lib/public-site";

/**
 * The public shell — /about, /privacy, /terms.
 *
 * This group exists so those three documents sit OUTSIDE `(app)`. That is the
 * whole safety story of this feature: `src/app/(app)/layout.tsx` is what
 * actually redirects a visitor with no session, and a page in a sibling route
 * group never renders inside it, so nothing here can loosen it. Equally, this
 * layout must never grow a `getActor()` call or mount SessionProvider — it
 * renders for someone with no cookie at all, exactly like `(auth)` does.
 *
 * Route groups do not appear in URLs, so these files resolve to /about,
 * /privacy and /terms. Do NOT add a `page.tsx` directly in this folder: it
 * would resolve to "/", which `(app)/page.tsx` already owns, and Next treats
 * two groups claiming one path as a build error rather than a runtime one.
 *
 * Being reachable is a separate matter from living outside `(app)`. The proxy
 * redirects every path that is not on its allowlist, so these three paths are
 * listed in PUBLIC_PATHS in `src/proxy.ts` as well; without that entry a
 * signed-out reader — including Google's — is bounced to /login, which is the
 * precise thing Google rejects.
 */
export const metadata: Metadata = {
  /**
   * The root layout sets `robots: { index: false, follow: false }`, which is
   * right for an internal tool and wrong for exactly these pages. Metadata is
   * inherited field by field, and a child that sets a field replaces it, so
   * overriding `robots` here re-opens the three public documents to crawlers
   * without touching the noindex that still covers every gated route.
   */
  robots: { index: true, follow: true },
};

const NAV = [
  { href: PUBLIC_SITE.paths.about, label: "About" },
  { href: PUBLIC_SITE.paths.privacy, label: "Privacy" },
  { href: PUBLIC_SITE.paths.terms, label: "Terms" },
] as const;

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-4 sm:px-6">
          <Link
            href={PUBLIC_SITE.paths.about}
            className="flex items-center gap-2.5 transition-opacity hover:opacity-80"
          >
            <span className="flex size-7 items-center justify-center rounded-md bg-accent text-[13px] font-semibold text-accent-foreground">
              N
            </span>
            <span className="text-[14px] font-semibold tracking-tight text-foreground">
              {BRAND.product}
            </span>
          </Link>
          <nav className="flex items-center gap-4 text-[13px]">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                {item.label}
              </Link>
            ))}
            <Link
              href="/login"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              Staff sign in
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-12 sm:px-6 sm:py-16">
        {children}
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-5 py-6 text-[12px] leading-relaxed text-subtle-foreground sm:px-6">
          <p>
            {BRAND.product} is an internal tool operated by {BRAND.company}. It is not a
            public product and has no public sign-up.
          </p>
          <p>
            <a
              href={`mailto:${PUBLIC_SITE.contactEmail}`}
              className="text-muted-foreground underline decoration-border-strong underline-offset-2 hover:text-foreground"
            >
              {PUBLIC_SITE.contactEmail}
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
