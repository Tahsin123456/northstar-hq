-- The sweep needs to know when it last TRIED, not only when it last succeeded.
--
-- `findDueChannels` ordered on `lastFetchedAt`, and the failure path
-- deliberately leaves that column alone so the freshness notice cannot claim
-- data nobody could fetch. The consequence was that a channel which fails
-- every time stayed null, null sorts first as "never fetched, most urgent",
-- and it held the head of the queue on every hourly run forever. At the
-- per-run cap of 25 channels, twenty-five permanently failing rows meant no
-- other channel was ever synced again — reachable today, since a connection
-- stuck needing re-authorisation makes every own channel behind it fail like
-- this.
--
-- ADDITIVE AND NULLABLE, so it is safe against the previous release: the old
-- code neither writes nor reads this column, and every row it inserts simply
-- leaves it null.
--
-- BACKFILLED FROM `lastFetchedAt` rather than left null, because a channel
-- that has been fetched has by definition been attempted. Without this every
-- existing row would read as "never attempted" on the first run after deploy
-- and the whole tracker would sort as equally urgent at once.

ALTER TABLE "channels" ADD COLUMN "lastAttemptedAt" TIMESTAMP(3);

UPDATE "channels" SET "lastAttemptedAt" = "lastFetchedAt" WHERE "lastFetchedAt" IS NOT NULL;
