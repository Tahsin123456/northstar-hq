import "server-only";

import { z } from "zod";
import { prisma } from "@/server/db";
import { errors } from "@/server/errors";
import { actorCan } from "@/server/auth/dal";
import { revokeAllSessionsForUser } from "@/server/auth/session";
import { listAuditEvents, recordAudit, type AuditEntryDTO } from "@/server/audit/audit-service";
import type { AuditAction } from "@/lib/audit/actions";
import { ROLE_ORDER, roleDefinition } from "@/lib/auth/permissions";
import { MAX_MONEY_MINOR, isSupportedCurrency, normalizeCurrencyCode } from "@/lib/finance/money";
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
  readonly hitCount: number;
  readonly bonusMinor: number;
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
function toPayrollEmployee(row: EmployeeRecordRow, fallbackCurrency: string): PayrollEmployee {
  return {
    userId: row.userId,
    // A payroll line with a blank name is unreadable, and the account is
    // guaranteed to carry at least one of these.
    name: row.name ?? row.email ?? row.userId,
    email: row.email ?? "",
    role: row.role,
    salaryMinor: row.pay?.salaryMinor ?? 0,
    hitPaymentMinor: row.pay?.hitPaymentMinor ?? 0,
    currency: row.pay?.currency ?? fallbackCurrency,
    nicheIds: row.nicheIds,
    joinedOnMs: row.joinedOn?.getTime() ?? null,
    employmentEndedOnMs: row.employmentEndedOn?.getTime() ?? null,
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
    select: { id: true, name: true, colorIndex: true },
  });
  return new Map(rows.map((row) => [row.id, row]));
}

function toNicheDTOs(
  nicheIds: readonly string[],
  nicheById: ReadonlyMap<string, NicheChip>,
): EmployeeNicheDTO[] {
  return nicheIds
    .map((id) => nicheById.get(id))
    .filter((niche): niche is NicheChip => niche !== undefined)
    .map((niche) => ({ id: niche.id, name: niche.name, colorIndex: niche.colorIndex }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * When each of these people was invited, if an invitation row survives.
 *
 * Matched on email rather than on a foreign key because that is the only link
 * there is: an `Invitation` is consumed into an `AppUser` at acceptance and
 * never points back. Addresses are normalised to lowercase on both sides — see
 * `normalizeEmail` in auth-service — so a plain `in` is a real match.
 */
async function loadInvitedAt(
  organizationId: string,
  emails: readonly string[],
): Promise<Map<string, Date>> {
  const wanted = emails.filter((email) => email.length > 0);
  if (wanted.length === 0) return new Map();

  const rows = await prisma.invitation.findMany({
    where: { organizationId, email: { in: wanted } },
    // Ascending, so a re-invited address ends up mapped to its most recent
    // invitation rather than the first one anybody ever sent.
    orderBy: { createdAt: "asc" },
    select: { email: true, createdAt: true },
  });

  const byEmail = new Map<string, Date>();
  for (const row of rows) byEmail.set(row.email, row.createdAt);
  return byEmail;
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
 * The Shorts, niches and threshold come from the shared gatherer in
 * payroll-data.ts and are reused for everybody. Two reasons, both structural:
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

  const { niches, shorts, organizationDefaultThreshold } = await loadPayrollInputs(
    organizationId,
    period,
  );

  const byUserId = new Map<string, CurrentPeriodFigure>();
  for (const row of rows) {
    const calculation = calculateEmployeePayroll({
      employee: toPayrollEmployee(row, fallbackCurrency),
      shorts,
      niches,
      period,
      organizationDefaultThreshold,
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
        hitCount: bucket.hitCount,
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
 * The rate comes from the RECORD, not from today's EmployeeProfile: a hit
 * payment raised in September must not rewrite what August's bonus was made of.
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
      hitCount: bucket.hitCount,
      bonusMinor: bucket.hitCount * hitPaymentMinor,
    }))
    .sort((a, b) => b.bonusMinor - a.bonusMinor || a.nicheName.localeCompare(b.nicheName));
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
  const allowed = new Set<string>(PROFILE_ACTIVITY_ACTIONS);
  // `employee.pay_updated` carries the amounts in its metadata — see the note
  // on `updateEmployeePay`. It belongs on an admin's timeline, but only for a
  // reader already entitled to the figures; this feed must not become the back
  // door into payroll.
  if (includePay) allowed.add("employee.pay_updated");

  const page = await listAuditEvents({
    organizationId,
    actorUserId: userId,
    limit: PROFILE_ACTIVITY_SCAN,
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
    select: { id: true, name: true, colorIndex: true },
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
      .map((niche) => ({ id: niche.id, name: niche.name, colorIndex: niche.colorIndex }))
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
 */
export async function rejectEmployee(
  userId: string,
  request: Request,
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

  await recordAudit(
    {
      organizationId,
      actorUserId: actor.userId,
      actorLabel: actor.name ?? actor.email,
      request,
    },
    {
      action: "employee.rejected",
      summary: `Rejected the pending account for ${label}`,
      targetType: "user",
      targetId: userId,
      targetLabel: label,
      metadata: { role: member.role, sessionsRevoked: outcome.sessionsRevoked },
    },
  );

  return { userId, status: "deactivated", name: member.name, email: member.email };
}
