import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * =========================================================================
 * THE NICHE MONEY FEATURE IS GONE, AND STAYS GONE
 * =========================================================================
 *
 * The owner removed it outright: "Not only you won't get money generated in a
 * niche correctly, i feel like you're going to break things so I need you to
 * remove anything associated with it. The niche RPM and whatnot as well."
 *
 * That was one connected stack — the Overview earnings panel, the money strip
 * on every niche card, the per-niche RPM range (manual and derived), the
 * Engaged Views setting, the views-gained API and the channel-level view
 * readings that fed it — and a removal is the kind of change that comes back
 * one helper at a time: a "harmless" utility restored from history, a fixture
 * key nobody noticed, a comment that still promises a figure. None of that is
 * a compile error, which is why this reads the source instead.
 *
 * Two things are pinned. The files that were deleted do not exist, and no
 * surviving file under `src/` (tests included, this one excepted) or the
 * Prisma schema names any of the feature's modules, symbols, columns or query
 * keys — matched without regard to case, so `NicheViewsGainedDTO` and
 * `MAX_ENGAGED_VIEW_SHARE_BASIS_POINTS` trip the same needle as their
 * lower-camel forms. The needles are the feature's own spellings, never bare
 * "rpm", "priced" or "worth", which the hit-rule copy legitimately uses.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

const DELETED_FILES = [
  "src/components/dashboard/niche-earnings-panel.tsx",
  "src/components/niches/niche-value-strip.tsx",
  "src/components/niches/niche-rpm-dialog.tsx",
  "src/hooks/use-views-gained.ts",
  "src/lib/niches/niche-rpm-patch.ts",
  "src/app/api/niches/views-gained/route.ts",
  "src/server/services/niche-views-gained-service.ts",
  "src/server/services/niche-rpm-service.ts",
  "src/server/services/views-gained-service.ts",
  "src/lib/analytics/niche-rpm.ts",
  "src/lib/analytics/niche-earnings.ts",
  "src/lib/analytics/views-gained-labels.ts",
  "src/lib/analytics/channel-views-gained.ts",
  // Their tests. Restoring one of these from history is the same regression
  // wearing a different file name.
  "src/lib/analytics/__tests__/niche-rpm.test.ts",
  "src/lib/analytics/__tests__/niche-rpm-format.test.ts",
  "src/lib/analytics/__tests__/niche-earnings.test.ts",
  "src/lib/analytics/__tests__/channel-views-gained.test.ts",
  "src/lib/analytics/__tests__/views-gained-labels.test.ts",
  "src/lib/niches/__tests__/niche-rpm-patch.test.ts",
  "src/server/__tests__/views-gained-route.test.ts",
  "src/server/__tests__/channel-view-snapshots-migration.test.ts",
  "src/server/services/__tests__/niche-rpm-disclosure.test.ts",
  "src/server/services/__tests__/niche-rpm-permission.test.ts",
  "src/server/services/__tests__/niche-rpm-views-gained-pin.test.ts",
  "src/server/services/__tests__/niche-views-gained.test.ts",
  "src/server/services/__tests__/views-gained-service.test.ts",
] as const;

/** Matched case-insensitively against every scanned file. */
const FORBIDDEN = [
  // Modules and routes
  "niche-rpm",
  "niche-earnings",
  "views-gained",
  "channel-views-gained",
  // Symbols
  "NicheViewsGained",
  "nicheGainedById",
  "ourViewsGained",
  "competitorViewsGained",
  "VIEWS_GAINED_KEY",
  "NicheValueStrip",
  "NicheRpmDialog",
  "NicheEarningsPanel",
  "NicheRpmResolution",
  "EngagedViewShare",
  "ENGAGED_VIEWS_GLOSS",
  "EngagedViewsCard",
  "recordChannelReading",
  "resolveNicheRpmByNiche",
  "assertMayConfigureRpm",
  "setNicheRpm",
  "RPM_MENU_ITEM_LABEL",
  "manualRpmBasis",
  // Columns, tables and the Prisma model
  "rpmLowMinorPerMillion",
  "rpmHighMinorPerMillion",
  "rpmCurrency",
  "ChannelViewSnapshot",
  "channel_view_snapshots",
] as const;

/** Every .ts/.tsx under `dir`, skipping generated output and this file. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ".generated" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && full !== SELF) {
      out.push(full);
    }
  }
  return out;
}

describe("the niche money feature", () => {
  it("has no file left on disk", () => {
    const survivors = DELETED_FILES.filter((path) => existsSync(join(ROOT, path)));
    expect(survivors).toEqual([]);
  });

  it("is named by no surviving source file, test or schema", () => {
    const files = [...sourceFiles(join(ROOT, "src")), join(ROOT, "prisma", "schema.prisma")];
    expect(files.length).toBeGreaterThan(100);

    const needles = FORBIDDEN.map((needle) => needle.toLowerCase());
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8").toLowerCase();
      for (const needle of needles) {
        if (text.includes(needle)) {
          offenders.push(`${relative(ROOT, file).split(sep).join("/")} :: ${needle}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
