-- A niche now says what a hit is WORTH and what kind of niche it is, and a
-- channel's content types become time-bounded rules instead of a flat join.
--
-- HAND-EDITED, and the edit is the whole point. `prisma migrate diff` emits
-- DROP TABLE "channel_content_types" before CREATE TABLE
-- "channel_content_type_rules", which is correct as schema and wrong as
-- history: the rows in the old table are somebody's judgement about what a
-- channel makes, recorded nowhere else. The order below creates the new table,
-- carries those judgements into it, and only then drops the old one.

-- AlterTable
ALTER TABLE "niches" ADD COLUMN     "hitPaymentMinor" INTEGER,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'production';

-- CreateTable
CREATE TABLE "channel_content_type_rules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "trackedChannelId" TEXT NOT NULL,
    "contentTypeId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveUntil" TIMESTAMP(3),
    "consecutiveOverrides" INTEGER NOT NULL DEFAULT 0,
    "overrideStreakFrom" TIMESTAMP(3),
    "autoClosedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_content_type_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_content_type_rules_organizationId_idx" ON "channel_content_type_rules"("organizationId");

-- CreateIndex
CREATE INDEX "channel_content_type_rules_contentTypeId_idx" ON "channel_content_type_rules"("contentTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "channel_content_type_rules_trackedChannelId_contentTypeId_e_key" ON "channel_content_type_rules"("trackedChannelId", "contentTypeId", "effectiveFrom");

-- Carry every existing channel assignment across as an open-ended rule.
--
-- `effectiveFrom` is the epoch and `effectiveUntil` is null, which reproduces
-- exactly what the old join meant: this tag applies to everything this channel
-- has published and everything it publishes next. The rule can be narrowed
-- afterwards; starting narrower would silently drop labels that are currently
-- showing.
--
-- `organizationId` comes through `tracked_channels`, which is where the old
-- table reached tenancy from — it had no column of its own.
INSERT INTO "channel_content_type_rules" (
    "id", "organizationId", "trackedChannelId", "contentTypeId",
    "effectiveFrom", "effectiveUntil", "createdById", "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    tc."organizationId",
    cct."trackedChannelId",
    cct."contentTypeId",
    TIMESTAMP '1970-01-01 00:00:00',
    NULL,
    cct."assignedById",
    cct."createdAt",
    CURRENT_TIMESTAMP
FROM "channel_content_types" cct
JOIN "tracked_channels" tc ON tc."id" = cct."trackedChannelId";

-- DropForeignKey
ALTER TABLE "channel_content_types" DROP CONSTRAINT "channel_content_types_contentTypeId_fkey";

-- DropForeignKey
ALTER TABLE "channel_content_types" DROP CONSTRAINT "channel_content_types_trackedChannelId_fkey";

-- DropTable
DROP TABLE "channel_content_types";

-- AddForeignKey
ALTER TABLE "channel_content_type_rules" ADD CONSTRAINT "channel_content_type_rules_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_content_type_rules" ADD CONSTRAINT "channel_content_type_rules_trackedChannelId_fkey" FOREIGN KEY ("trackedChannelId") REFERENCES "tracked_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_content_type_rules" ADD CONSTRAINT "channel_content_type_rules_contentTypeId_fkey" FOREIGN KEY ("contentTypeId") REFERENCES "content_types"("id") ON DELETE CASCADE ON UPDATE CASCADE;
