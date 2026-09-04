-- Second deploy of the niche-money removal.
--
-- docs/deploy-migrations.md: a destructive change ships in two deploys —
-- stop reading the column, ship; then drop it, ship. The previous release
-- (6934a21, "Remove niche earnings, niche RPM and the readings that fed
-- them") no longer names any object below, so nothing serving traffic while
-- this runs can miss them.
--
-- What goes, and what created it:
--   niches.rpmLowMinorPerMillion / rpmHighMinorPerMillion / rpmCurrency
--     (20260831_niche_rpm_range) — the hand-entered RPM range per niche.
--   organization_settings.engagedViewShareBasisPoints
--     (20260831_organization_engaged_view_share) — the share the manual
--     rate was scaled by.
--   channel_view_snapshots (20260903_channel_view_snapshots) — one reading
--     of each channel's lifetime counter per sync, the view side of the
--     niche money figure. DROP TABLE takes its unique index, its capturedAt
--     index and its foreign key to channels with it.
--
-- The readings are unrecoverable after this. VideoSnapshot is per video and
-- does not reconstruct a channel-level series. The owner confirmed the drop.

DROP TABLE "channel_view_snapshots";

ALTER TABLE "niches"
  DROP COLUMN "rpmLowMinorPerMillion",
  DROP COLUMN "rpmHighMinorPerMillion",
  DROP COLUMN "rpmCurrency";

ALTER TABLE "organization_settings"
  DROP COLUMN "engagedViewShareBasisPoints";
