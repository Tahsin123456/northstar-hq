/**
 * =========================================================================
 * WHICH FORMAT A NICHE — AND A VIDEO — BELONGS TO
 * =========================================================================
 *
 * The studio is adding Long Form, and the owner's decision is SEPARATE NICHE
 * LISTS PER FORMAT: a Shorts "GTA" and a Long Form "GTA" are different bodies
 * of work with different channels, different rules and different people
 * accountable for them. `Niche.format` is that decision as a column, and this
 * module is its one home — the word "format" is defined here and nowhere else,
 * exactly as `niche-kind.ts` is the one home of production-versus-watchlist.
 *
 * A STRING UNION AND A NARROWER, not an enum: the schema's portability
 * contract forbids `enum` blocks, so `Niche.format` is a `String` column
 * narrowed here and validated at every boundary — the same treatment
 * `NicheKind` gets. This module is deliberately free of Prisma, React and DTO
 * imports so the server, the browser and the pure analytics engine can all
 * read one definition of the word.
 */

export type NicheFormat = "shorts" | "longform";

/** Every format, in the order a chooser should offer them. Shorts first. */
export const NICHE_FORMATS: readonly NicheFormat[] = ["shorts", "longform"];

/**
 * The default for anything that predates the word.
 *
 * Shorts, matching the column default, because every niche created before
 * formats existed IS a Shorts niche. Long Form starts empty and is opted into
 * deliberately — a default that guessed "longform" would move rows into a list
 * nobody has built yet.
 */
export const DEFAULT_NICHE_FORMAT: NicheFormat = "shorts";

/**
 * The stored column, narrowed.
 *
 * Anything unrecognised reads as "shorts", mirroring `toNicheKind`'s
 * fail-closed reasoning: an unreadable value must not quietly move a niche —
 * and every channel filed under it — out of the product the team actually
 * uses. Landing in the Shorts list is visible and arguable; landing in a Long
 * Form list nobody looks at yet is neither.
 */
export function toNicheFormat(stored: string | null | undefined): NicheFormat {
  return stored === "longform" ? "longform" : "shorts";
}

export function isNicheFormat(value: unknown): value is NicheFormat {
  return value === "shorts" || value === "longform";
}

/**
 * The minimum shape needed to answer "is this video of that format?".
 *
 * Both fields, deliberately, because the two formats are decided from
 * DIFFERENT columns — see `isVideoOfFormat` below for why neither one alone
 * can answer both questions.
 */
export interface VideoFormatSource {
  /** True only when the classifier positively identified a Short. */
  readonly isShort: boolean;
  /** "short" | "not_short" | "uncertain" — the classifier's full verdict. */
  readonly classification: string;
}

/**
 * Does this video belong to this format's analytics?
 *
 * THE LOAD-BEARING RULE, and the single most breakable line in the whole
 * format concept, so it is stated in full:
 *
 *   shorts   — `isShort === true`. Unchanged from the filter the whole app
 *              already runs on: only videos the classifier POSITIVELY
 *              identified as Shorts.
 *
 *   longform — `classification === "not_short"`, and NEVER `!isShort`.
 *
 * The two are not complements, and treating them as complements is the bug
 * this function exists to make unwritable. `isShort: false` covers TWO
 * populations: videos the classifier positively identified as long-form
 * (`classification: "not_short"`), and videos it COULD NOT RESOLVE
 * (`classification: "uncertain"`). The Shorts side already handles uncertainty
 * conservatively — an uncertain video has `isShort: false` and is excluded, so
 * doubt shrinks the sample rather than inflating a rate. Writing longform as
 * `!isShort` would quietly catch that entire uncertain population on the other
 * side: every video nobody could classify would surface as "long-form", with
 * its views inflating Long Form totals exactly the way the Shorts filter was
 * built to prevent.
 *
 * So an uncertain video appears in NEITHER format. That is a deliberate,
 * conservative asymmetry — the sum of the two formats is allowed to be smaller
 * than the library, and the gap IS the uncertainty, visible instead of
 * laundered into whichever side asked first.
 */
export function isVideoOfFormat(video: VideoFormatSource, format: NicheFormat): boolean {
  return format === "shorts"
    ? video.isShort === true
    : video.classification === "not_short";
}
