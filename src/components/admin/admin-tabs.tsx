"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useOptionalSession } from "@/components/providers/session-provider";
import { usePendingApprovals } from "@/hooks/use-employees";
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
  /**
   * Carries the size of the approvals queue when there is one.
   *
   * A flag rather than a number on the tab, because the count is fetched — the
   * table below is a static description of the section, and putting live data
   * in it would mean rebuilding the array on every render.
   */
  readonly showsPendingCount?: boolean;
}

const ADMIN_TABS: readonly AdminTab[] = [
  { href: "/admin", label: "Overview", exact: true },
  /*
   * Approvals sits second, ahead of the screen it draws its rows from.
   *
   * The other tabs are places to look something up; this one is a queue with
   * work in it, and the work is somebody who cannot sign in until an admin
   * clicks. Ordering it after People would put the one tab that expires — a
   * person waiting — behind one that never does. It carries the count as a
   * badge for the same reason: the queue is normally empty, and a tab that
   * never changes is a tab nobody looks at.
   */
  {
    href: "/admin/approvals",
    label: "Approvals",
    requires: "users.manage",
    showsPendingCount: true,
  },
  /*
   * People was two tabs — Users and Employees — describing the same colleagues
   * from two angles, and an admin's every real question spanned both.
   *
   * It is `users.manage`, which is what BOTH of them were. The screen is a
   * roster and a directory at once, and it only widens into salaries for a
   * viewer who also holds `payroll.view`. Gating the tab on the payroll
   * permission would hide the approval decisions from the admins meant to make
   * them; gating the COLUMNS is the API's job, and it does it by omitting the
   * fields rather than by blanking them.
   *
   * The prefix match keeps it lit on /admin/people/[id], the one person's
   * profile — leaving the tab dark there would suggest the admin had navigated
   * out of the section.
   */
  { href: "/admin/people", label: "People", requires: "users.manage" },
  /*
   * Niches is `settings.manage`, not `niches.manage`.
   *
   * The tab is not for organising the taxonomy — that is the main Niches page,
   * and a Head of Shorts does it there with `niches.manage`. This one exists to
   * set hit rate thresholds, which is organization-wide analysis configuration
   * and carries the permission that guards it. Gating it on `niches.manage`
   * would show it to somebody every control on it would refuse.
   */
  { href: "/admin/niches", label: "Niches", requires: "settings.manage" },
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

  /*
   * The badge count.
   *
   * Gated on the permission rather than on which tabs survived the filter,
   * because this component renders for everybody in the admin section — an
   * auditor, somebody with only the YouTube permission — and firing a
   * `users.manage` request on their behalf would put a 403 in the console of
   * every admin page they open, to decide whether to draw a badge they will
   * never see.
   *
   * It shares a cache key with the queue itself, so the number here and the
   * rows there are one request and cannot disagree.
   */
  const mayManageUsers = session?.can("users.manage") ?? false;
  const { data: queue } = usePendingApprovals({ enabled: mayManageUsers });
  const pendingCount = queue?.approvals.length ?? 0;

  return (
    // -mb-px pulls the 2px active underline over the container's hairline, so
    // the two read as one line rather than as a rule with a bar under it.
    <nav aria-label="Administration" className="-mb-px flex items-center gap-1 overflow-x-auto">
      {tabs.map((tab) => {
        const isActive = tab.exact
          ? pathname === tab.href
          : pathname === tab.href || pathname.startsWith(`${tab.href}/`);

        const badge = tab.showsPendingCount ? pendingCount : 0;

        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 pb-2.5 pt-3 text-[13px] font-medium",
              "transition-colors duration-150",
              isActive
                ? "border-accent text-foreground"
                : "border-transparent text-muted-foreground hover:border-border-strong hover:text-foreground",
            )}
          >
            {tab.label}
            {badge > 0 ? (
              <>
                <span
                  aria-hidden
                  // `text-background` against `bg-warning` in both themes: the
                  // warning token is a dark brown on light and an amber on
                  // dark, and the page background is the one colour that
                  // contrasts with both without a second variable.
                  className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-warning px-1.5 py-px text-[10px] font-semibold tabular-nums text-background"
                >
                  {badge}
                </span>
                {/* The words, not the pill: `aria-label` on a plain span with
                    no role is unreliably announced, and "Approvals 3" gives a
                    screen reader no way to tell a count from a name. */}
                <span className="sr-only">{badge} waiting for approval</span>
              </>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
