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
import {
  describeNicheGap,
  payDateFor,
  periodLabel,
  type NichePayrollGap,
  type PayrollPeriodWindow,
} from "./payroll-engine";

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
  /**
   * The rate THIS niche paid, so the line reads "120 × $5 = $600".
   *
   * On the niche rather than on the person, because the rate is a property of
   * the work now: one payslip can hold GTA hits at one price and Minecraft hits
   * at another, and quoting a single figure across both lines would make two
   * thirds of the arithmetic in this message fail to check out.
   *
   * `null` when it could not be stated — a settled record paid at several rates
   * whose per-niche prices could not be recovered. The line then reports the
   * count and the money without the multiplication, which is the honest form of
   * the same sentence.
   */
  readonly hitPaymentMinor: number | null;
  /** `hitCount × hitPaymentMinor`, or null in lockstep with it. */
  readonly bonusMinor: number | null;
}

/**
 * A niche that cost this person money without appearing in their bonus.
 *
 * THE SILENCE THIS FIELD EXISTS TO BREAK. A hit pays only when its niche has
 * all three of a threshold, a window and a price. Miss any one of them and the
 * engine — correctly — pays nothing, and until now the message said nothing
 * either: the person's block rendered name, base salary and total, three lines
 * with nothing wrong on any of them and no mention that a Short had reached the
 * bar and earned zero. The owner read exactly that, checked it against a hit he
 * knew about, and could not tell whether the tool was wrong or the payment was.
 *
 * NO AMOUNT, EVER. An unpriced hit has no price by definition, so "would have
 * earned X" is not derivable and must not be invented — the engine's refusal to
 * price it is correct and this is a disclosure, not a payment. The count is the
 * only figure here, and it is exact for the ONE NICHE it is printed against.
 *
 * NOT SUMMABLE ACROSS NICHES, not even within one person. A rule gap counts a
 * Short once in every half-configured niche it is filed under, so adding two of
 * these together can exceed the number of Shorts involved — see `SkippedNiche`.
 * Anything that needs one figure for a person counts NICHES; see
 * `formatEmployeeLine`, which used to get this wrong.
 *
 * The two gaps are counted over different populations and the wording has to
 * keep them apart — see the engine's `SkippedNiche.shortCount`. A PAYMENT gap
 * counts Shorts this niche judged as HITS and could not price: the question was
 * asked and the answer was yes. A RULE gap counts Shorts published in the month
 * that nothing could judge, so they are not hits and must never be called that.
 */
export interface PayrollMessageGap {
  readonly nicheName: string;
  /** Which of the niche's three settings are absent. See `NichePayrollGap`. */
  readonly missing: NichePayrollGap;
  /** Distinct Shorts of THIS person's that this gap cost. Never an amount. */
  readonly shortCount: number;
}

export interface PayrollMessageEmployee {
  readonly name: string;
  /** Already resolved to a label ("Head of Shorts"), never a raw role id. */
  readonly roleLabel: string;
  readonly baseSalaryMinor: number;
  /**
   * The one rate this record was paid at, or 0 when it spanned several.
   *
   * NOT what the niche lines are priced at any more — each of those carries its
   * own. Kept because it is what `PayrollRecord` stores, and dropping it would
   * make the message's shape disagree with the row it is built from.
   */
  readonly hitPaymentMinor: number;
  readonly adjustmentMinor: number;
  readonly adjustmentReason: string | null;
  readonly totalMinor: number;
  readonly currency: string;
  readonly byNiche: readonly PayrollMessageNiche[];
  /**
   * Niches that produced no money for this person because a setting is absent.
   *
   * SEPARATE FROM `byNiche` BECAUSE IT IS NOT A NICHE LINE. A `byNiche` entry
   * is a bonus that was paid; the null-rate branch on one means "this settled
   * record could not be broken down by niche", which is a different and
   * unrelated claim. Folding a gap in there would make one line mean two
   * things, and it would collide with the record's own stored total.
   *
   * Empty is the ordinary case and also the honest case where the fact is not
   * available: only a send that follows the finalization it is announcing holds
   * the per-employee gaps, because nothing durable stores them. In practice
   * that is the scheduled monthly job alone — an admin-initiated send addresses
   * a month rather than a run and arrives here empty, whether it is the first
   * send or a re-send. See `EmployeeNicheGap` in the payroll service for the
   * full account. An empty array says the message has nothing to add, never
   * that nothing was skipped.
   */
  readonly unpaidNiches: readonly PayrollMessageGap[];
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

/**
 * One niche that earned this person nothing, and which setting is why.
 *
 * TWO SHAPES, BECAUSE THE TWO GAPS STOPPED AT DIFFERENT POINTS. The payment
 * line says "hits" and means it — those Shorts were measured against a real bar
 * inside a real window and won. The rule line must not: nothing in that niche
 * was ever judged, so its count is Shorts published in the month, and calling
 * them hits would claim a verdict that was never reached.
 *
 * The missing setting is named through `describeNicheGap`, the engine's own
 * composition, which is what the payroll screen, the finalize dialog and the
 * employee's own notices already use. An owner reading "no hit payment" here
 * and "no hit window" on the screen about the same niche would have no way to
 * know which field to open.
 *
 * NO MONEY ON EITHER LINE. There is no rate — that is the whole problem — so
 * there is no figure to state and nothing to multiply.
 */
function formatGapLine(gap: PayrollMessageGap): string {
  const lacks = `no ${describeNicheGap(gap.missing)} set`;

  if (gap.missing.rule === null) {
    // A PAYMENT GAP: judged, won, unpaid.
    //
    // "hits:" whatever the count, matching the paid niche lines above it
    // exactly. Those never singularise either, and a block where one line reads
    // "GTA hit:" and the next "RDR hits:" invites the reader to look for a
    // difference in meaning that is not there.
    return `${gap.nicheName} hits: ${gap.shortCount} — not paid, ${lacks}`;
  }

  // A RULE GAP: never judged. Not hits, and the line does not say hits.
  //
  // "video(s)", NOT "Short(s)" — the one deliberate wording change Shorts
  // users see from the Long Form deploy, owner-approved. The same monthly run
  // now pays both formats, so this line can describe a Long Form niche's
  // uncounted uploads, and "3 Shorts not counted" under a Long Form niche
  // name would be wrong on its face. The count itself is exact and unchanged.
  const videos = gap.shortCount === 1 ? "video" : "videos";
  return `${gap.nicheName}: ${gap.shortCount} ${videos} not counted, ${lacks}`;
}

/**
 * The explanation the per-employee lines above are otherwise cryptic without.
 *
 * Written for the owner, who is the only reader of this chat and the only
 * person who can close any of these gaps. It names the three settings in plain
 * words rather than field names, says where they live, and — the part the app
 * must not decide — hands back the question of whether to make anything up to
 * the people listed. It also refuses to imply the month will re-pay itself: a
 * finalized period does not move, and a price set today counts from the next
 * one.
 *
 * The middle sentence is `skipped-niches-notice.tsx`'s, word for word. The
 * admin screen and this message are two renderings of one fact and there is no
 * version of them disagreeing that is not a bug.
 */
function gapNotice(input: PayrollMessageInput): string {
  return [
    // "videos", not "Shorts" — the sentence can now be about either format's
    // gaps. See the note in `formatGapLine`; the pledged middle sentence
    // below is untouched.
    "Some videos earned nothing this month.",
    "A hit bonus needs three things from a niche: a view threshold, a window to reach it in, and what one hit is worth.",
    "You set those under Niches.",
    "Nobody's salary is affected — only the hit bonus.",
    `${periodLabel(input.period)} is final either way: a setting completed now counts towards later periods, and whether to make anything up to the people above is your call.`,
  ].join(" ");
}

/**
 * The same fact in the few characters the summarised ladder can spare.
 *
 * A DISCLOSURE THAT DISAPPEARS AS THE TEAM GROWS IS THE BUG THIS WHOLE CHANGE
 * IS ABOUT. Step 2 of `buildPayrollMessage` drops every per-niche line, which
 * would take the gap lines with it, so the fact needs a form that survives to
 * the floor of the message.
 *
 * COUNTS A NICHE, NOT A SHORT, AND THAT IS DELIBERATE. Summing `shortCount`
 * across people would double-count a Short two colleagues share a niche and a
 * channel on, and an inflated number in a payroll announcement is worse than a
 * smaller true one. Distinct niche names is a figure this function can actually
 * prove.
 *
 * NO FREE TEXT. `MAX_COMPANY_CHARS` bounds the header and footer so the floor
 * of the message is arithmetic rather than an assumption; interpolating a niche
 * name here would put an unbounded string back into it.
 */
function shortGapNotice(input: PayrollMessageInput): string {
  const niches = new Set<string>();
  for (const employee of input.employees) {
    for (const gap of employee.unpaidNiches) niches.add(gap.nicheName);
  }
  const count = niches.size;
  return `Hit bonuses went unpaid on this run: ${count} ${
    count === 1 ? "niche is" : "niches are"
  } missing a setting. The full breakdown is on the payroll screen.`;
}

/** True when anybody on the run had a Short a niche setting cost them. */
function hasGaps(input: PayrollMessageInput): boolean {
  return input.employees.some((employee) => employee.unpaidNiches.length > 0);
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
    // The NICHE's rate, off the line. Two niches on one payslip can pay
    // differently, so a single figure from the record would make most of these
    // lines fail to multiply out.
    if (niche.hitPaymentMinor === null || niche.bonusMinor === null) {
      // No price to state, so no multiplication to write. The count is stored
      // on the hits and is never in doubt; the total below is the record's own.
      lines.push(`${niche.nicheName} hits: ${niche.hitCount}`);
      continue;
    }
    const rate = formatPayAmount(niche.hitPaymentMinor, employee.currency);
    const bonus = formatPayAmount(niche.bonusMinor, employee.currency);
    lines.push(`${niche.nicheName} hits: ${niche.hitCount} × ${rate} = ${bonus}`);
  }

  // DIRECTLY UNDER THE LINES THAT DID PAY, and above the total, because that is
  // where the money stops adding up. A reader who gets as far as "Total" has
  // already formed the belief this block exists to correct.
  for (const gap of employee.unpaidNiches) {
    lines.push(formatGapLine(gap));
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

  // The gap survives the loss of the per-niche detail, in the shortest form
  // that is still true — and the figure is NICHES, not Shorts.
  //
  // SUMMING `shortCount` HERE WOULD DOUBLE-COUNT, AND IT IS THIS PERSON'S OWN
  // NUMBERS THAT DO IT. The double-counting is not only across people. A rule
  // gap is bucketed per niche by `collectSkippedNiches`, which adds the video
  // id to EVERY assigned niche a Short is filed under that is missing a rule
  // half — so one Short filed under two half-configured niches lands in two
  // buckets, each with `shortCount: 1`. `SkippedNiche` says so itself: "One
  // Short filed under two unusable niches is counted once in each, so summing
  // `shortCount` across niches can exceed the number of Shorts involved." The
  // sum would have printed "2 Shorts earned nothing" for one Short, which is
  // the inflated figure `shortGapNotice` refuses for the same reason: in a
  // payroll announcement a smaller true number beats a larger invented one.
  //
  // Distinct niches is the figure this line actually holds — `unpaidNiches` is
  // one entry per niche — and it is the same unit the summarised notice counts,
  // so the line and the paragraph under it cannot disagree.
  //
  // "no hit bonus from" rather than "unpaid hits": one line cannot carry both
  // gap kinds, and a rule gap's Shorts were never judged, so calling them hits
  // here would be the one claim the engine explicitly refuses to make. Not
  // "niches earned nothing" either — a niche's earnings are a real and
  // unrelated figure elsewhere in this product.
  const unpaidNiches = employee.unpaidNiches.length;
  const gapPart =
    unpaidNiches > 0
      ? ` · no hit bonus from ${unpaidNiches} niche${unpaidNiches === 1 ? "" : "s"}`
      : "";

  return `${name} — ${role}: ${total}${hitPart}${gapPart}`;
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

  // Absent entirely on a clean run, so a month with every niche configured
  // reads exactly as it always has — and so the presence of the paragraph is
  // itself the signal that something needs attention.
  const notice = hasGaps(input) ? [gapNotice(input)] : [];

  return [header(input), ...blocks, ...notice, footer(input)].join(SECTION_GAP);
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

  // THE TAIL IS UNDROPPABLE, AND THE NOTICE IS PART OF IT FROM HERE DOWN.
  //
  // Steps 2 and 3 exist to shed detail, and a disclosure that only survives at
  // small team sizes is the same silence this change removes, arriving later.
  // The short form carries no free text — a niche count and a fixed sentence —
  // so the floor of the message stays the arithmetic `MAX_COMPANY_CHARS`
  // makes it rather than a hope about how long a niche name is.
  const tail = hasGaps(input) ? [shortGapNotice(input), bottom] : [bottom];

  const summarised = [top, ...lines, ...tail].join(SECTION_GAP);
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
      ...tail,
    ].join(SECTION_GAP);

    if (candidate.length > limit) break;
    kept.push(lines[index]);
  }

  // If not even one line fitted, this is header + overflow + notice + total: a
  // few hundred characters at most, because `MAX_COMPANY_CHARS` bounds the only
  // free text in the header and footer and the notice interpolates nothing but
  // a count. There is no shorter honest message, and it is far below Telegram's
  // own limit.
  const omitted = lines.length - kept.length;
  return [
    top,
    ...kept,
    ...(omitted > 0 ? [formatRosterOverflow(omitted)] : []),
    ...tail,
  ].join(SECTION_GAP);
}
