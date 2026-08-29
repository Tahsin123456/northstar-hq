/**
 * Finance — the mark a connector leaves on a figure it has stopped maintaining.
 *
 * WHY THIS IS A SHARED FILE AND NOT A PRIVATE CONSTANT
 * Two unrelated pieces of code have to agree on this mark. The YouTube revenue
 * connector WRITES it when it refuses to re-total a month, and the ledger READS
 * it to decide the row is no longer a live estimate. Kept private to the
 * connector, the read side would have to re-type the sentence, and the day
 * somebody reworded one copy the ledger would go straight back to promising a
 * month-end revision that is never coming — silently, and only on the rows that
 * were already wrong.
 *
 * WHY A NOTE PREFIX AND NOT A COLUMN
 * Because there is no column. `FinanceEntry` carries `isEstimated`, which says
 * "the source may still revise this", and nothing that can say "the source has
 * stopped". A third state needs a third field and that is a migration, so the
 * mark travels in `notes` — which the ledger already renders on every row, and
 * which an admin is allowed to edit. This file is what makes that survivable:
 * one definition, read once on the server into a boolean on the DTO, so no
 * screen parses prose for itself and an edited note costs at most one row's
 * chip until the next sync re-writes the mark.
 */

/**
 * The words the mark opens with, and the whole of what the reader matches on.
 *
 * Separate from the punctuation below so the tolerant read in
 * `isUnmaintainedNote` cannot drift from the strict write: both are built from
 * this one string.
 */
const UNMAINTAINED_MARK_WORDS = "NOT BEING UPDATED";

/**
 * The exact opening of the note, as it is written and as it is matched in SQL.
 *
 * It LEADS the note because the ledger truncates that column to one line: a
 * warning the reader has to hover to see is not a warning. It is also matched
 * literally when the month recovers, so it is a constant rather than prose —
 * rewording it would strand every mark already written in the database.
 */
export const UNMAINTAINED_NOTE_PREFIX = `${UNMAINTAINED_MARK_WORDS} —`;

/**
 * Whether a note carries the mark.
 *
 * Deliberately more forgiving than the writer: leading whitespace is ignored
 * and the words are compared case-insensitively, without the em dash. The
 * asymmetry is on purpose and it only runs in one direction — this function
 * decides what a screen SAYS and never what the connector writes, so being
 * generous here can leave a warning up a moment too long but can never suppress
 * one. An admin who retypes the dash or drops a space in front of it has not
 * cancelled the fact that nothing is re-checking their figure, and the row must
 * not quietly start claiming otherwise.
 *
 * The connector's own guards stay exact — `startsWith(UNMAINTAINED_NOTE_PREFIX)`
 * before re-marking, and the same string in the query that lifts the mark when
 * the month recovers. Loosening THOSE is what would strand a mark forever: a
 * note the guard reads as already marked but the un-marking query cannot find.
 */
export function isUnmaintainedNote(notes: string | null | undefined): boolean {
  if (typeof notes !== "string") return false;
  return (
    notes.trimStart().slice(0, UNMAINTAINED_MARK_WORDS.length).toUpperCase() ===
    UNMAINTAINED_MARK_WORDS
  );
}
