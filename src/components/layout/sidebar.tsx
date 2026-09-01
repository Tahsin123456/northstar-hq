"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Bookmark,
  Clapperboard,
  Coins,
  Film,
  ShieldCheck,
  Wallet,
  Flame,
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
  /**
   * A Shorts surface — hidden from an actor whose `contentScope` is "longs".
   *
   * PER ITEM, not per section, and the granularity is load-bearing: Notes and
   * Saved live in the same "Intelligence" section as Winners and Outliers, are
   * format-neutral, and stay for everybody — hiding whole sections would take
   * them from exactly the people the spec keeps them for. Sections whose every
   * item is hidden are already dropped by the existing empty-section rule.
   *
   * Same affordance-not-boundary caveat as `requires`: the API refuses a
   * longs-role's `?format=shorts` regardless of what this renders.
   */
  shortsOnly?: boolean;
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
 *
 * EVERY SECTION HERE IS A PLACE TO DO THE WORK. Settings is not, so it is not
 * in this table at all — see `SidebarFooterNav` at the bottom of this file.
 */
const NAV_SECTIONS: NavSection[] = [
  {
    label: null,
    items: [
      // Compare is gone, and nothing replaced it. The Overview table already
      // ranks every channel on the same metrics and sorts by any of them, so
      // the one thing Compare added over it was a six-channel ceiling.
      { href: "/", label: "Overview", icon: LayoutDashboard, shortsOnly: true },
      { href: "/our-vs-market", label: "Our vs Market", icon: Swords, shortsOnly: true },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { href: "/winners", label: "Winners", icon: Flame, shortsOnly: true },
      { href: "/outliers", label: "Outliers", icon: TrendingUp, shortsOnly: true },
      // Notes and Saved are format-neutral and stay for every role — the
      // reason `shortsOnly` is an item flag rather than a section one.
      { href: "/notes", label: "Notes", icon: StickyNote },
      { href: "/saved", label: "Saved", icon: Bookmark },
    ],
  },
  {
    // The other side of the operation, as its own place to do the work.
    // `longs.view` is held by admin and the two longs roles only, so a
    // shorts-role user never sees this section at all — and an admin gains it
    // beside everything they already had, which is the one visible sidebar
    // change for them.
    label: "Long Form",
    items: [
      { href: "/longform", label: "Overview", icon: Clapperboard, requires: ["longs.view"] },
      { href: "/longform/videos", label: "Videos", icon: Film, requires: ["longs.view"] },
      { href: "/longform/niches", label: "Niches", icon: Layers, requires: ["longs.view"] },
    ],
  },
  {
    label: "Tracker",
    items: [
      { href: "/channels", label: "Channels", icon: Tv2, matchPrefix: true, shortsOnly: true },
      { href: "/niches", label: "Niches", icon: Layers, shortsOnly: true },
      // Beside Niches because they are the two taxonomies — which slice of the
      // operation owns a channel, and what the work itself is — and a reader
      // looking for one is usually deciding between them.
      //
      // TOP LEVEL, not a tab inside Niches and not a settings pane. The feature
      // was reported missing twice while it was reachable only by opening a
      // niche first, which is the answer to a question nobody asks in those
      // words: you go looking for "content types", not for the niche you
      // happened to define them under.
      //
      // `shortsOnly` even though the tags themselves are format-neutral: the
      // PAGE is built over the Shorts dataset, and a longs-role user reaching
      // it would meet the 403 with nothing they could do there.
      { href: "/content-types", label: "Content Types", icon: Shapes, shortsOnly: true },
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
        // Either capability opens a real tab in there. Payroll moved into
        // Finance and kept `payroll.view`, which is individually grantable —
        // so somebody may hold it with no finance access at all, and listing
        // only `finance.view` here would hide the section from the one person
        // an admin deliberately gave payroll to. The section's layouts decide
        // which half of it they actually reach.
        requires: ["finance.view", "payroll.view"],
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

  // Which side of the operation the signed-in role is about, straight off the
  // session's ActorDTO — the same resolved value the server derived, so the
  // sidebar cannot disagree with the role table.
  const contentScope = session?.user.contentScope;

  // Sections whose every item is hidden are dropped entirely, so a Channel
  // Director does not see an empty "Administration" heading advertising that
  // there is something there they cannot reach — and a longs-role user does
  // not see a "Tracker" heading over nothing once its items are all Shorts.
  const visibleSections = React.useMemo(
    () =>
      NAV_SECTIONS.map((section) => ({
        ...section,
        items: section.items.filter((item) => {
          // Shorts surfaces disappear for a longs-scoped role. "all" (admin)
          // and "shorts" both keep them, so for every current user this
          // filter removes nothing.
          if (item.shortsOnly && contentScope === "longs") return false;
          return !item.requires || (session?.canAny(item.requires) ?? false);
        }),
      })).filter((section) => section.items.length > 0),
    [session, contentScope],
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
          {section.items.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              pathname={pathname}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}

/**
 * One row of the sidebar.
 *
 * Extracted so the footer's Settings link is the same component rather than the
 * same classes copied — the two sit two elements apart in the finished sidebar,
 * and a divergence between them would be visible at a glance.
 */
function NavLink({
  item,
  pathname,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  onNavigate?: () => void;
}) {
  const isActive = item.matchPrefix
    ? pathname === item.href || pathname.startsWith(`${item.href}/`)
    : pathname === item.href;

  return (
    <Link
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
          isActive ? "text-accent" : "text-subtle-foreground group-hover:text-muted-foreground",
        )}
      />
      {item.label}
    </Link>
  );
}

/**
 * Settings, and where it went.
 *
 * IT WAS IN "TRACKER", WHICH WAS WRONG. Nothing on that screen tracks anything:
 * for an employee it is their own name, email and password, and for an admin it
 * is the organization's analysis defaults, collection cadence and currency.
 * Filed beside Channels and Niches it read as a fourth kind of tracked data.
 *
 * IT IS NOT IN A SECTION AT ALL, AND THAT IS THE POINT. Every group above is a
 * place to do the work — find something, manage it, get paid for it. Settings
 * is where you go to change the tool you were doing that work with, which is a
 * different kind of destination and belongs apart from them rather than as the
 * odd item inside one. Inventing a "Personal" or "You" heading for a section of
 * one would have been a heading that describes a single link.
 *
 * So it sits in the sidebar's footer, immediately above the theme toggle — the
 * app's other "change the tool, not the data" control, which has always lived
 * there unlabelled for exactly this reason. Same row height, same icon
 * treatment and the same active state as any nav item, because it is still
 * navigation; only its position says it is a different sort of place.
 *
 * NO PERMISSION GATE, deliberately. Every signed-in person has an account to
 * manage, and the screen already shows the organization half only to
 * `settings.manage` — which is a decision the page makes about its own content,
 * not a reason to hide the door.
 */
const SETTINGS_ITEM: NavItem = { href: "/settings", label: "Settings", icon: Settings };

export function SidebarFooterNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Account" className="flex flex-col gap-0.5">
      <NavLink item={SETTINGS_ITEM} pathname={pathname} onNavigate={onNavigate} />
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
