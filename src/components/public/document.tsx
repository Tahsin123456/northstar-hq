import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Typography primitives for the three public documents.
 *
 * The rest of the product is a dense analytics UI — 11–13px type in tables
 * that are scanned, not read. These pages are the opposite: a stranger, quite
 * possibly a Google reviewer on a phone, reading several hundred words top to
 * bottom. So the body size steps up to 14px with generous leading and the
 * measure is capped, while the colour tokens, radii and hairline borders stay
 * exactly the ones in globals.css. The pages should read as the same product
 * in a different register, not as a different product.
 *
 * Everything here is a plain server component. Nothing in this file may import
 * a provider, a hook or the API client: these pages render for a visitor with
 * no session, no SessionProvider above them, and no cookie to fetch with.
 */

export function DocumentTitle({
  title,
  intro,
  updated,
}: {
  title: string;
  intro: React.ReactNode;
  /** ISO date; omitted on pages where a revision date would be noise. */
  updated?: { label: string; iso: string };
}) {
  return (
    <header className="mb-10 border-b border-border pb-8">
      <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-foreground sm:text-[30px]">
        {title}
      </h1>
      <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">{intro}</p>
      {updated ? (
        <p className="mt-4 text-[12px] uppercase tracking-[0.14em] text-subtle-foreground">
          Last updated{" "}
          <time dateTime={updated.iso} className="tnum">
            {updated.label}
          </time>
        </p>
      ) : null}
    </header>
  );
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-9 first:mt-0">
      <h2 className="text-[17px] font-semibold tracking-tight text-foreground">{title}</h2>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

export function Paragraph({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={cn("text-[14px] leading-relaxed text-muted-foreground", className)}>
      {children}
    </p>
  );
}

export function Bullets({ children }: { children: React.ReactNode }) {
  return (
    <ul className="flex list-disc flex-col gap-2 pl-5 text-[14px] leading-relaxed text-muted-foreground marker:text-subtle-foreground">
      {children}
    </ul>
  );
}

/**
 * A labelled block — used for the OAuth scopes, where the raw scope string
 * matters (a reviewer compares it against the consent screen character for
 * character) and so is set in the mono face rather than paraphrased.
 */
export function Term({
  term,
  children,
}: {
  term: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-sunken px-4 py-3">
      <p className="break-words font-mono text-[12px] leading-relaxed text-foreground">{term}</p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

/**
 * A link out of this origin.
 *
 * Deliberately renders as an ordinary anchor with no target="_blank": Google's
 * brand verification fetches these pages and parses the HTML, and the fewer
 * unusual attributes sit on the privacy-policy link it is looking for, the
 * less there is to go wrong. `rel="noreferrer"` keeps the referrer off third
 * parties, matching the Referrer-Policy the app already sets.
 */
const LINK_CLASS =
  "text-accent underline decoration-border-strong underline-offset-2 transition-colors hover:text-accent-hover hover:decoration-accent";

export function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      rel="noreferrer"
      className={LINK_CLASS}
    >
      {children}
    </a>
  );
}

/** The same treatment for a link that stays on this origin. */
export function InternalLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className={LINK_CLASS}>
      {children}
    </Link>
  );
}
