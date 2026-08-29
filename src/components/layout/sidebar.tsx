"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Bookmark,
  Coins,
  ShieldCheck,
  Wallet,
  Flame,
  GitCompareArrows,
  Layers,
  LayoutDashboard,
  Moon,
  Settings,
  Shapes,
  StickyNote,
  Sun,
  Swords,
  TrendingUp,
  Tv2,
} from "lucide-react";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";
import { useTheme } from "@/components/providers/theme-provider";
import { useOptionalSession } from "@/components/providers/session-provider";
import type { Permission } from "@/lib/auth/permissions";

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Matches nested routes, e.g. /channels/abc under /channels. */
  matchPrefix?: boolean;
  /**
   * Hide this item unless the signed-in user holds one of these.
   *
   * An affordance, not a control. The route and its API are enforced
   * server-side regardless of what the sidebar renders — this exists so people
   * are not shown doors that will not open for them, which is a usability
   * concern rather than a security one.
   */
  requires?: readonly Permission[];
}

interface NavSection {
  label: string | null;
  items: NavItem[];
}

/**
 * Grouped so the sidebar stays readable as the app grows.
 *
 * "Intelligence" is the discovery loop — find something, judge it, keep it.
 * "Tracker" is the underlying data being managed. Without the grouping this
 * would be nine flat items, which is the point at which a sidebar stops being
 * scannable.
 */
const NAV_SECTIONS: NavSection[] = [
  {
    label: null,
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/our-vs-market", label: "Our vs Market", icon: Swords },
      { href: "/compare", label: "Compare", icon: GitCompareArrows },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { href: "/winners", label: "Winners", icon: Flame },
      { href: "/outliers", label: "Outliers", icon: TrendingUp },
      { href: "/notes", label: "Notes", icon: StickyNote },
      { href: "/saved", label: "Saved", icon: Bookmark },
    ],
  },
  {
    label: "Tracker",
    items: [
      { href: "/channels", label: "Channels", icon: Tv2, matchPrefix: true },
      // `matchPrefix` because a niche's own page is `/niches/[id]`, and the
      // sidebar losing its highlight there would suggest the user had left the
      // Tracker.
      { href: "/niches", label: "Niches", icon: Layers, matchPrefix: true },
      // Beside Niches because they are the two taxonomies — which slice of the
      // operation owns a channel, and what the work itself is — and a reader
      // looking for one is usually deciding between them.
      //
      // TOP LEVEL, not a tab inside Niches and not a settings pane. The feature
      // was reported missing twice while it was reachable only by opening a
      // niche first, which is the answer to a question nobody asks in those
      // words: you go looking for "content types", not for the niche you
      // happened to define them under.
      { href: "/content-types", label: "Content Types", icon: Shapes },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
  {
    label: "Business",
    items: [
      {
        // An employee's own pay, and only ever their own row.
        //
        // This was listed unconditionally, on the reasoning that every role held
        // `earnings.view_own` so a filter here would never filter. That stopped
        // being true when the permission was withheld from Admin — an admin
        // reads the whole payroll next door, so a personal earnings page would
        // be a narrower version of a screen they already have. Without the gate
        // they kept a nav entry to a page that answers 403.
        href: "/earnings",
        label: "Your Earnings",
        icon: Coins,
        requires: ["earnings.view_own"],
      },
      {
        href: "/finance",
        label: "Finance",
        icon: Wallet,
        matchPrefix: true,
        requires: ["finance.view"],
      },
    ],
  },
  {
    label: "Administration",
    items: [
      {
        href: "/admin",
        label: "Admin",
        icon: ShieldCheck,
        matchPrefix: true,
        // Either capability is enough to have somewhere useful to land: the
        // admin area shows only the panels the person can actually use.
        requires: ["users.manage", "audit.view", "youtube.manage"],
      },
    ],
  },
];

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const session = useOptionalSession();

  // Sections whose every item is hidden are dropped entirely, so a Channel
  // Director does not see an empty "Administration" heading advertising that
  // there is something there they cannot reach.
  const visibleSections = React.useMemo(
    () =>
      NAV_SECTIONS.map((section) => ({
        ...section,
        items: section.items.filter(
          (item) => !item.requires || (session?.canAny(item.requires) ?? false),
        ),
      })).filter((section) => section.items.length > 0),
    [session],
  );

  return (
    <nav className="flex flex-col gap-4" aria-label="Main">
      {visibleSections.map((section, index) => (
        <div key={section.label ?? `section-${index}`} className="flex flex-col gap-0.5">
          {section.label ? (
            <div className="px-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
              {section.label}
            </div>
          ) : null}
          {section.items.map((item) => {
            const isActive = item.matchPrefix
              ? pathname === item.href || pathname.startsWith(`${item.href}/`)
              : pathname === item.href;

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "group relative flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] font-medium",
                  "transition-colors duration-150",
                  isActive
                    ? "bg-surface-hover text-foreground"
                    : "text-muted-foreground hover:bg-surface-hover/60 hover:text-foreground",
                )}
              >
                <item.icon
                  className={cn(
                    "size-4 shrink-0 transition-colors",
                    isActive
                      ? "text-accent"
                      : "text-subtle-foreground group-hover:text-muted-foreground",
                  )}
                />
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export function BrandMark() {
  return (
    <Link href="/" className="flex items-center gap-2.5 px-1 group">
      <span className="flex size-7 items-center justify-center rounded-md bg-accent text-accent-foreground">
        <BarChart3 className="size-4" strokeWidth={2.5} />
      </span>
      <span className="flex flex-col leading-none">
        <span className="text-[13px] font-semibold tracking-tight text-foreground">
          {BRAND.product}
        </span>
        <span className="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
          {BRAND.company}
        </span>
      </span>
    </Link>
  );
}

export function ThemeToggle() {
  // `ready` is false during SSR and the first hydration pass, when the stored
  // theme is not yet known. A neutral label until then avoids both a hydration
  // mismatch and a visible flip of the icon on load.
  const { theme, toggle, ready } = useTheme();

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      className="flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] font-medium text-muted-foreground transition-colors hover:bg-surface-hover/60 hover:text-foreground"
    >
      {ready && theme === "dark" ? (
        <Sun className="size-4 shrink-0 text-subtle-foreground" />
      ) : (
        <Moon className="size-4 shrink-0 text-subtle-foreground" />
      )}
      {ready ? (theme === "dark" ? "Light mode" : "Dark mode") : "Theme"}
    </button>
  );
}
