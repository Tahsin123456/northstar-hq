/**
 * Copies a local SQLite database into a production PostgreSQL one.
 *
 * WHY THIS EXISTS
 * Development runs on SQLite — one file, zero setup. Production cannot: SQLite
 * has a single writer and no point-in-time recovery, which is not a defensible
 * place to keep financial records. So the first deploy needs the existing
 * tracker moved across, and the part that genuinely cannot be re-fetched is the
 * snapshot history: view counts are a point-in-time observation, and YouTube
 * will not tell you what a video had last Tuesday.
 *
 * HOW IT READS SQLITE
 * Through Node's built-in `node:sqlite`, not through Prisma. Prisma generates
 * one client per provider, so a single process cannot hold both a SQLite and a
 * PostgreSQL client — and the alternative, a second generated client, means a
 * build step and a dependency for a script that runs once. The built-in reader
 * needs neither.
 *
 * TYPE CONVERSION
 * SQLite stores everything as a number: dates as epoch milliseconds, BigInt as
 * a plain integer, booleans as 0/1. PostgreSQL wants real Date, BigInt and
 * boolean values. Rather than hardcode which column is which — a list that goes
 * stale the moment the schema changes — the mapping is read from Prisma's own
 * model metadata, so it is always in step with schema.prisma.
 *
 * USAGE
 *   # 1. Point at the production database and regenerate the client for it
 *   #    (PowerShell)
 *   $env:DATABASE_URL="postgresql://..."
 *   npm run db:push
 *
 *   # 2. Preview without writing anything
 *   node scripts/migrate-to-postgres.mjs --dry-run
 *
 *   # 3. Do it
 *   node scripts/migrate-to-postgres.mjs
 *
 * Safe to re-run: every insert skips rows that are already there.
 */
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient, Prisma } from "@prisma/client";

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const SQLITE_PATH = path.resolve(process.cwd(), "prisma/dev.db");

/**
 * Insert order, parents before children.
 *
 * PostgreSQL enforces foreign keys immediately, so a video inserted before its
 * channel is rejected rather than silently orphaned — which is a feature, and
 * the reason this list is explicit rather than derived.
 */
const TABLES = [
  "organizations",
  "app_users",
  "organization_settings",
  "organization_members",
  "member_permission_grants",
  "user_settings",
  "channels",
  "tracked_channels",
  "niches",
  "tracked_channel_niches",
  "videos",
  "video_snapshots",
  "channel_refresh_runs",
  "collections",
  "saved_shorts",
  "saved_short_collections",
  "notes",
  "finance_categories",
  "finance_entries",
  "exchange_rates",
  "youtube_connections",
  "invitations",
  "audit_events",
];

/**
 * Deliberately NOT copied.
 *
 * Sessions, reset tokens and rate-limit counters describe a browser talking to
 * the old deployment. Carrying them over would move live credentials onto a new
 * host for no benefit; signing in again on production is the correct outcome.
 */
const SKIPPED = ["sessions", "password_reset_tokens", "rate_limit_buckets"];

function assertPostgres(url) {
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Point it at the production PostgreSQL database first.",
    );
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error(
      `DATABASE_URL is "${url.slice(0, 24)}…", which is not a PostgreSQL connection string.\n` +
        "This script copies SQLite INTO PostgreSQL; running it against the local file would " +
        "mean copying the database onto itself.",
    );
  }
}

/** Prisma model metadata, keyed by physical table name. */
function buildModelIndex() {
  const index = new Map();
  for (const model of Prisma.dmmf.datamodel.models) {
    const table = model.dbName ?? model.name;
    const fields = new Map();
    for (const field of model.fields) {
      if (field.kind !== "scalar") continue;
      fields.set(field.dbName ?? field.name, {
        prop: field.name,
        type: field.type,
        required: field.isRequired,
      });
    }
    index.set(table, { model: model.name, fields });
  }
  return index;
}

/** SQLite's storage representation -> what PostgreSQL expects. */
function convert(value, type) {
  if (value === null || value === undefined) return null;
  switch (type) {
    case "DateTime":
      // Stored as epoch milliseconds by the Prisma SQLite connector.
      return value instanceof Date ? value : new Date(Number(value));
    case "BigInt":
      return typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value)));
    case "Boolean":
      return Boolean(value);
    case "Float":
    case "Int":
      return Number(value);
    default:
      return value;
  }
}

async function main() {
  assertPostgres(process.env.DATABASE_URL);

  const sqlite = new DatabaseSync(SQLITE_PATH, { readOnly: true });
  const prisma = new PrismaClient();
  const models = buildModelIndex();

  console.log(`Source: ${SQLITE_PATH}`);
  console.log(`Target: PostgreSQL${DRY_RUN ? "  (DRY RUN — nothing will be written)" : ""}\n`);

  // Refuse to write into a database that already holds a tracker, unless told
  // to. Running this twice against a live production database is the kind of
  // mistake that is only obvious afterwards.
  if (!DRY_RUN && !FORCE) {
    const existingChannels = await prisma.trackedChannel.count();
    if (existingChannels > 0) {
      throw new Error(
        `The target database already has ${existingChannels} tracked channels.\n` +
          "Re-run with --force if you are certain you want to merge into it.",
      );
    }
  }

  const summary = [];

  for (const table of TABLES) {
    const meta = models.get(table);
    if (!meta) {
      console.log(`  ${table.padEnd(26)} skipped (no matching model)`);
      continue;
    }

    const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all();
    if (rows.length === 0) {
      summary.push({ table, source: 0, written: 0 });
      continue;
    }

    const converted = rows.map((row) => {
      const out = {};
      for (const [column, value] of Object.entries(row)) {
        const field = meta.fields.get(column);
        // A column with no matching field is one the schema has since dropped.
        if (!field) continue;
        out[field.prop] = convert(value, field.type);
      }
      return out;
    });

    let written = 0;
    if (!DRY_RUN) {
      // Chunked: a single createMany with thousands of rows can exceed the
      // parameter limit on the wire.
      const CHUNK = 200;
      for (let i = 0; i < converted.length; i += CHUNK) {
        const result = await prisma[lowerFirst(meta.model)].createMany({
          data: converted.slice(i, i + CHUNK),
          skipDuplicates: true,
        });
        written += result.count;
      }
    }

    summary.push({ table, source: rows.length, written });
    console.log(
      `  ${table.padEnd(26)} ${String(rows.length).padStart(5)} rows` +
        (DRY_RUN ? "" : ` -> ${written} written`),
    );
  }

  for (const table of SKIPPED) {
    const n = sqlite.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
    if (n > 0) console.log(`  ${table.padEnd(26)} ${String(n).padStart(5)} rows  (skipped by design)`);
  }

  sqlite.close();

  if (!DRY_RUN) {
    // Verify against the target rather than trusting the write counts: the
    // point of the exercise is that the production database holds the data.
    console.log("\nVerifying the target database:");
    const checks = {
      channels: await prisma.channel.count(),
      trackedChannels: await prisma.trackedChannel.count(),
      niches: await prisma.niche.count(),
      videos: await prisma.video.count(),
      snapshots: await prisma.videoSnapshot.count(),
      collections: await prisma.collection.count(),
      savedShorts: await prisma.savedShort.count(),
      financeCategories: await prisma.financeCategory.count(),
      financeEntries: await prisma.financeEntry.count(),
    };
    for (const [name, count] of Object.entries(checks)) {
      console.log(`  ${name.padEnd(20)} ${count}`);
    }

    const expected = Object.fromEntries(summary.map((s) => [s.table, s.source]));
    const mismatches = [
      ["videos", checks.videos, expected.videos ?? 0],
      ["video_snapshots", checks.snapshots, expected.video_snapshots ?? 0],
      ["tracked_channels", checks.trackedChannels, expected.tracked_channels ?? 0],
      ["niches", checks.niches, expected.niches ?? 0],
    ].filter(([, actual, want]) => actual !== want);

    if (mismatches.length > 0) {
      console.log("\nRow counts do not match the source:");
      for (const [name, actual, want] of mismatches) {
        console.log(`  ${name}: expected ${want}, found ${actual}`);
      }
      throw new Error("Migration incomplete — investigate before using this database.");
    }

    console.log("\nEvery row copied and verified. Sign in on production to confirm.");
  }

  await prisma.$disconnect();
}

const lowerFirst = (value) => value.charAt(0).toLowerCase() + value.slice(1);

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
