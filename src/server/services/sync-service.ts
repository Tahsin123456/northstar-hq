import "server-only";

import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { toAppError, type AppErrorCode } from "@/server/errors";
import { pruneAuditEvents, recordAudit } from "@/server/audit/audit-service";
import { pruneDeadSessions } from "@/server/auth/session";
import { pruneRateLimits } from "@/server/auth/rate-limit";
import { syncChannel, type SyncOptions, type SyncResult } from "./channel-sync";
import { getOrgSettings } from "./user-service";

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
  readonly errors: readonly ScheduledSyncError[];
}

export interface AllOrganizationsSyncSummary {
  readonly organizationsConsidered: number;
  readonly channelsSynced: number;
  readonly failed: number;
  readonly quotaUnitsUsed: number;
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

  // A zero interval means "always due", which is what the Settings minimum of 0
  // promises. Computing the cutoff from it gives that for free.
  const staleBefore = Date.now() - refreshIntervalMinutes * MS_PER_MINUTE;

  return tracked
    .filter((row) => {
      const lastFetchedAt = row.channel.lastFetchedAt;
      return lastFetchedAt === null || lastFetchedAt.getTime() < staleBefore;
    })
    .map((row) => ({
      channelId: row.channelId,
      label: row.label ?? row.channel.title,
      lastFetchedAt: row.channel.lastFetchedAt,
    }))
    .sort((a, b) => {
      // Never fetched outranks everything: it is the only state where the
      // dashboard shows a channel with no numbers at all.
      if (a.lastFetchedAt === null) return b.lastFetchedAt === null ? 0 : -1;
      if (b.lastFetchedAt === null) return 1;
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
  const emptySummary = (): ScheduledSyncSummary => ({
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
    errors: [],
  });

  // The Settings toggle is the organization's consent to spend its quota
  // unattended. Honouring it is the difference between a switch and a
  // decoration — and it is also the safe default, because the scheduler will be
  // pointed at this endpoint before anybody has decided how aggressive they
  // want to be. No audit entry is written on this path: an hourly "sync
  // triggered" event for a team that opted out would bury the log in noise
  // describing work that never happened.
  if (!maySync) return emptySummary();

  const due = await findDueChannels(organizationId, settings.refreshIntervalMinutes);
  if (due.length === 0) return emptySummary();

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
      result = await syncChannel(channel.channelId, syncOptions);
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
    errors,
  };

  await recordRunFailureIfAny(summary, options.request ?? null);
  return summary;
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
    durationMs: Date.now() - startedAt,
    summaries,
  };
}
