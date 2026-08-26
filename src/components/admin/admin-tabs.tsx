"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useOptionalSession } from "@/components/providers/session-provider";
import type { Permission } from "@/lib/auth/permissions";
import { cn } from "@/lib/utils";

/**
 * The admin section's sub-navigation.
 *
 * Same rule as the sidebar: a tab is hidden unless the viewer holds the
 * capability behind it, because showing somebody a door that will not open is
 * a usability failure rather than a security one. The gate that actually holds
 * is `requirePermission` in each route handler, and the section's own
 * `layout.tsx` re-checks on the server before any of this renders.
 *
 * Overview carries no `requires` of its own. Reaching this component at all
 * means the layout already established that the viewer holds `users.manage` or
 * `audit.view`, and the Overview page renders only the panels their permissions
 * actually cover — so it is always a legitimate place for them to land.
 */

interface AdminTab {
  readonly href: string;
  readonly label: string;
  readonly requires?: Permission;
  /**
   * Overview lives at the section root, so it must match exactly — a prefix
   * match would leave it lit on every other tab.
   */
  readonly exact?: boolean;
}

const ADMIN_TABS: readonly AdminTab[] = [
  { href: "/admin", label: "Overview", exact: true },
  { href: "/admin/users", label: "Users", requires: "users.manage" },
  /*
   * Employees is `users.manage`, not `payroll.view`.
   *
   * The screen is a roster first — who works here, on what, since when — and
   * only widens into salaries for a viewer who also holds `payroll.view`. Gating
   * the tab on the payroll permission would hide the approval queue from the
   * admins who are meant to work it; gating the *columns* is the API's job, and
   * it does it by omitting the fields rather than by blanking them.
   */
  { href: "/admin/employees", label: "Employees", requires: "users.manage" },
  /*
   * Payroll is the other half of that split, and it IS `payroll.view`.
   *
   * Where Employees is a roster that widens into pay, this tab is nothing but
   * pay — the run, the totals, every colleague's figure — so the permission
   * that guards the columns there guards the whole door here. It comes with the
   * Admin role, and unlike `users.manage` it IS individually grantable: the
   * brief's rule is "no access unless explicitly granted", so this tab
   * legitimately appears for somebody an admin has deliberately given payroll
   * access to. `payroll.manage` — changing pay rather than reading it — is the
   * one that never appears on the grant checklist.
   *
   * The prefix match keeps it lit on /admin/payroll/history: history is the
   * same area rather than a sixth destination, and a sub-navigation for two
   * pages would be one more row of chrome than either page earns.
   */
  { href: "/admin/payroll", label: "Payroll", requires: "payroll.view" },
  { href: "/admin/audit", label: "Audit log", requires: "audit.view" },
  { href: "/admin/youtube", label: "YouTube", requires: "youtube.manage" },
];

export function AdminTabs() {
  const pathname = usePathname();
  const session = useOptionalSession();

  const tabs = React.useMemo(
    () => ADMIN_TABS.filter((tab) => !tab.requires || (session?.can(tab.requires) ?? false)),
    [session],
  );

  return (
    // -mb-px pulls the 2px active underline over the container's hairline, so
    // the two read as one line rather than as a rule with a bar under it.
    <nav aria-label="Administration" className="-mb-px flex items-center gap-1 overflow-x-auto">
      {tabs.map((tab) => {
        const isActive = tab.exact
          ? pathname === tab.href
          : pathname === tab.href || pathname.startsWith(`${tab.href}/`);

        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "whitespace-nowrap border-b-2 px-3 pb-2.5 pt-3 text-[13px] font-medium",
              "transition-colors duration-150",
              isActive
                ? "border-accent text-foreground"
                : "border-transparent text-muted-foreground hover:border-border-strong hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
