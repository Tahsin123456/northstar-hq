import { HOUR_MS } from "@/lib/analytics/hit-rate";
import { isVideoOfFormat, type VideoFormatSource } from "@/lib/niches/niche-format";

/**
 * =========================================================================
 * HOW OFTEN TO PHOTOGRAPH A SHORT
 * =========================================================================
 *
 * WHY THIS FILE EXISTS
 * The snapshot cadence used to be one number for everything: 360 minutes, from
 * `OrganizationSettings.snapshotIntervalMinutes`, applied identically to a
 * three-day-old Short and a three-hundred-day-old one. That was defensible when
 * a hit was a lifetime view count, because any reading answered the question
 * equally well.
 *
 * Under a windowed rule it is not defensible at all. The verdict is decided by
 * what the Short had done by the time its window shut, so a reading taken
 * inside the window is the only kind that can prove a hit, and every reading
 * taken afterwards is — for this purpose — worthless. Sampling both at the same
 * rate spends the same storage to learn much less, and it is the direct cause
 * of the state the library is in: 3,196 snapshots over 2,594 videos, and only
 * 59 Shorts (2.5%) with any reading inside seven days of publishing. Nearly
 * every one of those rows was taken too late to decide anything.
 *
 * THE SHAPE: DENSE INSIDE THE WINDOW, SPARSE OUTSIDE IT.
 *   • the opening stretch — hourly. This is where a Short either takes off or
 *     does not, and an hourly reading is what makes "it had cleared the bar by
 *     hour 6" a fact rather than a guess.
 *   • the rest of the window — every six hours. Enough to place the crossing
 *     within a quarter of a day, which is all the verdict needs: the outcome is
 *     binary at the close and `observedAtHours` only has to be honest about
 *     when the evidence was taken.
 *   • after the window — daily at most. The verdict is frozen; what is left is
 *     the lifetime trend, and that has never needed four readings a day.
 *
 * THE BOUNDARIES COME FROM THE NICHE'S OWN WINDOW, not from a hardcoded number
 * of days. A team that judges Shorts over 48 hours gets its dense phase inside
 * those 48 hours; a team on 14 days gets a proportionate one. A constant here
 * would be right for exactly one team's rule and quietly wrong for every other.
 *
 * WHAT IT COSTS is stated on `snapshotIntervalMinutes` below, in rows per Short
 * per window, because a cadence proposal without a row count is a wish.
 */

/** Readings an hour apart, for the stretch that decides the outcome. */
const DENSE_INTERVAL_MINUTES = 60;

/**
 * The opening stretch, as a fraction of the window.
 *
 * A seventh, so the canonical seven-day rule gets its first DAY sampled hourly
 * — the phrasing everybody uses for this ("hourly for the first day") turned
 * into something that scales with the rule instead of assuming it.
 */
const DENSE_FRACTION = 1 / 7;

/**
 * Bounds on that stretch.
 *
 * The floor keeps a very short window from having no dense phase at all: a
 * six-hour rule divided by seven is under an hour, and a rule that tight is
 * exactly the one that needs every reading it can get. The ceiling stops a
 * 30-day window from demanding four days of hourly sampling for a Short whose
 * fate was decided on day one — 24 hourly readings is already the shape of the
 * curve.
 */
const MIN_DENSE_PHASE_HOURS = 1;
const MAX_DENSE_PHASE_HOURS = 24;

/** The rest of the window: four readings a day. */
const IN_WINDOW_INTERVAL_MINUTES = 360;

/** After the close: one a day, and only for the lifetime trend. */
const AFTER_WINDOW_INTERVAL_MINUTES = 1440;

export interface SnapshotCadenceInput {
  /** The video's age at capture time, in hours. */
  readonly ageHours: number;
  /**
   * The window that will judge this video, in hours, or null when there is
   * none — a long-form video, or a Short whose channel sits in no niche with a
   * complete rule. Null means there is no verdict to gather evidence for, so
   * the organization's own interval is used unchanged and nothing about this
   * change touches those videos.
   */
  readonly windowHours: number | null;
  /** `OrganizationSettings.snapshotIntervalMinutes`. */
  readonly baseIntervalMinutes: number;
}

/** Where a video sits relative to the window that judges it. */
export type SnapshotPhase = "dense" | "in-window" | "after-window" | "unwindowed";

/** The opening stretch of a window, in hours. Derived, never hardcoded. */
export function densePhaseHours(windowHours: number): number {
  return Math.min(
    MAX_DENSE_PHASE_HOURS,
    Math.max(MIN_DENSE_PHASE_HOURS, Math.round(windowHours * DENSE_FRACTION)),
  );
}

/** Which phase a video is in. Exported so a diagnostic can say so out loud. */
export function snapshotPhase(input: SnapshotCadenceInput): SnapshotPhase {
  const { ageHours, windowHours } = input;
  if (windowHours === null || windowHours <= 0) return "unwindowed";
  if (ageHours >= windowHours) return "after-window";
  if (ageHours < densePhaseHours(windowHours)) return "dense";
  return "in-window";
}

/**
 * The minimum gap between two snapshots of this video, right now.
 *
 * WHAT THE CADENCE COSTS, per Short, per 168-hour window, at the ceiling:
 *   • dense phase   24 hours ÷ 1 hour  = 24 rows
 *   • rest of window 144 hours ÷ 6 hours = 24 rows
 *   • ------------------------------------------------
 *   • at most 48 rows inside the window, then ~1 per day for as long as the
 *     Short is inside the lookback.
 *
 * Against today's uniform 360 minutes, which produces 28 rows over the same
 * seven days and then 4 a day forever, that is +71% while the window is open
 * and −75% afterwards. Any Short older than about a fortnight ends up costing
 * FEWER rows than it does today, and the rows it does cost are the ones that
 * can decide something.
 *
 * TWO THINGS KEEP THAT A CEILING RATHER THAN A PROMISE.
 * The first is `channel-sync`'s existing guard — `if (!dueByTime || !changed)
 * continue` — which drops any reading identical to the one before it, so a
 * Short that stops moving stops costing rows however dense the schedule says to
 * be. The second is that snapshots are only written when a sync actually runs:
 * this function can ask for hourly readings, but nothing will take them unless
 * the sweep reaches that channel hourly. That is why `findDueChannels` refreshes
 * a channel with an open window more often than one without — the two halves
 * only work together.
 *
 * The organization's own interval still wins when it is DENSER than what this
 * asks for. A team that has chosen 15-minute sampling has chosen to spend that,
 * and this function's job is to stop the long tail wasting rows, not to slow
 * down a team that wants more.
 */
export function snapshotIntervalMinutes(input: SnapshotCadenceInput): number {
  const base = Math.max(0, input.baseIntervalMinutes);

  switch (snapshotPhase(input)) {
    // No window, no verdict to gather evidence for: behave exactly as before.
    case "unwindowed":
      return base;
    case "dense":
      return Math.min(base, DENSE_INTERVAL_MINUTES);
    case "in-window":
      return Math.min(base, IN_WINDOW_INTERVAL_MINUTES);
    // The one phase where the organization's interval is a FLOOR rather than a
    // ceiling. Its verdict is settled and cannot be revisited, so anything more
    // than a daily reading is storage spent on a question already answered.
    case "after-window":
      return Math.max(base, AFTER_WINDOW_INTERVAL_MINUTES);
  }
}

/**
 * The two windows a channel carries under formats, in hours.
 *
 * Structural rather than an import of the sync service's shape, for the same
 * reason everything in this file is: the cadence is isomorphic and the server
 * is only one of its callers.
 */
export interface ChannelFormatWindows {
  /** The governing window among the channel's SHORTS-format niches, or null. */
  readonly shortsWindowHours: number | null;
  /** The governing window among its LONGFORM-format niches, or null. */
  readonly longformWindowHours: number | null;
}

/**
 * Which window judges THIS video — and therefore paces its snapshots.
 *
 * The dispatch is `isVideoOfFormat`, not a complement: a Short reads the
 * shorts window, a positively-identified long-form video reads the longform
 * window, and an UNCERTAIN video reads NEITHER — null, the flat organization
 * interval — because no verdict will ever be gathered for it and dense
 * sampling would be storage spent on a question nobody will ask. Before any
 * longform niche exists `longformWindowHours` is always null, so a long-form
 * video resolves to null exactly as it always did: this function changes
 * nothing about any existing row until somebody opts a channel into Long Form.
 *
 * The maths downstream (`snapshotIntervalMinutes`) is untouched — it already
 * scales with whatever window it is handed, and this only decides which one
 * that is.
 */
export function hitWindowForVideo(
  video: VideoFormatSource,
  windows: ChannelFormatWindows,
): number | null {
  if (isVideoOfFormat(video, "shorts")) return windows.shortsWindowHours;
  if (isVideoOfFormat(video, "longform")) return windows.longformWindowHours;
  return null;
}

/**
 * =========================================================================
 * THE GRID EVERY READING IS FILED ON
 * =========================================================================
 *
 * Five minutes, and the number is chosen from both directions.
 *
 * FROM ABOVE: it must be finer than any cadence this app schedules, or a
 * legitimate reading would be swallowed. The densest `snapshotIntervalMinutes`
 * ever returns is 60, and the tightest interval an organization can configure
 * for itself is minutes rather than seconds. Five is comfortably inside that.
 *
 * FROM BELOW: it must be coarser than the window in which two syncs of the same
 * channel can race. That window is one run's read-then-write — the sweep and a
 * manual Refresh overlapping — which is seconds to about a minute. Five minutes
 * covers it with room to spare.
 *
 * Snapping down rather than to the nearest, so a reading is never filed under a
 * bucket that had not started when it was taken.
 */
export const SNAPSHOT_GRID_MS = 5 * 60 * 1000;

/**
 * The bucket a reading taken at `at` belongs to.
 *
 * This is what makes snapshot idempotency a database constraint rather than a
 * matter of timing — see `VideoSnapshot` in the schema and the upsert in
 * `channel-sync`. Two overlapping runs of the same channel produce the same
 * `capturedAt` for the same video, so the second one's row collides with the
 * first's instead of joining it.
 */
export function snapshotBucket(at: Date): Date {
  return new Date(Math.floor(at.getTime() / SNAPSHOT_GRID_MS) * SNAPSHOT_GRID_MS);
}

/**
 * True when this video's window is still open at `nowMs`.
 *
 * The sweep uses it to decide which channels are urgent. Kept here beside the
 * cadence because "inside the window" has to mean the same thing to both — a
 * channel refreshed on the slow schedule cannot supply the dense readings the
 * cadence above is asking for.
 */
export function isInsideWindow(
  publishedAtMs: number,
  windowHours: number | null,
  nowMs: number,
): boolean {
  if (windowHours === null || windowHours <= 0) return false;
  return nowMs < publishedAtMs + windowHours * HOUR_MS;
}
