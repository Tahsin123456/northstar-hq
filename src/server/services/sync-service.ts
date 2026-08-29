import "server-only";

import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { toAppError, type AppErrorCode } from "@/server/errors";
import { pruneAuditEvents, recordAudit } from "@/server/audit/audit-service";
import { pruneDeadSessions } from "@/server/auth/session";
import { pruneRateLimits } from "@/server/auth/rate-limit";
import { syncChannel, type SyncOptions, type SyncResult } from "./channel-sync";
import { getOrgSettings } from "./user-service";
import {
  evaluateHitsForOrganization,
  resolveChannelRule,
  type HitEvaluationSummary,
} from "./hit-evaluation-service";
import {
  syncRevenueForOrganization,
  type RevenueSyncSummary,
} from "./youtube-revenue-service";
import { resolveHitRule, HOUR_MS, type HitRule } from "@/lib/analytics/hit-rate";
import { isInsideWindow } from "@/lib/sync/snapshot-cadence";

/**
 * Scheduled synchronisation — refreshing the data without a human present.
 *
 * WHY THIS EXISTS
 * Until now the only thing that refreshed a channel was somebody clicking
 * Refresh. That makes the dashboard's central claim — "these are the current
 * numbers" — depend on whoever happened to open the page most recently, and it
 * pushes the cost of a YouTube round trip onto a page view. This module is the
 * other half: the database is the source the dashboard reads, and something
 * else keeps the database current on a clock.
 *
 * THE QUOTA IS THE BUDGET, AND IT IS THE WHOLE DESIGN
 * YouTube's default allowance is 10,000 units per day per key. A channel
 * refresh walks the uploads playlist (1 unit per 50 videos) and reads
 * statistics (another 1 unit per 50), so a busy channel inside a 400-day
 * lookback costs on the order of 10–15 units. Refreshing a few dozen channels
 * every hour is therefore comfortably inside the allowance, especially since
 * the staleness filter skips anything already fresh.
 *
 * Fetching on page view has no such ceiling. One director with the dashboard
 * open and an itchy refresh finger would spend the whole team's daily quota
 * before lunch, and the failure mode is that *everybody* stops getting data for
 * the rest of the day. A schedule turns an unbounded, user-driven cost into a
 * fixed, predictable one — which is the only version of this that survives
 * contact with production.
 *
 * WHY THERE IS NO SECOND FETCHING PATH HERE
 * Everything below decides *which* channels to sync and *when to stop*. The
 * actual fetch/classify/persist pipeline is `syncChannel` in channel-sync.ts,
 * unchanged and uncopied. A background sweep with its own YouTube code would
 * drift from the interactive one — different lookback, different Shorts
 * classification, different snapshot cadence — and the two would quietly
 * disagree about the same channel.
 *
 * NO SESSION, BY CONSTRUCTION
 * Nothing in this file calls `getScope()`, `getCurrentOrgId()` or anything else
 * that reads a cookie. The organization is a parameter, and settings come from
 * `getOrgSettings(organizationId)` rather than `getCurrentOrgSettings()`. That
 * is not a stylistic choice: a scheduler has no session, so a single accidental
 * session-dependent call would make the job throw 401 in production and work
 * fine in every test that happened to run signed in.
 */

const MS_PER_MINUTE = 60_000;

/**
 * How often a channel with a Short still inside its hit window is refreshed.
 *
 * WHY THE STALENESS RULE NEEDED AN EXCEPTION AT ALL
 * The snapshot cadence asks for hourly readings while a window is open, but a
 * snapshot is only ever written during a sync — so a cadence of one hour
 * against a sweep that reaches the channel every six is a cadence of six hours
 * wearing a smaller number. The two halves only work together.
 *
 * The cost is bounded and worth stating: a channel refresh is 10–15 quota units
 * against a 10,000/day allowance, so an hourly refresh is about 300 units a day
 * for as long as that channel has something in flight. Northstar publishes a
 * handful of Shorts a week, so this is a few hundred units a day in total — and
 * it only applies to channels with an open window, which is the whole point.
 * Everything else keeps the organization's own interval and gets cheaper,
 * because the cadence stops sampling the back catalogue four times a day.
 */
const OPEN_WINDOW_REFRESH_MINUTES = 60;

/** How the run was initiated. Recorded so the audit log can tell them apart. */
export type ScheduledSyncTrigger = "cron" | "manual";

export interface ScheduledSyncOptions {
  readonly organizationId: string;
  readonly trigger: ScheduledSyncTrigger;
  /** Ceiling on channels touched. Defaults to `SYNC_MAX_CHANNELS_PER_RUN`. */
  readonly maxChannels?: number;
  /**
   * Run even when the organization has left "Automatic background refresh"
   * switched off. Exists so an operator can force a catch-up sweep; the
   * scheduler never sets it.
   */
  readonly ignoreAutoRefreshSetting?: boolean;
  /** The originating Request, for audit context. Absent for a true cron run. */
  readonly request?: Request | null;
}

export interface ScheduledSyncError {
  readonly channelId: string;
  /** The name the team sees in the dashboard, so the log reads the same way. */
  readonly channelLabel: string;
  readonly code: AppErrorCode;
  readonly message: string;
}

export interface HousekeepingResult {
  readonly deadSessionsDeleted: number;
  readonly rateLimitBucketsDeleted: number;
  readonly auditEventsDeleted: number;
}

export interface ScheduledSyncSummary {
  readonly organizationId: string;
  readonly trigger: ScheduledSyncTrigger;
  /** Active tracked channels that were past the staleness interval. */
  readonly channelsConsidered: number;
  readonly channelsSynced: number;
  /**
   * Due but not attempted — over the per-run cap, or dropped when the run
   * stopped early. Always `considered - synced - failed`, so the four numbers
   * reconcile without the reader having to guess what each one counts.
   */
  readonly skipped: number;
  readonly failed: number;
  readonly quotaUnitsUsed: number;
  readonly durationMs: number;
  /**
   * The error that ended the run before it reached the end of its list, or
   * null. `"QUOTA_EXCEEDED"` here is the normal, expected way a busy day ends.
   */
  readonly stoppedEarly: AppErrorCode | null;
  /**
   * The organization's stored "Automatic background refresh" setting, as read
   * at run time — not whether this particular run was allowed to proceed. See
   * the note in `runScheduledSync` for how to read it against the counters.
   */
  readonly autoRefreshEnabled: boolean;
  readonly housekeeping: HousekeepingResult;
  /**
   * What the revenue step did, or null when the run never got as far as it.
   *
   * Revenue rides on this schedule rather than on a cron of its own. A second
   * scheduled endpoint would be a second thing to configure at deploy, a second
   * thing to forget, and a second place for "when did this last run?" to be
   * answered differently — for a job whose upstream cost is one API call per
   * connected account.
   */
  readonly revenue: RevenueSyncSummary | null;
  /**
   * What the hit evaluation step decided, or null when it could not run.
   *
   * On this schedule rather than one of its own, for the same reason revenue is:
   * the cron endpoint is the only thing here that runs on a clock, and a second
   * schedule is a second thing to configure at deploy and forget. It also has
   * to run AFTER the channel sweep in the same pass — the snapshots it reads
   * are the ones that pass just wrote.
   */
  readonly hitEvaluation: HitEvaluationSummary | null;
  readonly errors: readonly ScheduledSyncError[];
}

export interface AllOrganizationsSyncSummary {
  readonly organizationsConsidered: number;
  readonly channelsSynced: number;
  readonly failed: number;
  readonly quotaUnitsUsed: number;
  /** Monthly ledger entries the revenue step wrote or corrected across every org. */
  readonly revenueEntriesCreated: number;
  readonly revenueEntriesRevised: number;
  /**
   * Verdicts written or moved across every organization.
   *
   * Worth a line in the run's output because it is the number that says whether
   * the new definition is actually settling anything: a steady state is a large
   * `shortsConsidered` and a small figure here, and a run that writes thousands
   * is one where a rule changed or a backlog finally resolved.
   */
  readonly hitVerdictsWritten: number;
  readonly durationMs: number;
  readonly summaries: readonly ScheduledSyncSummary[];
}

/**
 * Failures that make continuing pointless rather than merely unlucky.
 *
 * The distinction is whether the *next* channel could plausibly succeed. A
 * deleted channel or a malformed playlist is that channel's problem, so the
 * sweep moves on. These three are properties of the key or the upstream
 * service: every remaining channel would fail identically, and trying anyway
 * converts one clear error into two dozen, plus the request volume that earned
 * the rate limit in the first place.
 */
const RUN_ENDING_CODES: ReadonlySet<AppErrorCode> = new Set<AppErrorCode>([
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "MISSING_API_KEY",
]);

/**
 * Translates an organization's saved preferences into sync options.
 *
 * Lives here rather than in channel-service because both the interactive
 * refresh and the scheduled sweep have to produce *identical* options — they
 * write the same canonical Video and VideoSnapshot rows, and a background job
 * using a different lookback or snapshot cadence than the Refresh button would
 * make the history depend on which path happened to touch a channel last.
 * channel-service calls this with the signed-in organization; the scheduler
 * calls it with an id it was handed.
 *
 * `SHORTS_PROBE_ENABLED=false` in the environment is a hard override rather
 * than a default: a deployment on a network that blocks youtube.com must be
 * able to disable the probe globally whatever the team has toggled.
 */
export async function buildSyncOptions(
  organizationId: string,
  trigger: SyncOptions["trigger"],
): Promise<SyncOptions> {
  const settings = await getOrgSettings(organizationId);
  return {
    trigger,
    lookbackDays: settings.lookbackDays,
    snapshotIntervalMinutes: settings.snapshotIntervalMinutes,
    probeEnabled: env.shortsProbeEnabled && settings.shortsProbeEnabled,
  };
}

/**
 * The hit window that judges each channel's Shorts, in hours.
 *
 * Null for a channel filed under no niche, or under none with BOTH halves of a
 * rule — which is not a defect to work around but the state most of this
 * tracker is in until an admin finishes configuring it. The snapshot cadence
 * reads null as "no window", falls back to the organization's flat interval,
 * and nothing about the old behaviour changes for those channels.
 *
 * The choice among several niches is `resolveChannelRule`, which is the
 * evaluator's — and through it the analytics engine's `pickGoverningRule`. It
 * has to be: sampling a channel densely for seven days and then judging it on a
 * 48-hour rule would collect the wrong evidence, so the cadence and the verdict
 * must be reading the same clock.
 */
export async function resolveChannelHitWindows(
  organizationId: string,
  channelIds: readonly string[],
): Promise<Map<string, number | null>> {
  const windows = new Map<string, number | null>(channelIds.map((id) => [id, null]));
  if (channelIds.length === 0) return windows;

  const [niches, tracked] = await Promise.all([
    prisma.niche.findMany({
      where: { organizationId },
      select: { id: true, hitThreshold: true, hitWindowHours: true },
    }),
    prisma.trackedChannel.findMany({
      where: { organizationId, isActive: true, channelId: { in: [...channelIds] } },
      select: { channelId: true, niches: { select: { nicheId: true } } },
    }),
  ]);

  const ruleByNicheId = new Map<string, HitRule>();
  for (const niche of niches) {
    const rule = resolveHitRule(niche);
    if (rule !== null) ruleByNicheId.set(niche.id, rule);
  }

  for (const row of tracked) {
    const governing = resolveChannelRule(
      row.niches.map((assignment) => assignment.nicheId),
      ruleByNicheId,
    );
    windows.set(row.channelId, governing?.rule.windowHours ?? null);
  }

  return windows;
}

/**
 * Sync options for ONE channel, window included.
 *
 * The single-channel entry point, so the Refresh button and the scheduled sweep
 * cannot end up passing different cadences for the same channel. That is the
 * same reason `buildSyncOptions` lives here rather than in channel-service: a
 * channel's snapshot history must not depend on which path last touched it.
 */
export async function buildChannelSyncOptions(
  organizationId: string,
  channelId: string,
  trigger: SyncOptions["trigger"],
): Promise<SyncOptions> {
  const [base, windows] = await Promise.all([
    buildSyncOptions(organizationId, trigger),
    resolveChannelHitWindows(organizationId, [channelId]),
  ]);
  return { ...base, hitWindowHours: windows.get(channelId) ?? null };
}

/**
 * Deletes rows that have outlived their purpose.
 *
 * Bundled into the sync run because this app deliberately does not host its own
 * scheduler, so the cron endpoint is the only thing that reliably runs on a
 * clock. Piggy-backing housekeeping on it is the difference between retention
 * being a policy and retention being a comment.
 *
 * Session and rate-limit pruning are global rather than per-organization — the
 * tables carry no `organizationId` — so a multi-organization run repeats them.
 * That is deliberate and harmless: after the first pass they are indexed
 * deleteMany calls that match nothing, which is far cheaper than the special
 * casing needed to hoist them out.
 *
 * Failures are swallowed per-step. Housekeeping is maintenance, and letting a
 * lock on the sessions table abort a sync that already fetched real data would
 * trade something valuable for something merely tidy.
 *
 * The three run in sequence rather than concurrently. There is no latency to
 * win — this is a background job — and SQLite serialises writers, so firing
 * three deletes at once buys nothing and risks SQLITE_BUSY on the local
 * development database for no reason.
 */
export async function runHousekeeping(organizationId: string): Promise<HousekeepingResult> {
  const prune = async (name: string, run: () => Promise<number>): Promise<number> => {
    try {
      return await run();
    } catch (error) {
      console.error(`[sync] ${name} failed`, error);
      return 0;
    }
  };

  return {
    deadSessionsDeleted: await prune("pruneDeadSessions", () => pruneDeadSessions()),
    rateLimitBucketsDeleted: await prune("pruneRateLimits", () => pruneRateLimits()),
    auditEventsDeleted: await prune("pruneAuditEvents", () =>
      pruneAuditEvents(organizationId),
    ),
  };
}

interface DueChannel {
  readonly channelId: string;
  readonly label: string;
  readonly lastFetchedAt: Date | null;
  /** The window judging this channel's Shorts, passed straight to the sync. */
  readonly hitWindowHours: number | null;
  /** At least one Short on this channel is still inside its window. */
  readonly hasOpenWindow: boolean;
}

/**
 * Which channels have a Short whose window has not shut yet.
 *
 * One query for the whole tracker rather than one per channel: the widest
 * window in the organization bounds what could possibly still be open, and the
 * per-channel clock is then applied in memory. Long-form is excluded because a
 * window only judges Shorts.
 */
async function findChannelsWithOpenWindows(
  windowByChannelId: ReadonlyMap<string, number | null>,
  nowMs: number,
): Promise<Set<string>> {
  const open = new Set<string>();

  const windowed = [...windowByChannelId.entries()].filter(
    (entry): entry is [string, number] => entry[1] !== null && entry[1] > 0,
  );
  if (windowed.length === 0) return open;

  const widestWindowHours = Math.max(...windowed.map(([, hours]) => hours));

  const recent = await prisma.video.findMany({
    where: {
      channelId: { in: windowed.map(([channelId]) => channelId) },
      isShort: true,
      publishedAt: { gte: new Date(nowMs - widestWindowHours * HOUR_MS) },
    },
    select: { channelId: true, publishedAt: true },
  });

  for (const video of recent) {
    if (open.has(video.channelId)) continue;
    if (isInsideWindow(video.publishedAt.getTime(), windowByChannelId.get(video.channelId) ?? null, nowMs)) {
      open.add(video.channelId);
    }
  }

  return open;
}

/**
 * The organization's stale channels, oldest first.
 *
 * ORDERING IS DONE IN MEMORY, ON PURPOSE
 * The natural query is `orderBy: { channel: { lastFetchedAt: "asc" } }` with a
 * `take`, but null ordering is exactly where SQLite and PostgreSQL disagree —
 * SQLite sorts NULLs first on ASC, PostgreSQL sorts them last — and Prisma's
 * `nulls` option is not available on SQLite. A never-fetched channel is the
 * *most* urgent thing in the list, so on PostgreSQL that query would silently
 * starve brand-new channels whenever the tracker exceeded the per-run cap. A
 * tracker is a few hundred rows of two columns at worst, so selecting them and
 * sorting here is cheap, portable and obviously correct.
 */
async function findDueChannels(
  organizationId: string,
  refreshIntervalMinutes: number,
): Promise<DueChannel[]> {
  // Never trust an organizationId from a request: every caller of this module
  // passes one it resolved server-side, and the filter is unconditional.
  const tracked = await prisma.trackedChannel.findMany({
    where: { organizationId, isActive: true },
    select: {
      channelId: true,
      label: true,
      channel: { select: { title: true, lastFetchedAt: true } },
    },
  });

  const nowMs = Date.now();
  const windowByChannelId = await resolveChannelHitWindows(
    organizationId,
    tracked.map((row) => row.channelId),
  );
  const openWindowChannelIds = await findChannelsWithOpenWindows(windowByChannelId, nowMs);

  return tracked
    .map((row) => ({
      channelId: row.channelId,
      label: row.label ?? row.channel.title,
      lastFetchedAt: row.channel.lastFetchedAt,
      hitWindowHours: windowByChannelId.get(row.channelId) ?? null,
      hasOpenWindow: openWindowChannelIds.has(row.channelId),
    }))
    .filter((channel) => {
      // A zero interval means "always due", which is what the Settings minimum
      // of 0 promises. Computing the cutoff from it gives that for free.
      //
      // A channel with a Short still inside its window is held to a tighter
      // interval, because those are the only hours in which a reading can prove
      // anything. `min` rather than a flat 60, so a team that has chosen to
      // refresh every 15 minutes is not slowed down by this.
      const intervalMinutes = channel.hasOpenWindow
        ? Math.min(refreshIntervalMinutes, OPEN_WINDOW_REFRESH_MINUTES)
        : refreshIntervalMinutes;
      const staleBefore = nowMs - intervalMinutes * MS_PER_MINUTE;
      const lastFetchedAt = channel.lastFetchedAt;
      return lastFetchedAt === null || lastFetchedAt.getTime() < staleBefore;
    })
    .sort((a, b) => {
      // Never fetched outranks everything: it is the only state where the
      // dashboard shows a channel with no numbers at all.
      if (a.lastFetchedAt === null) return b.lastFetchedAt === null ? 0 : -1;
      if (b.lastFetchedAt === null) return 1;
      // Then an open window, because that evidence expires. A stale channel
      // whose Shorts have all been judged loses nothing by waiting for the next
      // run; a channel three hours into a 48-hour window loses a reading that
      // can never be taken again. This is the only ordering rule in this file
      // that is about information rather than about fairness, and the per-run
      // cap is what makes it matter.
      if (a.hasOpenWindow !== b.hasOpenWindow) return a.hasOpenWindow ? -1 : 1;
      return a.lastFetchedAt.getTime() - b.lastFetchedAt.getTime();
    });
}

/**
 * Refresh one organization's stale channels on a schedule.
 *
 * Runs without a session. `organizationId` is a parameter and every query below
 * filters on it.
 */
export async function runScheduledSync(
  options: ScheduledSyncOptions,
): Promise<ScheduledSyncSummary> {
  const { organizationId, trigger } = options;
  const startedAt = Date.now();

  const settings = await getOrgSettings(organizationId);
  const maySync = settings.autoRefreshEnabled || options.ignoreAutoRefreshSetting === true;

  // Housekeeping is unrelated to YouTube and runs either way. An organization
  // that switched automatic refresh off still accumulates expired sessions and
  // spent rate-limit buckets, and pruning those is not something they opted out
  // of when they declined to spend quota.
  const housekeeping = await runHousekeeping(organizationId);

  // `autoRefreshEnabled` always reports the *stored setting*, never the
  // effective permission to run. Reporting the effective value would make an
  // `ignoreAutoRefreshSetting` sweep indistinguishable from an organization
  // that had opted in, which is the one thing a reader of this summary is most
  // likely to be checking. As it stands the three cases read cleanly:
  // `false` with nothing synced means opted out; `true` with
  // `channelsConsidered: 0` means everything was already fresh; `false` with
  // channels synced means an operator forced a catch-up.
  const emptySummary = (
    revenue: RevenueSyncSummary | null = null,
    hitEvaluation: HitEvaluationSummary | null = null,
  ): ScheduledSyncSummary => ({
    organizationId,
    trigger,
    channelsConsidered: 0,
    channelsSynced: 0,
    skipped: 0,
    failed: 0,
    quotaUnitsUsed: 0,
    durationMs: Date.now() - startedAt,
    stoppedEarly: null,
    autoRefreshEnabled: settings.autoRefreshEnabled,
    housekeeping,
    revenue,
    hitEvaluation,
    errors: [],
  });

  // The Settings toggle is the organization's consent to spend its quota
  // unattended. Honouring it is the difference between a switch and a
  // decoration — and it is also the safe default, because the scheduler will be
  // pointed at this endpoint before anybody has decided how aggressive they
  // want to be. No audit entry is written on this path: an hourly "sync
  // triggered" event for a team that opted out would bury the log in noise
  // describing work that never happened.
  //
  // The hit evaluation runs on BOTH sides of this gate, which is why it is
  // taken here rather than after the sweep only. It spends no quota and talks
  // to nobody: it reads snapshots this database already has and decides what
  // they mean. Its verdicts also change with the CLOCK rather than with new
  // data — every hour, windows shut and Shorts stop being "pending" — so an
  // organization that has opted out of background refresh still needs its
  // pending verdicts settling, or its hit rate would stay frozen at whatever it
  // was the last time somebody pressed Refresh.
  if (!maySync) return emptySummary(null, await runHitEvaluationStep(organizationId));

  /**
   * Revenue first, and independently of whether any channel is due.
   *
   * Channel staleness and revenue freshness are different questions. A tracker
   * whose channels were all refreshed twenty minutes ago still has a month of
   * revenue that YouTube has since revised, and gating the import on the
   * channel sweep would mean a busy tracker imported revenue every run and a
   * quiet one never imported it at all.
   *
   * It is inside the `maySync` gate, though. "Automatic background refresh" is
   * the organization's consent to let this app talk to Google unattended, and
   * that consent does not become narrower because the traffic is worth money.
   *
   * Failures are contained: the revenue step reports errors in its own summary
   * rather than throwing, so an expired Google grant cannot stop the channel
   * sweep that has nothing to do with it.
   */
  const revenue = await runRevenueStep(organizationId, trigger, options.request ?? null);

  const due = await findDueChannels(organizationId, settings.refreshIntervalMinutes);
  // Still evaluates. Nothing being due means nothing NEW to read, not that the
  // windows on what is already stored have stopped closing.
  if (due.length === 0) {
    return emptySummary(revenue, await runHitEvaluationStep(organizationId));
  }

  const maxChannels = Math.max(1, options.maxChannels ?? env.syncMaxChannelsPerRun);
  const batch = due.slice(0, maxChannels);

  await recordAudit(
    {
      organizationId,
      // Null for machine-initiated runs. The schema allows it and the audit
      // list falls back to `actorLabel`, which is how the log distinguishes
      // "the scheduler did this" from "somebody's account did this" — an
      // important difference when reading back an incident.
      actorUserId: null,
      actorLabel: trigger === "cron" ? "Scheduled sync" : "Sync service",
      request: options.request ?? null,
    },
    {
      action: "sync.triggered",
      summary: `Scheduled sync started for ${batch.length} of ${due.length} stale channel${due.length === 1 ? "" : "s"}.`,
      targetType: "organization",
      targetId: organizationId,
      metadata: {
        trigger,
        channelsDue: due.length,
        channelsPlanned: batch.length,
        maxChannels,
        refreshIntervalMinutes: settings.refreshIntervalMinutes,
      },
    },
  );

  const syncOptions = await buildSyncOptions(
    organizationId,
    // ChannelRefreshRun's trigger vocabulary predates the scheduler and its
    // word for "no person was involved" is "auto". Mapping here keeps the
    // refresh-run history readable rather than introducing a fourth value that
    // nothing else understands.
    trigger === "cron" ? "auto" : "manual",
  );

  const errors: ScheduledSyncError[] = [];
  let channelsSynced = 0;
  let failed = 0;
  let quotaUnitsUsed = 0;
  let stoppedEarly: AppErrorCode | null = null;

  // Sequential, not parallel. A burst of concurrent refreshes is precisely the
  // traffic shape that earns a rate limit, and it also defeats the early stop
  // below: by the time the first QUOTA_EXCEEDED came back, the other requests
  // would already be in flight.
  for (const channel of batch) {
    let result: SyncResult;
    try {
      // The window rides along per channel: everything else in these options is
      // an organization-wide setting, but the snapshot cadence is decided by
      // the rule that will judge THIS channel's Shorts.
      result = await syncChannel(channel.channelId, {
        ...syncOptions,
        hitWindowHours: channel.hitWindowHours,
      });
    } catch (caught) {
      // syncChannel records upstream failures on the row and returns them, so
      // reaching here means something structural — the channel row vanished
      // between the query above and now, or the database went away. Neither is
      // this channel's fault to keep retrying, but neither is it a reason to
      // abandon the remaining channels.
      const appError = toAppError(caught);
      failed += 1;
      errors.push({
        channelId: channel.channelId,
        channelLabel: channel.label,
        code: appError.code,
        message: appError.userMessage,
      });
      continue;
    }

    quotaUnitsUsed += result.quotaUnitsUsed;

    if (result.status === "error") {
      failed += 1;
      const code = result.errorCode ?? "INTERNAL_ERROR";
      errors.push({
        channelId: channel.channelId,
        channelLabel: channel.label,
        code,
        message: result.error ?? "Sync failed for an unknown reason.",
      });

      if (RUN_ENDING_CODES.has(code)) {
        stoppedEarly = code;
        break;
      }
      continue;
    }

    channelsSynced += 1;
  }

  // Last, and deliberately after the loop rather than inside it: the snapshots
  // this reads are the ones the sweep has just written, and a Short that was
  // pending at the top of the run may have had its window shut and its
  // deciding reading taken in the same pass.
  const hitEvaluation = await runHitEvaluationStep(organizationId);

  const summary: ScheduledSyncSummary = {
    organizationId,
    trigger,
    channelsConsidered: due.length,
    channelsSynced,
    skipped: due.length - channelsSynced - failed,
    failed,
    quotaUnitsUsed,
    durationMs: Date.now() - startedAt,
    stoppedEarly,
    autoRefreshEnabled: settings.autoRefreshEnabled,
    housekeeping,
    revenue,
    hitEvaluation,
    errors,
  };

  await recordRunFailureIfAny(summary, options.request ?? null);
  return summary;
}

/**
 * The hit evaluation, wrapped so it can never end the run.
 *
 * Contained for the same reason the revenue step is: this is bookkeeping over
 * data the sweep has already fetched and paid for, and letting a lock on
 * `video_hit_evaluations` throw away a successful sync would trade something
 * expensive for something recomputable. The next run re-decides everything it
 * missed — that is what idempotence buys — so a failure here costs an hour of
 * freshness on the verdicts and nothing else.
 *
 * A null in the summary therefore means "did not run", never "found nothing".
 */
async function runHitEvaluationStep(
  organizationId: string,
): Promise<HitEvaluationSummary | null> {
  try {
    return await evaluateHitsForOrganization(organizationId);
  } catch (caught) {
    const appError = toAppError(caught);
    console.error(
      `[sync] hit evaluation failed for organization ${organizationId}: ${appError.code} — ${appError.message}`,
    );
    return null;
  }
}

/**
 * The revenue import, wrapped so it can never end the channel sweep.
 *
 * `syncRevenueForOrganization` already contains one connection's failure and
 * reports it. This catches the structural case it cannot — the database going
 * away mid-step — and turns it into a summary the caller can report, because a
 * revenue problem taking the whole scheduled run down with it would stop the
 * channel data that has nothing to do with Google's billing.
 */
async function runRevenueStep(
  organizationId: string,
  trigger: ScheduledSyncTrigger,
  request: Request | null,
): Promise<RevenueSyncSummary> {
  try {
    return await syncRevenueForOrganization(organizationId, { trigger, request });
  } catch (caught) {
    const appError = toAppError(caught);
    console.error(
      `[sync] revenue step failed for organization ${organizationId}: ${appError.code} — ${appError.message}`,
    );
    return {
      organizationId,
      connectionsConsidered: 0,
      connectionsSynced: 0,
      connectionsSkipped: 0,
      failed: 1,
      daysWritten: 0,
      daysRevised: 0,
      entriesCreated: 0,
      entriesRevised: 0,
      errors: [{ connectionId: null, label: "Revenue sync", message: appError.userMessage }],
    };
  }
}

/**
 * Writes `sync.failed` when the run as a whole did not do its job.
 *
 * Deliberately not one event per failed channel. Those are already recorded on
 * ChannelRefreshRun with full detail, and an audit log that gains an entry every
 * time one deleted channel 404s stops being the place you look to find out that
 * something went wrong. The two cases that qualify are the ones an operator
 * would actually want to be told about: the run ran out of quota (or upstream
 * headroom) and stopped short, or it attempted work and nothing succeeded.
 */
async function recordRunFailureIfAny(
  summary: ScheduledSyncSummary,
  request: Request | null,
): Promise<void> {
  const attempted = summary.channelsSynced + summary.failed;
  const totalFailure = attempted > 0 && summary.channelsSynced === 0;
  if (summary.stoppedEarly === null && !totalFailure) return;

  const reason = summary.stoppedEarly
    ? `stopped early after ${summary.stoppedEarly}`
    : `all ${summary.failed} attempted channel${summary.failed === 1 ? "" : "s"} failed`;

  await recordAudit(
    {
      organizationId: summary.organizationId,
      actorUserId: null,
      actorLabel: summary.trigger === "cron" ? "Scheduled sync" : "Sync service",
      request,
    },
    {
      action: "sync.failed",
      summary: `Scheduled sync ${reason}. ${summary.channelsSynced} synced, ${summary.failed} failed, ${summary.skipped} left for the next run.`,
      targetType: "organization",
      targetId: summary.organizationId,
      metadata: {
        trigger: summary.trigger,
        stoppedEarly: summary.stoppedEarly,
        channelsConsidered: summary.channelsConsidered,
        channelsSynced: summary.channelsSynced,
        failed: summary.failed,
        skipped: summary.skipped,
        quotaUnitsUsed: summary.quotaUnitsUsed,
        // Codes, not messages: enough to diagnose, and no upstream prose that
        // might one day carry something we would rather not retain.
        errorCodes: summary.errors.map((error) => error.code),
      },
    },
  );
}

/**
 * Sweep every organization.
 *
 * What the cron endpoint calls. Organizations are processed one after another
 * and one organization's failure never stops the rest — a single tenant with a
 * broken tracker must not be able to freeze everybody else's data by being
 * first in the list.
 *
 * Note that the per-run channel cap is *per organization*, so the worst-case
 * quota spend scales with tenant count. That is the right shape for this
 * deployment (Northstar is one organization) and the number to revisit first if
 * that ever stops being true — a global budget shared across tenants would need
 * to live in the database, not in a loop.
 */
export async function runScheduledSyncForAllOrganizations(
  options: {
    readonly trigger: ScheduledSyncTrigger;
    readonly maxChannels?: number;
    readonly request?: Request | null;
  },
): Promise<AllOrganizationsSyncSummary> {
  const startedAt = Date.now();

  const organizations = await prisma.organization.findMany({
    select: { id: true },
    // Stable order so a run that is cut short by a platform timeout does not
    // starve the same tenant every time — oldest first is at least predictable.
    orderBy: { createdAt: "asc" },
  });

  const summaries: ScheduledSyncSummary[] = [];

  for (const organization of organizations) {
    try {
      summaries.push(
        await runScheduledSync({
          organizationId: organization.id,
          trigger: options.trigger,
          maxChannels: options.maxChannels,
          request: options.request ?? null,
        }),
      );
    } catch (caught) {
      const appError = toAppError(caught);
      console.error(
        `[sync] organization ${organization.id} sweep failed: ${appError.code} — ${appError.message}`,
      );

      await recordAudit(
        {
          organizationId: organization.id,
          actorUserId: null,
          actorLabel: options.trigger === "cron" ? "Scheduled sync" : "Sync service",
          request: options.request ?? null,
        },
        {
          action: "sync.failed",
          summary: `Scheduled sync could not run: ${appError.userMessage}`,
          targetType: "organization",
          targetId: organization.id,
          metadata: { trigger: options.trigger, code: appError.code },
        },
      );
    }
  }

  return {
    organizationsConsidered: organizations.length,
    channelsSynced: summaries.reduce((total, s) => total + s.channelsSynced, 0),
    failed: summaries.reduce((total, s) => total + s.failed, 0),
    quotaUnitsUsed: summaries.reduce((total, s) => total + s.quotaUnitsUsed, 0),
    revenueEntriesCreated: summaries.reduce(
      (total, s) => total + (s.revenue?.entriesCreated ?? 0),
      0,
    ),
    revenueEntriesRevised: summaries.reduce(
      (total, s) => total + (s.revenue?.entriesRevised ?? 0),
      0,
    ),
    hitVerdictsWritten: summaries.reduce(
      (total, s) => total + (s.hitEvaluation?.created ?? 0) + (s.hitEvaluation?.updated ?? 0),
      0,
    ),
    durationMs: Date.now() - startedAt,
    summaries,
  };
}
