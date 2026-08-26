/**
 * =========================================================================
 * THE MONTHLY PAYROLL MESSAGE
 * =========================================================================
 *
 * Pure, isomorphic, no I/O — the same discipline `payroll-engine.ts` follows,
 * and for the same reason. The wording of the message that lands in Telegram on
 * payday is a thing people will argue about ("why does it say $4,000 when his
 * salary is $4,000.50?"), so it has to be testable without a bot token, a
 * network call or a database.
 *
 * This module formats a payroll run that has ALREADY been calculated. It never
 * decides what anybody earned; it is handed the figures and turns them into
 * sentences. Keeping those two jobs apart is what stops a display tweak from
 * quietly changing a total.
 *
 * PLAIN TEXT, DELIBERATELY
 * The transport sends these with no `parse_mode`, so Telegram treats the body
 * as literal text. That means an employee called "Anna *Smith*" or a niche
 * named "C++" renders exactly as written, with no escaping rules for a future
 * caller to get wrong and no chance of a stray underscore swallowing half a
 * salary line into italics.
 */

import { formatMoney, formatMoneyTrimmed } from "@/lib/finance/money";
import { payDateFor, type PayrollPeriodWindow } from "./payroll-engine";

/**
 * Telegram's hard cap on a single `sendMessage` body, in UTF-16 code units.
 *
 * Exceeding it is not a soft failure — the API rejects the whole message — so
 * this is the number `buildPayrollMessage` renders down to fit.
 */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** The blank line between sections, in one place because two paths join on it. */
const SECTION_GAP = "\n\n";

/** Names are rendered as given; these caps only apply on the summarised path. */
const MAX_NAME_CHARS = 60;
const MAX_ROLE_CHARS = 40;
const MAX_REASON_CHARS = 120;

/**
 * The company name is clipped on every path, unlike the caps above.
 *
 * Header and footer are the two sections `buildPayrollMessage` can never drop,
 * so together they are the floor of the single message it promises. Bounding
 * the one piece of free text they interpolate is what makes that promise
 * arithmetic rather than an assumption about how long a workspace name is.
 */
const MAX_COMPANY_CHARS = 80;

// ---------------------------------------------------------------------------
// INPUTS
// ---------------------------------------------------------------------------

export interface PayrollMessageNiche {
  readonly nicheName: string;
  readonly hitCount: number;
  readonly bonusMinor: number;
}

export interface PayrollMessageEmployee {
  readonly name: string;
  /** Already resolved to a label ("Head of Shorts"), never a raw role id. */
  readonly roleLabel: string;
  readonly baseSalaryMinor: number;
  /** The per-hit rate, so a line can read "120 × $10". */
  readonly hitPaymentMinor: number;
  readonly adjustmentMinor: number;
  readonly adjustmentReason: string | null;
  readonly totalMinor: number;
  readonly currency: string;
  readonly byNiche: readonly PayrollMessageNiche[];
}

export interface PayrollMessageInput {
  /** From OrganizationSettings, so a rename reaches the message. */
  readonly companyName: string;
  readonly period: PayrollPeriodWindow;
  readonly employees: readonly PayrollMessageEmployee[];
  readonly totalMinor: number;
  readonly currency: string;
}

// ---------------------------------------------------------------------------
// PRIMITIVES
// ---------------------------------------------------------------------------

/**
 * Month names, hardcoded rather than taken from `Intl`.
 *
 * `Intl.DateTimeFormat` resolves against the runtime's locale, which differs
 * between a developer's laptop, a CI container and a serverless region. A
 * payroll message whose date format depends on where the process happened to
 * run is not something you can write a test for, and "September 1, 2026" is the
 * format the brief specifies regardless of who reads it.
 */
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/**
 * The date the money actually lands: the first of the month after the period.
 *
 * Read in UTC, matching the half-open window the engine calculates against —
 * the alternative is a message that says "August 31" to a reader in São Paulo
 * and "September 1" to one in Berlin about the very same payment.
 */
export function formatPayDate(period: PayrollPeriodWindow): string {
  const payOn = new Date(payDateFor(period));
  const month = MONTH_NAMES[payOn.getUTCMonth()] ?? "";
  return `${month} ${payOn.getUTCDate()}, ${payOn.getUTCFullYear()}`;
}

/**
 * An amount, with the decimals shown only when there are any.
 *
 * The brief's example reads "Base salary: $4,000", not "$4,000.00", and for
 * round figures the cents are noise. Hiding them unconditionally would be a
 * lie, though: a salary of $4,000.50 rendered as "$4,000" or "$4,001" is a
 * message somebody will reconcile against a bank statement and find wrong. So
 * the fraction is dropped only when it is genuinely zero, and a currency with
 * no minor units at all (JPY) takes the same path for free.
 */
export function formatPayAmount(minor: number, currency: string): string {
  // The rule itself lives in money.ts, because the Employees screen renders the
  // same salaries and the two must not drift into "$4,000" here and "$4,000.00"
  // there. What stays local is the pinned locale: this string is built on a
  // server for a fixed chat, so it must not depend on the process's locale,
  // whereas the browser should follow the reader's.
  return formatMoneyTrimmed(minor, currency, { locale: "en-US" });
}

/** Trims to a hard ceiling, so a pathological name cannot blow a size budget. */
function clip(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// SECTIONS
// ---------------------------------------------------------------------------

function header(input: PayrollMessageInput): string {
  const company = clip(input.companyName, MAX_COMPANY_CHARS);
  return [`${company} — Monthly Payroll`, formatPayDate(input.period)].join("\n");
}

function footer(input: PayrollMessageInput): string {
  const company = clip(input.companyName, MAX_COMPANY_CHARS);
  return `Total ${company} Payroll: ${formatPayAmount(input.totalMinor, input.currency)}`;
}

/**
 * One person's full breakdown.
 *
 * The per-niche lines are what make the bonus explicable — "GTA hits: 120 ×
 * $10 = $1,200" can be checked against the payroll screen, whereas a single
 * lumped bonus figure can only be believed. Somebody with no qualifying hits
 * gets no hit lines at all rather than a row of zeroes.
 */
export function formatEmployeeBlock(employee: PayrollMessageEmployee): string {
  const lines: string[] = [
    `${employee.name} — ${employee.roleLabel}`,
    `Base salary: ${formatPayAmount(employee.baseSalaryMinor, employee.currency)}`,
  ];

  for (const niche of employee.byNiche) {
    const rate = formatPayAmount(employee.hitPaymentMinor, employee.currency);
    const bonus = formatPayAmount(niche.bonusMinor, employee.currency);
    lines.push(`${niche.nicheName} hits: ${niche.hitCount} × ${rate} = ${bonus}`);
  }

  // Shown on its own line rather than folded into the total, for the same
  // reason the column is separate in the database: a hand-made correction
  // should be visible as one, not disguised as a computed figure.
  if (employee.adjustmentMinor !== 0) {
    const amount = formatMoney(employee.adjustmentMinor, employee.currency, {
      signDisplay: "always",
      locale: "en-US",
    });
    const reason = employee.adjustmentReason
      ? ` — ${clip(employee.adjustmentReason, MAX_REASON_CHARS)}`
      : "";
    lines.push(`Adjustment: ${amount}${reason}`);
  }

  lines.push(`Total: ${formatPayAmount(employee.totalMinor, employee.currency)}`);
  return lines.join("\n");
}

/** The same person on one line, for the summarised path. */
function formatEmployeeLine(employee: PayrollMessageEmployee): string {
  const name = clip(employee.name, MAX_NAME_CHARS);
  const role = clip(employee.roleLabel, MAX_ROLE_CHARS);
  const total = formatPayAmount(employee.totalMinor, employee.currency);
  const hits = employee.byNiche.reduce((sum, niche) => sum + niche.hitCount, 0);
  const hitPart = hits > 0 ? ` (${hits} hit${hits === 1 ? "" : "s"})` : "";
  return `${name} — ${role}: ${total}${hitPart}`;
}

const EMPTY_RUN_NOTICE = "Nobody was on payroll for this period.";

// ---------------------------------------------------------------------------
// ASSEMBLY
// ---------------------------------------------------------------------------

/**
 * The whole run as one string, with no length ceiling.
 *
 * This is the canonical rendering — what the message *says* — and it is what
 * the tests assert against. `buildPayrollMessage` is the delivery concern on
 * top of it, and it returns exactly this string whenever it fits in one
 * Telegram message, which is every realistic team.
 */
export function formatPayrollMessage(input: PayrollMessageInput): string {
  const blocks =
    input.employees.length > 0
      ? input.employees.map(formatEmployeeBlock)
      : [EMPTY_RUN_NOTICE];
  return [header(input), ...blocks, footer(input)].join(SECTION_GAP);
}

/**
 * Says how many people the roster left out, so a short list is never mistaken
 * for the whole team.
 */
function formatRosterOverflow(omitted: number): string {
  const who = omitted === 1 ? "person" : "people";
  return `…and ${omitted} more ${who} on payroll. The full breakdown is on the payroll screen.`;
}

/**
 * The whole run as ONE message Telegram will accept. Never two.
 *
 * WHY ONE MESSAGE, AND NOT NUMBERED PARTS
 * This used to return an array — "(1/3)", "(2/3)", "(3/3)" — which reads well
 * right up until the second part fails. `sendMessages` stopped at the first
 * failure, `notification-service` marked the whole row failed, and the next
 * retry (a platform replay, the admin's re-send button, or the next cron
 * finding a failed row claimable) started again from part 1. Everyone's salary
 * posted twice in the chat, and Telegram has no unsend.
 *
 * Making that resumable would have meant storing how many parts got through —
 * a column `PayrollNotification` does not have, which would have to be smuggled
 * into `lastError` or `attempts` and then kept correct forever. Removing the
 * failure mode is cheaper and needs no schema: with exactly one `sendMessage`
 * behind the claim, delivery is atomic by construction. It either happened or
 * it did not, a retry cannot repeat a fragment, and there is nothing to resume.
 *
 * WHAT IS GIVEN UP, AND WHY IT IS THE RIGHT TRADE
 * A team too large for 4096 characters loses its per-niche breakdown, and a
 * team too large even for one line each loses the tail of the roster. Both are
 * still on the payroll screen, which is where anybody checking a figure looks
 * anyway. The alternative was announcing some people's pay twice.
 *
 * The ladder, in order:
 *   1. The canonical rendering, whenever it fits. This is every realistic team.
 *   2. One line per person — the per-niche detail goes, nobody does.
 *   3. As many of those lines as fit, plus a line saying how many are missing.
 *      Never a message cut mid-figure, and never a list that looks complete.
 *
 * The total is always present, and it is always the calculated total — no path
 * here recomputes it from what happened to be included.
 */
export function buildPayrollMessage(
  input: PayrollMessageInput,
  options: { limit?: number } = {},
): string {
  const limit = options.limit ?? TELEGRAM_MESSAGE_LIMIT;

  const detailed = formatPayrollMessage(input);
  if (detailed.length <= limit) return detailed;

  // An empty run has nothing to summarise, and its notice is two lines long.
  // Handing it to the roster logic below would drop that notice for nothing.
  if (input.employees.length === 0) return detailed;

  const top = header(input);
  const bottom = footer(input);
  const lines = input.employees.map(formatEmployeeLine);

  const summarised = [top, ...lines, bottom].join(SECTION_GAP);
  if (summarised.length <= limit) return summarised;

  // Step 3. Each candidate is measured WITH the overflow line it would need,
  // because that line is what stops a clipped roster from reading as the team.
  // Dropping one more person shortens the list and shortens nothing else, so
  // the loop converges; the message it settles on is the last candidate that
  // measured under the limit.
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const remaining = lines.length - index - 1;
    const candidate = [
      top,
      ...kept,
      lines[index],
      ...(remaining > 0 ? [formatRosterOverflow(remaining)] : []),
      bottom,
    ].join(SECTION_GAP);

    if (candidate.length > limit) break;
    kept.push(lines[index]);
  }

  // If not even one line fitted, this is header + overflow + total: a few
  // hundred characters at most, because `MAX_COMPANY_CHARS` bounds the only
  // free text in either. There is no shorter honest message, and it is far
  // below Telegram's own limit.
  const omitted = lines.length - kept.length;
  return [
    top,
    ...kept,
    ...(omitted > 0 ? [formatRosterOverflow(omitted)] : []),
    bottom,
  ].join(SECTION_GAP);
}
