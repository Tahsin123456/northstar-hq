/**
 * Historical view reconstruction.
 *
 * Answers "what did these Shorts look like on a given date?" using the
 * `VideoSnapshot` time series — never by working backwards from today's
 * counters.
 *
 * WHY THIS CANNOT BE FAKED
 * A distribution "30 days ago" built from current view counts is not a
 * historical distribution; it is today's distribution with a date label on it.
 * Every Short would appear to have had its present-day views a month early,
 * which would make the chart claim the opposite of what actually happened
 * (Shorts appear to *lose* nothing over time and the shape never changes). The
 * only honest source is a view count that was actually recorded at that time.
 *
 * So this returns the real snapshot value where one exists and reports
 * coverage where one does not. A caller with insufficient coverage is told so
 * and shows nothing.
 */

import { prisma } from "@/server/db";
import { getCurrentOrgId } from "./user-service";

/** Below this share of covered videos, the reconstruction is not trustworthy. */
export const MIN_HISTORY_COVERAGE = 0.8;

export interface HistoricalVideoPoint {
  readonly id: string;
  readonly channelId: string;
  readonly publishedAt: number;
  /** View count as recorded at or before `asOfMs`. */
  readonly views: number;
  readonly isShort: boolean;
}

export interface HistoricalViewsResult {
  readonly asOfMs: number;
  /** True when enough videos had a snapshot at or before `asOfMs`. */
  readonly available: boolean;
  /** 0..1 — the share of in-window Shorts with a usable snapshot. */
  readonly coverage: number;
  readonly totalInWindow: number;
  readonly covered: number;
  /**
   * Earliest snapshot this organization has, so the UI can say how far back its
   * own history goes.
   */
  readonly earliestSnapshotMs: number | null;
  readonly videos: readonly HistoricalVideoPoint[];
}

/**
 * View counts for Shorts uploaded in `[asOf - windowDays, asOf)`, as they stood
 * at `asOf`.
 *
 * The window ends at `asOf` rather than today, so the result is genuinely "the
 * distribution as it looked then" — the same Shorts, with the views they had.
 */
export async function getHistoricalViews(options: {
  asOfMs: number;
  windowDays: number;
}): Promise<HistoricalViewsResult> {
  // Reconstruction covers what the team tracks. Scoping this to the individual
  // would give two colleagues different history for the same channel.
  const organizationId = await getCurrentOrgId();
  const { asOfMs, windowDays } = options;

  const asOf = new Date(asOfMs);
  const windowStart = new Date(asOfMs - windowDays * 86_400_000);

  const [videos, earliest] = await Promise.all([
    prisma.video.findMany({
      where: {
        isShort: true,
        publishedAt: { gte: windowStart, lt: asOf },
        channel: { trackedBy: { some: { organizationId, isActive: true } } },
      },
      select: {
        id: true,
        channelId: true,
        publishedAt: true,
        isShort: true,
        // The most recent observation at or before the target moment. Ordering
        // descending and taking one is what makes this "as of", rather than
        // "the first time we ever saw it".
        snapshots: {
          where: { capturedAt: { lte: asOf } },
          orderBy: { capturedAt: "desc" },
          take: 1,
          select: { viewCount: true },
        },
      },
    }),
    // Reached through the same tracking join as the videos above. Unscoped,
    // this reported the oldest snapshot in the entire installation, so the UI
    // would tell one team its history reaches back to a date only another
    // team's channels can actually support — and disclose that date to them.
    prisma.videoSnapshot.findFirst({
      where: {
        video: { channel: { trackedBy: { some: { organizationId, isActive: true } } } },
      },
      orderBy: { capturedAt: "asc" },
      select: { capturedAt: true },
    }),
  ]);

  const points: HistoricalVideoPoint[] = [];
  for (const video of videos) {
    const snapshot = video.snapshots[0];
    // No observation at that time means we genuinely do not know. Skipping is
    // correct; substituting the current count would invent history.
    if (!snapshot) continue;
    points.push({
      id: video.id,
      channelId: video.channelId,
      publishedAt: video.publishedAt.getTime(),
      views: Number(snapshot.viewCount),
      isShort: true,
    });
  }

  const totalInWindow = videos.length;
  const covered = points.length;
  const coverage = totalInWindow === 0 ? 0 : covered / totalInWindow;

  return {
    asOfMs,
    // An empty window is "no data", not "fully covered".
    available: totalInWindow > 0 && coverage >= MIN_HISTORY_COVERAGE,
    coverage,
    totalInWindow,
    covered,
    earliestSnapshotMs: earliest?.capturedAt.getTime() ?? null,
    videos: points,
  };
}
