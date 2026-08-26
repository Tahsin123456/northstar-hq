"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * The Finance area's own navigation.
 *
 * A tab strip rather than three more sidebar entries: Overview, Entries and
 * Settings are three views of one ledger, and promoting them to top level would
 * put bookkeeping controls next to the tracker's analysis pages for everyone
 * who never opens them.
 *
 * Rendered by the segment layout so it survives navigation between the tabs —
 * the strip itself is never re-mounted, only the panel below it.
 */
const TABS = [
  { href: "/finance", label: "Overview" },
  { href: "/finance/entries", label: "Entries" },
  { href: "/finance/settings", label: "Settings" },
] as const;

export function FinanceNav() {
  const pathname = usePathname();

  return (
    <div className="border-b border-border bg-surface-sunken/40">
      {/* Same gutters and ceiling as PageContainer, so the tabs line up with
          the page title directly beneath them. */}
      <div className="mx-auto w-full max-w-[1400px] px-4 sm:px-6 lg:px-8">
        <nav className="-mb-px flex items-center gap-1 overflow-x-auto" aria-label="Finance">
          {TABS.map((tab) => {
            // "/finance" is a prefix of every other tab's href, so a prefix
            // match would light Overview up on all three. The index tab is the
            // one case that has to be exact.
            const isActive =
              tab.href === "/finance"
                ? pathname === "/finance"
                : pathname === tab.href || pathname.startsWith(`${tab.href}/`);

            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "whitespace-nowrap border-b-2 px-3 py-2.5 text-[13px] font-medium transition-colors duration-150",
                  isActive
                    ? "border-accent text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
