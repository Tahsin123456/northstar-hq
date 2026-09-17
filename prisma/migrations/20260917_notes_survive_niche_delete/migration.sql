-- A note outlives the niche it was filed on.
--
-- `notes.nicheId` cascaded, so deleting a niche deleted every note filed on
-- it — the whole team's research, personal and shared — under a confirmation
-- dialog that said "This removes the label, nothing else" and promised that
-- no Shorts, view counts or history were affected. Notes exist nowhere else
-- and nothing reported the loss: the success toast counted unfiled channels
-- and said nothing about notes.
--
-- SET NULL keeps the row. `deleteNiche` now re-files its notes as "general"
-- (a kind that already exists for a note attached to nothing) in the same
-- transaction as the delete, so no row is left claiming targetType "niche"
-- with a null nicheId; this constraint is the backstop for any other path
-- that deletes a niche row.
--
-- SAFE AGAINST THE PREVIOUS RELEASE, which is what this file has to be while
-- the old code is still serving: nothing in it depends on the cascade, and
-- weakening a foreign key from CASCADE to SET NULL only ever destroys less.
-- No row is written or removed here.

ALTER TABLE "notes" DROP CONSTRAINT "notes_nicheId_fkey";

ALTER TABLE "notes" ADD CONSTRAINT "notes_nicheId_fkey"
  FOREIGN KEY ("nicheId") REFERENCES "niches"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
