-- The niche money figure is "the views a channel gained in the selected
-- period — every video it has, however long ago it was posted — priced at the
-- niche's RPM". YouTube reports that quantity once per channel, as the
-- lifetime `statistics.viewCount`, and every sync already fetches it and
-- overwrites `channels.viewCount` with it. Overwritten is the problem: a
-- column that only ever holds the latest reading cannot say what the reading
-- was thirty days ago, so a period delta is impossible from `channels` alone.
--
-- This table is the channel counter kept as a series: one row per channel per
-- sync, appended and never updated. `views gained in the period` becomes one
-- subtraction per channel, with no dependence on which videos the app holds
-- rows for or which of them the sweep reached first.
--
-- ADDITIVE, AND SAFE AGAINST THE PREVIOUS RELEASE. A new table, a unique, an
-- index and a foreign key; nothing the running code selects is renamed or
-- dropped, and the running code never writes here, so the deploy has no
-- window in which either version can fail.
--
-- THE UNIQUE ON (channelId, capturedAt) is the same idempotency argument
-- `video_snapshots` carries: the writer snaps `capturedAt` to a five-minute
-- grid, so an overlapping pair of syncs — the sweep and a manual Refresh —
-- collides on the key instead of writing two rows seconds apart into a series
-- every delta is computed from.
--
-- THE SEED BELOW IS THE ONE SANCTIONED "BACKFILL", and it is worth being
-- precise about why it does not break the rule in docs/deploy-migrations.md.
-- It copies columns that already exist (`viewCount`, `subscriberCount`,
-- `videoCount`, stamped at `lastFetchedAt`) into a table the previous release
-- never reads, so it assumes nothing about the new code and changes nothing
-- the old code can see. It exists so that the very next sync after this
-- deploy produces a REAL delta — two readings, hours apart — instead of every
-- niche waiting one full sync cycle to show its first figure. A channel that
-- has never been fetched has no reading to seed and gets none. The id is
-- prefixed rather than generated because the row is a copy of a known row,
-- and a deterministic id makes a re-run of this statement a no-op on the
-- primary key rather than a second seed.

-- CreateTable
CREATE TABLE "channel_view_snapshots" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "viewCount" BIGINT NOT NULL,
    "subscriberCount" BIGINT,
    "videoCount" BIGINT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_view_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_view_snapshots_channelId_capturedAt_key" ON "channel_view_snapshots"("channelId", "capturedAt");

-- CreateIndex
CREATE INDEX "channel_view_snapshots_capturedAt_idx" ON "channel_view_snapshots"("capturedAt");

-- AddForeignKey
ALTER TABLE "channel_view_snapshots" ADD CONSTRAINT "channel_view_snapshots_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed one reading per channel from the columns the previous release already
-- keeps, so the next sync yields a delta rather than a lone first reading.
INSERT INTO "channel_view_snapshots" ("id", "channelId", "viewCount", "subscriberCount", "videoCount", "capturedAt")
SELECT 'seed_' || "id", "id", "viewCount", "subscriberCount", "videoCount", "lastFetchedAt"
FROM "channels"
WHERE "viewCount" IS NOT NULL AND "lastFetchedAt" IS NOT NULL;
