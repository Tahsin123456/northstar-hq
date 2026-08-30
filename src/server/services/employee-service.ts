import "server-only";

import { z } from "zod";
import { prisma } from "@/server/db";
import { AppError, errors } from "@/server/errors";
import { actorCan } from "@/server/auth/dal";
import { revokeAllSessionsForUser } from "@/server/auth/session";
import { listAuditEvents, recordAudit, type AuditEntryDTO } from "@/server/audit/audit-service";
import type { AuditAction } from "@/lib/audit/actions";
import { ROLE_ORDER, roleDefinition } from "@/lib/auth/permissions";
import { MAX_MONEY_MINOR, isSupportedCurrency, normalizeCurrencyCode } from "@/lib/finance/money";
import { toNicheKind, type NicheKind } from "@/lib/niches/niche-kind";
import {
  calculateEmployeePayroll,
  payDateFor,
  periodContaining,
  periodForMonth,
  periodLabel,
  type PayrollEmployee,
  type PayrollPeriodWindow,
} from "@/lib/payroll/payroll-engine";
import { loadPayrollInputs } from "./payroll-data";
import { getCurrentOrgSettings, getScope } from "./user-service";

/**
 * =========================================================================
 * EMPLOYEES — THE PEOPLE BEHIND THE MEMBERSHIPS
 * =========================================================================
 *
 * `admin-service.ts` answers "who can reach our data?". This one answers "who
 * works here, on what, and for how much?". They are deliberately separate
 * services over separate tables, because they have different readers: an admin
 * managing access should not need — and must not incidentally receive — a
 * colleague's salary.
 *
 * THE ONE RULE THAT SHAPES EVERY FUNCTION HERE
 * Pay is OMITTED, not nulled, when the caller lacks `payroll.view`. A response
 * carrying `salaryMinor: null` would leak by shape: it tells the reader the
 * field exists, tells them it is being withheld, and hands the next developer a
 * tempting `?? 0`. The DTOs below make the payroll block an optional property
 * that is genuinely absent from the serialised JSON — and, one level down,
 * `loadEmployeeRecords` does not even put the columns in its `select`, so the
 * figures are never in this process's memory for a caller who may not see them.
 *
 * `includePay` IS RESOLVED BY THE ROUTE, FROM THE SESSION
 * Never from a query string, a header or a body. Every route under
 * src/app/api/admin/employees calls `actorCan("payroll.view")` and passes the
 * answer down. The parameter is a boolean rather than an actor precisely so
 * this file cannot be tempted to re-derive authorisation from something a
 * caller supplied.
 *
 * ESTIMATES ARE THE ENGINE, NOT A SECOND OPINION
 * The current-period figure on this screen comes from
 * `calculateEmployeePayroll`, fed by `loadPayrollInputs` in payroll-data.ts —
 * the same pure function and the same query that produce the finalized
 * PayrollRecord. Nothing here re-implements a threshold, a period boundary or a
 * bonus. If the estimate and the payslip could disagree, the number nobody
 * could explain would be the one this screen showed.
 */

// ---------------------------------------------------------------------------
// WIRE TYPES
// ---------------------------------------------------------------------------

export interface EmployeeNicheDTO {
  readonly id: string;
  readonly name: string;
  /** `--chart-N` accent index, so the chip here matches the chip everywhere else. */
  readonly colorIndex: number;
  /**
   * "production" | "watchlist".
   *
   * Carried so this chip satisfies `NicheRefDTO` and renders identically to the
   * one on the dashboard — but it earns its place here on its own too. Somebody
   * assigned only to watchlist niches can earn no hit bonus at all, and an
   * admin looking at the roster should be able to see that from the chips
   * rather than from an empty payroll line a month later.
   */
  readonly kind: NicheKind;
}

/** The pay columns of the Employees table. Present only behind payroll.view. */
export interface EmployeePayDTO {
  readonly salaryMinor: number;
  readonly hitPaymentMinor: number;
  readonly currency: string;
  /**
   * Salary plus bonuses for the CURRENT period.
   *
   * An estimate in the honest sense while `isDraft` is true: views still move,
   * so the figure can only go up until the period closes and is finalized. Once
   * it is finalized this is the stored PayrollRecord instead, and the name
   * overstates it — see `isDraft`.
   *
   * Formatted with `currency` above, which is the CONFIGURED one. The two can
   * only disagree in one narrow case — a frozen period whose record was written
   * before somebody changed this person's currency — and the profile page is
   * where that is legible, because its payment history carries each record's
   * own currency.
   */
  readonly estimatedPayMinor: number;
  /**
   * True while `estimatedPayMinor` is a live recalculation.
   *
   * False once the period has been frozen, when the figure beside it is the
   * stored record. Finalizing accepts `force`, so the month in progress can
   * legitimately be frozen already — and an Employees list quoting a moving
   * estimate next to a Payroll page quoting the settled record is how somebody
   * ends up telling an employee the wrong number. The flag travels with the
   * figure rather than with the page so no caller can render one without it.
   */
  readonly isDraft: boolean;
}

export interface EmployeeListItemDTO {
  readonly userId: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly role: string;
  readonly roleLabel: string;
  /** "invited" | "pending_approval" | "active" | "deactivated". */
  readonly status: string;
  readonly assignedNiches: readonly EmployeeNicheDTO[];
  readonly joinedOn: number | null;
  readonly lastLoginAt: number | null;
  /** When they were invited, if an invitation for this address still exists. */
  readonly invitedAt: number | null;
  /** ABSENT — not null — for a caller without payroll.view. */
  readonly pay?: EmployeePayDTO;
}

/**
 * One row of the approvals queue.
 *
 * Deliberately NOT `EmployeeListItemDTO` narrowed to the pending ones. That
 * type is a roster entry — status, last login, and behind `payroll.view` a
 * salary — and none of it answers the question this screen asks, which is
 * "should this person be let in?". What does answer it is who they say they
 * are, what they were invited as, and who invited them; so those are the only
 * fields here, and there is no `pay` key on this shape at all. An approvals
 * queue cannot leak a figure it was never given a place to put.
 *
 * `status` is absent for the same reason: every row in this list is
 * `pending_approval` by construction. A column that reads the same on every row
 * is noise in a table whose whole job is to be scanned quickly.
 */
export interface PendingApprovalDTO {
  readonly userId: string;
  readonly name: string | null;
  readonly email: string | null;
  /** The role the invitation was issued for — what they will become on approval. */
  readonly role: string;
  readonly roleLabel: string;
  readonly assignedNiches: readonly EmployeeNicheDTO[];
  /**
   * When they accepted the invitation and joined the queue.
   *
   * Null when no invitation row survives — a workspace's founding account, or
   * an address that was invited and then re-invited under a different one. The
   * UI must print an em dash rather than inventing a date.
   */
  readonly acceptedAt: number | null;
  /** When the invitation itself was sent. */
  readonly invitedAt: number | null;
  /** The admin who sent it, by name, or null if that account is gone. */
  readonly invitedBy: string | null;
}

export interface EmployeeAccountDTO {
  readonly userId: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly role: string;
  readonly roleLabel: string;
  readonly status: string;
  readonly createdAt: number;
  readonly lastLoginAt: number | null;
  readonly invitedAt: number | null;
  readonly deactivatedAt: number | null;
  /**
   * Employment dates, ungated — the same fields the Employees table shows to
   * anyone who can manage users. A start date is roster information of the same
   * kind as a role; a salary is not, and lives in the gated block below.
   */
  readonly joinedOn: number | null;
  readonly employmentEndedOn: number | null;
  /** So the UI can grey out the controls that would refuse anyway. */
  readonly isSelf: boolean;
}

export interface EmployeeNicheBonusDTO {
  /**
   * Null only on a frozen period whose niche has since been deleted.
   *
   * A stored PayrollHit keeps the niche's NAME as well as its id precisely so
   * the line stays readable after the niche is gone; the id is what goes, and
   * saying so beats inventing one.
   */
  readonly nicheId: string | null;
  readonly nicheName: string;
  readonly thresholdApplied: number;
  /**
   * The clock half of the rule these hits were judged under, in hours.
   *
   * Null on a frozen line: `PayrollHit` has no column for the window, and this
   * screen deliberately does not go and recover it from the evaluation the way
   * the payroll detail view does — a roster card is not the place a bonus gets
   * audited. A null means "not shown here", and the line states the bar alone
   * rather than inventing a window to keep the sentence tidy.
   */
  readonly windowHoursApplied: number | null;
  readonly hitCount: number;
  /**
   * The NICHE's per-hit rate these hits were paid at, in minor units.
   *
   * On the line rather than beside the person, because the rate is a property
   * of the work now: one record can hold GTA hits at one price and Minecraft
   * hits at another, and a single figure on the profile could not describe
   * that. The employee's own `hitPaymentMinor` is a historical column and no
   * longer produces any of these numbers.
   *
   * Null on a frozen line whose record was paid at more than one rate. This
   * screen deliberately does not go and recover the individual prices the way
   * the payroll detail view does — a roster card is not the place a bonus gets
   * audited — so a null means "not shown here", and the row states its hit
   * count without a price rather than inventing one.
   */
  readonly hitPaymentMinor: number | null;
  /** `hitCount × hitPaymentMinor`, or null in lockstep with it. */
  readonly bonusMinor: number | null;
}

export interface EmployeePeriodEstimateDTO {
  readonly year: number;
  readonly month: number;
  readonly label: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly payOn: number;
  readonly hitCount: number;
  readonly baseSalaryMinor: number;
  readonly hitBonusMinor: number;
  /**
   * Always 0 while `isDraft` — a draft has nothing frozen to correct.
   *
   * Carried on the DTO anyway so that once the period IS frozen, base + bonus +
   * adjustment still visibly equals `totalMinor`. Without it a corrected record
   * would render as three numbers that do not add up.
   */
  readonly adjustmentMinor: number;
  readonly totalMinor: number;
  /**
   * True when these figures were calculated just now, false when they were read
   * from the stored PayrollRecord. The same distinction — and the same name —
   * `PayrollPeriodHeaderDTO.isDraft` carries on the payroll screens.
   */
  readonly isDraft: boolean;
  readonly byNiche: readonly EmployeeNicheBonusDTO[];
}

/** One past period, as it was actually recorded. */
export interface EmployeePaymentDTO {
  readonly periodId: string;
  readonly year: number;
  readonly month: number;
  readonly label: string;
  readonly payOn: number;
  /** "open" | "finalized" | "paid" — the period's status, not the payment's. */
  readonly periodStatus: string;
  readonly baseSalaryMinor: number;
  readonly hitPaymentMinor: number;
  readonly hitCount: number;
  readonly hitBonusMinor: number;
  readonly adjustmentMinor: number;
  readonly adjustmentReason: string | null;
  readonly totalMinor: number;
  readonly currency: string;
  /** "pending" | "paid" */
  readonly paymentStatus: string;
  readonly paidAt: number | null;
}

export interface EmployeePayrollDTO {
  readonly salaryMinor: number;
  /**
   * =======================================================================
   * THE EMPLOYEE-LEVEL PER-HIT RATE. HISTORICAL — IT NO LONGER DECIDES PAY.
   * =======================================================================
   *
   * `EmployeeProfile.hitPaymentMinor`, the column that used to price every hit
   * this person earned. `Niche.hitPaymentMinor` prices them now, because a rate
   * is a property of the WORK rather than of the person: a hit in a niche that
   * takes a day to produce is not worth the same as one that takes an hour, and
   * paying two editors different amounts for the identical Short was never what
   * anybody meant.
   *
   * IT IS STILL HERE, AND ON PURPOSE. Every `PayrollRecord` finalized before the
   * change was computed from it, and a bonus that has been paid has to stay
   * explicable — deleting the column would turn a run of real payslips into
   * figures nobody can account for. Nothing READS it for a new calculation:
   * `toPayrollEmployee` does not pass it to the engine, and the engine has no
   * field to receive it on.
   *
   * So it is shown on the profile as what it is — a record of what this person
   * used to be paid per hit — and the screen says where the live rate lives
   * instead. Editing it is still allowed, because correcting a historical figure
   * an old payslip references is a legitimate thing to want; it changes no
   * future run.
   */
  readonly hitPaymentMinor: number;
  readonly currency: string;
  readonly joinedOn: number | null;
  readonly employmentEndedOn: number | null;
  readonly notes: string | null;
  /** False when nobody has configured pay for this person yet. */
  readonly configured: boolean;
  readonly currentPeriod: EmployeePeriodEstimateDTO;
  readonly history: readonly EmployeePaymentDTO[];
}

export interface EmployeeProfileDTO {
  readonly account: EmployeeAccountDTO;
  readonly assignedNiches: readonly EmployeeNicheDTO[];
  readonly recentActivity: readonly AuditEntryDTO[];
  /** ABSENT — not null — for a caller without payroll.view. */
  readonly payroll?: EmployeePayrollDTO;
}

// ---------------------------------------------------------------------------
// ROW TYPES
// ---------------------------------------------------------------------------

/** The money columns of EmployeeProfile. Only ever populated behind payroll.view. */
export interface EmployeePayRow {
  readonly salaryMinor: number;
  readonly hitPaymentMinor: number;
  readonly currency: string;
  /** Admin-only free text. Never audited, never shown outside the payroll block. */
  readonly notes: string | null;
}

/** One member of the organization, with as much of their profile as was asked for. */
export interface EmployeeRecordRow {
  readonly memberId: string;
  readonly userId: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly role: string;
  readonly status: string;
  readonly deactivatedAt: Date | null;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
  readonly nicheIds: readonly string[];
  /** False when this person has no EmployeeProfile row at all — pay is unset, not zero. */
  readonly hasProfile: boolean;
  readonly joinedOn: Date | null;
  readonly employmentEndedOn: Date | null;
  /**
   * `null` means one of two different things, and the caller always knows
   * which: either no profile exists, or `includePay` was false and the columns
   * were never selected. Neither of them means "they earn nothing".
   */
  readonly pay: EmployeePayRow | null;
}

// ---------------------------------------------------------------------------
// SCHEMAS
// ---------------------------------------------------------------------------

/**
 * A generous ceiling that still refuses a pathological request.
 *
 * Nobody works across fifty niches; the cap exists so a malformed client cannot
 * ask us to write an unbounded number of rows in one transaction.
 */
const MAX_NICHE_ASSIGNMENTS = 50;

export const setEmployeeNichesSchema = z.object({
  nicheIds: z
    .array(z.string().trim().min(1))
    .max(MAX_NICHE_ASSIGNMENTS, "That is more niches than one person can be assigned to."),
});

/**
 * Money arrives as integer minor units and is validated as such.
 *
 * The client parses what the admin typed with `parseMoneyToMinor`, the same
 * function this server would use, so the wire format is already exact.
 * Rejecting a float rather than rounding it is deliberate: a request carrying
 * `1234.5` means the caller has a bug, and silently storing 1235 would hide
 * that bug inside somebody's salary.
 */
const minorAmountSchema = z
  .number()
  .int("Amounts must be whole minor units — cents, not fractions of a cent.")
  .min(0, "Pay cannot be negative.")
  .max(MAX_MONEY_MINOR, "That amount is larger than this system can store.");

const currencyFieldSchema = z
  .string()
  .trim()
  .transform(normalizeCurrencyCode)
  .refine(isSupportedCurrency, { message: "That is not a currency this app handles." });

/**
 * A date the admin picked, or `null` to clear it.
 *
 * Parsed to a `Date` here so the service never handles a string that might not
 * be one. `new Date("2026-08-01")` is UTC midnight, which is the clock the
 * payroll periods use — an employment date must not shift a month because the
 * browser was in Auckland.
 */
const dateFieldSchema = z.union([
  z
    .string()
    .trim()
    .min(1)
    .refine((value) => !Number.isNaN(new Date(value).getTime()), {
      message: "That is not a date we can read. Use YYYY-MM-DD.",
    })
    .transform((value) => new Date(value)),
  z.null(),
]);

/** Long enough for a real note, short enough that the column is not a document store. */
const MAX_NOTES_LENGTH = 2000;

export const updateEmployeePaySchema = z
  .object({
    salaryMinor: minorAmountSchema.optional(),
    hitPaymentMinor: minorAmountSchema.optional(),
    currency: currencyFieldSchema.optional(),
    joinedOn: dateFieldSchema.optional(),
    employmentEndedOn: dateFieldSchema.optional(),
    notes: z.union([z.string().trim().max(MAX_NOTES_LENGTH), z.null()]).optional(),
  })
  .refine(
    (value) =>
      value.salaryMinor !== undefined ||
      value.hitPaymentMinor !== undefined ||
      value.currency !== undefined ||
      value.joinedOn !== undefined ||
      value.employmentEndedOn !== undefined ||
      value.notes !== undefined,
    { message: "Nothing to change — send at least one field." },
  );

export type UpdateEmployeePayInput = z.infer<typeof updateEmployeePaySchema>;

/**
 * A ceiling on one batch, not a business rule.
 *
 * Each id in the list costs a compare-and-set, a session revocation and an
 * audit write, and they run one after another (see `runApprovalBatch`). Fifty
 * is comfortably more than any real onboarding wave and small enough that the
 * request cannot be turned into a way to hold a connection open. An admin with
 * more than fifty waiting can tick the next fifty.
 */
const MAX_BULK_APPROVALS = 50;

/** POST /api/admin/approvals/approve. */
export const bulkApprovalSchema = z.object({
  userIds: z
    .array(z.string().trim().min(1))
    .min(1, "Select at least one account.")
    .max(MAX_BULK_APPROVALS, `You can action ${MAX_BULK_APPROVALS} accounts at a time.`),
});

/** Long enough to say why, short enough that the audit metadata stays a log line. */
const MAX_DENIAL_REASON_LENGTH = 500;

/**
 * POST /api/admin/approvals/deny.
 *
 * The reason is optional and stays optional all the way down: it is a courtesy
 * to whoever reads the audit trail in six months, not a field to make somebody
 * fill in before they can close a queue. An empty string normalises to absent
 * so the log never carries `reason: ""`, which reads as "they gave a reason and
 * it was nothing".
 */
export const bulkDenialSchema = bulkApprovalSchema.extend({
  reason: z
    .string()
    .trim()
    .max(MAX_DENIAL_REASON_LENGTH, "That reason is longer than the log can keep.")
    .transform((value) => (value.length > 0 ? value : undefined))
    .optional(),
});

// ---------------------------------------------------------------------------
// READING MEMBERS AND THEIR PROFILES
// ---------------------------------------------------------------------------

/**
 * What an ordinary admin read of EmployeeProfile is entitled to.
 *
 * Employment dates only. `joinedOn` is roster information — the same class of
 * fact as a role or a job title, and the Employees table shows it to anyone who
 * can manage users. A salary is not, which is why the two column sets sit side
 * by side here: the difference between them is one glance rather than one grep.
 */
const EMPLOYMENT_COLUMNS = {
  userId: true,
  joinedOn: true,
  employmentEndedOn: true,
} as const;

/** The same, widened with the figures that require payroll.view. */
const PAY_COLUMNS = {
  ...EMPLOYMENT_COLUMNS,
  salaryMinor: true,
  hitPaymentMinor: true,
  currency: true,
  notes: true,
} as const;

const MEMBER_SELECT = {
  id: true,
  userId: true,
  role: true,
  niches: { select: { nicheId: true } },
  user: {
    select: {
      name: true,
      email: true,
      status: true,
      deactivatedAt: true,
      lastLoginAt: true,
      createdAt: true,
    },
  },
} as const;

/**
 * Everyone in the organization, or one person, with niches and profile.
 *
 * `organizationId` is a parameter rather than resolved from the session so a
 * caller without one — a scheduled job, a script — can use the identical read.
 * Every request-bound caller MUST source it from `getScope()`; taking it from a
 * body would make this a cross-tenant employee API.
 *
 * NOT AN AUTHORIZATION BOUNDARY. `includePay` decides which columns are
 * selected, not whether the caller is allowed them. The route decides that.
 */
export async function loadEmployeeRecords(
  organizationId: string,
  options: { includePay: boolean; userId?: string },
): Promise<EmployeeRecordRow[]> {
  const members = await prisma.organizationMember.findMany({
    where: {
      organizationId,
      ...(options.userId ? { userId: options.userId } : {}),
    },
    select: MEMBER_SELECT,
  });

  if (members.length === 0) return [];

  // Scoped on organizationId as well as userId. `EmployeeProfile.userId` is
  // globally unique, so an unscoped lookup would happily return the profile a
  // different organization wrote for the same person.
  const where = { organizationId, userId: { in: members.map((member) => member.userId) } };

  interface ProfileParts {
    readonly joinedOn: Date | null;
    readonly employmentEndedOn: Date | null;
    readonly pay: EmployeePayRow | null;
  }

  const profileByUser = new Map<string, ProfileParts>();

  // Two whole branches rather than one query with a conditional `select`,
  // because the difference has to be legible: in the second branch the money
  // columns are not in the projection, so they are never in this process's
  // memory and there is nothing anybody downstream could forget to strip.
  if (options.includePay) {
    for (const profile of await prisma.employeeProfile.findMany({
      where,
      select: PAY_COLUMNS,
    })) {
      profileByUser.set(profile.userId, {
        joinedOn: profile.joinedOn,
        employmentEndedOn: profile.employmentEndedOn,
        pay: {
          salaryMinor: profile.salaryMinor,
          hitPaymentMinor: profile.hitPaymentMinor,
          currency: profile.currency,
          notes: profile.notes,
        },
      });
    }
  } else {
    for (const profile of await prisma.employeeProfile.findMany({
      where,
      select: EMPLOYMENT_COLUMNS,
    })) {
      profileByUser.set(profile.userId, {
        joinedOn: profile.joinedOn,
        employmentEndedOn: profile.employmentEndedOn,
        pay: null,
      });
    }
  }

  return members.map((member) => {
    const profile = profileByUser.get(member.userId);
    return {
      memberId: member.id,
      userId: member.userId,
      name: member.user.name,
      email: member.user.email,
      role: member.role,
      status: member.user.status,
      deactivatedAt: member.user.deactivatedAt,
      lastLoginAt: member.user.lastLoginAt,
      createdAt: member.user.createdAt,
      nicheIds: member.niches.map((assignment) => assignment.nicheId),
      hasProfile: profile !== undefined,
      joinedOn: profile?.joinedOn ?? null,
      employmentEndedOn: profile?.employmentEndedOn ?? null,
      pay: profile?.pay ?? null,
    };
  });
}

/**
 * A record row in the shape the payroll engine consumes.
 *
 * Only meaningful for a row loaded with `includePay: true`. A row without pay
 * degrades to zeros rather than throwing, because the engine's answer for "no
 * rate configured" is already the right one — no salary, no bonus. Every caller
 * here is behind payroll.view, which is what keeps that fallback from ever
 * being mistaken for a figure.
 */
function toPayrollEmployee(
  row: EmployeeRecordRow,
  fallbackCurrency: string,
  /**
   * This person's frozen credits, from the same gatherer the payroll run uses.
   *
   * Passed in rather than looked up here, and never defaulted silently to an
   * empty list at the call site: this roster builds its own employee list
   * because it has to show people payroll does not, and if that list arrived
   * without the ledger the Employees screen would count a Short somebody was
   * already paid for while the Payroll screen correctly refused to. Two screens
   * disagreeing about one figure is the failure this whole arrangement is
   * built to avoid.
   *
   * Empty for a roster row with no employee profile, who has no rate and can
   * therefore earn no bonus for the engine to guard against.
   */
  alreadyPaidVideoIds: readonly string[],
): PayrollEmployee {
  return {
    userId: row.userId,
    // A payroll line with a blank name is unreadable, and the account is
    // guaranteed to carry at least one of these.
    name: row.name ?? row.email ?? row.userId,
    email: row.email ?? "",
    role: row.role,
    salaryMinor: row.pay?.salaryMinor ?? 0,
    // `row.pay.hitPaymentMinor` IS DELIBERATELY NOT PASSED. The per-hit rate
    // moved to the niche and the engine has no field to receive this one on —
    // see `PayrollEmployee`. The column is still read for the profile screen,
    // where it explains finalized records that were computed from it; it is
    // simply not an input to a new calculation any more.
    currency: row.pay?.currency ?? fallbackCurrency,
    nicheIds: row.nicheIds,
    joinedOnMs: row.joinedOn?.getTime() ?? null,
    employmentEndedOnMs: row.employmentEndedOn?.getTime() ?? null,
    alreadyPaidVideoIds,
  };
}

// ---------------------------------------------------------------------------
// SHARED HELPERS
// ---------------------------------------------------------------------------

function displayName(row: { name: string | null; email: string | null; userId: string }): string {
  return row.name ?? row.email ?? row.userId;
}

/** Most privileged first, then alphabetical — how an admin reads a team list. */
function compareEmployees(a: EmployeeRecordRow, b: EmployeeRecordRow): number {
  const rank = (role: string): number => {
    const index = (ROLE_ORDER as readonly string[]).indexOf(role);
    // An unrecognised role sorts last: a stale or hand-edited value must never
    // be presented as the most senior person in the room.
    return index === -1 ? ROLE_ORDER.length : index;
  };

  const byRole = rank(a.role) - rank(b.role);
  if (byRole !== 0) return byRole;
  return displayName(a).localeCompare(displayName(b));
}

interface NicheChip {
  readonly id: string;
  readonly name: string;
  readonly colorIndex: number;
  readonly kind: NicheKind;
}

/**
 * The organization's niches, for display.
 *
 * A separate read from the one `loadPayrollInputs` does, because they want
 * different columns for different reasons: payroll needs the canonical
 * `hitThreshold` and nothing else, this needs the chip's accent index and
 * nothing else. Sharing one query would mean shipping a threshold to a screen
 * that does not use it, or a colour into a calculation that must not depend on
 * one.
 */
async function loadNicheChips(organizationId: string): Promise<Map<string, NicheChip>> {
  const rows = await prisma.niche.findMany({
    where: { organizationId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, colorIndex: true, kind: true },
  });
  return new Map(
    rows.map((row) => [row.id, { ...row, kind: toNicheKind(row.kind) }] as const),
  );
}

function toNicheDTOs(
  nicheIds: readonly string[],
  nicheById: ReadonlyMap<string, NicheChip>,
): EmployeeNicheDTO[] {
  return nicheIds
    .map((id) => nicheById.get(id))
    .filter((niche): niche is NicheChip => niche !== undefined)
    .map((niche) => ({
      id: niche.id,
      name: niche.name,
      colorIndex: niche.colorIndex,
      kind: niche.kind,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The invitation an account came in through, as far as it can be reconstructed. */
interface InvitationContext {
  readonly invitedAt: Date;
  /** Set once the person has accepted and chosen a password. */
  readonly acceptedAt: Date | null;
  /** The admin who sent it, or null if that account has since been deleted. */
  readonly invitedBy: string | null;
}

/**
 * The invitation behind each of these addresses, if a row survives.
 *
 * Matched on email rather than on a foreign key because that is the only link
 * there is: an `Invitation` is consumed into an `AppUser` at acceptance and
 * never points back. Addresses are normalised to lowercase on both sides — see
 * `normalizeEmail` in auth-service — so a plain `in` is a real match.
 *
 * ONE QUERY, TWO READERS. The Employees table wants only "when were they
 * invited"; the approvals queue wants when they accepted and who invited them,
 * because those are the two facts an admin uses to decide. Selecting all three
 * here rather than writing a second, nearly identical query is what stops the
 * two screens from disagreeing about which invitation a re-invited address
 * came in on.
 */
async function loadInvitationContext(
  organizationId: string,
  emails: readonly string[],
): Promise<Map<string, InvitationContext>> {
  const wanted = emails.filter((email) => email.length > 0);
  if (wanted.length === 0) return new Map();

  const rows = await prisma.invitation.findMany({
    where: { organizationId, email: { in: wanted } },
    // Ascending, so a re-invited address ends up mapped to its most recent
    // invitation rather than the first one anybody ever sent.
    orderBy: { createdAt: "asc" },
    select: {
      email: true,
      createdAt: true,
      acceptedAt: true,
      // The inviter's name, or their address if they never set one. Not the
      // whole user row — this is a label to print, and nothing else on that
      // record belongs on a screen about somebody else's account.
      createdBy: { select: { name: true, email: true } },
    },
  });

  const byEmail = new Map<string, InvitationContext>();
  for (const row of rows) {
    byEmail.set(row.email, {
      invitedAt: row.createdAt,
      acceptedAt: row.acceptedAt,
      invitedBy: row.createdBy?.name ?? row.createdBy?.email ?? null,
    });
  }
  return byEmail;
}

/** The `invitedAt` column of the Employees table, narrowed from the read above. */
async function loadInvitedAt(
  organizationId: string,
  emails: readonly string[],
): Promise<Map<string, Date>> {
  const context = await loadInvitationContext(organizationId, emails);
  return new Map([...context].map(([email, row]) => [email, row.invitedAt]));
}

/**
 * One person's figure for the current period, from whichever source is
 * authoritative for it.
 *
 * Deliberately not `PayrollCalculation`: that type is the engine's output and
 * cannot describe a stored record, which carries an adjustment the engine knows
 * nothing about. A shape both branches can fill is what lets the two callers
 * below stay identical whether the month is live or frozen.
 */
interface CurrentPeriodFigure {
  readonly hitCount: number;
  readonly baseSalaryMinor: number;
  readonly hitBonusMinor: number;
  readonly adjustmentMinor: number;
  readonly totalMinor: number;
  readonly byNiche: readonly EmployeeNicheBonusDTO[];
}

interface CurrentPeriodEstimates {
  readonly period: PayrollPeriodWindow;
  /** False when the period is frozen and these are the stored records. */
  readonly isDraft: boolean;
  /** Populated for every row that was asked about, in both branches. */
  readonly byUserId: ReadonlyMap<string, CurrentPeriodFigure>;
}

/** "finalized" and "paid" both mean the figures are stored, not derived. */
function isFrozenStatus(status: string): boolean {
  return status === "finalized" || status === "paid";
}

/**
 * The current month's figures for these people — read if frozen, calculated if
 * not.
 *
 * WHY THE PERIOD ROW IS LOADED FIRST, AND WHY THAT IS THE WHOLE POINT
 * `finalizePeriod` accepts `force`, so the month in progress can legitimately
 * be frozen: "pay everyone out early, we are closing the books" is a real
 * instruction. From that moment the PayrollRecord is what gets paid, and
 * payroll-service refuses to recompute it — a Short crossing a million views
 * tomorrow must not change what was already settled. This function used to
 * recalculate unconditionally, which meant the Employees screens showed a live
 * figure beside a Payroll page showing the frozen one, with nothing to say
 * which was binding. Same rule, one branch, in the same place payroll-service
 * puts it.
 *
 * THE LIVE BRANCH FETCHES ITS INPUTS ONCE
 * The Shorts and the niches — each carrying its own threshold, or the null that
 * means it has none — come from the shared gatherer in payroll-data.ts and are
 * reused for everybody. Two reasons, both structural:
 * the same Short can pay two different people, so a per-employee query would be
 * an N+1; and if the estimate used a different query from the finalized run,
 * the number an admin saw on Tuesday and the number they paid on the 1st could
 * differ for reasons nobody could reconstruct.
 *
 * `loadPayrollInputs` also returns its own employee list, assembled for the
 * payroll run. It is deliberately ignored here: that list contains only people
 * with an EmployeeProfile, whereas this screen is a roster and must show a row
 * for everybody — including the new hire whose pay nobody has set up yet.
 *
 * Only ever called behind payroll.view.
 */
async function estimateCurrentPeriod(
  organizationId: string,
  rows: readonly EmployeeRecordRow[],
  fallbackCurrency: string,
): Promise<CurrentPeriodEstimates> {
  const period = periodContaining(Date.now());

  const stored = await loadFrozenPeriodFigures(organizationId, period, rows);
  if (stored) return { period, isDraft: false, byUserId: stored };

  const { niches, shorts, employees } = await loadPayrollInputs(organizationId, period);

  // The one thing this roster DOES take from the gatherer's employee list. The
  // rest of that list is ignored on purpose — see above — but the frozen
  // credits are per person and cannot be reconstructed from a roster row, and
  // an estimate computed without them would credit a Short the payroll run
  // refuses to pay twice.
  const alreadyPaidByUserId = new Map(
    employees.map((employee) => [employee.userId, employee.alreadyPaidVideoIds]),
  );

  const nowMs = Date.now();
  const byUserId = new Map<string, CurrentPeriodFigure>();
  for (const row of rows) {
    const calculation = calculateEmployeePayroll({
      employee: toPayrollEmployee(
        row,
        fallbackCurrency,
        alreadyPaidByUserId.get(row.userId) ?? [],
      ),
      shorts,
      niches,
      period,
      // One clock for the whole roster. Sampled per employee, two people could
      // straddle a window's close and disagree about whether the same Short is
      // still pending.
      nowMs,
    });

    byUserId.set(row.userId, {
      hitCount: calculation.hitCount,
      baseSalaryMinor: calculation.baseSalaryMinor,
      hitBonusMinor: calculation.hitBonusMinor,
      // A draft has no adjustment by definition: an adjustment corrects a
      // frozen figure, and nothing here is frozen yet. The same sentence
      // `toDraftRecordDTO` in payroll-service writes, for the same reason.
      adjustmentMinor: 0,
      totalMinor: calculation.totalMinor,
      byNiche: calculation.byNiche.map((bucket) => ({
        nicheId: bucket.nicheId,
        nicheName: bucket.nicheName,
        thresholdApplied: bucket.thresholdApplied,
        // The engine just computed it, so the draft line can state the whole
        // rule. The frozen branch below cannot — see the field's own note.
        windowHoursApplied: bucket.windowHoursApplied,
        hitCount: bucket.hitCount,
        // Straight off the engine's line: a draft was computed from the niches
        // as they stand right now, so there is nothing to recover.
        hitPaymentMinor: bucket.hitPaymentMinor,
        bonusMinor: bucket.bonusMinor,
      })),
    });
  }

  return { period, isDraft: true, byUserId };
}

/**
 * The stored records for a frozen current period, or null if it is still open.
 *
 * Null — rather than an empty map — is what tells the caller to run the engine.
 * A frozen period with no records for these people is a different fact from an
 * open one, and collapsing them would send a finalized month back through a
 * recalculation.
 *
 * EVERY REQUESTED ROW GETS AN ENTRY, INCLUDING PEOPLE WHO ARE NOT ON THE RUN.
 * Somebody hired after the month was finalized has no PayrollRecord in it, and
 * the honest reading of that is not "we have not worked it out yet" but "the
 * frozen run has no line for them" — which is zero, and stays zero until an
 * admin re-finalizes. Seeding the map is also what keeps the profile read's
 * "estimate missing" check genuinely unreachable rather than newly reachable.
 *
 * Cheaper than the branch it replaces: this reads one period row, one record
 * per employee and their stored hits, where the live branch reads every Short
 * published in the month.
 */
async function loadFrozenPeriodFigures(
  organizationId: string,
  period: PayrollPeriodWindow,
  rows: readonly EmployeeRecordRow[],
): Promise<ReadonlyMap<string, CurrentPeriodFigure> | null> {
  const periodRow = await prisma.payrollPeriod.findUnique({
    where: {
      organizationId_year_month: {
        organizationId,
        year: period.year,
        month: period.month,
      },
    },
    select: { id: true, status: true },
  });

  // No row at all reads as open — the same reading payroll-service gives it —
  // and an unrecognised status reads as open too, because a stale string must
  // never be mistaken for a frozen document.
  if (!periodRow || !isFrozenStatus(periodRow.status)) return null;

  const userIds = rows.map((row) => row.userId);

  const records = await prisma.payrollRecord.findMany({
    where: { periodId: periodRow.id, userId: { in: userIds } },
    select: {
      userId: true,
      hitCount: true,
      baseSalaryMinor: true,
      hitPaymentMinor: true,
      hitBonusMinor: true,
      adjustmentMinor: true,
      totalMinor: true,
      // The evidence, not a second stored summary. Grouping these is how the
      // per-niche lines are rebuilt, so they cannot drift from the hits that
      // justify them — see `groupStoredHits`.
      hits: { select: { nicheId: true, nicheName: true, thresholdAtRun: true } },
    },
  });

  const byUserId = new Map<string, CurrentPeriodFigure>();
  for (const userId of userIds) {
    byUserId.set(userId, {
      hitCount: 0,
      baseSalaryMinor: 0,
      hitBonusMinor: 0,
      adjustmentMinor: 0,
      totalMinor: 0,
      byNiche: [],
    });
  }

  for (const record of records) {
    byUserId.set(record.userId, {
      hitCount: record.hitCount,
      baseSalaryMinor: record.baseSalaryMinor,
      hitBonusMinor: record.hitBonusMinor,
      adjustmentMinor: record.adjustmentMinor,
      totalMinor: record.totalMinor,
      byNiche: groupStoredHits(record.hits, record.hitPaymentMinor),
    });
  }

  return byUserId;
}

/**
 * Per-niche lines from a frozen record's stored hits.
 *
 * Mirrors `groupHitsByNiche` in payroll-service — same key, same ordering — so
 * a person's profile and the Payroll page describe one frozen month the same
 * way. The name is the fallback key because a stored hit's `nicheId` can be
 * null once the niche is deleted, and two hits credited to a since-deleted
 * "GTA" still belong on one line.
 *
 * The rate comes from the RECORD, not from today's EmployeeProfile and not from
 * today's niches: a hit payment raised in September must not rewrite what
 * August's bonus was made of.
 *
 * A RECORD PAID AT SEVERAL RATES CANNOT STATE THEM HERE, and says so. The rate
 * lives on the niche now, `PayrollRecord` has one rate column, and it holds 0
 * when the month's hits spanned more than one price. The payroll detail screen
 * recovers the individual prices — with a guard that they still add up to what
 * was paid — because that is where a bonus gets audited; this card shows the
 * counts and leaves the money to the total above them.
 */
function groupStoredHits(
  hits: readonly { nicheId: string | null; nicheName: string; thresholdAtRun: number }[],
  hitPaymentMinor: number,
): EmployeeNicheBonusDTO[] {
  const buckets = new Map<
    string,
    { nicheId: string | null; nicheName: string; thresholdApplied: number; hitCount: number }
  >();

  for (const hit of hits) {
    const key = hit.nicheId ?? `name:${hit.nicheName}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.hitCount += 1;
    } else {
      buckets.set(key, {
        nicheId: hit.nicheId,
        nicheName: hit.nicheName,
        thresholdApplied: hit.thresholdAtRun,
        hitCount: 1,
      });
    }
  }

  return [...buckets.values()]
    .map((bucket) => ({
      nicheId: bucket.nicheId,
      nicheName: bucket.nicheName,
      thresholdApplied: bucket.thresholdApplied,
      // Not recoverable from a PayrollHit row, and deliberately not fetched
      // here — see the field's note on `EmployeeNicheBonusDTO`. The payroll
      // detail screen is where a frozen bonus gets explained in full.
      windowHoursApplied: null,
      hitCount: bucket.hitCount,
      // 0 on the record means "several rates", not "free" — see the note above.
      hitPaymentMinor: hitPaymentMinor > 0 ? hitPaymentMinor : null,
      bonusMinor: hitPaymentMinor > 0 ? bucket.hitCount * hitPaymentMinor : null,
    }))
    // Unpriced lines last rather than as zeroes: an unknown amount is not a
    // small one.
    .sort(
      (a, b) =>
        (b.bonusMinor ?? -1) - (a.bonusMinor ?? -1) || a.nicheName.localeCompare(b.nicheName),
    );
}

function toPeriodEstimateDTO(
  period: PayrollPeriodWindow,
  figure: CurrentPeriodFigure,
  isDraft: boolean,
): EmployeePeriodEstimateDTO {
  return {
    year: period.year,
    month: period.month,
    label: periodLabel(period),
    startsAt: period.startsAtMs,
    endsAt: period.endsAtMs,
    payOn: payDateFor(period),
    hitCount: figure.hitCount,
    baseSalaryMinor: figure.baseSalaryMinor,
    hitBonusMinor: figure.hitBonusMinor,
    adjustmentMinor: figure.adjustmentMinor,
    totalMinor: figure.totalMinor,
    isDraft,
    byNiche: figure.byNiche,
  };
}

/**
 * The membership for a target id, or a 404.
 *
 * Scoped on organization, always. An id in a URL is a guess until it is proven
 * to belong to the caller's workspace, and `findUnique` on the id alone is how
 * a guess becomes a cross-tenant edit.
 */
async function requireMember(
  organizationId: string,
  userId: string,
): Promise<{
  memberId: string;
  role: string;
  name: string | null;
  email: string | null;
  status: string;
}> {
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: {
      id: true,
      role: true,
      user: { select: { name: true, email: true, status: true } },
    },
  });
  if (!member) throw errors.notFound("employee");

  return {
    memberId: member.id,
    role: member.role,
    name: member.user.name,
    email: member.user.email,
    status: member.user.status,
  };
}

// ---------------------------------------------------------------------------
// READ: the Employees table
// ---------------------------------------------------------------------------

export async function listEmployees(options: {
  includePay: boolean;
}): Promise<EmployeeListItemDTO[]> {
  const { organizationId } = await getScope();

  const rows = await loadEmployeeRecords(organizationId, { includePay: options.includePay });

  const [nicheById, invitedAt] = await Promise.all([
    loadNicheChips(organizationId),
    loadInvitedAt(
      organizationId,
      rows.map((row) => row.email ?? ""),
    ),
  ]);

  // The estimate is the expensive part — every Short published this month — so
  // it is not computed at all for a caller who would not be shown it.
  let estimates: CurrentPeriodEstimates | null = null;
  let fallbackCurrency = "USD";
  if (options.includePay) {
    // The organization's reporting currency, used for anybody whose own pay has
    // not been configured yet. Labelling an unset rate in a currency the team
    // does not use would be a worse guess than the one they chose in settings.
    fallbackCurrency = (await getCurrentOrgSettings()).baseCurrency;
    estimates = await estimateCurrentPeriod(organizationId, rows, fallbackCurrency);
  }

  return [...rows].sort(compareEmployees).map((row) => {
    const base: EmployeeListItemDTO = {
      userId: row.userId,
      name: row.name,
      email: row.email,
      role: row.role,
      roleLabel: roleDefinition(row.role).label,
      status: row.status,
      assignedNiches: toNicheDTOs(row.nicheIds, nicheById),
      joinedOn: row.joinedOn?.getTime() ?? null,
      lastLoginAt: row.lastLoginAt?.getTime() ?? null,
      invitedAt: invitedAt.get(row.email ?? "")?.getTime() ?? null,
    };

    // Spread-in rather than assigned: without payroll.view the `pay` key is not
    // on the object at all, so it cannot appear in the JSON as `null`.
    if (!estimates) return base;

    const figure = estimates.byUserId.get(row.userId);
    return {
      ...base,
      pay: {
        salaryMinor: row.pay?.salaryMinor ?? 0,
        hitPaymentMinor: row.pay?.hitPaymentMinor ?? 0,
        currency: row.pay?.currency ?? fallbackCurrency,
        estimatedPayMinor: figure?.totalMinor ?? 0,
        // A period-wide fact repeated on every row, on purpose: the flag has to
        // travel with the figure it qualifies, or a caller can render the
        // number without it.
        isDraft: estimates.isDraft,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// READ: the approvals queue
// ---------------------------------------------------------------------------

/**
 * Everybody waiting behind the approval gate.
 *
 * A separate read from `listEmployees` rather than a filter over it, and the
 * reason is cost rather than tidiness: the roster computes a live payroll
 * estimate for every person on it — every Short published this month — and this
 * queue needs none of that. Filtering the roster down to the pending rows would
 * pay the whole bill to throw most of it away, on the one screen an admin is
 * meant to be able to open, glance at and clear.
 *
 * OLDEST WAIT FIRST. Not by role, the way the roster sorts: this is a queue, and
 * the person who has been unable to sign in the longest is the one whose day is
 * being held up. Anybody whose acceptance date is unknown sorts to the bottom
 * rather than to the top — an absent date is not evidence of a long wait.
 */
export async function listPendingApprovals(): Promise<PendingApprovalDTO[]> {
  const { organizationId } = await getScope();

  const members = await prisma.organizationMember.findMany({
    // Filtered in the database, not in this process. A queue is normally a
    // handful of rows out of a whole workspace, and `pending_approval` is the
    // one status this screen exists for.
    where: { organizationId, user: { status: "pending_approval" } },
    select: {
      userId: true,
      role: true,
      niches: { select: { nicheId: true } },
      user: { select: { name: true, email: true } },
    },
  });

  if (members.length === 0) return [];

  const [nicheById, invitations] = await Promise.all([
    loadNicheChips(organizationId),
    loadInvitationContext(
      organizationId,
      members.map((member) => member.user.email ?? ""),
    ),
  ]);

  return members
    .map((member) => {
      const invitation = invitations.get(member.user.email ?? "");
      return {
        userId: member.userId,
        name: member.user.name,
        email: member.user.email,
        role: member.role,
        roleLabel: roleDefinition(member.role).label,
        assignedNiches: toNicheDTOs(
          member.niches.map((niche) => niche.nicheId),
          nicheById,
        ),
        acceptedAt: invitation?.acceptedAt?.getTime() ?? null,
        invitedAt: invitation?.invitedAt.getTime() ?? null,
        invitedBy: invitation?.invitedBy ?? null,
      } satisfies PendingApprovalDTO;
    })
    .sort((a, b) => {
      // Number.MAX_SAFE_INTEGER, not 0: an unknown acceptance date has to sort
      // *last*, and treating null as the epoch would put it first — presenting
      // the row we know least about as the most urgent one on the screen.
      const waitA = a.acceptedAt ?? Number.MAX_SAFE_INTEGER;
      const waitB = b.acceptedAt ?? Number.MAX_SAFE_INTEGER;
      if (waitA !== waitB) return waitA - waitB;
      return displayName(a).localeCompare(displayName(b));
    });
}

// ---------------------------------------------------------------------------
// READ: one person's profile
// ---------------------------------------------------------------------------

/**
 * Audit actions worth showing on somebody's profile.
 *
 * An allow-list rather than "everything they touched", for the reason stated at
 * the top of src/lib/audit/actions.ts: a feed of every row a colleague appears
 * in is employee monitoring wearing a profile page's clothes. These are the
 * entries that describe work and access — what they changed about the team's
 * data, and what happened to their own account.
 *
 * `auth.*` is excluded on purpose. Sign-ins are recorded so a security incident
 * can be investigated, not so a manager can read them as attendance.
 *
 * `finance.*` and `payroll.*` are excluded because they are gated by different
 * permissions; surfacing them here would let a users.manage admin read finance
 * activity through the side door.
 *
 * Notes and generated reports are named in the brief for this screen but are
 * not audited anywhere yet — nothing writes a `note.*` or `report.*` key. When
 * something does, adding the keys here is the only change needed.
 */
const PROFILE_ACTIVITY_ACTIONS: readonly AuditAction[] = [
  "user.invitation_accepted",
  "user.invited",
  "user.role_changed",
  "user.permission_granted",
  "user.permission_revoked",
  // Letting somebody in is `employee.approved` and nothing else. The Users
  // screen cannot reach that end state any more — `updateMember` refuses
  // pending_approval -> active and says to use the Employees screen — so there
  // is one key to look for rather than two that mean the same thing.
  //
  // `user.reactivated` stays because it is a different event: an account that
  // HAD access, lost it, and got it back. Reading that as an approval is
  // exactly the confusion the single path was introduced to end.
  "user.reactivated",
  "employee.approved",
  "employee.rejected",
  "employee.niches_updated",
  "channel.added",
  "channel.removed",
  "channel.restored",
  "channel.renamed",
  "channel.ownership_changed",
  "niche.created",
  "niche.updated",
  "niche.deleted",
  "niche.threshold_changed",
  "youtube.connected",
  "youtube.disconnected",
  "youtube.reauthorized",
  "sync.triggered",
];

/** How many activity rows a profile shows. */
const PROFILE_ACTIVITY_LIMIT = 12;

/**
 * Scanned wider than it is shown, because the filter above discards rows.
 *
 * Asking for twelve and keeping the four that survive would make an active
 * person's profile look empty.
 */
const PROFILE_ACTIVITY_SCAN = 120;

async function loadProfileActivity(
  organizationId: string,
  userId: string,
  includePay: boolean,
): Promise<AuditEntryDTO[]> {
  // ONE ANSWER, USED TWICE. Whether this reader may see the amounts decides
  // both whether the pay entry appears at all and whether it arrives with its
  // figures — and the two must not be able to disagree. They did: the
  // allow-list widened on `includePay` while `listAuditEvents` was called
  // without a money-access flag, which defaults to none, so `stripMoneyKeys`
  // emptied the very entry the branch exists to show. A payroll.view admin read
  // a salary change with no salary in it here, and the same change with its
  // figures through /api/admin/audit.
  //
  // `payroll.view` is resolved from the SESSION, exactly as that route resolves
  // it — never from a parameter, so nothing a caller supplies can turn the
  // redaction off. It is AND-ed with `includePay` rather than replacing it: the
  // route already resolved the same permission the same way, and keeping both
  // means this can only ever narrow what the old code showed.
  const seesAmounts = includePay && (await actorCan("payroll.view"));

  const allowed = new Set<string>(PROFILE_ACTIVITY_ACTIONS);
  // `employee.pay_updated` carries the amounts in its metadata — see the note
  // on `updateEmployeePay`. It belongs on an admin's timeline, but only for a
  // reader already entitled to the figures; this feed must not become the back
  // door into payroll.
  if (seesAmounts) allowed.add("employee.pay_updated");

  const page = await listAuditEvents({
    organizationId,
    actorUserId: userId,
    limit: PROFILE_ACTIVITY_SCAN,
    // `finance.view` is deliberately false rather than resolved. Nothing under
    // `finance.` is on `PROFILE_ACTIVITY_ACTIONS`, so no finance figure can
    // reach this feed to be unlocked — and asking for a permission this read
    // has no use for is how the single "may see money" flag became a key to
    // two different ledgers in the first place.
    moneyAccess: { "payroll.view": seesAmounts, "finance.view": false },
  });

  return page.entries
    .filter((entry) => allowed.has(entry.action))
    .slice(0, PROFILE_ACTIVITY_LIMIT);
}

/** How many past periods a profile shows. Two years of monthly runs. */
const PAYMENT_HISTORY_LIMIT = 24;

async function loadPaymentHistory(
  organizationId: string,
  userId: string,
): Promise<EmployeePaymentDTO[]> {
  const rows = await prisma.payrollRecord.findMany({
    // `PayrollRecord.userId` is deliberately not a foreign key — see the note
    // in the schema — so the organization filter has to travel through the
    // period. Without it this would read every workspace's payslips for a
    // person who happens to belong to two.
    where: { userId, period: { organizationId } },
    orderBy: [{ period: { year: "desc" } }, { period: { month: "desc" } }],
    take: PAYMENT_HISTORY_LIMIT,
    select: {
      periodId: true,
      baseSalaryMinor: true,
      hitPaymentMinor: true,
      hitCount: true,
      hitBonusMinor: true,
      adjustmentMinor: true,
      adjustmentReason: true,
      totalMinor: true,
      currency: true,
      paymentStatus: true,
      paidAt: true,
      period: { select: { year: true, month: true, status: true, payOn: true } },
    },
  });

  return rows.map((row) => ({
    periodId: row.periodId,
    year: row.period.year,
    month: row.period.month,
    label: periodLabel(periodForMonth(row.period.year, row.period.month)),
    payOn: row.period.payOn.getTime(),
    periodStatus: row.period.status,
    baseSalaryMinor: row.baseSalaryMinor,
    hitPaymentMinor: row.hitPaymentMinor,
    hitCount: row.hitCount,
    hitBonusMinor: row.hitBonusMinor,
    adjustmentMinor: row.adjustmentMinor,
    adjustmentReason: row.adjustmentReason,
    totalMinor: row.totalMinor,
    currency: row.currency,
    paymentStatus: row.paymentStatus,
    paidAt: row.paidAt?.getTime() ?? null,
  }));
}

export async function getEmployeeProfile(
  userId: string,
  options: { includePay: boolean },
): Promise<EmployeeProfileDTO> {
  const { organizationId, userId: selfUserId } = await getScope();

  const [row] = await loadEmployeeRecords(organizationId, {
    includePay: options.includePay,
    userId,
  });
  if (!row) throw errors.notFound("employee");

  const [nicheById, invitedAt, recentActivity] = await Promise.all([
    loadNicheChips(organizationId),
    loadInvitedAt(organizationId, [row.email ?? ""]),
    loadProfileActivity(organizationId, userId, options.includePay),
  ]);

  const profile: EmployeeProfileDTO = {
    account: {
      userId: row.userId,
      name: row.name,
      email: row.email,
      role: row.role,
      roleLabel: roleDefinition(row.role).label,
      status: row.status,
      createdAt: row.createdAt.getTime(),
      lastLoginAt: row.lastLoginAt?.getTime() ?? null,
      invitedAt: invitedAt.get(row.email ?? "")?.getTime() ?? null,
      deactivatedAt: row.deactivatedAt?.getTime() ?? null,
      joinedOn: row.joinedOn?.getTime() ?? null,
      employmentEndedOn: row.employmentEndedOn?.getTime() ?? null,
      isSelf: row.userId === selfUserId,
    },
    assignedNiches: toNicheDTOs(row.nicheIds, nicheById),
    recentActivity,
  };

  if (!options.includePay) return profile;

  const settings = await getCurrentOrgSettings();
  const [estimates, history] = await Promise.all([
    estimateCurrentPeriod(organizationId, [row], settings.baseCurrency),
    loadPaymentHistory(organizationId, userId),
  ]);

  const figure = estimates.byUserId.get(row.userId);
  // Unreachable — both branches of `estimateCurrentPeriod` fill an entry for
  // every row they are given, including a frozen period with no record for this
  // person — but the figure is the point of the block, so a missing one is a bug
  // worth naming rather than a zero worth showing.
  if (!figure) throw errors.internal("payroll estimate missing for employee");

  return {
    ...profile,
    payroll: {
      salaryMinor: row.pay?.salaryMinor ?? 0,
      hitPaymentMinor: row.pay?.hitPaymentMinor ?? 0,
      currency: row.pay?.currency ?? settings.baseCurrency,
      joinedOn: row.joinedOn?.getTime() ?? null,
      employmentEndedOn: row.employmentEndedOn?.getTime() ?? null,
      notes: row.pay?.notes ?? null,
      configured: row.hasProfile,
      currentPeriod: toPeriodEstimateDTO(estimates.period, figure, estimates.isDraft),
      history,
    },
  };
}

// ---------------------------------------------------------------------------
// WRITE: niche assignment
// ---------------------------------------------------------------------------

export interface SetEmployeeNichesResult {
  readonly userId: string;
  readonly assignedNiches: readonly EmployeeNicheDTO[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/**
 * Replaces this person's niche assignments with exactly this set.
 *
 * A replace rather than add/remove pairs, for the same reason the permission
 * grants are: the UI is a checklist, so the honest request is "these are the
 * boxes that are ticked". Sending deltas from a checklist lets two in-flight
 * edits each apply half of what the admin saw.
 *
 * This is not a display setting. A niche-scoped role sees the channels in its
 * assigned niches and nothing else, and payroll pays bonuses only for hits
 * inside them — so one write moves both what somebody can read and what they
 * are owed. That is why the diff is audited rather than the result.
 */
export async function setEmployeeNiches(
  userId: string,
  nicheIds: readonly string[],
  request: Request,
): Promise<SetEmployeeNichesResult> {
  const { organizationId, actor } = await getScope();

  const member = await requireMember(organizationId, userId);

  // Deduplicated before validation, so a client that sends the same id twice
  // gets one assignment rather than a unique-constraint error.
  const desired = [...new Set(nicheIds)];

  // Every id is proven to belong to THIS organization. A niche id from another
  // workspace would otherwise create a MemberNiche row pointing across the
  // tenant boundary — and that row is what a payroll bonus is calculated from.
  const known = await prisma.niche.findMany({
    where: { organizationId, id: { in: desired } },
    select: { id: true, name: true, colorIndex: true, kind: true },
  });

  if (known.length !== desired.length) {
    throw errors.invalidInput("One of those niches does not exist in this workspace.");
  }

  const nameById = new Map(known.map((niche) => [niche.id, niche.name]));

  const existing = await prisma.memberNiche.findMany({
    where: { memberId: member.memberId },
    select: { nicheId: true, niche: { select: { name: true } } },
  });

  const current = new Set(existing.map((assignment) => assignment.nicheId));
  const desiredSet = new Set(desired);

  const addedIds = desired.filter((id) => !current.has(id));
  const removedIds = [...current].filter((id) => !desiredSet.has(id));

  if (addedIds.length > 0 || removedIds.length > 0) {
    await prisma.$transaction(async (tx) => {
      if (removedIds.length > 0) {
        await tx.memberNiche.deleteMany({
          where: { memberId: member.memberId, nicheId: { in: removedIds } },
        });
      }
      if (addedIds.length > 0) {
        await tx.memberNiche.createMany({
          data: addedIds.map((nicheId) => ({
            memberId: member.memberId,
            nicheId,
            // Who put this person on this niche, kept on the row so the answer
            // survives the audit retention window.
            assignedById: actor.userId,
          })),
        });
      }
    });
  }

  const label = displayName({ name: member.name, email: member.email, userId });
  const addedNames = addedIds.map((id) => nameById.get(id) ?? id).sort();
  const removedNames = removedIds
    .map((id) => existing.find((row) => row.nicheId === id)?.niche.name ?? id)
    .sort();

  if (addedNames.length > 0 || removedNames.length > 0) {
    // One entry, not two. Unlike a permission grant, an assignment change reads
    // as a single decision — "moved from GTA to Finance" — and splitting it
    // would make the reader reassemble it from two adjacent rows.
    const parts: string[] = [];
    if (addedNames.length > 0) parts.push(`added ${addedNames.join(", ")}`);
    if (removedNames.length > 0) parts.push(`removed ${removedNames.join(", ")}`);

    await recordAudit(
      {
        organizationId,
        actorUserId: actor.userId,
        actorLabel: actor.name ?? actor.email,
        request,
      },
      {
        action: "employee.niches_updated",
        summary: `Niches for ${label}: ${parts.join("; ")}`,
        targetType: "user",
        targetId: userId,
        targetLabel: label,
        metadata: { added: addedNames, removed: removedNames, total: desired.length },
      },
    );
  }

  return {
    userId,
    assignedNiches: known
      .map((niche) => ({
        id: niche.id,
        name: niche.name,
        colorIndex: niche.colorIndex,
        // Narrowed at the boundary, like every other read of this column.
        kind: toNicheKind(niche.kind),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    added: addedNames,
    removed: removedNames,
  };
}

// ---------------------------------------------------------------------------
// WRITE: pay configuration
// ---------------------------------------------------------------------------

export interface UpdateEmployeePayResult {
  readonly userId: string;
  readonly salaryMinor: number;
  readonly hitPaymentMinor: number;
  readonly currency: string;
  readonly joinedOn: number | null;
  readonly employmentEndedOn: number | null;
  readonly notes: string | null;
}

/**
 * Creates or updates this person's EmployeeProfile.
 *
 * REQUIRES payroll.manage, CHECKED TWICE.
 * The route checks it first, as every route does. This re-checks because it is
 * the one function in the codebase that writes a salary, and the second check
 * costs a memoised session read: `getActor` is wrapped in React's `cache()`, so
 * within a request it is free. If a future caller reaches this from somewhere
 * that is not a route — a server action, a job, a script — the guard travels
 * with the write rather than with the URL.
 */
export async function updateEmployeePay(
  userId: string,
  input: UpdateEmployeePayInput,
  request: Request,
): Promise<UpdateEmployeePayResult> {
  if (!(await actorCan("payroll.manage"))) {
    throw errors.forbidden("change pay");
  }

  const { organizationId, actor } = await getScope();
  const member = await requireMember(organizationId, userId);

  const existing = await prisma.employeeProfile.findUnique({
    where: { userId },
    select: {
      organizationId: true,
      salaryMinor: true,
      hitPaymentMinor: true,
      currency: true,
      joinedOn: true,
      employmentEndedOn: true,
      notes: true,
    },
  });

  // `EmployeeProfile.userId` is globally unique, so an existing row could in
  // principle belong to another workspace. Refusing rather than overwriting is
  // the only safe answer: a membership here entitles nobody to edit it.
  if (existing && existing.organizationId !== organizationId) {
    throw errors.notFound("employee");
  }

  const settings = await getCurrentOrgSettings();

  // Every field resolves to "what was sent, else what is stored, else a
  // default", so a PATCH that carries one field cannot blank the other five.
  // `undefined` means absent; `null` is a real value that clears a date.
  const next = {
    salaryMinor: input.salaryMinor ?? existing?.salaryMinor ?? 0,
    hitPaymentMinor: input.hitPaymentMinor ?? existing?.hitPaymentMinor ?? 0,
    currency: input.currency ?? existing?.currency ?? settings.baseCurrency,
    joinedOn: input.joinedOn !== undefined ? input.joinedOn : (existing?.joinedOn ?? null),
    employmentEndedOn:
      input.employmentEndedOn !== undefined
        ? input.employmentEndedOn
        : (existing?.employmentEndedOn ?? null),
    notes: input.notes !== undefined ? input.notes || null : (existing?.notes ?? null),
  };

  // Checked on the resolved values rather than on the input, so sending only a
  // `joinedOn` cannot quietly push it past an `employmentEndedOn` that is
  // already stored. An end before a start makes `employedDuring` in the payroll
  // engine answer a question nobody asked.
  if (next.joinedOn && next.employmentEndedOn && next.employmentEndedOn < next.joinedOn) {
    throw errors.invalidInput("Employment cannot end before it began.");
  }

  // Upsert rather than create-or-update by hand: two admins saving the form at
  // once would otherwise race to insert, and the loser would get a unique
  // constraint violation instead of the value they typed.
  const saved = await prisma.employeeProfile.upsert({
    where: { userId },
    create: { organizationId, userId, ...next },
    update: next,
    select: {
      salaryMinor: true,
      hitPaymentMinor: true,
      currency: true,
      joinedOn: true,
      employmentEndedOn: true,
      notes: true,
    },
  });

  const label = displayName({ name: member.name, email: member.email, userId });
  const notesChanged =
    input.notes !== undefined && (input.notes || null) !== (existing?.notes ?? null);

  // THE AMOUNTS ARE IN THIS ENTRY ON PURPOSE, AND ONLY THIS ONE.
  //
  // The rule everywhere else in this codebase is that a payroll figure never
  // reaches audit metadata, and every other action here obeys it — the payroll
  // period keys record headcount and outcome, never money. This is the
  // deliberate exception, because a salary that changed with no record of what
  // it changed from is precisely the event an audit log exists to answer. An
  // entry saying "pay updated" and nothing else would be a log of the fact that
  // something was hidden.
  //
  // `notes` is NOT recorded. It is free text an admin wrote about a colleague:
  // that it changed is auditable, what it says is not.
  await recordAudit(
    {
      organizationId,
      actorUserId: actor.userId,
      actorLabel: actor.name ?? actor.email,
      request,
    },
    {
      action: "employee.pay_updated",
      // The figures stay out of the summary, which is the line rendered in the
      // log list. Somebody scrolling the audit page should not read a
      // colleague's salary over their shoulder to find out who changed a niche.
      summary: `Updated pay configuration for ${label}`,
      targetType: "user",
      targetId: userId,
      targetLabel: label,
      metadata: {
        currency: saved.currency,
        salaryMinorFrom: existing?.salaryMinor ?? null,
        salaryMinorTo: saved.salaryMinor,
        hitPaymentMinorFrom: existing?.hitPaymentMinor ?? null,
        hitPaymentMinorTo: saved.hitPaymentMinor,
        joinedOn: saved.joinedOn?.toISOString() ?? null,
        employmentEndedOn: saved.employmentEndedOn?.toISOString() ?? null,
        notesChanged,
        created: existing === null,
      },
    },
  );

  return {
    userId,
    salaryMinor: saved.salaryMinor,
    hitPaymentMinor: saved.hitPaymentMinor,
    currency: saved.currency,
    joinedOn: saved.joinedOn?.getTime() ?? null,
    employmentEndedOn: saved.employmentEndedOn?.getTime() ?? null,
    notes: saved.notes,
  };
}

// ---------------------------------------------------------------------------
// WRITE: the admin approval gate
// ---------------------------------------------------------------------------

export interface EmployeeApprovalResult {
  readonly userId: string;
  readonly status: string;
  readonly name: string | null;
  readonly email: string | null;
}

/**
 * Approves an account that is waiting behind the gate.
 *
 * WHAT `pending_approval` IS
 * Somebody has accepted an invitation and chosen a password, but no
 * administrator has let them in yet. Nothing extra enforces the gate: the
 * session DAL already refuses any account whose status is not "active", so such
 * an account simply cannot authenticate until one of these two functions runs.
 * That is the design — one check, in the one place that decides identity,
 * rather than a second gate somewhere that could be missed.
 *
 * Both transitions are compare-and-set: the current status appears in the
 * `where` clause, so two admins clicking Approve and Reject at the same moment
 * produce one winner and one clear error, never a half-applied account.
 */
export async function approveEmployee(
  userId: string,
  request: Request,
): Promise<EmployeeApprovalResult> {
  const { organizationId, actor } = await getScope();
  const member = await requireMember(organizationId, userId);

  if (member.status !== "pending_approval") {
    throw errors.invalidInput(
      "That account is not waiting for approval. Change its status from the Users screen instead.",
    );
  }

  const result = await prisma.appUser.updateMany({
    where: { id: userId, status: "pending_approval" },
    data: {
      status: "active",
      // Cleared together, because a lockout or a deactivation stamp surviving an
      // approval looks exactly like an approval that silently failed.
      deactivatedAt: null,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  if (result.count === 0) {
    throw errors.invalidInput("That account was changed by someone else. Reload and try again.");
  }

  const label = displayName({ name: member.name, email: member.email, userId });

  await recordAudit(
    {
      organizationId,
      actorUserId: actor.userId,
      actorLabel: actor.name ?? actor.email,
      request,
    },
    {
      action: "employee.approved",
      summary: `Approved ${label} as ${roleDefinition(member.role).label}`,
      targetType: "user",
      targetId: userId,
      targetLabel: label,
      metadata: { role: member.role },
    },
  );

  return { userId, status: "active", name: member.name, email: member.email };
}

/**
 * Turns a pending account away.
 *
 * Deactivation rather than deletion. The account, its invitation and the audit
 * trail that led here are the evidence that somebody applied and was refused;
 * deleting the row would erase the decision along with its subject. A
 * deactivated account cannot authenticate, and an admin who changes their mind
 * can reactivate it from the Users screen.
 *
 * THE REASON IS FOR THE LOG, NOT FOR THE PERSON. It goes into the audit
 * summary and metadata, where an admin reading the trail later can see why the
 * decision was made. Nothing mails it to the rejected account: telling somebody
 * "you were turned down because X" is a conversation a human being should have,
 * and a system that sends it automatically has made that choice for them.
 */
export async function rejectEmployee(
  userId: string,
  request: Request,
  options: { reason?: string } = {},
): Promise<EmployeeApprovalResult> {
  const { organizationId, actor } = await getScope();
  const member = await requireMember(organizationId, userId);

  if (member.status !== "pending_approval") {
    throw errors.invalidInput(
      "That account is not waiting for approval. Deactivate it from the Users screen instead.",
    );
  }

  const outcome = await prisma.$transaction(async (tx) => {
    const updated = await tx.appUser.updateMany({
      where: { id: userId, status: "pending_approval" },
      data: { status: "deactivated", deactivatedAt: new Date() },
    });
    if (updated.count === 0) return { applied: false, sessionsRevoked: 0 };

    // A pending account should have no sessions — it could never have signed in
    // — but revoking in the same transaction as the status flip means there is
    // no ordering in which a rejected person is left holding one.
    const sessionsRevoked = await revokeAllSessionsForUser(userId, tx);
    return { applied: true, sessionsRevoked };
  });

  if (!outcome.applied) {
    throw errors.invalidInput("That account was changed by someone else. Reload and try again.");
  }

  const label = displayName({ name: member.name, email: member.email, userId });

  // Trimmed and emptiness-checked again here rather than trusted from the
  // schema: this function is called directly by the per-row action on the
  // Employees page as well as through the bulk route, and a summary ending in a
  // dangling em dash is how "the reason is optional" leaks into the log.
  const reason = options.reason?.trim();
  const hasReason = reason !== undefined && reason.length > 0;

  await recordAudit(
    {
      organizationId,
      actorUserId: actor.userId,
      actorLabel: actor.name ?? actor.email,
      request,
    },
    {
      action: "employee.rejected",
      summary: hasReason
        ? `Rejected the pending account for ${label} — ${reason}`
        : `Rejected the pending account for ${label}`,
      targetType: "user",
      targetId: userId,
      targetLabel: label,
      metadata: {
        role: member.role,
        sessionsRevoked: outcome.sessionsRevoked,
        // Spread rather than assigned, so an unexplained denial has no `reason`
        // key at all instead of one holding null — the same distinction the pay
        // block draws one screen over.
        ...(hasReason ? { reason } : {}),
      },
    },
  );

  return { userId, status: "deactivated", name: member.name, email: member.email };
}

// ---------------------------------------------------------------------------
// WRITE: the same gate, in batches
// ---------------------------------------------------------------------------

/**
 * What happened to one account in a batch.
 *
 * `error` carries an `AppError.userMessage` — a sentence written for a person,
 * the same text the single-account routes return — and never an exception's own
 * message, which can name a table, a column or a query. See `refusalMessage`.
 */
export interface BulkApprovalOutcome {
  readonly userId: string;
  readonly ok: boolean;
  readonly name: string | null;
  readonly email: string | null;
  /** Why this one did not apply. Null on success. */
  readonly error: string | null;
}

export interface BulkApprovalResult {
  readonly results: readonly BulkApprovalOutcome[];
  readonly succeeded: number;
  readonly failed: number;
}

/**
 * Runs one decision over a list of accounts, and does not stop at the first
 * refusal.
 *
 * WHY PARTIAL SUCCESS IS THE CONTRACT
 * Onboarding happens in waves, and the realistic failure is not "the database
 * is down" — it is one row in the batch that a colleague approved thirty
 * seconds ago in another tab. Aborting on that would throw away nine good
 * approvals to report one stale id, and the admin would have no way to tell
 * which of the ten actually landed. So every id is attempted, every outcome is
 * named, and the caller is told exactly which ones need looking at.
 *
 * SEQUENTIAL, NOT `Promise.all`. Each iteration is a compare-and-set, a session
 * revocation inside a transaction and an audit write. Firing fifty of those at
 * once would open fifty connections from one HTTP request to write rows that
 * nobody is waiting on in parallel — and would interleave the audit entries into
 * an order that no longer matches the order the admin ticked the boxes.
 *
 * NOT A TRANSACTION EITHER, for the same reason partial success is the
 * contract: `approveEmployee` and `rejectEmployee` each audit their own
 * decision, and rolling nine of them back because the tenth was stale would
 * un-approve people an admin has been told were approved.
 */
async function runApprovalBatch(
  userIds: readonly string[],
  decide: (userId: string) => Promise<EmployeeApprovalResult>,
): Promise<BulkApprovalResult> {
  // Deduplicated so a list that names the same person twice cannot produce one
  // success and one "already decided" failure for the same account — which
  // would be entirely this function's own doing.
  const unique = [...new Set(userIds)];

  const results: BulkApprovalOutcome[] = [];
  for (const userId of unique) {
    try {
      const applied = await decide(userId);
      results.push({
        userId,
        ok: true,
        name: applied.name,
        email: applied.email,
        error: null,
      });
    } catch (error) {
      results.push({
        userId,
        ok: false,
        // The account could not be read, or could not be changed; either way
        // this response is not the place to guess at a name for it.
        name: null,
        email: null,
        error: refusalMessage(error),
      });
    }
  }

  return {
    results,
    succeeded: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
  };
}

/**
 * The sentence to show for one failed member of a batch.
 *
 * An `AppError` was constructed with a `userMessage` for exactly this purpose,
 * so it is safe to pass on. Anything else is an unexpected throw whose message
 * is written for a developer, and it is replaced wholesale rather than trimmed.
 *
 * IT IS LOGGED HERE BECAUSE NOTHING ELSE WILL. Catching the error is what makes
 * partial success possible, and it also means `handleMutation`'s 5xx logging
 * never sees this one — so a batch could quietly swallow a real fault. The log
 * line follows `describeWriteFailure` in audit-service: error name and first
 * line only, never the object. A PrismaClientValidationError renders the
 * rejected call into its own text, `data` included, and a server log outlives
 * the request and answers to nobody's permissions.
 */
function refusalMessage(error: unknown): string {
  if (error instanceof AppError) return error.userMessage;

  const described =
    error instanceof Error
      ? `${error.name}: ${error.message.split("\n")[0] ?? ""}`
      : "non-Error thrown";
  console.error("[approvals] unexpected failure while deciding one account —", described);

  return "Something went wrong with this account. Try it on its own to see why.";
}

/** Approve several accounts, reporting each one separately. */
export async function approveEmployees(
  userIds: readonly string[],
  request: Request,
): Promise<BulkApprovalResult> {
  return runApprovalBatch(userIds, (userId) => approveEmployee(userId, request));
}

/**
 * Deny several accounts, reporting each one separately.
 *
 * One reason for the whole batch, because that is what the dialog asks for and
 * what is true: an admin clearing five requests in one action had one thought
 * about all five. It is written into each denial's own audit entry rather than
 * into a single batch record, so a person's account still carries its own
 * complete decision when somebody looks it up a year later.
 */
export async function denyEmployees(
  userIds: readonly string[],
  request: Request,
  options: { reason?: string } = {},
): Promise<BulkApprovalResult> {
  return runApprovalBatch(userIds, (userId) =>
    rejectEmployee(userId, request, { reason: options.reason }),
  );
}
