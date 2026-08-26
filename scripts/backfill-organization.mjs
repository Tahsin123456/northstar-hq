/**
 * One-off migration: move shared research from per-user ownership to the
 * organization that now owns it.
 *
 * Northstar HQ began as a single-user tool, so every niche, tracked channel,
 * note, collection and saved Short was stamped with one `userId`. As a team
 * tool that is wrong — the Head of Shorts must see the same channels as the
 * Admin — so those rows now hang off an `Organization` instead.
 *
 * This script is the bridge between the two shapes. It is idempotent and runs
 * in a transaction, so re-running it is safe and a failure leaves nothing
 * half-migrated.
 *
 * IT DELIBERATELY CREATES NO CREDENTIALS. The first admin account is claimed
 * through the one-time /setup page, so no password is ever typed into a shell,
 * stored in an env var, or left in shell history.
 *
 *   node scripts/prisma-run.mjs exec node scripts/backfill-organization.mjs
 *
 * or, with DATABASE_URL already exported:
 *
 *   node scripts/backfill-organization.mjs
 */
import path from "node:path";
import process from "node:process";
import { PrismaClient } from "@prisma/client";

/** Mirrors the normalisation in src/server/env.ts and scripts/prisma-run.mjs. */
function normalizeDatabaseUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  if (!rawUrl.startsWith("file:") && !rawUrl.startsWith("sqlite:")) return rawUrl;
  const rawPath = rawUrl.replace(/^file:/, "").replace(/^sqlite:/, "");
  if (/^([a-zA-Z]:[\\/]|\/)/.test(rawPath)) return `file:${rawPath.split(path.sep).join("/")}`;
  return `file:${path.resolve(process.cwd(), rawPath).split(path.sep).join("/")}`;
}

process.env.DATABASE_URL = normalizeDatabaseUrl(process.env.DATABASE_URL);

const prisma = new PrismaClient();

const ORG_NAME = "Northstar Studios";

/** Prisma model name -> physical table name, for the raw-SQL steps. */
const SHARED_TABLES = {
  niche: "niches",
  trackedChannel: "tracked_channels",
  note: "notes",
  collection: "collections",
  savedShort: "saved_shorts",
};

/**
 * Columns that lived on user_settings before the contract step moved them to
 * organization_settings.
 */
const LEGACY_SETTINGS_COLUMNS = [
  "defaultThreshold",
  "defaultPeriodDays",
  "lookbackDays",
  "refreshIntervalMinutes",
  "snapshotIntervalMinutes",
  "shortsProbeEnabled",
  "autoRefreshEnabled",
];

/**
 * Reads the pre-migration team settings, or null once the columns are gone.
 *
 * Returning null rather than throwing is what makes the script safe to re-run:
 * after the contract step there is nothing left to copy, and the upsert below
 * is already a no-op because organization_settings exists.
 */
async function readLegacyUserSettings(tx) {
  try {
    const rows = await tx.$queryRawUnsafe(
      `SELECT ${LEGACY_SETTINGS_COLUMNS.map((c) => `"${c}"`).join(", ")}
       FROM "user_settings" ORDER BY "createdAt" ASC LIMIT 1`,
    );
    return rows[0] ?? null;
  } catch {
    // The columns no longer exist — the contract step has already run.
    return null;
  }
}

/** Moves every unassigned row of one table into the organization. */
async function repointTable(tx, table, organizationId) {
  try {
    return await tx.$executeRawUnsafe(
      `UPDATE "${table}" SET "organizationId" = ? WHERE "organizationId" IS NULL`,
      organizationId,
    );
  } catch {
    // PostgreSQL uses numbered placeholders rather than '?'.
    return await tx.$executeRawUnsafe(
      `UPDATE "${table}" SET "organizationId" = $1 WHERE "organizationId" IS NULL`,
      organizationId,
    );
  }
}

/**
 * Seed categories.
 *
 * These are starting points, not a fixed taxonomy — the schema stores
 * categories as rows precisely so the team can rename, reorder and archive
 * them without a migration.
 */
const SEED_CATEGORIES = {
  revenue: ["YouTube Ad Revenue", "Sponsorship", "Affiliate", "Licensing", "Other"],
  expense: [
    "Salaries",
    "Freelancers",
    "Software",
    "AI Tools",
    "Advertising",
    "Equipment",
    "Contractors",
    "Hosting",
    "Other",
  ],
};

const slugify = (value) => value.trim().toLowerCase();

/** SQLite has no boolean type; a raw read returns 0/1. */
const toBoolean = (value, fallback) =>
  value === undefined || value === null ? fallback : Boolean(value);

async function main() {
  const before = {
    videos: await prisma.video.count(),
    snapshots: await prisma.videoSnapshot.count(),
  };

  const summary = await prisma.$transaction(async (tx) => {
    // 1. The workspace. Keyed on the slug so a second run finds the same row.
    const existing = await tx.organization.findUnique({ where: { slug: slugify(ORG_NAME) } });
    const org =
      existing ??
      (await tx.organization.create({
        data: { name: ORG_NAME, slug: slugify(ORG_NAME) },
      }));

    // 2. Team settings copied from the LIVE user row, never from schema
    //    defaults. Skipping this would silently reset the hit threshold to
    //    1,000,000 and move every number on the dashboard.
    //
    //    Read with raw SQL rather than through the Prisma client: this script
    //    has to run against the PRE-contract database, where user_settings
    //    still holds these columns, but it is executed with a client generated
    //    from the POST-contract schema, where those fields no longer exist on
    //    the model. Going through the client would silently return `undefined`
    //    for every one of them and quietly reset the very values this step
    //    exists to preserve.
    const seed = await readLegacyUserSettings(tx);
    await tx.organizationSettings.upsert({
      where: { organizationId: org.id },
      update: {},
      create: {
        organizationId: org.id,
        defaultThreshold: seed?.defaultThreshold ?? 1_000_000,
        defaultPeriodDays: seed?.defaultPeriodDays ?? 30,
        lookbackDays: seed?.lookbackDays ?? 400,
        refreshIntervalMinutes: seed?.refreshIntervalMinutes ?? 360,
        snapshotIntervalMinutes: seed?.snapshotIntervalMinutes ?? 360,
        shortsProbeEnabled: toBoolean(seed?.shortsProbeEnabled, true),
        autoRefreshEnabled: toBoolean(seed?.autoRefreshEnabled, false),
        companyName: ORG_NAME,
      },
    });

    // 3. Memberships. Any pre-existing account becomes an admin: the only row
    //    that can exist at this point is the original single-user account, and
    //    that person is the owner.
    const users = await tx.appUser.findMany({ select: { id: true } });
    for (const user of users) {
      await tx.organizationMember.upsert({
        where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
        update: {},
        create: { organizationId: org.id, userId: user.id, role: "admin" },
      });
    }

    // 4. Repoint the shared rows. `userId` is left untouched — the contract
    //    step renames that column in Prisma only, so every byline survives.
    //
    //    Raw SQL again, for the same reason and one more: after the contract
    //    step `organizationId` is non-nullable, so `where: { organizationId:
    //    null }` is not even expressible in the generated types. Raw UPDATEs
    //    make this script idempotent across BOTH schema states — it moves rows
    //    before the contract, and matches nothing after it.
    const repointed = {};
    for (const [model, table] of Object.entries(SHARED_TABLES)) {
      repointed[model] = await repointTable(tx, table, org.id);
    }

    // 5. Finance categories, if the org has none yet.
    const categoryCount = await tx.financeCategory.count({ where: { organizationId: org.id } });
    let categoriesCreated = 0;
    if (categoryCount === 0) {
      for (const [kind, names] of Object.entries(SEED_CATEGORIES)) {
        for (const [index, name] of names.entries()) {
          await tx.financeCategory.create({
            data: {
              organizationId: org.id,
              kind,
              name,
              slug: slugify(name),
              sortOrder: index,
            },
          });
          categoriesCreated += 1;
        }
      }
    }

    return { orgId: org.id, users: users.length, repointed, categoriesCreated };
  });

  // The canonical YouTube data is never touched by this migration; assert it.
  const after = {
    videos: await prisma.video.count(),
    snapshots: await prisma.videoSnapshot.count(),
  };
  if (after.videos !== before.videos || after.snapshots !== before.snapshots) {
    throw new Error(
      `Migration altered canonical data: videos ${before.videos}->${after.videos}, ` +
        `snapshots ${before.snapshots}->${after.snapshots}`,
    );
  }

  const orphans = {};
  for (const [model, table] of Object.entries(SHARED_TABLES)) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS n FROM "${table}" WHERE "organizationId" IS NULL`,
    );
    orphans[model] = Number(rows[0]?.n ?? 0);
  }
  const totalOrphans = Object.values(orphans).reduce((sum, n) => sum + n, 0);

  console.log(JSON.stringify({ ...summary, videos: after.videos, snapshots: after.snapshots, orphans }, null, 2));

  if (totalOrphans > 0) {
    throw new Error(
      `${totalOrphans} shared rows still have no organization. Do not run the contract step.`,
    );
  }
  console.log("\nBackfill complete. Every shared row belongs to an organization.");
}

main()
  .catch((error) => {
    console.error("Backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
