import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * =========================================================================
 * THE CHANNEL SERIES REACHES PRODUCTION THROUGH A MIGRATION, SEEDED
 * =========================================================================
 *
 * `prisma migrate deploy` runs ahead of `next build` (docs/deploy-migrations.md),
 * with the previous release still serving traffic while it does. So the
 * migration has to be ADDITIVE — nothing the old code selects may move — and
 * it has to leave the new table in a state the very next sync can produce a
 * delta from, or every niche waits a full sync cycle for its first figure.
 * Both are properties of a SQL file, and both are the kind that fail
 * silently at deploy time, so they are pinned by reading the file.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MIGRATIONS = path.join(ROOT, "prisma", "migrations");
const FOLDER = "20260903_channel_view_snapshots";

const sql = readFileSync(path.join(MIGRATIONS, FOLDER, "migration.sql"), "utf8");
const schema = readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8");

/** SQL with its comments stripped, so the assertions read what runs. */
const statements = sql
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

describe("the channel_view_snapshots migration", () => {
  it("is the newest dated migration, so it applies after everything shipped before it", () => {
    const dated = readdirSync(MIGRATIONS)
      .filter((name) => /^\d{8}_/.test(name))
      .sort();
    expect(dated.at(-1)).toBe(FOLDER);
  });

  it("creates the table with the columns the schema declares", () => {
    expect(statements).toContain('CREATE TABLE "channel_view_snapshots"');
    for (const column of [
      '"id" TEXT NOT NULL',
      '"channelId" TEXT NOT NULL',
      '"viewCount" BIGINT NOT NULL',
      '"subscriberCount" BIGINT',
      '"videoCount" BIGINT',
      '"capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
    ]) {
      expect(statements).toContain(column);
    }
    expect(statements).toContain(
      'CONSTRAINT "channel_view_snapshots_pkey" PRIMARY KEY ("id")',
    );
  });

  it("enforces one reading per channel per bucket in the database, not in memory", () => {
    // Exactly the name Prisma generates for `@@unique([channelId, capturedAt])`,
    // so a later `migrate diff` sees no drift.
    expect(statements).toContain(
      'CREATE UNIQUE INDEX "channel_view_snapshots_channelId_capturedAt_key" ON "channel_view_snapshots"("channelId", "capturedAt")',
    );
    expect(statements).toContain(
      'CREATE INDEX "channel_view_snapshots_capturedAt_idx" ON "channel_view_snapshots"("capturedAt")',
    );
  });

  it("cascades with the channel it belongs to", () => {
    expect(statements).toContain(
      'FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE',
    );
  });

  /**
   * The one sanctioned backfill: existing columns copied into a table the
   * previous release never reads. Without it the next sync writes a lone
   * first reading and no channel has a delta until the sync after that.
   */
  it("seeds one reading per fetched channel from the columns the old release keeps", () => {
    expect(statements).toContain(
      'INSERT INTO "channel_view_snapshots" ("id", "channelId", "viewCount", "subscriberCount", "videoCount", "capturedAt")',
    );
    expect(statements).toContain(
      "SELECT 'seed_' || \"id\", \"id\", \"viewCount\", \"subscriberCount\", \"videoCount\", \"lastFetchedAt\"",
    );
    expect(statements).toContain('FROM "channels"');
    // A channel never fetched has no reading to seed; a null in a NOT NULL
    // column would fail the whole migration and with it the deploy.
    expect(statements).toContain('WHERE "viewCount" IS NOT NULL AND "lastFetchedAt" IS NOT NULL');
  });

  it("touches nothing the previous release selects", () => {
    // Additive only: no DROP, no ALTER of an existing table. The one ALTER is
    // the new table's own foreign key.
    expect(statements).not.toMatch(/DROP /i);
    const alters = statements.match(/ALTER TABLE "([a-z_]+)"/g) ?? [];
    expect(alters).toEqual(['ALTER TABLE "channel_view_snapshots"']);
  });

  it("matches the Prisma model it exists for", () => {
    expect(schema).toContain("model ChannelViewSnapshot {");
    expect(schema).toContain('@@map("channel_view_snapshots")');
    expect(schema).toContain("@@unique([channelId, capturedAt])");
    // The back-relation, so a channel delete cascades and the service can
    // select the series through the channel.
    expect(schema).toContain("viewSnapshots  ChannelViewSnapshot[]");
    // Portability contract: no native types on the new model.
    const model = schema.slice(schema.indexOf("model ChannelViewSnapshot {"));
    expect(model.slice(0, model.indexOf("}"))).not.toContain("@db.");
  });
});
