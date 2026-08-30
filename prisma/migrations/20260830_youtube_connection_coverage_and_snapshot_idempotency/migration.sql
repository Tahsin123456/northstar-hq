-- Two independent repairs, both of which are about a claim the database was
-- not actually enforcing.
--
-- 1. A connection could only ever be credited with ONE channel, so a second
--    channel from the same Google grant was read with the shared public API key
--    while being labelled "one of ours". `youtube_connection_channels` records
--    every channel a grant covers, and the credential lookup reads it.
--
-- 2. A connection's "Last sync" was written only by a successful REVENUE read,
--    so a connection without the monetary scope said "Never synced" forever
--    while its channel synced correctly every hour. The channel sync now
--    records its own outcome, in columns of its own.
--
-- 3. `video_snapshots` had no unique constraint at all: duplicate suppression
--    was one in-memory `if` in the sync, which two concurrent syncs of the same
--    channel both pass. The unique below enforces it in the database.

-- AlterTable
ALTER TABLE "youtube_connections" ADD COLUMN     "channelSyncError" TEXT,
ADD COLUMN     "channelSyncStatus" TEXT NOT NULL DEFAULT 'never',
ADD COLUMN     "lastChannelSyncAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "youtube_connection_channels" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "youtubeChannelId" TEXT NOT NULL,
    "title" TEXT,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "youtube_connection_channels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Exactly the name Prisma generates for this unique (63 characters, its limit),
-- so a later `migrate diff` sees no drift.
CREATE UNIQUE INDEX "youtube_connection_channels_organizationId_youtubeChannelId_key" ON "youtube_connection_channels"("organizationId", "youtubeChannelId");

-- CreateIndex
CREATE INDEX "youtube_connection_channels_connectionId_idx" ON "youtube_connection_channels"("connectionId");

-- AddForeignKey
ALTER TABLE "youtube_connection_channels" ADD CONSTRAINT "youtube_connection_channels_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_connection_channels" ADD CONSTRAINT "youtube_connection_channels_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "youtube_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry every existing connection's own channel across as a covered channel.
--
-- Not strictly required — `connectionsByChannel` still reads the connection's
-- own `youtubeChannelId` as well, so an un-backfilled deployment resolves
-- exactly as it does today — but doing it here means the new table is the
-- complete picture from the first run rather than filling in as people happen
-- to reconnect.
INSERT INTO "youtube_connection_channels" (
    "id", "organizationId", "connectionId", "youtubeChannelId", "title",
    "confirmedAt", "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    c."organizationId",
    c."id",
    c."youtubeChannelId",
    c."channelTitle",
    c."updatedAt",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "youtube_connections" c
WHERE c."youtubeChannelId" IS NOT NULL;

-- DropIndex
-- Replaced by the unique below, which indexes the same two columns in the same
-- order and therefore serves every query the old index served.
DROP INDEX "video_snapshots_videoId_capturedAt_idx";

-- CreateIndex
--
-- Deliberately NOT preceded by a rounding of existing `capturedAt` values onto
-- the new five-minute grid. Rounding history could collide two genuine readings
-- and would make this statement fail; leaving it alone cannot, because the old
-- writer stamped every row of a run with one millisecond-precision timestamp and
-- one row per video. Old rows keep their exact instants, new rows land on the
-- grid, and the constraint only ever has to hold going forward.
CREATE UNIQUE INDEX "video_snapshots_videoId_capturedAt_key" ON "video_snapshots"("videoId", "capturedAt");
