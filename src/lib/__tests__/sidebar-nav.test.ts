import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ROLE_DEFINITIONS,
  ROLES,
  type Permission,
  type Role,
} from "@/lib/auth/permissions";
import { NAV_SECTIONS } from "@/components/layout/sidebar";
import {
  activeSectionId,
  isItemActive,
  isSectionCollapsed,
  isSectionCollapsible,
  sidebarItemKey,
  visibleSections,
  type SidebarViewer,
} from "@/lib/sidebar-nav";
import { channelHref } from "@/lib/channel-href";
import { channelsPageCopy } from "@/lib/channels-page-copy";
import { UPLOAD_VIEWS_TIP } from "@/lib/analytics/constants";

/**
 * The sidebar is the first thing every role sees, and the table behind it is
 * data with a lot riding on it. Every case below is written from the role
 * brief — who is meant to see which sections — rather than from the
 * implementation, so a row that leaks to the wrong role fails by name.
 *
 * Nothing here renders React. `NAV_SECTIONS` is the real table (icons and
 * all), and the rules are the pure functions in `src/lib/sidebar-nav.ts`.
 */

function viewerFor(role: Role, grants: readonly Permission[] = []): SidebarViewer {
  const definition = ROLE_DEFINITIONS[role];
  const held = new Set<Permission>([...definition.permissions, ...grants]);
  return {
    contentScope: definition.contentScope,
    canAny: (permissions) => permissions.some((permission) => held.has(permission)),
  };
}

function sectionLabelsFor(viewer: SidebarViewer): string[] {
  return visibleSections(NAV_SECTIONS, viewer).map((section) => section.label);
}

function rowLabels(viewer: SidebarViewer, sectionLabel: string): string[] {
  const section = visibleSections(NAV_SECTIONS, viewer).find((s) => s.label === sectionLabel);
  return section ? section.items.map((item) => item.label) : [];
}

function section(id: string) {
  const found = NAV_SECTIONS.find((s) => s.id === id);
  if (!found) throw new Error(`No section ${id}`);
  return found;
}

function link(href: string) {
  for (const s of NAV_SECTIONS) {
    const item = s.items.find((i) => i.href === href);
    if (item) return item;
  }
  throw new Error(`No row at ${href}`);
}

describe("the table itself", () => {
  it("is Shorts, Long Form, Research, Money, Admin — in that order", () => {
    expect(NAV_SECTIONS.map((s) => s.label)).toEqual([
      "Shorts",
      "Long Form",
      "Research",
      "Money",
      "Admin",
    ]);
  });

  it("gives the two formats the same row names for the same kinds of screen", () => {
    const shorts = section("shorts").items.map((i) => i.label);
    const longform = section("longform").items.map((i) => i.label);
    for (const shared of ["Overview", "Winners", "Channels", "Niches"]) {
      expect(shorts, shared).toContain(shared);
      expect(longform, shared).toContain(shared);
    }
  });

  it("lists no URL twice", () => {
    const keys = NAV_SECTIONS.flatMap((s) => s.items.map(sidebarItemKey));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("what each role sees", () => {
  /**
   * The whole brief in one table. Admin is the only role that sees both
   * formats; the three Shorts roles never see Long Form and the two Longs
   * roles never see Shorts; Research and Money are for everybody.
   */
  const EXPECTED: Readonly<Record<Role, readonly string[]>> = {
    admin: ["Shorts", "Long Form", "Research", "Money", "Admin"],
    head_of_shorts: ["Shorts", "Research", "Money"],
    short_form_editor: ["Shorts", "Research", "Money"],
    short_form_clip_producer: ["Shorts", "Research", "Money"],
    head_of_longs: ["Long Form", "Research", "Money"],
    long_form_editor: ["Long Form", "Research", "Money"],
  };

  it("covers every role in the catalogue", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ROLES].sort());
  });

  for (const role of ROLES) {
    it(`${role} sees ${EXPECTED[role].join(", ")}`, () => {
      expect(sectionLabelsFor(viewerFor(role))).toEqual(EXPECTED[role]);
    });
  }

  it("shows Money as Finance only to the admin, and as Your Earnings only to employees", () => {
    expect(rowLabels(viewerFor("admin"), "Money")).toEqual(["Finance"]);
    for (const role of ROLES) {
      if (role === "admin") continue;
      expect(rowLabels(viewerFor(role), "Money"), role).toEqual(["Your Earnings"]);
    }
  });

  it("puts Add Channel in the Shorts section for the roles that may add one, and nowhere else", () => {
    expect(rowLabels(viewerFor("admin"), "Shorts").at(-1)).toBe("Add Channel");
    expect(rowLabels(viewerFor("head_of_shorts"), "Shorts").at(-1)).toBe("Add Channel");
    for (const role of ["short_form_editor", "short_form_clip_producer"] as const) {
      expect(rowLabels(viewerFor(role), "Shorts"), role).not.toContain("Add Channel");
    }
    // A Head of Longs holds `channels.manage` too, and still does not see it:
    // the row is a Shorts surface, and their Channels row is not in the nav.
    const longs = visibleSections(NAV_SECTIONS, viewerFor("head_of_longs"));
    expect(longs.flatMap((s) => s.items.map((i) => i.label))).not.toContain("Add Channel");
  });

  it("shows Admin to somebody granted only settings.manage — the hit-rule screen is theirs", () => {
    // The admin layout admits on this permission; the sidebar must agree, or
    // the person can reach the screen by URL and never by nav.
    const grantee = viewerFor("short_form_editor", ["settings.manage"]);
    expect(sectionLabelsFor(grantee)).toEqual(["Shorts", "Research", "Money", "Admin"]);
  });

  it("shows Admin to each of the other three admin capabilities on its own", () => {
    for (const permission of ["users.manage", "audit.view", "youtube.manage"] as const) {
      expect(sectionLabelsFor(viewerFor("short_form_editor", [permission])), permission).toContain(
        "Admin",
      );
    }
  });
});

describe("which row is lit", () => {
  it("lights Long Form Channels on a Long Form channel page — and only it", () => {
    const pathname = "/longform/channels/abc123";
    expect(isItemActive(link("/longform/channels"), pathname)).toBe(true);
    expect(isItemActive(link("/channels"), pathname)).toBe(false);
    expect(isItemActive(link("/longform"), pathname)).toBe(false);
    expect(activeSectionId(NAV_SECTIONS, pathname)).toBe("longform");
  });

  it("lights Shorts Channels on a Shorts channel page", () => {
    expect(activeSectionId(NAV_SECTIONS, "/channels/abc123")).toBe("shorts");
    expect(isItemActive(link("/longform/channels"), "/channels/abc123")).toBe(false);
  });

  it("keeps Overview exact, so it is dark on every other Shorts page", () => {
    expect(isItemActive(link("/"), "/")).toBe(true);
    expect(isItemActive(link("/"), "/winners")).toBe(false);
    expect(isItemActive(link("/longform"), "/longform/videos")).toBe(false);
  });

  it("lights Finance and Admin across their subtrees", () => {
    expect(activeSectionId(NAV_SECTIONS, "/finance/payroll")).toBe("money");
    expect(activeSectionId(NAV_SECTIONS, "/admin/niches")).toBe("admin");
  });

  it("finds no section for Settings, which lives in the footer", () => {
    expect(activeSectionId(NAV_SECTIONS, "/settings")).toBeNull();
  });
});

describe("folding sections", () => {
  it("never folds the section that holds the current page", () => {
    const shorts = section("shorts");
    expect(isSectionCollapsed(shorts, ["shorts"], "shorts")).toBe(false);
    // The same stored preference is honoured once the reader is elsewhere.
    expect(isSectionCollapsed(shorts, ["shorts"], "research")).toBe(true);
    expect(isSectionCollapsed(shorts, ["shorts"], null)).toBe(true);
  });

  it("gives a single-item section no toggle, and never draws it folded", () => {
    const admin = section("admin");
    expect(admin.items).toHaveLength(1);
    expect(isSectionCollapsible(admin)).toBe(false);
    expect(isSectionCollapsed(admin, ["admin"], null)).toBe(false);
  });

  it("gives an employee's one-row Money section no toggle either", () => {
    const money = visibleSections(NAV_SECTIONS, viewerFor("short_form_editor")).find(
      (s) => s.id === "money",
    );
    expect(money?.items.map((i) => i.label)).toEqual(["Your Earnings"]);
    expect(money && isSectionCollapsible(money)).toBe(false);
  });

  it("folds a multi-row section the reader is not in", () => {
    expect(isSectionCollapsed(section("research"), ["research"], "shorts")).toBe(true);
    expect(isSectionCollapsed(section("research"), [], "shorts")).toBe(false);
  });
});

/**
 * The store, under a stubbed `window`.
 *
 * The suite runs on the `node` environment; only what the store touches is
 * implemented. Defined AFTER the static imports above have run, so the
 * component module loaded exactly as it does in every other test here.
 */
const storage = new Map<string, string>();
let readStorageItem: (key: string) => string | null = (key) => storage.get(key) ?? null;

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: {
      getItem: (key: string) => readStorageItem(key),
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
      clear: () => storage.clear(),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  },
});

const {
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  expandSection,
  getSidebarServerSnapshot,
  getSidebarSnapshot,
  parseCollapsedIds,
  setSectionCollapsed,
  subscribeToSidebar,
  toggleSection,
} = await import("@/lib/sidebar-store");

describe("the collapsed-state store", () => {
  beforeEach(() => {
    storage.clear();
    readStorageItem = (key) => storage.get(key) ?? null;
    // A fresh subscription re-reads storage, which is how a page load starts.
    subscribeToSidebar(() => {})();
  });

  it("renders nothing collapsed on the server, as the same array every time", () => {
    expect(getSidebarServerSnapshot()).toEqual([]);
    expect(getSidebarServerSnapshot()).toBe(getSidebarServerSnapshot());
  });

  it("collapses nothing when storage cannot be read", () => {
    storage.set(SIDEBAR_COLLAPSED_STORAGE_KEY, JSON.stringify(["shorts"]));
    readStorageItem = () => {
      throw new Error("SecurityError: localStorage is disabled");
    };
    subscribeToSidebar(() => {})();
    expect(getSidebarSnapshot()).toEqual([]);
  });

  it("collapses nothing when storage holds something this module did not write", () => {
    expect(parseCollapsedIds(null)).toEqual([]);
    expect(parseCollapsedIds("not json")).toEqual([]);
    expect(parseCollapsedIds('{"shorts":true}')).toEqual([]);
    expect(parseCollapsedIds("[1, 2]")).toEqual([]);
    expect(parseCollapsedIds('["shorts", 2]')).toEqual([]);
    expect(parseCollapsedIds('["shorts", "money"]')).toEqual(["shorts", "money"]);
  });

  it("round-trips a fold through storage", () => {
    let notified = 0;
    const unsubscribe = subscribeToSidebar(() => {
      notified += 1;
    });

    setSectionCollapsed("money", true);
    expect(notified).toBe(1);
    expect(getSidebarSnapshot()).toEqual(["money"]);
    expect(storage.get(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('["money"]');

    // A later page load reads it back.
    unsubscribe();
    subscribeToSidebar(() => {})();
    expect(getSidebarSnapshot()).toEqual(["money"]);

    toggleSection("money");
    expect(getSidebarSnapshot()).toEqual([]);
    expect(storage.has(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe(false);
  });

  it("keeps the same snapshot reference until something changes", () => {
    const before = getSidebarSnapshot();
    expandSection("money"); // already expanded — a no-op
    expect(getSidebarSnapshot()).toBe(before);
    setSectionCollapsed("research", true);
    expect(getSidebarSnapshot()).not.toBe(before);
    expandSection("research");
    expect(getSidebarSnapshot()).toEqual([]);
  });
});

/**
 * Copy pins. The retired names must be gone from every nav label and every
 * page title — not merely renamed in the sidebar and left on the page, which
 * is how a screen ends up called one thing on the left and another on top.
 */
const RETIRED = [
  "Intelligence",
  "Tracker",
  "Business",
  "Outliers",
  "Our vs Market",
  "Command centre",
  "Biggest outliers",
] as const;

const APP_DIR = join(process.cwd(), "src", "app", "(app)");

function pageFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return pageFilesUnder(full);
    return entry === "page.tsx" ? [full] : [];
  });
}

/** Every literal `title="…"` handed to a PageHeader across the app. */
function pageHeaderTitles(): { file: string; title: string }[] {
  // `[^>]` already spans newlines, so a multi-line <PageHeader … title="…">
  // is matched without the dotAll flag the ES2017 target lacks.
  const pattern = /<PageHeader\b[^>]*?\btitle="([^"]*)"/g;
  return pageFilesUnder(APP_DIR).flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return [...source.matchAll(pattern)].map((match) => ({ file, title: match[1] ?? "" }));
  });
}

function pageHeaderTitleOf(relativePage: string): string | undefined {
  const source = readFileSync(join(APP_DIR, relativePage), "utf8");
  return /<PageHeader\b[^>]*?\btitle="([^"]*)"/.exec(source)?.[1];
}

describe("copy pins", () => {
  it("uses none of the retired names in a nav label", () => {
    const labels = NAV_SECTIONS.flatMap((s) => [s.label, ...s.items.map((i) => i.label)]);
    for (const retired of RETIRED) {
      for (const label of labels) {
        expect(label, `${label} vs ${retired}`).not.toContain(retired);
      }
    }
  });

  it("uses none of the retired names in a page title", () => {
    const titles = pageHeaderTitles();
    expect(titles.length).toBeGreaterThan(10);
    for (const { file, title } of titles) {
      for (const retired of RETIRED) {
        expect(title, `${file}: "${title}" vs ${retired}`).not.toContain(retired);
      }
    }
  });

  it("keeps the renamed pages' titles in lockstep with their nav labels", () => {
    const lockstep: Record<string, string> = {
      // The two overviews are the pair the whole layout exists to make
      // symmetric; a page titled "Long Form" under a section headed "Long
      // Form" is the heading repeated, not a page name.
      "/": "page.tsx",
      "/longform": "longform/page.tsx",
      "/outliers": "outliers/page.tsx",
      "/our-vs-market": "our-vs-market/page.tsx",
      "/longform/videos": "longform/videos/page.tsx",
      "/content-types": "content-types/page.tsx",
      "/admin": "admin/page.tsx",
    };
    for (const [href, page] of Object.entries(lockstep)) {
      expect(pageHeaderTitleOf(page), href).toBe(link(href).label);
    }
    expect(link("/outliers").label).toBe("Breakouts");
    expect(link("/our-vs-market").label).toBe("Us vs Market");
    expect(link("/longform/videos").label).toBe("Winners");
  });

  it("uses none of the retired names as a heading in the PDF report", () => {
    // The report is the one screen that leaves the building. It summarises
    // the Winners and Breakouts pages, and must call them what the app does.
    const source = readFileSync(
      join(process.cwd(), "src", "lib", "report", "report-document.tsx"),
      "utf8",
    );
    const headings = [...source.matchAll(/<SectionHeading\b[^>]*?\btitle="([^"]*)"/g)].map(
      (match) => match[1] ?? "",
    );
    expect(headings).toContain("Winners");
    expect(headings).toContain("Breakouts");
    for (const heading of headings) {
      for (const retired of RETIRED) {
        expect(heading, `report: "${heading}" vs ${retired}`).not.toContain(retired);
      }
    }
  });

  it("calls the admin niche screen Hit Rules, in the tab and on the page", () => {
    expect(pageHeaderTitleOf("admin/niches/page.tsx")).toBe("Hit Rules");
    const tabs = readFileSync(
      join(process.cwd(), "src", "components", "admin", "admin-tabs.tsx"),
      "utf8",
    );
    expect(tabs).toContain('label: "Hit Rules"');
    expect(tabs).not.toContain('label: "Niches"');
  });

  it("mounts the roster at /longform/channels by re-export, the way niches is", () => {
    const source = readFileSync(join(APP_DIR, "longform", "channels", "page.tsx"), "utf8");
    expect(source).toContain('export { default } from "../../channels/page";');
  });
});

describe("the Shorts channels page, word for word", () => {
  /**
   * The roster module now serves two URLs. These are the three strings on
   * it that name the unit, pinned to what the Shorts page said before the
   * Long Form route existed — so parameterising them cannot have moved a
   * word on the page every current user reads.
   */
  it("says exactly what it said before", () => {
    expect(channelsPageCopy("shorts")).toEqual({
      emptyDescription:
        "Add a YouTube channel to start measuring how consistently it produces high-performing Shorts.",
      uploadViewsTip: UPLOAD_VIEWS_TIP,
      removedHistory:
        "Hidden from your dashboard. Their Shorts history is still stored and comes back intact.",
    });
  });

  it("speaks of videos, not Shorts, on the Long Form side", () => {
    const longform = channelsPageCopy("longform");
    for (const value of Object.values(longform)) {
      expect(value).not.toContain("Shorts");
    }
    expect(longform.emptyDescription).toContain("long-form videos");
  });

  it("links a Shorts row to the Shorts channel page and a Long Form row to the Long Form one", () => {
    expect(channelHref("shorts", "abc")).toBe("/channels/abc");
    expect(channelHref("longform", "abc")).toBe("/longform/channels/abc");
  });

  it("sends the card menu's View analytics to the same format as the card's own link", () => {
    // The kebab menu is rendered on every roster card, every overview row and
    // both channel headers. A literal /channels/ URL in it is a Shorts link on
    // a Long Form surface — the leak channel-href.ts exists to close.
    const source = readFileSync(
      join(process.cwd(), "src", "components", "channels", "channel-row-menu.tsx"),
      "utf8",
    );
    expect(source).toContain("router.push(channelHref(format, channel.id))");
    expect(source).toContain("const format = useDatasetFormat();");
    expect(source).not.toMatch(/[`"']\/channels\//);
  });
});
