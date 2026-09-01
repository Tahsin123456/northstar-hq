-- A niche now says which side of the operation it belongs to — "shorts" or
-- "longform" — because the studio is adding Long Form and the owner's decision
-- is separate niche lists per format. This migration is the dark plumbing for
-- that: one defaulted column, one widened unique, one read-path index, and no
-- behaviour anywhere until code starts asking.
--
-- NOT NULL DEFAULT 'shorts', because every niche that exists today IS a Shorts
-- niche. The default is the whole safety argument: existing rows come out of
-- this migration saying what they already were, the PREVIOUS release's inserts
-- keep succeeding (they name no format, so the column fills itself), and no
-- stored row changes meaning. This is the same shape `kind` shipped in.
--
-- CREATE THE WIDER UNIQUE BEFORE DROPPING THE NARROWER ONE. While this deploy
-- is in flight the old code is still serving traffic, and its create path
-- relies on (organizationId, slug) being enforced. Every row has
-- format = 'shorts' until the new code ships, so the widened index enforces
-- exactly the same collisions the old one did — there is no instant in the
-- deploy where a duplicate slug could slip in. The old index (its name
-- verified at prisma/migrations/0_init/migration.sql:657) is dropped only
-- after its replacement exists.
--
-- The videos index is the long-form read path, added now so the LATER deploy
-- that reads long-form analytics does not ship a table scan. Long Form selects
-- on classification = 'not_short' — never NOT "isShort", which would sweep in
-- videos the classifier could not resolve — so it needs the classification
-- analogue of the existing (channelId, isShort, publishedAt) index.

-- AlterTable
ALTER TABLE "niches" ADD COLUMN "format" TEXT NOT NULL DEFAULT 'shorts';

-- CreateIndex
CREATE UNIQUE INDEX "niches_organizationId_format_slug_key" ON "niches"("organizationId", "format", "slug");

-- DropIndex
DROP INDEX "niches_organizationId_slug_key";

-- CreateIndex
CREATE INDEX "videos_channelId_classification_publishedAt_idx" ON "videos"("channelId", "classification", "publishedAt");
