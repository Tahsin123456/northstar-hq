import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PERMISSIONS, ROLES, can } from "@/lib/auth/permissions";

/**
 * =========================================================================
 * MOVING THE MONEY MUST NOT WIDEN WHO SEES IT
 * =========================================================================
 *
 * Own-channel earnings are read on the Finance overview, and connection health
 * stays on Admin → YouTube. That split is not tidiness: the two screens are
 * admitted by DIFFERENT permissions, and the wrong one is individually
 * grantable to somebody whose job is fixing broken connections.
 *
 * `youtube.manage` is handed to whoever reconnects a Google account. If a
 * revenue figure ever appeared on the screen that permission opens, granting it
 * would silently hand over the studio's income as well — and nobody granting it
 * would think they had. That is the failure this file exists to catch, and it
 * catches it by asserting the shape of the gate rather than by rendering
 * anything.
 */

function source(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

describe("who may read revenue", () => {
  /**
   * Written as "every role, and here is the answer for each" rather than as a
   * list of the ones that should not have it, so a role added tomorrow fails
   * here unless somebody has decided about it on purpose.
   */
  it("is the admin and nobody else, by role", () => {
    for (const role of ROLES) {
      expect(can({ role }, "finance.view"), role).toBe(role === "admin");
    }
  });

  /**
   * The three money permissions answer three different questions — what the
   * company earned, what everybody is paid, and what I am paid — and are held
   * by different people on purpose. Collapsing any two of them would leak in a
   * direction nobody asked for.
   */
  it("is not the same permission as payroll or personal earnings", () => {
    expect(PERMISSIONS).toContain("finance.view");
    expect(PERMISSIONS).toContain("payroll.view");
    expect(PERMISSIONS).toContain("earnings.view_own");

    // A head of shorts holds none of the three; an admin holds the two that are
    // about other people and not the one that is about themselves.
    expect(can({ role: "head_of_shorts" }, "finance.view")).toBe(false);
    expect(can({ role: "head_of_shorts" }, "payroll.view")).toBe(false);
    expect(can({ role: "admin" }, "payroll.view")).toBe(true);
  });

  /**
   * THE ONE THAT NAMES THE MISTAKE. Connection management does not imply
   * reading money, in either direction, and a grant of one must never carry the
   * other with it.
   */
  it("is not implied by permission to manage the YouTube connections", () => {
    for (const role of ROLES) {
      if (can({ role }, "youtube.manage") && role !== "admin") {
        expect(can({ role }, "finance.view"), role).toBe(false);
      }
    }
    // A grant is additive and grants exactly what it names — this is the
    // Head of Shorts who was given the connections screen to fix a reconnect.
    const withConnections = { role: "head_of_shorts", grants: ["youtube.manage"] };
    expect(can(withConnections, "youtube.manage")).toBe(true);
    expect(can(withConnections, "finance.view")).toBe(false);
  });
});

describe("where the gate actually is", () => {
  /**
   * The UI hides nothing that matters — the payload never arrives.
   *
   * `/api/finance/overview` is the single endpoint carrying `youtubeRevenue`,
   * and it refuses before it reads anything. Asserting on the source is blunt,
   * but the alternative in this runner is asserting nothing at all, and a
   * deleted `requirePermission` is exactly the edit that would otherwise ship
   * quietly: every screen would keep working for the person who tested it.
   */
  it("is the first thing the finance overview endpoint does", () => {
    const route = source("app/api/finance/overview/route.ts");
    expect(route).toContain('requirePermission("finance.view")');

    const gate = route.indexOf('requirePermission("finance.view")');
    // The CALL, not the import at the top of the file.
    const read = route.indexOf("getFinanceOverview({");
    expect(gate).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(read);
  });

  /** The route the earnings are rendered on is gated too, so a direct visit
   *  redirects rather than rendering an empty shell and asking the API. */
  it("also guards the Finance route the earnings render on", () => {
    const layout = source("app/(app)/finance/(ledger)/layout.tsx");
    expect(layout).toContain('actorCan("finance.view")');
    expect(layout).toContain("redirect(");
  });

  /**
   * The other half of the split. Admin → YouTube keeps connection health and
   * gains no money; the sync endpoint behind its buttons returns counts, never
   * amounts, so triggering a revenue sync tells the operator that it worked
   * without telling them what it was worth.
   */
  it("keeps amounts off the youtube.manage surfaces", () => {
    const admin = source("app/(app)/admin/youtube/page.tsx");
    expect(admin).not.toContain("formatMoney");

    const sync = source("app/api/youtube/revenue/sync/route.ts");
    expect(sync).toContain('requirePermission("youtube.manage")');
    expect(sync).not.toContain("totalMinor");
  });
});

describe("the earnings are read where the money is", () => {
  /**
   * The section's headline "Total" is computed over every stored day precisely
   * so it survives the period selector. It used to be rendered inside the
   * branch that gives up when the LEDGER has no entries in the selected window,
   * which threw that away — an organisation whose only income is imported
   * YouTube revenue saw "no finance entries in this period" and nothing else,
   * including no coverage panel naming the channels nobody is reading.
   */
  it("survives a period with no ledger entries", () => {
    const page = source("app/(app)/finance/(ledger)/page.tsx");
    const emptyBranch = page.indexOf("isPeriodEmpty(data.summary)");
    const section = page.indexOf("<YouTubeRevenueSection");
    const closesBranch = page.indexOf("          )}", emptyBranch);

    expect(emptyBranch).toBeGreaterThan(-1);
    expect(section).toBeGreaterThan(-1);
    // Rendered after the empty-period ternary has closed, so neither branch of
    // it can suppress the section.
    expect(section).toBeGreaterThan(closesBranch);
  });
});
