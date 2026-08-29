import "server-only";

import { prisma } from "@/server/db";
import {
  moneyPermissionFor,
  shouldRecordNetworkContext,
  type AuditAction,
  type AuditMoneyPermission,
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
 *  • Reading is not one permission, and it is not two either. `audit.view` gets
 *    the entry; the amounts an entry carries need the permission those
 *    particular amounts belong to — `payroll.view` for a pay figure,
 *    `finance.view` for a ledger figure — and `listAuditEvents` strips them
 *    per entry without it. Holding one does not unlock the other. See the
 *    redaction note below.
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
 * touched, counts, the period, the currency an amount was recorded in. The
 * entry still answers who did what to whom and when, which is the
 * accountability record `audit.view` is granted for. Only the numbers are
 * gone — the ones belonging to whichever permission the caller turned out not
 * to hold.
 */
function stripMoneyKeys(metadata: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!MONEY_KEY_PATTERN.test(key)) safe[key] = value;
  }
  return safe;
}

// ---------------------------------------------------------------------------
// LEGACY SUMMARY SCRUB
// ---------------------------------------------------------------------------

/**
 * THIS IS BEST-EFFORT, AND IT IS THE SECOND LINE OF DEFENCE. READ THE WHY.
 *
 * The real fix is on the WRITE side: finance summaries no longer quote a figure
 * at all (see `finance-service.ts` — the amount travels in `metadata`, where
 * redaction is exact because it works on keys). That fix cannot reach rows
 * already in the table. Their `summary` column still reads "Recorded a
 * $4,100.00 revenue entry", and an `audit.view` reader without `finance.view`
 * would read every one of those amounts out of the prose. So the stored text is
 * scrubbed on the way out.
 *
 * WHY IT CANNOT BE EXACT. `formatMoney` goes through `Intl.NumberFormat`, whose
 * output depends on the currency AND the locale of whichever process wrote the
 * row: `$4,100.00`, `US$4,100.00`, `4.100,00 €`, `¥4100`, `TRY 4.100,00`,
 * `4,100.00 TRY` are all the same amount. There is no regex that catches every
 * form, and pretending otherwise is how a redaction quietly stops working. What
 * follows is a set of shapes, not a proof.
 *
 * SO IT ERRS TOWARDS REDACTING. An over-redacted summary costs a reader some
 * context they can recover from the action, the target and the timestamp; an
 * under-redacted one hands them the figure the permission exists to withhold.
 * The one thing it must not do is mangle a summary that carries no money —
 * every pattern below requires either a currency marker or a thousands-grouped
 * number, so an ordinary sentence, a year, a headcount and an ISO date all pass
 * through untouched.
 */

/**
 * Currency symbols, enumerated rather than expressed as `\p{Sc}`.
 *
 * The property escape needs an ES2018 target and this project compiles to
 * ES2017, so the class is written out: the Currency Symbols block plus the
 * strays that live outside it ($, ¢, £, ¤, ¥, ƒ and the fullwidth forms).
 */
const CURRENCY_SYMBOL =
  "[$\\u00A2-\\u00A5\\u0192\\u058F\\u060B\\u09F2\\u09F3\\u0AF1\\u0BF9\\u0E3F\\u17DB\\u20A0-\\u20BF\\uA838\\uFDFC\\uFE69\\uFF04\\uFFE0\\uFFE1\\uFFE5\\uFFE6]";

/** Optional sign, including the typographic minus `Intl` can emit. */
const SIGN = "[-+\\u2212]?";

/**
 * What may sit between a number and its currency marker.
 *
 * Not merely whitespace. he-IL writes "41.00 ‏$", and the right-to-left
 * mark is invisible, occupies no width, and is NOT matched by JavaScript's
 * `\s` — so a gap written as `\\s*` fails to bridge it and the amount walks
 * through intact. The left-to-right mark and the zero-width joiner are included
 * on the same reasoning rather than because they were observed in output.
 */
const GAP = "[\\s\\u200E\\u200F\\u200D]*";

/**
 * A formatted magnitude: digits with any mix of grouping and decimal
 * separators. `\s` already covers the no-break and thin spaces `Intl` uses as
 * group separators in fr-FR and similar.
 *
 * The apostrophes are de-CH and de-LI, which group as 13'940.00. That shape did
 * not merely escape an earlier version of this scrub — it HALF-escaped it,
 * which is worse: with the apostrophe outside this class, "$ 4'100.00" redacted
 * the "$ 4" and left "[redacted]'100.00", a result that looks like the scrub
 * worked while the figure is still legible. Both the typewriter and the
 * typographic apostrophe are here because `Intl` may emit either depending on
 * the runtime's locale data.
 */
const MAGNITUDE = "\\d+(?:[.,'\\u2019\\s]\\d+)*";

/** An ISO code, not followed by more letters, so `USDX` is not `USD`. */
const CODE = "[A-Z]{3}(?![A-Za-z])";

/**
 * The magnitude the ISO-code branches accept — one case narrower than the
 * symbol branches, because a code beside a small bare integer is usually a
 * UNIT rather than an amount.
 *
 * `finance.rate_updated` writes "Set 1 USD = 34.15 TRY". The "1 USD" there is
 * the left-hand side of a ratio, and redacting it leaves a sentence saying
 * nothing at all — the mangling this scrub is not allowed to do. The only way
 * `formatMoney` puts a separator-free integer next to a code is a zero-decimal
 * currency (¥4100, ₩12000), and those figures run to three digits and up, so
 * requiring either a separator or three digits gives up amounts the formatter
 * cannot actually produce. A currency SYMBOL carries no such ambiguity, which
 * is why the branches above it keep the loose form.
 */
const CODE_ADJACENT_MAGNITUDE = "(?:\\d+(?:[.,'\\u2019\\s]\\d+)+|\\d{3,})";

/** A symbol, with the letters some locales prefix it with: `US$`, `R$`, `NT$`. */
const SYMBOL = `[A-Za-z]{0,3}${CURRENCY_SYMBOL}`;

/**
 * Ordered widest-marker-first, because alternation takes the first branch that
 * matches at a position and a bare grouped number is the weakest signal here —
 * it must not win against a match that starts one character earlier with a
 * symbol.
 */
const MONEY_IN_TEXT = new RegExp(
  [
    // $4,100.00 · US$4,100.00 · ¥4100 · −₺4 100,00 · € 4.100,00
    `${SIGN}${SYMBOL}${GAP}${SIGN}${MAGNITUDE}`,
    // 4.100,00 € · 4 100,00 US$ · 41.00 ‏$ (he-IL, with an invisible RTL mark)
    `${SIGN}${MAGNITUDE}${GAP}${SYMBOL}`,
    // TRY 4.100,00 — what Intl emits for a code it has no symbol for, and what
    // the manual fallback in money.ts emits for the same reason.
    `\\b${CODE}${GAP}${SIGN}${CODE_ADJACENT_MAGNITUDE}`,
    // 4,100.00 TRY — formatMoney({ withCode: true }), and fr-FR-style output
    // for a code Intl has no symbol for.
    `${SIGN}${CODE_ADJACENT_MAGNITUDE}${GAP}${CODE}`,
    // 4,100.00 with no marker at all: a thousands-grouped number is money often
    // enough, and a bare integer — a year, a headcount, an ISO date — is
    // deliberately NOT matched here. The apostrophe is de-CH grouping.
    `${SIGN}\\d{1,3}(?:[.,'\\u2019\\s]\\d{3})+(?:[.,]\\d+)?`,
  ].join("|"),
  "g",
);

/** Matches the placeholder `sanitizeMetadata` writes, so the log reads consistently. */
const REDACTED = "[redacted]";

function scrubMoneyFromText(summary: string): string {
  return summary.replace(MONEY_IN_TEXT, REDACTED);
}

/**
 * Which kinds of money this reader is entitled to, keyed by the permission that
 * grants each.
 *
 * Keyed by the permission NAME rather than by a nickname for it, so a call site
 * cannot pair the wrong flag with the wrong kind of figure — building this
 * object is spelling out `"payroll.view": await actorCan("payroll.view")`, and
 * there is nowhere for a mismatch to hide.
 */
export type AuditMoneyAccess = Readonly<Record<AuditMoneyPermission, boolean>>;

/** What a caller that has not thought about it gets: neither. */
const NO_MONEY_ACCESS: AuditMoneyAccess = {
  "payroll.view": false,
  "finance.view": false,
};

export async function listAuditEvents(options: {
  organizationId: string;
  limit?: number;
  offset?: number;
  action?: string | null;
  actionPrefix?: string | null;
  actorUserId?: string | null;
  /**
   * Which kinds of amount this caller may see, on top of the `audit.view` that
   * got them the entries at all.
   *
   * ONE FLAG PER PERMISSION, not one flag for "money". This was a single
   * boolean resolved from `payroll.view`, which made that permission a key to
   * the finance ledger and left `finance.view` unable to unlock the finance
   * figures it names. The two are separate permissions precisely because
   * company revenue and an individual's salary leak differently, and an audit
   * reader must not be where they get joined back up.
   *
   * Resolved by the ROUTE from the session, never from a query string: a flag
   * the reader can set is a flag the reader can grant themselves. Defaults to
   * neither, so a call site that has not thought about it redacts rather than
   * leaks.
   */
  moneyAccess?: AuditMoneyAccess;
}): Promise<AuditPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const moneyAccess = options.moneyAccess ?? NO_MONEY_ACCESS;

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
    entries: rows.map((row) => {
      // PER ENTRY, NOT PER REQUEST. An entry's figures belong to one permission
      // — `payroll.view` for a pay entry, `finance.view` for a ledger entry —
      // and the reader either holds that one or does not. Deciding once for the
      // whole page would mean whichever permission was asked about unlocking
      // both kinds of money, which is the bug this replaced.
      const required = moneyPermissionFor(row.action);
      const maySeeAmounts = required === null || moneyAccess[required];

      return {
        id: row.id,
        action: row.action,
        // Metadata is redacted by key, which is exact. The summary is prose
        // written before the amounts were kept out of it, so it can only be
        // scrubbed — see the note on `scrubMoneyFromText`.
        summary: maySeeAmounts ? row.summary : scrubMoneyFromText(row.summary),
        // Prefer the live name so a rename is reflected, but fall back to the
        // label captured at record time when the account is gone.
        actorName: row.actor?.name ?? row.actor?.email ?? row.actorLabel,
        actorId: row.actorUserId,
        targetType: row.targetType,
        targetLabel: row.targetLabel,
        metadata: readMetadata(row.metadata, maySeeAmounts),
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        createdAt: row.createdAt.getTime(),
      };
    }),
    total,
    hasMore: offset + rows.length < total,
  };
}

/**
 * Metadata as this reader is entitled to see it.
 *
 * Whether the entry carries money at all is decided by its ACTION rather than
 * by the shape of the value — see `moneyPermissionFor` — so an amount cannot
 * slip through by being spelled differently in a row written months ago. By the
 * time it gets here that decision is made; this is only how it is applied.
 */
function readMetadata(
  raw: string | null,
  maySeeAmounts: boolean,
): Record<string, unknown> | null {
  const parsed = parseMetadata(raw);
  if (!parsed || maySeeAmounts) return parsed;
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
