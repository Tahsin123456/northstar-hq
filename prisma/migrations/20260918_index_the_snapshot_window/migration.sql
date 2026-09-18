-- Index the column the hit evaluator actually filters on, and stop paying for
-- three indexes nothing reads.
--
-- CONCURRENTLY is deliberately NOT used: Prisma wraps a migration in a
-- transaction and CREATE INDEX CONCURRENTLY cannot run inside one. The build
-- runs this before the new release serves traffic, with the previous release
-- still up, so a brief write lock on these tables is the safe trade.

-- The evaluator reads `videoId IN (...) AND videoAgeHours <= N`, selecting only
-- viewCount and videoAgeHours. Nothing indexed videoAgeHours, so every read
-- seeked on videoId and then discarded most of the rows it fetched. The third
-- column makes the index cover the query outright.
CREATE INDEX "video_snapshots_videoId_videoAgeHours_viewCount_idx"
  ON "video_snapshots" ("videoId", "videoAgeHours", "viewCount");

-- Nothing orders or filters Video by viewCount; the only viewCount ordering in
-- the codebase is on a different table. Maintained on every video upsert of
-- every sync, for no reader.
DROP INDEX IF EXISTS "videos_channelId_isShort_viewCount_idx";

-- Every read of this table filters organizationId + videoId, which the unique
-- constraint already serves. No query filters on outcome or windowClosesAt.
DROP INDEX IF EXISTS "video_hit_evaluations_organizationId_outcome_idx";
DROP INDEX IF EXISTS "video_hit_evaluations_organizationId_windowClosesAt_idx";
