import type { Permission } from "@/lib/auth/permissions";

/**
 * =========================================================================
 * SIDEBAR NAVIGATION — THE RULES, WITHOUT THE REACT
 * =========================================================================
 *
 * The sidebar decides three things: which sections a signed-in person sees,
 * which row is lit for the current URL, and which sections may be folded
 * away. All three used to live inline in `SidebarNav`, which meant the one
 * table every role's first impression of the product depends on could only
 * be checked by rendering the component. The decisions are pure functions of
 * the table, the viewer and the pathname, so they live here — importable
 * from a plain Node test — and the component is left with the rendering.
 *
 * AN AFFORDANCE, NEVER A BOUNDARY. Nothing in this module protects data. A
 * row hidden here is a door not shown to somebody it will not open for; the
 * route and its API refuse them regardless of what the sidebar renders
 * (`requirePermission` in `src/server/auth/dal.ts`, `requireFormat` in
 * `src/server/auth/format-scope.ts`). Every rule below is a usability
 * decision, and changing one changes nothing about who can read what.
 */

/**
 * Which side of the operation a role is about — the value `ActorDTO` carries
 * from the role table, so the sidebar cannot disagree with the server about
 * it. `undefined` is "no session", which is treated as "shorts": the sidebar
 * renders under `(app)/layout.tsx` where a session always exists, and the
 * fallback only decides what an impossible render would show.
 */
export type SidebarContentScope = "shorts" | "longs" | "all";

interface SidebarItemBase {
  readonly label: string;
  /**
   * Hide this item unless the signed-in user holds one of these.
   *
   * Any one of them is enough: the list is "a reason to have somewhere to
   * land", not a conjunction. Finance lists both `finance.view` and
   * `payroll.view` because somebody granted payroll alone still has a real tab
   * behind the door.
   */
  readonly requires?: readonly Permission[];
  /**
   * A Shorts surface — hidden from an actor whose `contentScope` is "longs".
   *
   * PER ITEM, not per section, and the granularity is load-bearing: the
   * Shorts section is entirely Shorts, but Research is format-neutral and
   * Money is about the person, and both stay for everybody. Sections whose
   * every item is hidden are dropped by `visibleSections`, so a longs role
   * sees no "Shorts" heading over nothing.
   */
  readonly shortsOnly?: boolean;
}

/** A row that navigates. */
export interface SidebarLinkSpec extends SidebarItemBase {
  readonly href: string;
  /** Matches nested routes, e.g. /channels/abc under /channels. */
  readonly matchPrefix?: boolean;
  readonly action?: undefined;
}

/**
 * A row that opens something in place rather than navigating.
 *
 * Add Channel is the one of these. It is row-shaped and lives inside the
 * Shorts section because that is where the channels it adds appear, but it
 * has no URL, is never "active", and is gated on `channels.manage` rather
 * than on the section being visible — an editor sees the Shorts tracker and
 * still cannot add to it.
 */
export interface SidebarActionSpec extends SidebarItemBase {
  readonly action: "add-channel";
  readonly href?: undefined;
  readonly matchPrefix?: undefined;
}

export type SidebarItemSpec = SidebarLinkSpec | SidebarActionSpec;

export interface SidebarSectionSpec<Item extends SidebarItemSpec = SidebarItemSpec> {
  /** Stable id — what the collapsed-state store remembers. Never shown. */
  readonly id: string;
  /** The heading. The section label IS the format where there is one. */
  readonly label: string;
  readonly items: readonly Item[];
}

/** What the sidebar needs to know about whoever is looking at it. */
export interface SidebarViewer {
  readonly contentScope: SidebarContentScope | undefined;
  readonly canAny: (permissions: readonly Permission[]) => boolean;
}

/** A stable key for a row — links by URL, actions by name. */
export function sidebarItemKey(item: SidebarItemSpec): string {
  return item.action !== undefined ? `action:${item.action}` : item.href;
}

export function isItemVisible(item: SidebarItemSpec, viewer: SidebarViewer): boolean {
  // Shorts surfaces disappear for a longs-scoped role. "all" (admin) and
  // "shorts" both keep them.
  if (item.shortsOnly && viewer.contentScope === "longs") return false;
  return !item.requires || viewer.canAny(item.requires);
}

/**
 * The sections this viewer sees, each holding only the rows they see.
 *
 * Sections whose every item is hidden are dropped entirely, so an editor does
 * not see an "Admin" heading advertising that there is something there they
 * cannot reach — and a longs-role user does not see a "Shorts" heading over
 * nothing once its items are all Shorts.
 */
export function visibleSections<Item extends SidebarItemSpec>(
  sections: readonly SidebarSectionSpec<Item>[],
  viewer: SidebarViewer,
): SidebarSectionSpec<Item>[] {
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => isItemVisible(item, viewer)),
    }))
    .filter((section) => section.items.length > 0);
}

/**
 * Is this row the current page?
 *
 * Exact by default. `matchPrefix` rows also own their subtree — Channels is
 * lit on /channels/abc, Finance on /finance/payroll — because leaving the row
 * dark there reads as having navigated out of the section. An action row has
 * no page and is never active.
 */
export function isItemActive(item: SidebarItemSpec, pathname: string): boolean {
  if (item.href === undefined) return false;
  return item.matchPrefix
    ? pathname === item.href || pathname.startsWith(`${item.href}/`)
    : pathname === item.href;
}

/**
 * The section that contains the current page, or null when none does.
 *
 * Over the VISIBLE sections rather than the full table — a section this
 * viewer cannot see cannot be the one they are in — and the first match
 * wins, which is safe because no two sections list the same URL.
 */
export function activeSectionId(
  sections: readonly SidebarSectionSpec[],
  pathname: string,
): string | null {
  for (const section of sections) {
    if (section.items.some((item) => isItemActive(item, pathname))) return section.id;
  }
  return null;
}

/**
 * May this section be folded?
 *
 * A section of one item renders a plain label with no toggle. Folding one
 * row behind a heading saves nothing and costs a click, and the chevron
 * would advertise contents the heading already states in full.
 */
export function isSectionCollapsible(section: SidebarSectionSpec): boolean {
  return section.items.length > 1;
}

/**
 * Whether a section renders folded — the stored preference, overridden by
 * two rules that beat it.
 *
 * THE SECTION CONTAINING THE ACTIVE ROUTE CAN NEVER BE COLLAPSED. A sidebar
 * that hides the lit row is a sidebar with no answer to "where am I?", which
 * is the first question it exists to answer. The store is also told to
 * expand it (see `SidebarNav`), but the guard is here as well so a stale
 * store — another tab, a storage event — cannot fold the current section
 * for a single frame.
 *
 * And a single-item section has nothing to fold; see `isSectionCollapsible`.
 */
export function isSectionCollapsed(
  section: SidebarSectionSpec,
  collapsedIds: readonly string[],
  activeId: string | null,
): boolean {
  if (!isSectionCollapsible(section)) return false;
  if (section.id === activeId) return false;
  return collapsedIds.includes(section.id);
}
