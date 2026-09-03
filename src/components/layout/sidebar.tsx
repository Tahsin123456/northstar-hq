"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Bookmark,
  ChevronDown,
  Clapperboard,
  Coins,
  Film,
  Flame,
  Layers,
  LayoutDashboard,
  Moon,
  Plus,
  Settings,
  Shapes,
  ShieldCheck,
  StickyNote,
  Sun,
  Swords,
  TrendingUp,
  Tv2,
  Wallet,
} from "lucide-react";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";
import { useTheme } from "@/components/providers/theme-provider";
import { useOptionalSession } from "@/components/providers/session-provider";
import { AddChannelDialog } from "@/components/channels/add-channel-dialog";
import {
  activeSectionId,
  isItemActive,
  isSectionCollapsed,
  isSectionCollapsible,
  sidebarItemKey,
  visibleSections,
  type SidebarItemSpec,
  type SidebarSectionSpec,
} from "@/lib/sidebar-nav";
import {
  expandSection,
  getSidebarServerSnapshot,
  getSidebarSnapshot,
  subscribeToSidebar,
  toggleSection,
} from "@/lib/sidebar-store";

/**
 * A row, as the sidebar draws it: the pure spec (`src/lib/sidebar-nav.ts`
 * owns `href`, `requires`, `shortsOnly` and their reasoning) plus an icon.
 * The spec is what the tests read; the icon is the one thing about a row
 * that only matters once it is on screen.
 */
type NavItem = SidebarItemSpec & {
  icon: React.ComponentType<{ className?: string }>;
};

type NavSection = SidebarSectionSpec<NavItem>;

/**
 * THE TABLE.
 *
 * The sidebar grew one feature at a time and ended up with six sections, one
 * of them unlabelled, three of them named for how the product was pitched
 * rather than for what a person is doing: "Intelligence" over the discovery
 * feeds, "Tracker" over the data they run on, "Business" over a page about
 * the reader's own pay. Shorts was the unlabelled default while Long Form
 * had a heading, so the two halves of the operation did not read as
 * siblings.
 *
 * NOW THE SECTION LABEL IS THE FORMAT. Shorts and Long Form are the two
 * operations, each with the same four kinds of screen inside — an overview,
 * the feed of what is working, the channels, the niches — so a person who
 * knows one side can read the other. The rows have the same name on both
 * sides where they are the same kind of screen, and "Overview" or "Niches"
 * appearing twice is the point rather than a duplication: the heading above
 * says which one. Research holds what is format-neutral and personal to the
 * reader's work; Money holds what is about them and about the company; Admin
 * is the one row for people who run the tool.
 *
 * EVERY SECTION HERE IS A PLACE TO DO THE WORK. Settings is not, so it is not
 * in this table at all — see `SidebarFooterNav` at the bottom of this file.
 *
 * URLS DO NOT CHANGE HERE. Breakouts is still /outliers and Us vs Market is
 * still /our-vs-market; renaming a page is not a reason to break every saved
 * link to it.
 */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: "shorts",
    label: "Shorts",
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard, shortsOnly: true },
      { href: "/winners", label: "Winners", icon: Flame, shortsOnly: true },
      // "Breakouts" says what the page is for — the Shorts that broke away
      // from their channel's own baseline. "Outliers" named the statistic.
      { href: "/outliers", label: "Breakouts", icon: TrendingUp, shortsOnly: true },
      { href: "/our-vs-market", label: "Us vs Market", icon: Swords, shortsOnly: true },
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
      // Add Channel is a row here rather than a button under the whole nav,
      // where it was shown to Long Form roles whose channel list is not even
      // in their sidebar. It sits at the foot of the section whose Channels
      // row it feeds, and it is gated on the permission the API checks —
      // an editor who cannot add a channel is not shown the button that
      // would tell them so.
      {
        action: "add-channel",
        label: "Add Channel",
        icon: Plus,
        shortsOnly: true,
        requires: ["channels.manage"],
      },
    ],
  },
  {
    // `longs.view` is held by admin and the two longs roles only, so a
    // shorts-role user never sees this section at all — and an admin gains it
    // beside everything they already had.
    id: "longform",
    label: "Long Form",
    items: [
      { href: "/longform", label: "Overview", icon: Clapperboard, requires: ["longs.view"] },
      // The same screen as Shorts Winners, for this format; it was "Videos",
      // which named the unit rather than the question the page answers.
      { href: "/longform/videos", label: "Winners", icon: Film, requires: ["longs.view"] },
      {
        href: "/longform/channels",
        label: "Channels",
        icon: Tv2,
        matchPrefix: true,
        requires: ["longs.view"],
      },
      { href: "/longform/niches", label: "Niches", icon: Layers, requires: ["longs.view"] },
    ],
  },
  {
    id: "research",
    label: "Research",
    items: [
      // Format-neutral and for every role — the reason `shortsOnly` is an
      // item flag rather than a section one.
      { href: "/notes", label: "Notes", icon: StickyNote },
      { href: "/saved", label: "Saved", icon: Bookmark },
    ],
  },
  {
    id: "money",
    label: "Money",
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
    id: "admin",
    label: "Admin",
    items: [
      {
        href: "/admin",
        label: "Admin",
        icon: ShieldCheck,
        matchPrefix: true,
        // Any one capability is enough to have somewhere useful to land: the
        // admin area shows only the panels the person can actually use. The
        // list is the same one `admin/layout.tsx` admits on — `settings.manage`
        // was missing here while the layout accepted it, so somebody granted
        // only the hit-rule screen could reach it by URL and never by nav.
        requires: ["users.manage", "audit.view", "youtube.manage", "settings.manage"],
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

  const sections = React.useMemo(
    () =>
      visibleSections(NAV_SECTIONS, {
        contentScope,
        canAny: (permissions) => session?.canAny(permissions) ?? false,
      }),
    [session, contentScope],
  );

  const collapsedIds = React.useSyncExternalStore(
    subscribeToSidebar,
    getSidebarSnapshot,
    getSidebarServerSnapshot,
  );

  const activeId = React.useMemo(() => activeSectionId(sections, pathname), [sections, pathname]);

  // Navigating into a folded section unfolds it, in the store and not only
  // on screen: `isSectionCollapsed` already refuses to draw the active
  // section folded, but leaving the store saying "collapsed" would make the
  // chevron's next click a no-op and fold the section again the moment the
  // reader left it. The two agree, so the sidebar the reader comes back to
  // is the one they last saw.
  React.useEffect(() => {
    if (activeId !== null) expandSection(activeId);
  }, [activeId]);

  return (
    <nav className="flex flex-col gap-4" aria-label="Main">
      {sections.map((section) => {
        const collapsible = isSectionCollapsible(section);
        const collapsed = isSectionCollapsed(section, collapsedIds, activeId);
        const listId = `sidebar-section-${section.id}`;

        return (
          <div key={section.id} className="flex flex-col gap-0.5">
            {collapsible ? (
              <SectionHeading
                label={section.label}
                expanded={!collapsed}
                controls={listId}
                // The section the reader is in cannot be folded — see
                // `isSectionCollapsed` — so the control says so rather than
                // silently doing nothing.
                locked={section.id === activeId}
                onToggle={() => toggleSection(section.id)}
              />
            ) : (
              <div className="px-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                {section.label}
              </div>
            )}
            <div id={listId} className="flex flex-col gap-0.5" hidden={collapsed}>
              {section.items.map((item) => (
                <NavRow
                  key={sidebarItemKey(item)}
                  item={item}
                  pathname={pathname}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

/**
 * A section heading that folds its rows.
 *
 * A real button with `aria-expanded` and `aria-controls`, so a screen reader
 * hears "Shorts, collapsed, button" and knows both that the rows exist and
 * how to reach them — a plain label with a click handler would announce
 * neither. The chevron rotates rather than swapping icons so the two states
 * are visibly the same control.
 */
function SectionHeading({
  label,
  expanded,
  controls,
  locked,
  onToggle,
}: {
  label: string;
  expanded: boolean;
  controls: string;
  locked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={locked}
      aria-expanded={expanded}
      aria-controls={controls}
      title={locked ? "The section with the current page stays open" : undefined}
      className={cn(
        "group flex w-full items-center justify-between rounded-md px-2.5 pb-1 text-left text-[10px] font-medium uppercase tracking-wider text-subtle-foreground",
        "transition-colors duration-150",
        locked ? "cursor-default" : "hover:text-muted-foreground",
      )}
    >
      {label}
      <ChevronDown
        aria-hidden
        className={cn(
          "size-3 shrink-0 transition-transform duration-150",
          expanded ? "rotate-0" : "-rotate-90",
          locked ? "opacity-40" : "opacity-70 group-hover:opacity-100",
        )}
      />
    </button>
  );
}

/**
 * The classes every row shares, links and actions alike, so the Add Channel
 * row is indistinguishable from the Channels row above it until it is
 * pressed — which is the whole reason it moved from a button into the list.
 */
function rowClassName(isActive: boolean): string {
  return cn(
    "group relative flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13px] font-medium",
    "transition-colors duration-150",
    isActive
      ? "bg-surface-hover text-foreground"
      : "text-muted-foreground hover:bg-surface-hover/60 hover:text-foreground",
  );
}

function rowIconClassName(isActive: boolean): string {
  return cn(
    "size-4 shrink-0 transition-colors",
    isActive ? "text-accent" : "text-subtle-foreground group-hover:text-muted-foreground",
  );
}

/** One row of a section: a link, or the one action that lives among them. */
function NavRow({
  item,
  pathname,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  onNavigate?: () => void;
}) {
  if (item.action === "add-channel") {
    return (
      <AddChannelDialog
        // In the mobile drawer, opening the dialog closes the drawer behind
        // it — the same courtesy a link gives by navigating away.
        onOpenChange={(open) => open && onNavigate?.()}
        trigger={
          <button type="button" className={rowClassName(false)}>
            <item.icon className={rowIconClassName(false)} />
            {item.label}
          </button>
        }
      />
    );
  }
  return <NavLink item={item} pathname={pathname} onNavigate={onNavigate} />;
}

/**
 * One navigating row of the sidebar.
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
  item: NavItem & { href: string };
  pathname: string;
  onNavigate?: () => void;
}) {
  const isActive = isItemActive(item, pathname);

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={isActive ? "page" : undefined}
      className={rowClassName(isActive)}
    >
      <item.icon className={rowIconClassName(isActive)} />
      {item.label}
    </Link>
  );
}

/**
 * Settings, and where it went.
 *
 * IT WAS FILED BESIDE CHANNELS AND NICHES, WHICH WAS WRONG. Nothing on that
 * screen tracks anything: for an employee it is their own name, email and
 * password, and for an admin it is the organization's analysis defaults,
 * collection cadence and currency. Next to the tracked data it read as a
 * fourth kind of tracked data.
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
const SETTINGS_ITEM: NavItem & { href: string } = {
  href: "/settings",
  label: "Settings",
  icon: Settings,
};

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
