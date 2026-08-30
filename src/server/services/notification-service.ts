import "server-only";

import { z } from "zod";
import { prisma } from "@/server/db";
import { errors } from "@/server/errors";
import { recordAudit } from "@/server/audit/audit-service";
import {
  periodForMonth,
  periodLabel,
  type PayrollPeriodWindow,
} from "@/lib/payroll/payroll-engine";
import {
  buildPayrollMessage,
  type PayrollMessageInput,
} from "@/lib/payroll/payroll-message";
import type {
  NotificationAttemptDTO,
  NotificationSettingsDTO,
  PayrollNotificationStatusDTO,
  TelegramStatusDTO,
} from "@/lib/dto";
import { getPeriodForOrganization, type PayrollPeriodDTO } from "./payroll-service";
import { sendMessage, sendTestMessage, telegramStatus } from "./telegram-service";
import { getOrgSettings } from "./user-service";

/**
 * =========================================================================
 * NOTIFICATIONS — WHO GETS TOLD, AND EXACTLY ONCE
 * =========================================================================
 *
 * `telegram-service.ts` knows how to post a string to a chat. This module
 * decides whether a message should go out at all, makes sure it goes out once,
 * and records what happened. Those are separable concerns and separating them
 * is what lets the payroll wording be unit-tested with no network and the
 * transport be reasoned about as plain HTTP.
 *
 * THE DUPLICATE-SEND PROBLEM
 * A scheduled job fires twice more often than anybody expects: a platform
 * retry after a timeout that actually succeeded, two regions racing, an admin
 * pressing the manual button while the cron is mid-flight, a redeploy
 * re-triggering the schedule. Sending the payroll summary twice is not a
 * cosmetic bug — it is a second message telling the whole team what everyone
 * earns, and there is no unsend.
 *
 * The protection is the unique constraint on `(periodId, channel)`, claimed
 * BEFORE the send rather than checked after it. The database, not this process,
 * decides who won:
 *
 *   • No row yet  -> `create`. Two racers both try; one gets P2002 and stops.
 *   • Row is "sent" -> stop, and say so. This is the case that has to hold when
 *     the job fires twice on the same day.
 *   • Row is "pending" or "failed" -> claim it with a compare-and-set on
 *     (status, attempts). Only one racer's update matches; the other sees zero
 *     rows affected and backs off.
 *
 * A read-then-write would let two invocations both observe "failed" and both
 * send. Every branch here is decided by a write's row count.
 *
 * WHY THE CLAIM IS ENOUGH ON ITS OWN
 * A claim only makes the DECISION to send happen once. It says nothing about a
 * send that half-happened — and this message used to be posted as up to four
 * numbered parts, so a failure on part 3 left parts 1 and 2 in the chat with
 * the row marked failed and therefore claimable again. The retry re-posted them.
 * `buildPayrollMessage` now renders any run into a single body (see the long
 * note there), so one claim guards exactly one `sendMessage`: the send is
 * atomic, and there is no fragment a retry can duplicate.
 */

/** Room for another channel without a migration; only one exists today. */
const TELEGRAM_CHANNEL = "telegram";

/**
 * How long a claim holds the notification row before another caller may take it.
 *
 * Comfortably longer than a send can take — the message is built from one
 * already-loaded period and posted with a ten-second fetch timeout — and short
 * enough that a process killed mid-send does not lock the month out of being
 * announced until somebody notices. Minutes, not hours.
 */
const CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * A fourth `status` value, stored in the same free-text column as the others.
 *
 * The schema types `status` as a String and documents three values; this adds a
 * fourth without a migration because a run that COULD not send is a distinct
 * outcome from one that failed to and from one that succeeded. Recording it as
 * "failed" would put a red alert on a workspace that simply has Telegram
 * switched off; leaving no row at all is the bug this fixes — the card then
 * shows last month's success and reads as "this month delivered fine".
 *
 * A skipped row is claimable exactly like a failed one, so it never blocks the
 * send that follows once the configuration is fixed.
 */
const SKIPPED_STATUS = "skipped";

// ---------------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------------

/**
 * Telegram chat ids, as an admin can legitimately type them.
 *
 * A numeric id (negative for groups and supergroups, which is why the sign is
 * allowed) or an @username for a public channel. Validated rather than accepted
 * as free text so a mistyped id fails in the settings form, where the person
 * who typed it is looking, instead of on the 1st of the month.
 */
const CHAT_ID_PATTERN = /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

export const notificationSettingsUpdateSchema = z
  .object({
    telegramChatId: z
      .string()
      .trim()
      .max(64)
      .nullable()
      .refine((value) => value === null || value === "" || CHAT_ID_PATTERN.test(value), {
        message:
          "That does not look like a Telegram chat id. Use the numeric id (e.g. -1001234567890) " +
          "or an @channelusername.",
      })
      // An emptied field means "no destination", which is the same state as
      // never having set one. Normalising here keeps two spellings of absence
      // out of the database.
      .transform((value) => (value === null || value === "" ? null : value))
      .optional(),
    telegramEnabled: z.boolean().optional(),
    payrollNotificationsEnabled: z.boolean().optional(),
  })
  .strict();

export type NotificationSettingsUpdate = z.infer<typeof notificationSettingsUpdateSchema>;

/**
 * The organization's notification row, created on first read.
 *
 * Same self-healing shape as `getOrgSettings`: a settings row that does not
 * exist yet means "the defaults", not an error.
 */
async function getOrCreateSettings(organizationId: string) {
  const existing = await prisma.notificationSettings.findUnique({ where: { organizationId } });
  return existing ?? prisma.notificationSettings.create({ data: { organizationId } });
}

function toSettingsDTO(row: {
  telegramChatId: string | null;
  telegramEnabled: boolean;
  payrollNotificationsEnabled: boolean;
}): NotificationSettingsDTO {
  return {
    telegramChatId: row.telegramChatId,
    telegramEnabled: row.telegramEnabled,
    payrollNotificationsEnabled: row.payrollNotificationsEnabled,
  };
}

export interface NotificationSettingsView {
  readonly settings: NotificationSettingsDTO;
  /**
   * Whether a message could actually be sent, and what is missing.
   *
   * The bot token is reported here as a BOOLEAN and never as a value — see
   * `telegram-env.ts`. An admin needs to know the token is set; nobody needs it
   * echoed back out of the API that stores it.
   */
  readonly telegram: TelegramStatusDTO;
  /**
   * How the most recent payroll summary delivery went, or null if none has
   * ever been attempted.
   *
   * Shipped alongside the settings rather than from its own endpoint because
   * it is read in exactly one place — next to the switches that caused it —
   * and because a failure that needs a second request to discover is a failure
   * nobody discovers. See `getLastPayrollNotification`.
   */
  readonly lastPayrollNotification: PayrollNotificationStatusDTO | null;
}

export async function getNotificationSettings(
  organizationId: string,
): Promise<NotificationSettingsView> {
  const row = await getOrCreateSettings(organizationId);
  return {
    settings: toSettingsDTO(row),
    telegram: telegramStatus(row.telegramChatId),
    lastPayrollNotification: await getLastPayrollNotification(organizationId),
  };
}

/**
 * The most recent delivery attempt for this organization's payroll summary.
 *
 * WHY THIS EXISTS AT ALL
 * The monthly send happens at midnight on the 1st with nobody watching. When
 * it fails, `sendPayrollNotification` writes the reason onto the
 * PayrollNotification row and audits it — but an audit entry is a haystack and
 * the admin has no reason to go looking. Without this read, the only way to
 * learn that last month's summary never arrived is for somebody to notice the
 * silence. The brief asks for the failure to be visible on the screen; this is
 * the value that makes it so.
 *
 * SCOPING. There is no organizationId on PayrollNotification — it hangs off
 * PayrollPeriod — so the filter goes through the relation. That is the same
 * join the claim already makes, and it means a period belonging to another
 * workspace cannot surface here however the ids were generated.
 *
 * Ordered by `updatedAt` rather than by period: the interesting row is the one
 * that moved most recently, which after a re-send of an older month is not the
 * newest month. `@updatedAt` is maintained by Prisma on every write, including
 * the claim, so a pending row that is mid-flight sorts to the top exactly while
 * it is worth showing.
 */
export async function getLastPayrollNotification(
  organizationId: string,
): Promise<PayrollNotificationStatusDTO | null> {
  const row = await prisma.payrollNotification.findFirst({
    where: { channel: TELEGRAM_CHANNEL, period: { organizationId } },
    orderBy: { updatedAt: "desc" },
    select: {
      channel: true,
      status: true,
      attempts: true,
      lastError: true,
      sentAt: true,
      updatedAt: true,
      // The period's identity only. Its records — and therefore every figure —
      // are not selected and are not this endpoint's to serve: `settings.manage`
      // is a weaker permission than `payroll.view`.
      period: { select: { year: true, month: true } },
    },
  });

  if (!row) return null;

  return {
    channel: row.channel,
    // The column is a plain string, so it is narrowed rather than asserted: a
    // value this code does not recognise reads as "pending" (in flight, outcome
    // unknown) instead of claiming a delivery succeeded.
    status:
      row.status === "sent" || row.status === "failed" || row.status === SKIPPED_STATUS
        ? row.status
        : "pending",
    attempts: row.attempts,
    lastError: row.lastError,
    sentAt: row.sentAt?.getTime() ?? null,
    updatedAt: row.updatedAt.getTime(),
    year: row.period.year,
    month: row.period.month,
    periodLabel: periodLabel(periodForMonth(row.period.year, row.period.month)),
  };
}

export async function updateNotificationSettings(
  organizationId: string,
  patch: NotificationSettingsUpdate,
): Promise<NotificationSettingsView> {
  // `upsert` rather than `update` so the first change to a never-read
  // organization does not fail on a missing row.
  const row = await prisma.notificationSettings.upsert({
    where: { organizationId },
    create: { organizationId, ...patch },
    update: patch,
  });

  return {
    settings: toSettingsDTO(row),
    telegram: telegramStatus(row.telegramChatId),
    // Re-read rather than omitted, so the PATCH response is the same shape the
    // GET returns and the client can replace its cache with it wholesale. A
    // settings change does not alter delivery history, but a response that
    // dropped the field would blank the card that shows it.
    lastPayrollNotification: await getLastPayrollNotification(organizationId),
  };
}

/** Which fields a PATCH actually touched, for the audit summary. */
export function changedSettingKeys(patch: NotificationSettingsUpdate): readonly string[] {
  return Object.keys(patch).filter(
    (key) => patch[key as keyof NotificationSettingsUpdate] !== undefined,
  );
}

// ---------------------------------------------------------------------------
// THE CLAIM
// ---------------------------------------------------------------------------

/**
 * A discriminated union rather than a bag of nullable fields.
 *
 * `notificationId` only exists on the branch that won the claim, and modelling
 * it that way means the code which records the outcome cannot be written
 * without having proved it holds the claim. The alternative — one shape with a
 * nullable id — needs a `?? ""` or a non-null assertion at the update, which is
 * a runtime failure waiting for the day a branch is added.
 */
type ClaimOutcome =
  | {
      readonly claimed: true;
      readonly notificationId: string;
      readonly attempts: number;
    }
  | {
      readonly claimed: false;
      readonly reason: "already_sent" | "in_flight";
      readonly attempts: number;
      readonly sentAt: Date | null;
    };

/**
 * Prisma reports a unique-constraint violation as error code P2002.
 *
 * Duck-typed rather than an `instanceof PrismaClientKnownRequestError` so this
 * module does not need a runtime import of the Prisma namespace for one branch.
 * The code is part of Prisma's documented public contract.
 */
function isUniqueConstraintViolation(caught: unknown): boolean {
  return (
    typeof caught === "object" &&
    caught !== null &&
    "code" in caught &&
    (caught as { readonly code?: unknown }).code === "P2002"
  );
}

/**
 * Takes ownership of this period's Telegram notification, or reports who has it.
 *
 * Runs in a transaction so the read that chooses the branch and the write that
 * acts on it cannot be interleaved with another invocation doing the same.
 */
async function claimNotification(periodId: string, force: boolean): Promise<ClaimOutcome> {
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.payrollNotification.findUnique({
        where: { periodId_channel: { periodId, channel: TELEGRAM_CHANNEL } },
        select: { id: true, status: true, attempts: true, sentAt: true, updatedAt: true },
      });

      if (!existing) {
        const created = await tx.payrollNotification.create({
          data: { periodId, channel: TELEGRAM_CHANNEL, status: "pending", attempts: 1 },
          select: { id: true },
        });
        return { claimed: true, notificationId: created.id, attempts: 1 };
      }

      // THE CASE THAT MUST HOLD WHEN THE JOB FIRES TWICE.
      if (existing.status === "sent" && !force) {
        return {
          claimed: false,
          reason: "already_sent",
          attempts: existing.attempts,
          sentAt: existing.sentAt,
        };
      }

      /**
       * A pending row that was claimed moments ago is somebody else's send in
       * progress, not an abandoned one.
       *
       * The compare-and-set below is only a version check: it serialises two
       * callers that read the SAME (status, attempts) pair inside overlapping
       * transactions — a millisecond race. It does nothing about the case that
       * actually happens. Run A claims, commits, and then spends up to ten
       * seconds building the message and waiting on Telegram. An admin pressing
       * "re-send" during that window reads the row A already bumped, matches
       * its own pair cleanly, and posts the whole payroll summary a second
       * time. Telegram has no unsend.
       *
       * So a claim is a lease. `updatedAt` is written by the claim itself, so
       * it dates the attempt without needing a column the schema does not have;
       * while it is fresh the row is off limits. Past the lease the send has
       * either finished — in which case the row is `sent` or `failed` and this
       * branch is about a retry — or the process died mid-flight, and a stuck
       * pending row must eventually become claimable or the month can never be
       * announced at all.
       *
       * `force` skips the lease: an admin who has read the card and decided to
       * re-send anyway is making an informed choice, which is different from a
       * scheduler blundering into a live send.
       */
      const leaseAgeMs = Date.now() - existing.updatedAt.getTime();
      if (existing.status === "pending" && leaseAgeMs < CLAIM_LEASE_MS && !force) {
        return {
          claimed: false,
          reason: "in_flight",
          attempts: existing.attempts,
          sentAt: existing.sentAt,
        };
      }

      // Optimistic claim on a pending, failed, or force-resent row. (status,
      // attempts) acts as the version: exactly one concurrent caller can match
      // the pair it read, and the other gets `count === 0`.
      const taken = await tx.payrollNotification.updateMany({
        where: { id: existing.id, status: existing.status, attempts: existing.attempts },
        data: { status: "pending", attempts: existing.attempts + 1, lastError: null },
      });

      if (taken.count === 0) {
        return {
          claimed: false,
          reason: "in_flight",
          attempts: existing.attempts,
          sentAt: existing.sentAt,
        };
      }

      return { claimed: true, notificationId: existing.id, attempts: existing.attempts + 1 };
    });
  } catch (caught) {
    if (isUniqueConstraintViolation(caught)) {
      // Another invocation created the row between our read and our insert.
      // The constraint did its job; this one stands down.
      return { claimed: false, reason: "in_flight", attempts: 0, sentAt: null };
    }
    throw caught;
  }
}

// ---------------------------------------------------------------------------
// SENDING THE PAYROLL SUMMARY
// ---------------------------------------------------------------------------

function skipped(detail: string): NotificationAttemptDTO {
  return { status: "skipped", detail, attempts: 0, sentAt: null, parts: 0 };
}

/**
 * Leaves the row saying this period was not announced, and why.
 *
 * Deliberately NOT a claim. A skip has nothing to make exclusive — no message
 * goes out — and burning the claim would leave the row looking attempted and
 * block the properly configured run that follows. This only writes the outcome,
 * and it writes it in a state (`skipped`) that `claimNotification` re-takes as
 * readily as a failure.
 *
 * WHY IT REFUSES TO TOUCH A ROW THAT ALREADY SENT
 * An admin who mutes notifications AFTER August went out and then presses
 * re-send would otherwise overwrite the record of a delivery that really
 * happened, and the audit log would be the only surviving evidence. The guard
 * is in the `where`, so it is the database that enforces it rather than a read
 * this code performs and then acts on.
 *
 * `attempts` is left alone on purpose: nothing was attempted, and inflating the
 * counter would make the card report tries that never reached Telegram.
 */
async function markNotificationSkipped(periodId: string, detail: string): Promise<void> {
  const reason = detail.slice(0, 500);

  try {
    const updated = await prisma.payrollNotification.updateMany({
      where: { periodId, channel: TELEGRAM_CHANNEL, status: { not: "sent" } },
      data: { status: SKIPPED_STATUS, lastError: reason },
    });

    // `updateMany` matching nothing means either no row yet or a row that has
    // already sent. Only the first of those wants a row created, and the unique
    // constraint settles which one it was.
    if (updated.count > 0) return;

    await prisma.payrollNotification.create({
      data: {
        periodId,
        channel: TELEGRAM_CHANNEL,
        status: SKIPPED_STATUS,
        attempts: 0,
        lastError: reason,
      },
    });
  } catch (caught) {
    // Either the row already sent (so the `create` collided with it) or a
    // concurrent run recorded the same skip a moment earlier. Both are the
    // outcome this function wanted; neither is worth failing a payroll run for.
    if (isUniqueConstraintViolation(caught)) return;
    throw caught;
  }
}

/**
 * The one place a skipped payroll notification is recorded.
 *
 * Both halves matter and both were missing. `payroll.notification_skipped` has
 * been declared in `actions.ts` since the audit log existed but was never
 * written, so a month that went unannounced left no entry to find; and the
 * notification row went untouched, so `getLastPayrollNotification` kept
 * returning the last month that DID send. An admin looking at either surface
 * saw a green tick for a month nobody was told about.
 */
async function recordPayrollSkip(
  options: SendPayrollNotificationOptions,
  detail: string,
): Promise<NotificationAttemptDTO> {
  const label = periodLabel(options.period);

  await markNotificationSkipped(options.periodId, detail);

  await recordAudit(
    {
      organizationId: options.organizationId,
      actorUserId: options.actorUserId,
      actorLabel: options.actorLabel,
      request: options.request ?? null,
    },
    {
      action: "payroll.notification_skipped",
      summary: `Payroll summary for ${label} was not sent to Telegram.`,
      targetType: "payroll_period",
      targetId: options.periodId,
      targetLabel: label,
      // The reason names a setting, never a figure and never a credential.
      metadata: { channel: TELEGRAM_CHANNEL, reason: detail },
    },
  );

  return skipped(detail);
}

/**
 * Turns the payroll screen's own period DTO into the message formatter's input.
 *
 * Deliberately a mapping and not a second set of queries. `getPeriodForOrganization`
 * is the identical function the admin screens read through, so the figures in
 * the Telegram message and the figures on the payroll page come from one code
 * path — and for a finalized period that path returns the STORED records rather
 * than recalculating, which is what stops the message reporting a total that a
 * moving view count has since changed.
 */
function toMessageInput(
  companyName: string,
  period: PayrollPeriodWindow,
  dto: PayrollPeriodDTO,
): PayrollMessageInput {
  return {
    companyName,
    period,
    // Already ordered most-earning-first by the service, so the message lists
    // people in the same order as the screen.
    employees: dto.records.map((record) => ({
      name: record.employeeName,
      roleLabel: record.roleLabel,
      baseSalaryMinor: record.baseSalaryMinor,
      hitPaymentMinor: record.hitPaymentMinor,
      adjustmentMinor: record.adjustmentMinor,
      adjustmentReason: record.adjustmentReason,
      totalMinor: record.totalMinor,
      currency: record.currency,
      byNiche: record.byNiche.map((line) => ({
        nicheName: line.nicheName,
        hitCount: line.hitCount,
        // The rate travels with the line, because the rate is per niche now.
        // Passed through as-is, nulls included: a message that invented a price
        // the screen refused to state would be the two disagreeing about the
        // same payslip, which is the one thing this mapping exists to prevent.
        hitPaymentMinor: line.hitPaymentMinor,
        bonusMinor: line.bonusMinor,
      })),
    })),
    totalMinor: dto.totals.totalMinor,
    currency: dto.totals.currency,
  };
}

export interface SendPayrollNotificationOptions {
  readonly organizationId: string;
  readonly periodId: string;
  /** The month being announced. Used for the window and the audit summary. */
  readonly period: PayrollPeriodWindow;
  /** Null for the scheduled job. */
  readonly actorUserId: string | null;
  /** Null-tolerant: `recordAudit` accepts an absent label and stores it as such. */
  readonly actorLabel: string | null;
  /**
   * Re-send a summary already marked sent. Only ever true for a deliberate
   * admin action; the scheduled job must never set it.
   */
  readonly force?: boolean;
  readonly request?: Request | null;
}

/**
 * Sends one period's payroll summary to Telegram, at most once.
 *
 * WHY THE CONFIGURATION CHECKS COME BEFORE THE CLAIM
 * Claiming is what stops a duplicate SEND. A run that cannot send at all —
 * notifications switched off, no chat configured, no token on the deployment —
 * has nothing to duplicate, and burning the claim on it would leave the row
 * looking attempted and block the properly configured run that follows. So the
 * order is: can we send → claim → send → record.
 *
 * WHY A MUTED ORGANIZATION STAYS MUTED EVEN ON A MANUAL SEND
 * `payrollNotificationsEnabled` is how an admin says "not this way, not now".
 * Having the manual button quietly override the switch would make the switch
 * mean nothing, and this message discloses every colleague's pay. The result
 * names the setting so the UI can offer to turn it on — an explicit act, in the
 * place where it is recorded.
 */
export async function sendPayrollNotification(
  options: SendPayrollNotificationOptions,
): Promise<NotificationAttemptDTO> {
  const { organizationId, periodId, period } = options;
  const label = periodLabel(period);

  const settings = await getOrCreateSettings(organizationId);
  const status = telegramStatus(settings.telegramChatId);

  // Every one of these returns leaves a trace now — see `recordPayrollSkip`.
  // A month that could not be announced is a month the team was not told about,
  // and the failure mode of the old silent return was that it looked identical
  // to a month that went out cleanly.
  if (!settings.telegramEnabled) {
    return recordPayrollSkip(
      options,
      "Telegram notifications are switched off for this organization.",
    );
  }
  if (!settings.payrollNotificationsEnabled) {
    return recordPayrollSkip(
      options,
      "Payroll notifications are muted. Turn them on in notification settings.",
    );
  }
  if (!status.tokenConfigured) {
    return recordPayrollSkip(
      options,
      "TELEGRAM_BOT_TOKEN is not set on this deployment, so no message can be sent.",
    );
  }
  const chatId = settings.telegramChatId;
  if (!chatId) {
    return recordPayrollSkip(
      options,
      "No Telegram chat id is configured. Set one in notification settings.",
    );
  }

  const claim = await claimNotification(periodId, options.force ?? false);

  if (!claim.claimed) {
    if (claim.reason === "already_sent") {
      // Not a failure. The point of the constraint is that this is the normal,
      // correct outcome of a job that fired twice.
      return {
        status: "already_sent",
        detail: `The ${label} payroll summary was already sent to Telegram.`,
        attempts: claim.attempts,
        sentAt: claim.sentAt?.getTime() ?? null,
        parts: 0,
      };
    }
    // Deliberately NOT recorded as a skipped month. Losing the race means
    // another invocation is delivering this very summary right now, so the
    // month is not going unannounced — and writing "skipped" over a row that a
    // concurrent run is about to mark "sent" would replace a true outcome with
    // a false one.
    return skipped("Another run is already sending this period's summary.");
  }

  // Read through the payroll service, which for a finalized period returns the
  // STORED records — so the message reports what was frozen rather than what
  // the view counts happen to say at the moment of sending.
  const [dto, orgSettings] = await Promise.all([
    getPeriodForOrganization(organizationId, period),
    getOrgSettings(organizationId),
  ]);

  const input = toMessageInput(orgSettings.companyName, period, dto);

  // ONE message, one send. `buildPayrollMessage` guarantees a single body for
  // any size of team, which is what makes this line atomic: it either posted or
  // it did not, so the retry that follows a failure cannot re-post half a
  // payroll announcement into the chat. There is no unsend to fall back on.
  const message = buildPayrollMessage(input);
  const result = await sendMessage(chatId, message);

  if (result.sent) {
    const sentAt = new Date();
    await prisma.payrollNotification.update({
      where: { id: claim.notificationId },
      data: { status: "sent", sentAt, lastError: null },
    });

    await recordAudit(
      {
        organizationId,
        actorUserId: options.actorUserId,
        actorLabel: options.actorLabel,
        request: options.request ?? null,
      },
      {
        action: "payroll.notification_sent",
        summary: `Payroll summary for ${label} sent to Telegram.`,
        targetType: "payroll_period",
        targetId: periodId,
        targetLabel: label,
        // Headcount and message count only. No salary, no bonus, no total —
        // the audit log is readable by `audit.view`, which is a wider group
        // than `payroll.view`.
        metadata: {
          channel: TELEGRAM_CHANNEL,
          // Always 1 now, and recorded anyway: an entry from before the
          // single-message change reads "parts: 3", and the difference is the
          // whole reason a re-send used to be able to duplicate an
          // announcement.
          parts: 1,
          employeeCount: input.employees.length,
          attempt: claim.attempts,
        },
      },
    );

    return {
      status: "sent",
      detail: null,
      attempts: claim.attempts,
      sentAt: sentAt.getTime(),
      parts: 1,
    };
  }

  /**
   * A FAILURE MUST BE VISIBLE.
   *
   * Recorded on the row an admin can read rather than only logged, because the
   * failure mode this guards against is silence: payday passes, no message
   * arrives, and nobody knows whether that is because nothing was owed or
   * because the bot was removed from the chat three weeks ago. The row keeps
   * `status: "failed"` and the reason, and the next run — scheduled or manual —
   * finds it claimable and tries again.
   *
   * `lastError` is already token-free: `telegram-service.ts` never builds an
   * error string from the request URL and scrubs the token from anything it
   * echoes back from upstream.
   */
  const detail = result.error ?? "Delivery to Telegram failed.";

  await prisma.payrollNotification.update({
    where: { id: claim.notificationId },
    data: { status: "failed", lastError: detail.slice(0, 500) },
  });

  await recordAudit(
    {
      organizationId,
      actorUserId: options.actorUserId,
      actorLabel: options.actorLabel,
      request: options.request ?? null,
    },
    {
      action: "payroll.notification_failed",
      summary: `Payroll summary for ${label} could not be sent to Telegram.`,
      targetType: "payroll_period",
      targetId: periodId,
      targetLabel: label,
      metadata: {
        channel: TELEGRAM_CHANNEL,
        attempt: claim.attempts,
        // The reason, which by construction carries no credential.
        error: detail,
      },
    },
  );

  return {
    status: "failed",
    detail,
    attempts: claim.attempts,
    sentAt: null,
    // Nothing reached the chat. A failed send of a single message leaves no
    // fragment behind, which is exactly what makes the retry safe.
    parts: 0,
  };
}

/**
 * The same send, addressed by calendar month rather than by row id.
 *
 * What the admin "re-send" button calls. The cron already holds the period id
 * from finalizing, so it uses `sendPayrollNotification` directly; a person
 * clicking a button knows a month, and resolving that to a row is this
 * function's whole job.
 *
 * WHY AN UNFINALIZED PERIOD IS REFUSED
 * An open period is a live calculation — its figures move as Shorts gain views.
 * Broadcasting one to the team would announce numbers that are guaranteed to
 * change, from a message that reads exactly like the real thing. Finalizing is
 * what turns an estimate into a document, and this is one of the places that
 * distinction has to be enforced rather than merely described.
 */
export async function sendPayrollNotificationForMonth(options: {
  readonly organizationId: string;
  readonly year: number;
  readonly month: number;
  readonly actorUserId: string | null;
  /** Null-tolerant: `recordAudit` accepts an absent label and stores it as such. */
  readonly actorLabel: string | null;
  readonly force?: boolean;
  readonly request?: Request | null;
}): Promise<NotificationAttemptDTO> {
  const period = periodForMonth(options.year, options.month);
  const label = periodLabel(period);

  const row = await prisma.payrollPeriod.findUnique({
    // Scoped by organization, not merely addressed by month: without this a
    // signed-in admin of one workspace could announce another's payroll.
    where: {
      organizationId_year_month: {
        organizationId: options.organizationId,
        year: options.year,
        month: options.month,
      },
    },
    select: { id: true, status: true },
  });

  if (!row) {
    throw errors.notFound(`${label} payroll period`);
  }
  if (row.status !== "finalized" && row.status !== "paid") {
    throw errors.invalidInput(
      `${label} has not been finalized yet, so its figures are still moving. ` +
        "Finalize the period first, then send the summary.",
    );
  }

  return sendPayrollNotification({
    organizationId: options.organizationId,
    periodId: row.id,
    period,
    actorUserId: options.actorUserId,
    actorLabel: options.actorLabel,
    force: options.force,
    request: options.request,
  });
}

// ---------------------------------------------------------------------------
// PROVING THE WIRING
// ---------------------------------------------------------------------------

/**
 * Sends a test message to the configured chat.
 *
 * Deliberately does NOT touch `PayrollNotification`: a test is not a payroll
 * notification, and letting one occupy the row for a period would either block
 * the real send or make the audit trail claim a summary went out when none did.
 * It also ignores `payrollNotificationsEnabled` — the point of a test is to
 * prove the plumbing before switching the monthly message on — but still
 * respects `telegramEnabled`, which is the "do not contact this chat" switch.
 */
export async function sendNotificationTest(options: {
  readonly organizationId: string;
  readonly actorUserId: string | null;
  /** Null-tolerant: `recordAudit` accepts an absent label and stores it as such. */
  readonly actorLabel: string | null;
  readonly request?: Request | null;
}): Promise<NotificationAttemptDTO> {
  const settings = await getOrCreateSettings(options.organizationId);
  const status = telegramStatus(settings.telegramChatId);

  if (!settings.telegramEnabled) {
    return skipped("Telegram is switched off for this organization.");
  }
  if (!status.tokenConfigured) {
    return skipped("TELEGRAM_BOT_TOKEN is not set on this deployment.");
  }
  if (!settings.telegramChatId) {
    return skipped("No Telegram chat id is configured.");
  }

  const result = await sendTestMessage(settings.telegramChatId);

  await recordAudit(
    {
      organizationId: options.organizationId,
      actorUserId: options.actorUserId,
      actorLabel: options.actorLabel,
      request: options.request ?? null,
    },
    {
      action: "payroll.test_notification_sent",
      summary: result.sent
        ? "Sent a Telegram test message."
        : "A Telegram test message could not be sent.",
      targetType: "notification_settings",
      targetId: options.organizationId,
      metadata: { channel: TELEGRAM_CHANNEL, sent: result.sent, error: result.error ?? null },
    },
  );

  return {
    status: result.sent ? "sent" : "failed",
    detail: result.error ?? null,
    attempts: 1,
    sentAt: result.sent ? Date.now() : null,
    parts: result.sent ? 1 : 0,
  };
}
