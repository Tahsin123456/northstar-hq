-- A niche can now say what 1,000 views in it are WORTH, as a hand-entered
-- low–high range, so the size of a niche and the share of it the studio is
-- capturing can be stated in money rather than only in views.
--
-- Three nullable columns, no backfill, no data touched. Every existing niche
-- comes out of this migration in the state it is genuinely in — nobody has
-- entered a rate — and null is the column's way of saying so. A DEFAULT 0 would
-- have asserted on every existing row that its niche pays nothing, which is a
-- different claim entirely and one no user made.
--
-- SCALE, because the column names carry it and getting it wrong is silent:
-- these are minor units per 1,000,000 VIEWS, not per 1,000. A Shorts RPM sits
-- under $0.10, so whole cents per 1,000 views cannot represent one — $0.045
-- would round to 4 or 5, an 11% error that is then multiplied by the niche's
-- whole view count. $1.00 per 1,000 views is 100000 here.
--
-- `rpmCurrency` exists for the same reason `finance_entries` and
-- `channel_revenue_days` carry one: a rate is meaningless without the unit it
-- was typed in, and inheriting the organization's base would reinterpret every
-- stored range the day an admin changes it.
--
-- Nothing is added for the *derived* rate — the one taken from an own channel's
-- reported revenue, which overrides the range above. That figure is computed on
-- read from `channel_revenue_days` and `video_snapshots`, both of which keep
-- changing underneath it; a stored copy would go stale while still presenting
-- itself as measured.

-- AlterTable
ALTER TABLE "niches" ADD COLUMN     "rpmCurrency" TEXT,
ADD COLUMN     "rpmHighMinorPerMillion" INTEGER,
ADD COLUMN     "rpmLowMinorPerMillion" INTEGER;
