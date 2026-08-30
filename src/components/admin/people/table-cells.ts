/**
 * The two cell classes every table on the People screen shares.
 *
 * Shared rather than re-declared per file: the roster and the invitations table
 * under it are read as one screen, and padding that drifts between them shows
 * up as a step in the page. They were already duplicated across Users and
 * Employees when those were two screens; merging them is the moment to stop.
 */
export const HEAD_CELL =
  "px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground";

export const CELL = "px-4 py-2.5 text-[13px]";
