import "server-only";

import { prisma } from "@/server/db";
import {
  evaluateHit,
  isFinalOutcome,
  pickGoverningRule,
  resolveHitRule,
  type HitOutcome,
  type HitRule,
  type HitVerdict,
  type NicheHitRule,
  type WindowObservation,
} from "@/lib/analytics/hit-rate";

/**
 * =========================================================================
 * MATERIALISING WHAT EVERY SHORT DID INSIDE ITS WINDOW
 * =========================================================================
 *
 * WHY THE ANSWER IS STORED RATHER THAN COMPUTED ON READ
 * "Did this Short reach 500,000 within seven days?" is a question about the
 * snapshot series, not about the video row. Answering it live means a
 * per-video range scan on every dashboard load, on every payroll preview, on
 * every PDF — for an answer that CANNOT CHANGE once the window has shut. Views
 * at day seven is a historical fact. This service works it out once, writes it
 * to `VideoHitEvaluation`, and everything downstream reads a column.
 *
 * WHAT IT DOES NOT DO: decide what a hit is. `evaluateHit` in
 * `@/lib/analytics/hit-rate` is the only thing in this product that decides
 * that, and this file's job is to feed it evidence and persist what it says.
 * The moment this module starts comparing a view count to a threshold on its
 * own, the dashboard and the payslip have two definitions.
 *
 * IDEMPOTENT, AND FINAL VERDICTS ARE FROZEN
 * Re-running changes nothing unless a verdict genuinely moved. A closed
 * window's "hit" or "miss" is never recomputed from newer data — see
 * `decideWrite` for why that is a correctness requirement and not merely a
 * saving — while "pending" and "unknown" are revisited every run, because those
 * are exactly the two that new evidence or the passage of time can settle.
 *
 * WHEN TO RUN IT
 *   • on the scheduled sync, after channels have been refreshed and new
 *     snapshots written (`sync-service`);
 *   • when a niche's threshold or window changes — every Short judged by that
 *     niche is re-decided against the new rule (`reevaluateHitsForNiche`);
 *   • when a Short is newly synced, which the scheduled run above covers.
 *
 * There is deliberately no second schedule. The cron endpoint this hangs off
 * is the only thing in this deployment that reliably runs on a clock, and a
 * second one would be a second thing to configure, forget, and disagree about.
 *
 * NO SESSION. `organizationId` is a parameter, every query filters on it, and
 * nothing here reads a cookie — the scheduler has no session and a single
 * session-dependent call would make this throw 401 in production while passing
 * every test that happened to run signed in.
 */

/** Keeps SQLite transactions a sane size, as in `channel-sync`. */
const WRITE_CHUNK = 50;

export interface HitEvaluationSummary {
  readonly organizationId: string;
  /** Shorts on tracked, active channels that were looked at. */
  readonly shortsConsidered: number;
  readonly created: number;
  readonly updated: number;
  /** Re-decided and identical. The number that should dominate a steady state. */
  readonly unchanged: number;
  /** Already settled and left alone without being recomputed. */
  readonly frozen: number;
  /**
   * The verdicts as they now stand across everything considered — not only the
   * rows written. A run that changes nothing still reports the shape of the
   * library, which is what makes this summary worth logging.
   */
  readonly byOutcome: Readonly<Record<HitOutcome, number>>;
  /**
   * Shorts whose channel sits in no niche with BOTH halves of a rule.
   *
   * Reported separately from the four outcomes because it is not a verdict
   * about a Short, it is a niche somebody has to finish configuring. It is also
   * the number that tells an admin why a hit rate looks thin.
   */
  readonly unscoreable: number;
  readonly durationMs: number;
}

export interface EvaluateHitsOptions {
  /** Limit to channels filed under these niches. Used after a rule changes. */
  readonly nicheIds?: readonly string[];
  /** Limit to specific videos. Used when a handful were just synced. */
  readonly videoIds?: readonly string[];
  /** Injectable clock. The scheduler passes nothing; tests move time. */
  readonly nowMs?: number;
}

/**
 * The persisted verdict, in the shape this module compares and writes.
 *
 * `bigint` for views because that is what the column is: a Short's counter can
 * exceed 2^31 and the rest of the schema has already committed to carrying that
 * honestly rather than rounding it at the edge.
 */
interface EvaluationFields {
  readonly outcome: HitOutcome;
  readonly nicheId: string | null;
  readonly thresholdApplied: number | null;
  readonly windowHoursApplied: number | null;
  readonly viewsAtWindow: bigint | null;
  readonly observedAtHours: number | null;
  readonly windowClosesAt: Date | null;
}

export type EvaluationDecision = "create" | "update" | "unchanged" | "frozen";

/**
 * Whether a freshly computed verdict should be written over the stored one.
 *
 * THE FROZEN CASE IS A CORRECTNESS RULE, NOT AN OPTIMISATION.
 * A "miss" is often inferred from "lifetime views are still under the bar" —
 * sound forever, because views only rise and the window is already shut. But
 * that inference is made against TODAY's total. Recompute it in a year, after
 * the Short has crept past the threshold, and the same evidence now produces
 * "unknown": a certain miss would decay into a shrug. Freezing settled verdicts
 * is what stops the library getting vaguer the longer it is kept.
 *
 * A RULE CHANGE THAWS EVERYTHING, because the stored verdict answers a question
 * nobody is asking any more. An admin who moves GTA from 1M/7d to 500K/48h has
 * redefined the bar, and every Short under it has to be re-decided — against
 * the new rule, and recorded with it, so a February bonus can still be
 * explained by the numbers that applied in February.
 *
 * "pending" and "unknown" are always re-decided. The first becomes something
 * else the moment the window shuts; the second is the absence of evidence, and
 * evidence can arrive — a backfilled snapshot series would settle a pile of
 * them at once.
 */
export function decideWrite(
  existing: EvaluationFields | null,
  next: EvaluationFields,
): EvaluationDecision {
  if (existing === null) return "create";

  const ruleUnchanged =
    existing.thresholdApplied === next.thresholdApplied &&
    existing.windowHoursApplied === next.windowHoursApplied;

  if (ruleUnchanged && isFinalOutcome(existing.outcome)) return "frozen";

  const identical =
    existing.outcome === next.outcome &&
    existing.nicheId === next.nicheId &&
    ruleUnchanged &&
    existing.viewsAtWindow === next.viewsAtWindow &&
    existing.observedAtHours === next.observedAtHours &&
    sameInstant(existing.windowClosesAt, next.windowClosesAt);

  return identical ? "unchanged" : "update";
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

/**
 * The verdict for a Short whose channel has no usable rule.
 *
 * STORED AS "unknown" WITH A NULL NICHE, and the two nulls are the point. The
 * outcome column has four values and this is not a fifth one — inventing a
 * verdict is the one thing the brief forbids outright. It is not a "miss"
 * either: a Short cannot fail a bar nobody set, and calling it one would let an
 * unconfigured niche drag a hit rate down while looking like a measurement.
 *
 * `thresholdApplied === null` is what distinguishes this from an ordinary
 * unknown, which always carries the rule it was judged against. Every reader
 * that separates "we were not watching" from "nobody has configured this niche"
 * keys on that, and `evaluateHitsForOrganization` counts them apart in its
 * summary rather than making callers rediscover the distinction.
 */
function unscoreableFields(): EvaluationFields {
  return {
    outcome: "unknown",
    nicheId: null,
    thresholdApplied: null,
    windowHoursApplied: null,
    viewsAtWindow: null,
    observedAtHours: null,
    windowClosesAt: null,
  };
}

function verdictToFields(verdict: HitVerdict, nicheId: string): EvaluationFields {
  return {
    outcome: verdict.outcome,
    nicheId,
    thresholdApplied: verdict.thresholdApplied,
    windowHoursApplied: verdict.windowHoursApplied,
    viewsAtWindow: verdict.viewsAtWindow === null ? null : BigInt(verdict.viewsAtWindow),
    observedAtHours: verdict.observedAtHours,
    windowClosesAt: new Date(verdict.windowClosesAtMs),
  };
}

/**
 * The niche whose rule judges a channel's Shorts, or null when none can.
 *
 * ONE RULE PER CHANNEL, because niches are assigned to channels rather than to
 * videos: every Short on a channel is judged by the same bar and the same
 * clock. The choice among several is `pickGoverningRule` — the analytics
 * engine's, not a copy — which takes the lowest threshold and breaks ties on
 * niche id.
 *
 * PAYROLL MAKES THE SAME CHOICE WITH THE SAME FUNCTION, and the fact that they
 * agree is deliberate rather than lucky. The difference is only in the
 * candidates: payroll narrows to the niches the EMPLOYEE is assigned to before
 * asking, because it is deciding whose bonus this is, while a stored evaluation
 * is the organization's verdict on the Short and considers every niche the
 * channel is filed under. Where both are looking at the same set they land on
 * the same niche, which is why a payslip can quote the evaluation's threshold
 * and have it match what the dashboard shows.
 */
export function resolveChannelRule(
  channelNicheIds: readonly string[],
  ruleByNicheId: ReadonlyMap<string, HitRule>,
): NicheHitRule | null {
  const candidates: NicheHitRule[] = [];
  for (const nicheId of channelNicheIds) {
    const rule = ruleByNicheId.get(nicheId);
    if (rule) candidates.push({ nicheId, rule });
  }
  return pickGoverningRule(candidates);
}

interface TrackedChannelRules {
  readonly channelId: string;
  readonly governing: NicheHitRule | null;
}

/**
 * Evaluate every Short on every tracked, active channel in one organization.
 *
 * Channel by channel rather than in one sweep of the whole library: each
 * channel has exactly one governing rule, so the snapshot query can be bounded
 * by that channel's own window instead of by the widest one in the
 * organization, and memory stays flat however many channels are tracked.
 */
export async function evaluateHitsForOrganization(
  organizationId: string,
  options: EvaluateHitsOptions = {},
): Promise<HitEvaluationSummary> {
  const startedAt = Date.now();
  const nowMs = options.nowMs ?? startedAt;

  const [niches, tracked] = await Promise.all([
    prisma.niche.findMany({
      where: { organizationId },
      select: { id: true, hitThreshold: true, hitWindowHours: true },
    }),
    prisma.trackedChannel.findMany({
      where: {
        organizationId,
        isActive: true,
        // Narrowed to one niche's channels when a rule has just changed. The
        // organization filter above still applies, so a niche id from another
        // tenant matches nothing rather than reaching across the line.
        ...(options.nicheIds && options.nicheIds.length > 0
          ? { niches: { some: { nicheId: { in: [...options.nicheIds] } } } }
          : {}),
      },
      select: { channelId: true, niches: { select: { nicheId: true } } },
    }),
  ]);

  // Only niches with BOTH halves get in. A threshold with no window is the old
  // lifetime comparison wearing the new vocabulary, and `resolveHitRule` is the
  // one place that judgement is made.
  const ruleByNicheId = new Map<string, HitRule>();
  for (const niche of niches) {
    const rule = resolveHitRule(niche);
    if (rule !== null) ruleByNicheId.set(niche.id, rule);
  }

  const channels: TrackedChannelRules[] = tracked.map((row) => ({
    channelId: row.channelId,
    governing: resolveChannelRule(
      row.niches.map((assignment) => assignment.nicheId),
      ruleByNicheId,
    ),
  }));

  const counters = {
    shortsConsidered: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    frozen: 0,
    unscoreable: 0,
  };
  const byOutcome: Record<HitOutcome, number> = { hit: 0, miss: 0, pending: 0, unknown: 0 };

  for (const channel of channels) {
    const result = await evaluateChannel(organizationId, channel, nowMs, options.videoIds);
    counters.shortsConsidered += result.shortsConsidered;
    counters.created += result.created;
    counters.updated += result.updated;
    counters.unchanged += result.unchanged;
    counters.frozen += result.frozen;
    counters.unscoreable += result.unscoreable;
    for (const outcome of ["hit", "miss", "pending", "unknown"] as const) {
      byOutcome[outcome] += result.byOutcome[outcome];
    }
  }

  return {
    organizationId,
    ...counters,
    byOutcome,
    durationMs: Date.now() - startedAt,
  };
}

interface ChannelEvaluationResult {
  shortsConsidered: number;
  created: number;
  updated: number;
  unchanged: number;
  frozen: number;
  unscoreable: number;
  byOutcome: Record<HitOutcome, number>;
}

async function evaluateChannel(
  organizationId: string,
  channel: TrackedChannelRules,
  nowMs: number,
  videoIds: readonly string[] | undefined,
): Promise<ChannelEvaluationResult> {
  const result: ChannelEvaluationResult = {
    shortsConsidered: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    frozen: 0,
    unscoreable: 0,
    byOutcome: { hit: 0, miss: 0, pending: 0, unknown: 0 },
  };

  const windowHours = channel.governing?.rule.windowHours ?? null;

  const videoWhere = {
    channelId: channel.channelId,
    isShort: true,
    ...(videoIds && videoIds.length > 0 ? { id: { in: [...videoIds] } } : {}),
  };

  const videos = await prisma.video.findMany({
    where: videoWhere,
    select: {
      id: true,
      publishedAt: true,
      viewCount: true,
      // Only readings that could possibly decide something. A snapshot taken at
      // hour 400 of a 168-hour window describes what the Short did afterwards,
      // which is the question this rule exists to refuse to answer — and on a
      // library where most snapshots are late, filtering in the database rather
      // than in memory is most of the rows.
      //
      // A channel with no rule bounds it at zero: there is no verdict to reach,
      // so there is no evidence worth carrying out of the database for it.
      snapshots: {
        where: { videoAgeHours: { lte: windowHours ?? 0 } },
        select: { viewCount: true, videoAgeHours: true },
      },
    },
  });

  if (videos.length === 0) return result;
  result.shortsConsidered = videos.length;

  const existingRows = await prisma.videoHitEvaluation.findMany({
    // Organization first. `Video` is a globally deduplicated row and the
    // verdict belongs to the team whose niche rule produced it; reading another
    // organization's evaluation would be judging these Shorts by someone else's
    // bar.
    where: { organizationId, videoId: { in: videos.map((video) => video.id) } },
    select: {
      videoId: true,
      outcome: true,
      nicheId: true,
      thresholdApplied: true,
      windowHoursApplied: true,
      viewsAtWindow: true,
      observedAtHours: true,
      windowClosesAt: true,
    },
  });

  const existingByVideoId = new Map<string, EvaluationFields>(
    existingRows.map((row) => [
      row.videoId,
      {
        // The column is a String; the four values are the vocabulary. Anything
        // else means somebody wrote a verdict this product does not have, and
        // treating it as unknown re-decides it rather than trusting it.
        outcome: toHitOutcome(row.outcome),
        nicheId: row.nicheId,
        thresholdApplied: row.thresholdApplied,
        windowHoursApplied: row.windowHoursApplied,
        viewsAtWindow: row.viewsAtWindow,
        observedAtHours: row.observedAtHours,
        windowClosesAt: row.windowClosesAt,
      },
    ]),
  );

  const writes: { videoId: string; fields: EvaluationFields }[] = [];

  for (const video of videos) {
    const fields =
      channel.governing === null
        ? unscoreableFields()
        : verdictToFields(
            evaluateHit({
              publishedAtMs: video.publishedAt.getTime(),
              rule: channel.governing.rule,
              lifetimeViews: Number(video.viewCount),
              observations: toObservations(video.snapshots),
              nowMs,
            }),
            channel.governing.nicheId,
          );

    if (channel.governing === null) result.unscoreable += 1;
    else result.byOutcome[fields.outcome] += 1;

    const decision = decideWrite(existingByVideoId.get(video.id) ?? null, fields);
    if (decision === "frozen") {
      result.frozen += 1;
      continue;
    }
    if (decision === "unchanged") {
      result.unchanged += 1;
      continue;
    }
    if (decision === "create") result.created += 1;
    else result.updated += 1;
    writes.push({ videoId: video.id, fields });
  }

  for (let index = 0; index < writes.length; index += WRITE_CHUNK) {
    const batch = writes.slice(index, index + WRITE_CHUNK);
    await prisma.$transaction(
      batch.map((write) =>
        prisma.videoHitEvaluation.upsert({
          // The unique pair is what makes this idempotent at the database level
          // too: two runs racing on the same Short produce one row, not two.
          where: { organizationId_videoId: { organizationId, videoId: write.videoId } },
          create: { organizationId, videoId: write.videoId, ...write.fields },
          update: { ...write.fields, evaluatedAt: new Date() },
        }),
      ),
    );
  }

  return result;
}

/**
 * Snapshot rows as evidence.
 *
 * `videoAgeHours` is precomputed on the row precisely so this is a projection
 * rather than a join against `Video.publishedAt` and a subtraction per reading.
 */
function toObservations(
  snapshots: readonly { viewCount: bigint; videoAgeHours: number }[],
): WindowObservation[] {
  return snapshots.map((snapshot) => ({
    views: Number(snapshot.viewCount),
    atHours: snapshot.videoAgeHours,
  }));
}

/** Narrows the stored string, treating anything unrecognised as unsettled. */
function toHitOutcome(value: string): HitOutcome {
  return value === "hit" || value === "miss" || value === "pending" ? value : "unknown";
}

/**
 * Re-decide every Short a niche judges, after its threshold or window moved.
 *
 * The whole niche, not the Shorts published since the change: the stored
 * verdicts were reached against a bar that no longer exists, and leaving them
 * would mean a dashboard showing one definition and a payslip quoting another.
 * `decideWrite` handles the thaw — a changed rule is the one thing that
 * reopens a settled verdict.
 */
export async function reevaluateHitsForNiche(
  organizationId: string,
  nicheId: string,
): Promise<HitEvaluationSummary> {
  return evaluateHitsForOrganization(organizationId, { nicheIds: [nicheId] });
}
