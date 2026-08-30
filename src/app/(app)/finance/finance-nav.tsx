"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useOptionalSession } from "@/components/providers/session-provider";
import type { Permission } from "@/lib/auth/permissions";
import { cn } from "@/lib/utils";

/**
 * The Finance area's own navigation.
 *
 * A tab strip rather than four more sidebar entries: Overview, Entries, Payroll
 * and Settings are four views of what the company earns, spends and pays, and
 * promoting them to top level would put bookkeeping controls next to the
 * tracker's analysis pages for everyone who never opens them.
 *
 * Rendered by the segment layout so it survives navigation between the tabs —
 * the strip itself is never re-mounted, only the panel below it.
 *
 * TABS ARE FILTERED BY PERMISSION, WHICH THEY DID NOT USED TO BE.
 * Every tab needed `finance.view` when there were three of them, and the
 * segment layout had already established it — so a filter here would never have
 * filtered. Payroll broke that: it is `payroll.view`, individually grantable,
 * and held by people who have no finance access at all. Both directions are
 * real now, so both are hidden rather than offered and refused. Same rule as
 * the sidebar and the admin tabs: the gate that holds is the layout beside each
 * page and the `requirePermission` in each route handler.
 */
interface FinanceTab {
  readonly href: string;
  readonly label: string;
  readonly requires: Permission;
}

const TABS: readonly FinanceTab[] = [
  { href: "/finance", label: "Overview", requires: "finance.view" },
  { href: "/finance/entries", label: "Entries", requires: "finance.view" },
  /*
   * Payroll sits between the ledger and its settings, not at the end.
   *
   * It is money going out, like the entries above it — the difference is only
   * that it is calculated rather than typed in. Settings stays last because it
   * is the one tab that configures the others rather than reporting anything.
   */
  { href: "/finance/payroll", label: "Payroll", requires: "payroll.view" },
  { href: "/finance/settings", label: "Settings", requires: "finance.view" },
];

export function FinanceNav() {
  const pathname = usePathname();
  const session = useOptionalSession();

  const tabs = React.useMemo(
    () => TABS.filter((tab) => session?.can(tab.requires) ?? false),
    [session],
  );

  return (
    <div className="border-b border-border bg-surface-sunken/40">
      {/* Same gutters and ceiling as PageContainer, so the tabs line up with
          the page title directly beneath them. */}
      <div className="mx-auto w-full max-w-[1400px] px-4 sm:px-6 lg:px-8">
        <nav className="-mb-px flex items-center gap-1 overflow-x-auto" aria-label="Finance">
          {tabs.map((tab) => {
            // "/finance" is a prefix of every other tab's href, so a prefix
            // match would light Overview up on all of them. The index tab is
            // the one case that has to be exact. The others keep the prefix
            // match — it is what holds Payroll lit on /finance/payroll/history.
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
