import "server-only";

import { prisma } from "@/server/db";
import { getVisibleNicheIds } from "@/server/auth/niche-scope";
import type { NicheViewsGainedDTO, NicheViewsGainedEntryDTO } from "@/lib/dto";
import type { NicheFormat } from "@/lib/niches/niche-format";
import { getCurrentOrgId } from "./user-service";
import { nicheFormatWhere } from "./niche-service";
import {
  baselineGraceMsFor,
  viewsGainedByChannel,
  type ChannelViewsGained,
} from "./views-gained-service";

/**
 * =========================================================================
 * WHAT EACH NICHE GAINED — THE VIEW SIDE OF THE MONEY FIGURES
 * =========================================================================
 *
 * The niche earnings panel and the niche cards price "views GAINED during the
 * selected period" — every view the tracked channels earned in the window,
 * old uploads included — not the lifetime views of what happened to be
 * published in it. This service supplies those gains, grouped per niche, from
 * the shared snapshot-delta measurement in `views-gained-service.ts`.
 *
 * THE MEASURED SPAN IS THE COVERED SPAN, NEVER THE REQUESTED ONE. The app can
 * only measure from the day it started recording view history. When the
 * period reaches further back than the history does, the whole answer is
 * measured over `[max(startMs, earliest snapshot), endMs)`. The clamp travels
 * back as `measuredFromMs` so every surface can say "measured over the last 9
 * of 30 days" instead of presenting a partial span as the period.
 *
 * "EARLIEST SNAPSHOT" MEANS EARLIEST AMONG THE VIDEOS BEING PRICED, and the
 * narrowing is not a nicety. The anchor used to be the organization's earliest
 * capture of ANY video — no format filter, no niche filter — while the
 * measurement that follows covers only this format's visible-niche members. A
 * long-form-only channel, or a channel filed under no niche at all, that
 * happened to be swept first would then set the start instant for the Shorts
 * page and consume the whole baseline grace before a single priced video was
 * considered. That is the same argmin-of-coverage flaw the grace exists to
 * kill, surviving one layer up, so the anchor query carries the same population
 * filter the measurement does.
 *
 * THAT SPAN IS SHARED BUT NOT PERFECTLY UNIFORM, AND THE LABEL SAYS SO. This
 * file used to claim the span was uniform — one start for every video — and
 * that claim is what broke the money figures on 1 September. First-ever
 * snapshots are written channel by channel over minutes to hours, so the
 * org-wide MINIMUM `capturedAt` is precisely the instant at which the fewest
 * videos have a reading: every video first captured a few minutes later held
 * nothing at-or-before it, was dropped from the sum AND from `coveredVideos`,
 * and coverage landed at a few percent against a 0.9 floor. Every niche said
 * "Not enough view history yet" while the owner had rates entered, and a
 * 30-day period would have stayed that way until October.
 *
 * So the videos that start a little late are now measured from their own first
 * reading, within the grace `baselineGraceMsFor` sizes — the raggedness is
 * bounded, reported as `maxBaselineLagMs`, and stated in the owner's label
 * instead of being asserted away. The tail of the span is reported the same way
 * and separately, as `maxEndLagMs`: snapshots stop at the last one written
 * before the period closed, which on a daily cadence can be a day short, and a
 * caveat that spoke only about the head went silent in exactly the case where
 * the figure was a third low. The alternative that keeps a perfectly
 * uniform start — moving `measuredFromMs` forward to a percentile of
 * first-snapshot times — was rejected: one newly-added channel holding a tenth
 * of the library would drag the whole organization's span from thirty days to
 * hours under a label that stayed technically true.
 *
 * VIEW COUNTS ONLY. The rate stays on `NicheDTO.rpm` behind `finance.view`;
 * what this returns is the same class of numbers `analytics.view` already
 * covers on the dataset. The niche SCOPE still applies — a niche-scoped
 * reader's invisible niches are OMITTED from the response entirely, because
 * even a view total is a statement about a niche they were not assigned.
 */

/** The full row set the grouping core works over. */
interface MemberChannel {
  readonly channelId: string;
  readonly ownershipType: string;
}

/**
 * The pure grouping: member channels' measured gains, filed under each niche.
 *
 * A CHANNEL IN TWO NICHES COUNTS IN BOTH — correct for a per-niche figure,
 * exactly as `niche-rpm-service` states for rates, and the reason the
 * earnings builder downstream refuses to SUM niches sharing a channel.
 *
 * Own/competitor sums include only channels that measured something
 * (`coveredVideos > 0`): an unmeasured channel's zero is "we could not ask",
 * not "it gained nothing", so it contributes to the coverage denominator —
 * which every money caller holds a floor against — and to nothing else. The
 * coverage counts sum over ALL members for the same reason: leaving the dark
 * channels out would report a full-coverage niche whose biggest channel was
 * never measured.
 *
 * THE LAGS ARE MAXIMISED PER NICHE, NOT ONLY PER PAGE. The caveat they produce
 * is rendered directly under ONE niche's money figure on the niche card, where
 * a page-wide maximum is a false statement about that niche: a niche every one
 * of whose videos held a reading at the window's start would still have read
 * "the app started recording some of these videos up to 3 hours into that span
 * … this figure is a little low" because some unrelated niche's channel was
 * swept late. The error is conservative and it is still invented, which is the
 * same class of defect as an invented number. The page-level maximum stays on
 * the DTO root for the Overview panel, where "some of these videos" is true of
 * the page.
 */
export function groupNicheViewsGained(
  nicheIds: readonly string[],
  membersByNiche: ReadonlyMap<string, readonly MemberChannel[]>,
  gainsByChannel: ReadonlyMap<string, ChannelViewsGained>,
): NicheViewsGainedEntryDTO[] {
  return nicheIds.map((nicheId) => {
    let ourViewsGained = 0;
    let competitorViewsGained = 0;
    let coveredVideos = 0;
    let totalVideos = 0;
    let maxBaselineLagMs = 0;
    let maxEndLagMs = 0;
    const ownChannelIds: string[] = [];

    for (const member of membersByNiche.get(nicheId) ?? []) {
      const gains = gainsByChannel.get(member.channelId);
      if (gains === undefined) continue;

      coveredVideos += gains.coveredVideos;
      totalVideos += gains.totalVideos;
      // Maximum, not average: the sentence an owner reads says "up to", and an
      // average would make it false for the worst video in the niche.
      if (gains.maxBaselineLagMs > maxBaselineLagMs) {
        maxBaselineLagMs = gains.maxBaselineLagMs;
      }
      if (gains.maxEndLagMs > maxEndLagMs) maxEndLagMs = gains.maxEndLagMs;

      if (gains.coveredVideos === 0) continue;
      if (member.ownershipType === "own") {
        ourViewsGained += gains.viewsGained;
        // Only channels that MEASURED something: the ids feed the earnings
        // total's double-count check, and a channel contributing zero views to
        // two niches cannot double anything.
        ownChannelIds.push(member.channelId);
      } else {
        competitorViewsGained += gains.viewsGained;
      }
    }

    return {
      nicheId,
      ourViewsGained,
      competitorViewsGained,
      coveredVideos,
      totalVideos,
      maxBaselineLagMs,
      maxEndLagMs,
      ownChannelIds,
    };
  });
}

/**
 * Views gained per visible niche of one format, over the covered part of the
 * requested period.
 */
export async function getNicheViewsGained(options: {
  readonly format: NicheFormat;
  readonly startMs: number;
  /** Exclusive. */
  readonly endMs: number;
}): Promise<NicheViewsGainedDTO> {
  const { format, startMs, endMs } = options;
  const [organizationId, visibleNiches] = await Promise.all([
    getCurrentOrgId(),
    /*
     * The niche scope, applied to the QUERY below rather than to the answer.
     * `analytics.view` gates the route; this decides which niches it is
     * answered FOR. Invisible niches are left out of the response entirely —
     * the same absence-not-empty rule `NicheDTO.rpm` follows — so a scoped
     * reader cannot learn even the view totals of a niche that is not theirs.
     */
    getVisibleNicheIds(),
  ]);

  const nicheRows = await prisma.niche.findMany({
    where: {
      organizationId,
      ...nicheFormatWhere(format),
      ...(visibleNiches === null ? {} : { id: { in: [...visibleNiches] } }),
    },
    select: { id: true },
  });

  const nicheIds = nicheRows.map((row) => row.id);

  /*
   * THE MEMBER SET IS READ BEFORE THE ANCHOR, not beside it, because the anchor
   * is defined in terms of it. One extra round trip buys a start instant that
   * belongs to the videos actually being priced — see the header's note on
   * the argmin-of-coverage flaw surviving one layer up.
   */
  const members =
    nicheIds.length === 0
      ? []
      : await prisma.trackedChannel.findMany({
          where: {
            organizationId,
            isActive: true,
            // Membership in one of the format's visible niches, in the query
            // beside the tenancy filter — the same placement every other
            // tracked-channel read uses, so the next caller inherits the
            // narrowing instead of having to remember it.
            niches: { some: { nicheId: { in: nicheIds } } },
          },
          select: {
            channelId: true,
            ownershipType: true,
            niches: { select: { nicheId: true } },
          },
        });

  const memberChannelIds = members.map((member) => member.channelId);

  /*
   * The earliest usable baseline the PRICED population's history holds, reached
   * through the same tracking join as everything else — the pattern
   * `history-service.ts` sets, and for its reason: unscoped, this would report
   * another team's oldest snapshot and promise history these channels cannot
   * support.
   *
   * The channel and format narrowing is this query's other half, and it is the
   * half that was missing. `viewsGainedByChannel` below measures exactly these
   * channels and exactly this format's videos; an anchor drawn from a wider
   * population can only sit EARLIER than the first reading any priced video
   * holds, which spends the whole baseline grace before the measurement starts.
   * The format filter IS `isVideoOfFormat` as a where clause — never
   * `isShort: false` on the longform side, which would sweep in every
   * unclassified video.
   */
  const earliest =
    memberChannelIds.length === 0
      ? null
      : await prisma.videoSnapshot.findFirst({
          where: {
            video: {
              channelId: { in: memberChannelIds },
              ...(format === "shorts"
                ? { isShort: true as const }
                : { classification: "not_short" as const }),
              channel: { trackedBy: { some: { organizationId, isActive: true } } },
            },
          },
          orderBy: { capturedAt: "asc" },
          select: { capturedAt: true },
        });

  const earliestSnapshotMs = earliest?.capturedAt.getTime() ?? null;
  const measuredFromMs =
    earliestSnapshotMs === null ? null : Math.max(startMs, earliestSnapshotMs);

  /*
   * NOTHING TO MEASURE IS SAID, NOT COMPUTED. With no snapshots at all, or a
   * period that ends before the history begins, every delta the measurement
   * could return would be the absence of a reading dressed as a zero. The
   * empty `niches` array is the no-history shape: a missing entry reads as
   * "unmeasured" downstream, which renders as words rather than as money.
   */
  if (measuredFromMs === null || measuredFromMs >= endMs) {
    return {
      requestedStartMs: startMs,
      endMs,
      measuredFromMs: null,
      earliestSnapshotMs,
      // No measurement ran, so there is no raggedness to report. `null` rather
      // than 0, which would read as "measured, and perfectly uniform".
      maxBaselineLagMs: null,
      maxEndLagMs: null,
      niches: [],
    };
  }

  /*
   * ONE measurement over every member channel, then grouped in memory. A
   * per-niche call would re-read the same channel's snapshots once per niche
   * it is filed under; this way a channel in two niches is measured once and
   * counted in both, mirroring how the RPM service judges it once.
   */
  const gainsByChannel: ReadonlyMap<string, ChannelViewsGained> =
    members.length === 0
      ? new Map<string, ChannelViewsGained>()
      : await viewsGainedByChannel({
          organizationId,
          channelIds: memberChannelIds,
          window: { startMs: measuredFromMs, endMs },
          // The niche's format, unlike the RPM denominator: what is priced
          // here is one format's niche, so only that format's videos may be
          // measured — and an uncertain video is in neither format, per
          // `isVideoOfFormat`.
          format,
          /*
           * THE GRACE, AND THIS CALLER IS THE ONLY ONE THAT ASKS FOR IT.
           *
           * Sized off the span actually being measured, not off the requested
           * period: the clamp above is exactly when the sweep-order dropout
           * bites, so the allowance has to be a fraction of what is really on
           * screen. Understating this niche's money is the safe direction;
           * understating the RPM denominator is not, which is why
           * `niche-rpm-service` passes nothing here.
           */
          baselineGraceMs: baselineGraceMsFor(measuredFromMs, endMs),
        });

  /*
   * The raggedest head and the raggedest tail anywhere in the answer, so the
   * PAGE-level label can state a TRUE bound rather than quoting the cap.
   * Maximum, not average: the sentence an owner reads says "up to", and an
   * average would make it false for the worst video.
   *
   * These are for the Overview panel, which is a statement about the page. The
   * niche CARD renders its caveat under one niche's figure, so it reads the
   * per-niche lags on the entry instead — see `groupNicheViewsGained`.
   */
  let maxBaselineLagMs = 0;
  let maxEndLagMs = 0;
  for (const gains of gainsByChannel.values()) {
    if (gains.maxBaselineLagMs > maxBaselineLagMs) maxBaselineLagMs = gains.maxBaselineLagMs;
    if (gains.maxEndLagMs > maxEndLagMs) maxEndLagMs = gains.maxEndLagMs;
  }

  const inScope = new Set(nicheIds);
  const membersByNiche = new Map<string, MemberChannel[]>();
  for (const member of members) {
    const row: MemberChannel = {
      channelId: member.channelId,
      ownershipType: member.ownershipType,
    };
    for (const { nicheId } of member.niches) {
      // A channel matched the filter through ONE of its niches; its other
      // memberships may be outside this format or this reader's scope, and
      // filing gains under those would leak exactly what the query excluded.
      if (!inScope.has(nicheId)) continue;
      const list = membersByNiche.get(nicheId);
      if (list) list.push(row);
      else membersByNiche.set(nicheId, [row]);
    }
  }

  return {
    requestedStartMs: startMs,
    endMs,
    measuredFromMs,
    earliestSnapshotMs,
    maxBaselineLagMs,
    maxEndLagMs,
    niches: groupNicheViewsGained(nicheIds, membersByNiche, gainsByChannel),
  };
}
