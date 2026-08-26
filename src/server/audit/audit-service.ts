import "server-only";

import { prisma } from "@/server/db";
import {
  carriesMoneyMetadata,
  shouldRecordNetworkContext,
  type AuditAction,
} from "@/lib/audit/actions";
import { clientIpFrom, userAgentFrom } from "@/server/auth/rate-limit";

/**
 * Writing and reading the audit trail.
 *
 * DESIGN NOTES
 *  • Entries are denormalised on purpose. `actorLabel`, `targetLabel` and
 *    `summary` are written at record time, so the log still reads correctly
 *    after the user, channel or finance row it refers to has been deleted. An
 *    audit trail that goes blank when you remove the thing being audited is
 *    worse than none, because it looks complete.
 *  • Recording never fails the action it describes. A logging outage must not
 *    stop an admin deactivating a compromised account.
 *  • Network context is captured only for the security-relevant actions listed
 *    in src/lib/audit/actions.ts — see the note there about why this is not an
 *    employee-monitoring tool.
 *  • Reading is not one permission. `audit.view` gets the entry; the amounts a
 *    pay entry carries in `metadata` need `payroll.view` on top, and
 *    `listAuditEvents` strips them without it. See the redaction note below.
 */

export interface AuditContext {
  readonly organizationId: string;
  readonly actorUserId?: string | null;
  readonly actorLabel?: string | null;
  /** Supply the Request to capture IP/user-agent for security events. */
  readonly request?: Request | null;
}

export interface AuditPayload {
  readonly action: AuditAction;
  readonly summary: string;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  readonly targetLabel?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}

/**
 * Fields that must never reach the log, whatever a caller passes.
 *
 * Metadata is the one free-form field here, which makes it the one place a
 * secret could be written by accident — a handler spreading a request body into
 * it, say. This strips the obvious names rather than trusting every future
 * caller to remember.
 */
const REDACTED_KEYS = new Set([
  "password",
  "newpassword",
  "currentpassword",
  "passwordhash",
  "token",
  "tokenhash",
  "accesstoken",
  "refreshtoken",
  "secret",
  "apikey",
  "authorization",
  "cookie",
]);

function sanitizeMetadata(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (REDACTED_KEYS.has(key.toLowerCase())) {
      safe[key] = "[redacted]";
      continue;
    }
    // Only primitives and short arrays; an arbitrary object graph is how a
    // whole user row ends up in the log.
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      safe[key] = typeof value === "string" ? value.slice(0, 500) : value;
    } else if (Array.isArray(value)) {
      safe[key] = value.slice(0, 20).map((v) => (typeof v === "string" ? v.slice(0, 200) : v));
    }
  }
  const json = JSON.stringify(safe);
  return json.length > 4000 ? json.slice(0, 4000) : json;
}

export async function recordAudit(
  context: AuditContext,
  payload: AuditPayload,
): Promise<void> {
  try {
    const withNetwork = context.request && shouldRecordNetworkContext(payload.action);

    await prisma.auditEvent.create({
      data: {
        organizationId: context.organizationId,
        actorUserId: context.actorUserId ?? null,
        actorLabel: context.actorLabel ?? null,
        action: payload.action,
        summary: payload.summary.slice(0, 500),
        targetType: payload.targetType ?? null,
        targetId: payload.targetId ?? null,
        targetLabel: payload.targetLabel?.slice(0, 200) ?? null,
        metadata: sanitizeMetadata(payload.metadata),
        ipAddress: withNetwork && context.request ? clientIpFrom(context.request) : null,
        userAgent: withNetwork && context.request ? userAgentFrom(context.request) : null,
      },
    });
  } catch (error) {
    // Never rethrow: the audited action already happened, and failing the
    // request now would leave the caller believing it did not.
    //
    // The failure is DESCRIBED, never handed over whole. A
    // PrismaClientValidationError renders the rejected call into its own text —
    // `data` included, which for a pay entry is the salary this module works to
    // keep behind `payroll.view`. Logging the error object would print that
    // into a server log, where it outlives the request and answers to nobody's
    // permissions. Action, error name and the first line: enough to find the
    // broken write, none of its arguments.
    console.error("[audit] failed to record event", payload.action, describeWriteFailure(error));
  }
}

/**
 * A one-line, argument-free description of a failed write.
 *
 * The first line only, because that line names the call that failed and
 * everything Prisma renders BELOW it — the `data` block, any offending value —
 * is the part that would carry a salary. The name is kept because
 * "PrismaClientValidationError" versus a connection error is most of what an
 * operator needs to know, and the cap is there because a long first line is
 * still a first line.
 */
function describeWriteFailure(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown error";
  const firstLine = error.message.trim().split("\n")[0] ?? "";
  return `${error.name}: ${firstLine.slice(0, 200)}`;
}

export interface AuditEntryDTO {
  readonly id: string;
  readonly action: string;
  readonly summary: string;
  readonly actorName: string | null;
  readonly actorId: string | null;
  readonly targetType: string | null;
  readonly targetLabel: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly createdAt: number;
}

export interface AuditPage {
  readonly entries: readonly AuditEntryDTO[];
  readonly total: number;
  readonly hasMore: boolean;
}

/**
 * Metadata keys that hold an amount.
 *
 * Money is stored and named in minor units throughout this codebase —
 * `salaryMinor`, `hitPaymentMinorFrom`, `totalMinor` — so the convention is a
 * reliable marker. `salary` and `amount` are matched too, for the spelling a
 * future writer reaches for when they are not thinking about this function.
 */
const MONEY_KEY_PATTERN = /minor|salary|amount/i;

/**
 * Strips the figures from a money-carrying entry, leaving the rest.
 *
 * The keys are DELETED, not nulled. `salaryMinorFrom: null` next to
 * `salaryMinorTo: null` does not read as "you may not see this", it reads as
 * "pay was set from nothing to nothing" — a different and false statement, and
 * a log that lies is worse than one that omits.
 *
 * Everything non-financial stays: which fields changed, whether notes were
 * touched, counts, the period. The entry still answers who did what to whom and
 * when, which is the accountability record `audit.view` is granted for. Only
 * the numbers that belong to `payroll.view` are gone.
 */
function stripMoneyKeys(metadata: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!MONEY_KEY_PATTERN.test(key)) safe[key] = value;
  }
  return safe;
}

export async function listAuditEvents(options: {
  organizationId: string;
  limit?: number;
  offset?: number;
  action?: string | null;
  actionPrefix?: string | null;
  actorUserId?: string | null;
  /**
   * Whether this caller may see the amounts a pay entry carries — that is,
   * whether they hold `payroll.view` on top of the `audit.view` that got them
   * the entry at all.
   *
   * Resolved by the ROUTE from the session, never from a query string: a flag
   * the reader can set is a flag the reader can grant themselves. Defaults to
   * false so a call site that has not thought about it redacts rather than
   * leaks.
   */
  includeSensitiveMetadata?: boolean;
}): Promise<AuditPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const includeSensitiveMetadata = options.includeSensitiveMetadata ?? false;

  const where = {
    organizationId: options.organizationId,
    ...(options.action ? { action: options.action } : {}),
    ...(options.actionPrefix ? { action: { startsWith: options.actionPrefix } } : {}),
    ...(options.actorUserId ? { actorUserId: options.actorUserId } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.auditEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: limit,
      select: {
        id: true,
        action: true,
        summary: true,
        actorUserId: true,
        actorLabel: true,
        targetType: true,
        targetLabel: true,
        metadata: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
        actor: { select: { name: true, email: true } },
      },
    }),
    prisma.auditEvent.count({ where }),
  ]);

  return {
    entries: rows.map((row) => ({
      id: row.id,
      action: row.action,
      summary: row.summary,
      // Prefer the live name so a rename is reflected, but fall back to the
      // label captured at record time when the account is gone.
      actorName: row.actor?.name ?? row.actor?.email ?? row.actorLabel,
      actorId: row.actorUserId,
      targetType: row.targetType,
      targetLabel: row.targetLabel,
      metadata: readMetadata(row.action, row.metadata, includeSensitiveMetadata),
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      createdAt: row.createdAt.getTime(),
    })),
    total,
    hasMore: offset + rows.length < total,
  };
}

/**
 * Metadata as this reader is entitled to see it.
 *
 * The redaction is keyed on the ACTION rather than on the shape of the value,
 * so an amount cannot slip through by being spelled differently in a row
 * written months ago — the action set in src/lib/audit/actions.ts is the
 * decision, and this is only how it is applied.
 */
function readMetadata(
  action: string,
  raw: string | null,
  includeSensitiveMetadata: boolean,
): Record<string, unknown> | null {
  const parsed = parseMetadata(raw);
  if (!parsed || includeSensitiveMetadata || !carriesMoneyMetadata(action)) return parsed;
  return stripMoneyKeys(parsed);
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Trims the log to a retention window.
 *
 * Called by the scheduled job. Keeping security events forever is not
 * automatically better: a log nobody prunes becomes a growing store of personal
 * data with no defined purpose, which is the opposite of what a
 * proportionate audit trail should be.
 */
export async function pruneAuditEvents(
  organizationId: string,
  retentionDays = 365,
): Promise<number> {
  // Scoped even though this deployment is single-tenant. An unscoped
  // deleteMany on a table that carries organizationId is a cross-tenant
  // destructive write waiting for the day a second organization exists, and
  // the cost of taking the parameter now is one argument.
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await prisma.auditEvent.deleteMany({
    where: { organizationId, createdAt: { lt: cutoff } },
  });
  return result.count;
}
