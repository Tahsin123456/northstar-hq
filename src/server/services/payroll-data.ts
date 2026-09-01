import "server-only";

import { prisma } from "@/server/db";
import { HOUR_MS, type HitOutcome } from "@/lib/analytics/hit-rate";
import { toNicheKind } from "@/lib/niches/niche-kind";
import { toNicheFormat, type NicheFormat } from "@/lib/niches/niche-format";
import type {
  PayrollEmployee,
  PayrollHitEvidence,
  PayrollNiche,
  PayrollPeriodWindow,
  PayrollShort,
} from "@/lib/payroll/payroll-engine";

/**
 * =========================================================================
 * PAYROLL — FEEDING THE ENGINE
 * =========================================================================
 *
 * `src/lib/payroll/payroll-engine.ts` decides what anybody earned. It is pure:
 * no Prisma, no clock, no session. This module is the other half — the one
 * place that turns rows into the four arguments that engine takes, so the live
 * preview, the finalized run and the employee screen's estimate are all
 * computed from an identically shaped input. If two screens ever disagreed
 * about a payroll figure, the cause would be two different gatherers, and there
 * is deliberately only one.
 *
 * WHAT THE QUERIES ENCODE, AND WHY IT IS DONE HERE RATHER THAN IN THE ENGINE
 * The engine takes `isOwnChannel` as a flag on every Short and skips the ones
 * that are false. It could be handed the whole dataset and left to filter — but
 * competitor Shorts are the bulk of what this product stores, and shipping tens
 * of thousands of rows out of the database to throw away in memory is a cost
 * paid on every recalculation. So ownership, activity and the period window are
 * expressed as `where` clauses, and what arrives is already only what can earn
 * money. The engine's own checks then stand as a second, independent guard
 * rather than as the only one.
 *
 * SCOPE IS AN ARGUMENT, NOT A LOOKUP
 * `organizationId` is passed in rather than read from the session, because the
 * scheduled job that finalizes a month has no session and still has to run this
 * for a named organization. Every caller with a request behind it MUST source
 * it from `getScope()` — it must never be read from a request body, which would
 * turn this into a cross-tenant payroll API.
 *
 * NOTHING HERE IS AN AUTHORIZATION BOUNDARY. This module reads salaries. Every
 * caller is responsible for having cleared `payroll.view` (or `payroll.manage`)
 * first, in the route handler, before it ever gets here.
 */

/**
 * Exactly the arguments `calculatePayrollRun` takes.
 *
 * THERE IS NO ORGANIZATION DEFAULT THRESHOLD HERE, AND THAT IS THE POINT. This
 * module used to hand the engine `settings.defaultThreshold` to fall back on
 * for a niche that had never been configured, which is how an unconfigured
 * niche came to pay real bonuses for hits the rest of the product said it could
 * not measure. A null `hitThreshold` now means "not measurable" in payroll
 * exactly as it does on the dashboard, so there is no number to pass and
 * nothing for a future edit to reach for.
 */
export interface PayrollInputs {
  readonly employees: readonly PayrollEmployee[];
  readonly shorts: readonly PayrollShort[];
  readonly niches: readonly PayrollNiche[];
}

/**
 * Narrows a load to one person.
 *
 * `onlyUserId` exists for the employee's own earnings screen, which needs
 * exactly one line and has no business pulling the team's salaries into the
 * process that serves it. It changes WHICH employees are loaded and nothing
 * else — the niches, the Shorts and the threshold are identical, so the engine
 * sees the same world it would have seen on the admin run and produces the same
 * figure. That identity is the whole point: two gatherers would be two answers.
 *
 * It is NOT an authorization control. The caller decides whose id goes in here,
 * and the only caller that passes one takes it from the session.
 */
export interface PayrollInputOptions {
  readonly onlyUserId?: string;
}

/**
 * Everything the payroll engine needs for one organization and one period.
 *
 * Three reads that do not depend on each other run together. The second pair
 * waits on them: the Shorts query needs the set of owned channels AND the
 * widest window any niche has configured, and the frozen-credit query needs
 * that same window and the people to look credits up for.
 */
export async function loadPayrollInputs(
  organizationId: string,
  period: PayrollPeriodWindow,
  options: PayrollInputOptions = {},
): Promise<PayrollInputs> {
  const [members, niches, ownedChannels] = await Promise.all([
    loadEmployeeMembers(organizationId, options.onlyUserId),
    loadNiches(organizationId),
    loadOwnedChannels(organizationId),
  ]);

  /*
   * Serialised on purpose: the ledger is keyed on the Shorts this run can
   * actually credit, so it has to know them first.
   *
   * It used to bound by `publishedAt` and run in parallel, which was faster and
   * subtly wrong. `PayrollHit.publishedAt` is a copy frozen at finalize;
   * `Video.publishedAt` is rewritten by `buildVideoData` on every sync. Let
   * YouTube correct a publish date and the two disagree — at which point the
   * bounded query stops finding an earlier credit for a Short this run is
   * loading, and the guard against paying twice quietly stops guarding.
   *
   * A video id cannot drift. One extra round trip on a monthly job is the
   * cheapest correctness in this file.
   */
  const shorts = await loadShorts(organizationId, ownedChannels, period, niches);
  const paidVideoIdsByUserId = await loadFinalizedCredits(
    organizationId,
    members.map((member) => member.userId),
    shorts.map((short) => short.videoId),
  );

  // Attached here rather than inside `loadEmployeeMembers` because the ledger
  // query needs the widest configured window, which is loaded alongside the
  // members rather than before them.
  const employees: PayrollEmployee[] = members.map((member) => ({
    ...member,
    alreadyPaidVideoIds: paidVideoIdsByUserId.get(member.userId) ?? [],
  }));

  return { employees, shorts, niches };
}

// ---------------------------------------------------------------------------
// EMPLOYEES
// ---------------------------------------------------------------------------

/**
 * Members who have an EmployeeProfile, with their role and niche assignments.
 *
 * The join runs the other way round from how it reads: the membership is the
 * anchor because that is what carries the role and the MemberNiche rows, and
 * the profile is what makes a member an employee. A member with no profile is
 * not on payroll at all — not on it for zero, simply absent — which is what
 * lets an organization have people in it who are not paid through this system.
 *
 * The profile's own `organizationId` is checked as well as the membership's.
 * `EmployeeProfile.userId` is globally unique, so in a world where somebody
 * belongs to two organizations the profile belongs to exactly one of them, and
 * reading it from the other would be paying a salary out of the wrong budget.
 *
 * Deactivated accounts are deliberately NOT filtered out. Whether somebody is
 * owed money for August is decided by their employment dates, which the engine
 * applies — not by whether their login still works. Someone who left on the
 * 20th is paid for August and cannot sign in; those are different facts.
 */
/**
 * An employee before their frozen credits are attached.
 *
 * The ledger is loaded in a second wave — it needs the niches, which load
 * beside the members rather than before them — so the two halves of a
 * `PayrollEmployee` are assembled in two steps. Spelled as an `Omit` rather
 * than a hand-written twin so a future column on the engine's type cannot be
 * quietly dropped here.
 */
type PayrollMember = Omit<PayrollEmployee, "alreadyPaidVideoIds">;

async function loadEmployeeMembers(
  organizationId: string,
  onlyUserId?: string,
): Promise<PayrollMember[]> {
  const members = await prisma.organizationMember.findMany({
    where: {
      organizationId,
      user: { employeeProfile: { is: { organizationId } } },
      // Narrowed only when a caller asked for one person. `organizationId` is
      // still in the clause above it, so a user id from another workspace
      // matches nothing rather than reaching across the tenancy line.
      ...(onlyUserId ? { userId: onlyUserId } : {}),
    },
    select: {
      role: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          // Columns listed one by one rather than `include`d. `notes` is
          // admin-only free text with no business being in a calculation, and
          // an explicit select is what stops a future field on this table from
          // arriving in a payload by default.
          employeeProfile: {
            select: {
              salaryMinor: true,
              // `hitPaymentMinor` IS DELIBERATELY NOT SELECTED. The per-hit
              // rate moved to the niche, and the engine has no field to receive
              // this one on any more — see `PayrollEmployee`. The column stays
              // in the database because every finalized `PayrollRecord`
              // computed from it has to remain explicable; it is simply not an
              // input to a new calculation, and not fetching it is the cheapest
              // way to guarantee nothing downstream quietly starts reading it
              // again.
              currency: true,
              joinedOn: true,
              employmentEndedOn: true,
            },
          },
        },
      },
      niches: { select: { nicheId: true } },
    },
  });

  const employees: PayrollMember[] = [];

  for (const member of members) {
    const profile = member.user.employeeProfile;
    // Unreachable given the `where` above; the relation is still typed nullable
    // and narrowing it here is cheaper than asserting it away.
    if (!profile) continue;

    employees.push({
      userId: member.user.id,
      // A payroll line with a blank name is unreadable, and the account is
      // guaranteed to have at least one of the two.
      name: member.user.name ?? member.user.email ?? "Unnamed employee",
      email: member.user.email ?? "",
      role: member.role,
      salaryMinor: profile.salaryMinor,
      currency: profile.currency,
      nicheIds: member.niches.map((assignment) => assignment.nicheId),
      joinedOnMs: profile.joinedOn?.getTime() ?? null,
      employmentEndedOnMs: profile.employmentEndedOn?.getTime() ?? null,
    });
  }

  return employees;
}

// ---------------------------------------------------------------------------
// NICHES
// ---------------------------------------------------------------------------

/**
 * Every niche in the organization, with all three numbers and its kind.
 *
 * All of them, not only those attached to owned channels: the engine looks
 * niches up by id from two directions — the employee's assignments and the
 * channel's — and a missing entry would silently drop a hit that should have
 * paid.
 *
 * WATCHLIST NICHES ARE LOADED TOO, AND THAT IS DELIBERATE. Filtering them out
 * here would leave the engine unable to tell "this niche does not pay" from
 * "this niche does not exist", and the two behave differently: a missing entry
 * is skipped silently, while a watchlist one is skipped for a reason the engine
 * states. The exclusion belongs where the rule is written down, not in the
 * query — see `judgeShort`.
 *
 * ALL THREE NUMBERS STAY NULLABLE ALL THE WAY THROUGH, and the engine reads any
 * null as "nothing here can be scored or paid" rather than resolving it to
 * anything. The columns are carried, never coerced — there is no organization
 * default for the window any more than there is for the bar, no fall back to
 * the employee's rate for the price, and adding one would recreate the bug that
 * paid bonuses against numbers nobody had chosen.
 */
/**
 * A niche as THIS module holds it: the engine's shape, plus its format.
 *
 * The format is deliberately NOT on the engine's `PayrollNiche` — the engine
 * is content-agnostic and must stay so. It is consumed entirely inside
 * `loadShorts`, where it narrows each video's `nicheIds` to the channel's
 * SAME-FORMAT niches before the engine ever sees them; handing the narrowed
 * lists over is what keeps the format rule out of the money code.
 */
type LoadedPayrollNiche = PayrollNiche & { readonly format: NicheFormat };

async function loadNiches(organizationId: string): Promise<LoadedPayrollNiche[]> {
  const rows = await prisma.niche.findMany({
    where: { organizationId },
    select: {
      id: true,
      name: true,
      kind: true,
      format: true,
      hitPaymentMinor: true,
      hitThreshold: true,
      hitWindowHours: true,
    },
  });

  return rows.map((row) => ({
    ...row,
    // The column is a portable `String`; the engine takes the two-value union.
    // Anything unrecognised reads as "production", which over-counts visibly
    // rather than silently removing a niche from the run.
    kind: toNicheKind(row.kind),
    // Same treatment, same direction: an unreadable format reads as "shorts",
    // the product that exists, never as a way into a list nobody has built.
    format: toNicheFormat(row.format),
  }));
}

/**
 * The niches ONE person is on right now, with the three numbers that decide
 * whether a hit in them can pay.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS SEPARATELY FROM `loadPayrollInputs`
 * ─────────────────────────────────────────────────────────────────────────────
 * The employee's own earnings screen needs one fact about a FINALIZED month
 * that the stored record cannot supply: whether a niche they are on is missing
 * a setting, so a Short of theirs that reached the bar earned nothing. The
 * engine knows it at calculation time and nothing durable stores it —
 * `PayrollRecord` has no column for it and the schema is not ours to change.
 *
 * Going through `loadPayrollInputs` would have answered it and would have been
 * the wrong instrument twice over: it loads a month of Shorts and every frozen
 * credit to do it, which is a large read to answer a question about three
 * columns, and running the engine over a settled month is the retroactive
 * recalculation the payroll service refuses everywhere else. This reads the
 * assignment and the niches and stops.
 *
 * WHAT THE CALLER MAY SAY WITH IT, AND WHAT IT MAY NOT. This describes the
 * niches TODAY. It is not evidence about what was true when the month was
 * frozen, so nothing built from it may claim a count of Shorts against a
 * settled figure — see `settledGapSentence`, which states the niche's missing
 * setting and says the settled month does not move.
 *
 * `hitPaymentMinor` IS LOADED AND MUST NOT LEAVE THE SERVER. The caller needs
 * it only to decide whether a price exists at all; the amount is gated on
 * `settings.manage` elsewhere and the employee DTO carries the existence of the
 * gap, never the figure. See `niche-pay-disclosure.test.ts` for the endpoint
 * this rule was written after.
 *
 * SCOPE IS BOTH HALVES. `organizationId` sits in the same `where` as `userId`,
 * so an id from another workspace matches nothing rather than reaching across
 * the tenancy line — the pattern `loadEmployeeMembers` follows for the same
 * reason. Callers MUST take `userId` from the session, never from a request.
 */
export async function loadAssignedNiches(
  organizationId: string,
  userId: string,
): Promise<PayrollNiche[]> {
  const member = await prisma.organizationMember.findFirst({
    where: { organizationId, userId },
    select: {
      niches: {
        select: {
          niche: {
            select: {
              id: true,
              name: true,
              kind: true,
              hitPaymentMinor: true,
              hitThreshold: true,
              hitWindowHours: true,
            },
          },
        },
      },
    },
  });

  if (!member) return [];

  return member.niches.map((assignment) => ({
    ...assignment.niche,
    // The column is a portable `String`; the engine takes the two-value union.
    // Anything unrecognised reads as "production", exactly as `loadNiches`
    // resolves it, so one niche cannot be a watchlist one on one screen and a
    // production one on another.
    kind: toNicheKind(assignment.niche.kind),
  }));
}

/**
 * The longest window any niche here has, in hours.
 *
 * Decides how far BEFORE the period the Shorts query has to reach. A hit is
 * paid in the period its window closed in, so a run for February has to see
 * January's Shorts — a Short published on 28 January under a seven-day rule
 * resolves on 4 February and is February's to pay. Reaching back by the widest
 * configured window is the smallest range that provably contains every Short
 * that could resolve inside the period.
 *
 * Zero when nothing is configured, which collapses the range to the period
 * itself — the same query this module ran before windows existed, and the right
 * one, because with no rule anywhere nothing can resolve at all.
 */
function widestWindowHours(niches: readonly PayrollNiche[]): number {
  let widest = 0;
  for (const niche of niches) {
    if (niche.hitWindowHours !== null && niche.hitWindowHours > widest) {
      widest = niche.hitWindowHours;
    }
  }
  return widest;
}

/**
 * Publish dates that could possibly resolve inside the period, as a `where`.
 *
 * ONE DEFINITION, USED TWICE, ON PURPOSE. `loadShorts` selects the Shorts a run
 * may credit; `loadFinalizedCredits` selects the credits that could collide
 * with them. If those two ranges could drift apart, a Short would arrive
 * creditable with its own payment history missing, which is precisely the
 * double payment the ledger exists to stop.
 *
 * Half-open [start, end), like every other date range in this codebase.
 */
function publishedRangeFor(period: PayrollPeriodWindow, niches: readonly PayrollNiche[]) {
  return {
    gte: new Date(period.startsAtMs - widestWindowHours(niches) * HOUR_MS),
    lt: new Date(period.endsAtMs),
  };
}

// ---------------------------------------------------------------------------
// WHAT HAS ALREADY BEEN PAID
// ---------------------------------------------------------------------------

/**
 * The period statuses that mean the figures are stored rather than derived.
 *
 * The same pair `payroll-service` calls frozen, restated rather than imported
 * because that module imports this one and a cycle to share two strings would
 * be a poor trade. "paid" is a finalized period that has additionally been paid
 * out, so it is the stronger case of the same fact, never a weaker one.
 */
const FINALIZED_STATUSES = ["finalized", "paid"] as const;

/**
 * Every Short already credited to these people in a period that is frozen.
 *
 * THIS IS THE LEDGER, AND IT IS WHY THE GUARD IS NOT A DATE. A hit is paid in
 * the period its window closed in — and that date is not stable, because
 * `reevaluateHitsForNiche` rewrites the recorded rule whenever an admin edits a
 * niche. A Short that closed on 4 February under a 168-hour GTA rule closes on
 * 6 March once GTA is 900 hours. February is finalized and its `PayrollHit`
 * rows correctly survive, so March would credit the same videoId to the same
 * person a second time; `@@unique([recordId, videoId])` spans one record and
 * cannot see it. `PayrollHit` rows under a frozen `PayrollRecord` are the only
 * statement of what has actually been paid, so they are what gets checked.
 *
 * DRAFTS ARE DELIBERATELY EXCLUDED. An open period is recalculated on every
 * read by design, so the same Short legitimately moves between two DRAFT
 * periods as its rule changes and neither of them has paid anybody. Including
 * drafts would let whichever month happened to be read first claim it forever.
 *
 * KEYED BY USER, because the bonus is. Two people assigned to the same niche
 * are each credited for one hit, so paying Alex in February must not stop John
 * being paid in March — see `PayrollEmployee.alreadyPaidVideoIds`.
 *
 * BOUNDED BY THE SAME PUBLISH RANGE AS `loadShorts`, which is what keeps this
 * from growing without limit as the years of finalized payroll accumulate. A
 * credit for a Short published outside that range cannot collide with anything
 * this run can credit, because no such Short was loaded. `PayrollHit` carries
 * its own `publishedAt` snapshot, so the filter costs no join.
 */
async function loadFinalizedCredits(
  organizationId: string,
  userIds: readonly string[],
  candidateVideoIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byUserId = new Map<string, string[]>();
  if (userIds.length === 0 || candidateVideoIds.length === 0) return byUserId;

  const hits = await prisma.payrollHit.findMany({
    where: {
      // The exact Shorts this run could credit, so the answer cannot be
      // narrower than the question. `PayrollHit` already indexes videoId.
      videoId: { in: [...candidateVideoIds] },
      record: {
        userId: { in: [...userIds] },
        // `PayrollRecord` carries no organizationId of its own; it hangs off the
        // period, which does. Filtering through the relation is the entire
        // tenancy check, exactly as `loadRecordScoped` does it in the service.
        period: { organizationId, status: { in: [...FINALIZED_STATUSES] } },
      },
    },
    select: { videoId: true, record: { select: { userId: true } } },
  });

  for (const hit of hits) {
    const existing = byUserId.get(hit.record.userId);
    if (existing) existing.push(hit.videoId);
    else byUserId.set(hit.record.userId, [hit.videoId]);
  }

  return byUserId;
}

// ---------------------------------------------------------------------------
// SHORTS
// ---------------------------------------------------------------------------

/**
 * The stored outcome column, narrowed to the four values that exist.
 *
 * Anything else reads as "unknown" — the outcome that earns nothing and that
 * the evaluator re-decides on every run. A stale or hand-edited string must
 * never be mistaken for a frozen "hit" or "miss", because those are the two the
 * engine now takes at their word rather than re-deriving.
 */
function toHitOutcome(stored: string): HitOutcome {
  return stored === "hit" || stored === "miss" || stored === "pending" ? stored : "unknown";
}

interface OwnedChannel {
  readonly channelId: string;
  /** The tracker's label if the team renamed it, otherwise YouTube's title. */
  readonly displayName: string;
  readonly nicheIds: readonly string[];
}

/**
 * The channels this organization owns and still tracks.
 *
 * `ownershipType: "own"` is the entire reason a bonus exists — the flag already
 * on TrackedChannel, not a payroll-specific copy of it. `isActive` excludes
 * channels the team has removed from the tracker: an untracked channel produces
 * no analytics anywhere else in the product, and having it quietly keep paying
 * bonuses would be indefensible.
 */
async function loadOwnedChannels(organizationId: string): Promise<OwnedChannel[]> {
  const tracked = await prisma.trackedChannel.findMany({
    where: { organizationId, ownershipType: "own", isActive: true },
    select: {
      channelId: true,
      label: true,
      channel: { select: { title: true } },
      niches: { select: { nicheId: true } },
    },
  });

  return tracked.map((row) => ({
    channelId: row.channelId,
    // Same precedence the rest of the app uses for a channel's name, so a hit
    // reads with the name the team gave the channel.
    displayName: row.label ?? row.channel.title,
    nicheIds: row.niches.map((assignment) => assignment.nicheId),
  }));
}

/**
 * Videos on an owned channel that could resolve inside the period — the
 * channel's Shorts, and since formats its positively-identified long-form
 * videos too.
 *
 * THE RANGE IS NOT THE PERIOD, AND THAT IS THE WHOLE CHANGE. A hit is paid in
 * the period its window CLOSED in, not the one it was published in, so a
 * February run has to see January's Shorts: one published on 28 January under a
 * seven-day rule resolves on 4 February and February owes the bonus. The query
 * therefore starts `widestWindowHours` before the period and ends at the
 * period's end — the smallest range that provably contains every Short whose
 * window can shut inside it, plus every Short published in the month, which is
 * the population the skipped-niche report is drawn from.
 *
 * BOTH ENDS ARE STILL HALF-OPEN, [start, end), matching every other date range
 * in this codebase. The engine does the precise selection: it computes each
 * Short's `windowClosesAt` per niche and keeps the ones landing inside the
 * period, so this query only has to be a superset and never has to be exact.
 *
 * WHICH VIDEOS, UNDER FORMATS: `isShort: true` OR `classification:
 * "not_short"` — and NEVER the uncertain remainder. An uncertain video belongs
 * to neither format, no niche can judge it, and letting it in through a
 * `!isShort` complement is exactly the inflation `isVideoOfFormat` exists to
 * make unwritable. The OR is deliberately unconditional rather than gated on
 * "does a longform niche exist", because the narrowing below makes the extra
 * rows provably inert — see THE MONEY EDIT.
 *
 * `isAvailable` is deliberately not filtered on. A Short that cleared its
 * window in August and was taken down in September was still a hit in August,
 * and the person who made it is still owed for it.
 *
 * Views are the *current* stored counter. Under a windowed rule that number can
 * only ever rule a hit OUT — a Short still under the bar today cannot have
 * cleared it inside a window that shut months ago. It is never enough on its own
 * to call a window a hit; that is what the evaluation below is for.
 */
async function loadShorts(
  organizationId: string,
  ownedChannels: readonly OwnedChannel[],
  period: PayrollPeriodWindow,
  niches: readonly LoadedPayrollNiche[],
): Promise<PayrollShort[]> {
  if (ownedChannels.length === 0) return [];

  const channelById = new Map(ownedChannels.map((channel) => [channel.channelId, channel]));
  const channelIds = [...channelById.keys()];

  const publishedAt = publishedRangeFor(period, niches);

  // One predicate, used identically by both queries below, so the evaluations
  // can never cover a different population than the videos they judge.
  const formatWhere = { OR: [{ isShort: true }, { classification: "not_short" }] };

  const [videos, evaluations] = await Promise.all([
    prisma.video.findMany({
      where: { channelId: { in: channelIds }, ...formatWhere, publishedAt },
      select: {
        id: true,
        title: true,
        channelId: true,
        viewCount: true,
        publishedAt: true,
        // Both classification columns come back so each video can be tagged
        // with its format, which is what decides WHICH of the channel's niches
        // may judge it below.
        isShort: true,
        classification: true,
      },
    }),
    // Scoped by organization first, then narrowed through the relation with the
    // same predicate as the query above rather than by a list of ids. Same rows,
    // one round trip, and no multi-thousand-element `IN` clause to build.
    //
    // `organizationId` is not decoration here: `Video` is a globally
    // deduplicated row and the verdict belongs to the team whose niche rule
    // produced it. Reading another organization's evaluation would judge these
    // Shorts by somebody else's bar.
    prisma.videoHitEvaluation.findMany({
      where: {
        organizationId,
        video: { channelId: { in: channelIds }, ...formatWhere, publishedAt },
      },
      select: {
        videoId: true,
        // THE VERDICT ITSELF, not only the evidence under it. Payroll reads a
        // settled outcome rather than re-deriving one — a miss inferred from
        // "lifetime is still under the bar" carries no `viewsAtWindow` at all,
        // and re-evaluating it against today's total is how that certain miss
        // decayed into an "unknown". See `storedVerdictFor` in the engine.
        outcome: true,
        nicheId: true,
        thresholdApplied: true,
        windowHoursApplied: true,
        windowClosesAt: true,
        viewsAtWindow: true,
        observedAtHours: true,
      },
    }),
  ]);

  const evidenceByVideoId = new Map<string, PayrollHitEvidence>(
    evaluations.map((evaluation) => [
      evaluation.videoId,
      {
        // The column is a plain string; the engine takes the four-value union.
        // Anything unrecognised reads as "unknown", which earns nothing and is
        // never frozen — the safe direction for a value nobody wrote on purpose.
        outcome: toHitOutcome(evaluation.outcome),
        nicheId: evaluation.nicheId,
        thresholdApplied: evaluation.thresholdApplied,
        windowHoursApplied: evaluation.windowHoursApplied,
        windowClosesAtMs: evaluation.windowClosesAt?.getTime() ?? null,
        // BigInt again, converted once at the edge.
        viewsAtWindow:
          evaluation.viewsAtWindow === null ? null : Number(evaluation.viewsAtWindow),
        observedAtHours: evaluation.observedAtHours,
      },
    ]),
  );

  /*
   * THE MONEY EDIT: each video's candidate niches are the channel's SAME-FORMAT
   * niches, worked out once per channel per format rather than per video.
   *
   * The engine attributes a hit with `pickGoverningRule` over `short.nicheIds`
   * narrowed to the employee's assignments (`judgeShort`, payroll-engine.ts) —
   * it has no format concept, so whatever ids arrive here ARE the candidate
   * list. Hand a long-form video the channel's Shorts niches and a Long Form
   * hit gets judged by a Shorts rule and paid at a Shorts rate; the narrowing
   * below is the one line standing between those two prices.
   *
   * THE IDENTITY ARGUMENT, for an organization with zero longform niches
   * (every organization today): the `not_short` arm of the query loads videos
   * whose nicheIds narrow to [] — there are no longform niches to match. The
   * engine was READ to confirm what it does with an empty list: `judgeShort`
   * builds its candidates by iterating `short.nicheIds` (payroll-engine.ts
   * ~925), so an empty list yields no candidates, `pickGoverningRule` returns
   * null, and both `calculateEmployeePayroll` (~1129) and `runScope` (~1423)
   * `continue` past the video — it earns nothing, is reported nowhere (the
   * skipped-niche and unresolved buckets are keyed off `short.nicheIds` and a
   * judged verdict respectively), and moves no total by a minor unit. That is
   * the "unattributable" behaviour this narrowing relies on, and it is why the
   * OR arm needs no existence gate.
   */
  const formatById = new Map(niches.map((niche) => [niche.id, niche.format]));
  const formatNicheIds = new Map(
    ownedChannels.map((channel) => {
      // A niche id the loader somehow did not return reads as "shorts" — the
      // same fail-closed direction `toNicheFormat` takes, and never a way for
      // a long-form video to acquire a judge by accident.
      const idsOf = (format: NicheFormat) =>
        channel.nicheIds.filter((id) => (formatById.get(id) ?? "shorts") === format);
      return [
        channel.channelId,
        { shorts: idsOf("shorts"), longform: idsOf("longform") } as const,
      ];
    }),
  );

  const shorts: PayrollShort[] = [];

  for (const video of videos) {
    const channel = channelById.get(video.channelId);
    if (!channel) continue;

    // The query admits exactly two populations — `isShort: true` and
    // `classification: "not_short"` — so this tag is total over what can reach
    // it, and `isShort` wins the (data-impossible) case of a row claiming both.
    const format: NicheFormat = video.isShort ? "shorts" : "longform";

    shorts.push({
      // The internal Video id, which is what `videoId` means everywhere else in
      // this schema (SavedShort, Note). It is also what lands on PayrollHit,
      // where the unique constraint on (record, video) is the anti-double-count
      // guarantee — so it has to be the same identifier on both sides.
      videoId: video.id,
      title: video.title,
      channelId: video.channelId,
      channelName: channel.displayName,
      // BigInt counters cannot cross into JSON and cannot be arithmetic with a
      // threshold. Converted once, here, at the edge.
      views: Number(video.viewCount),
      publishedAtMs: video.publishedAt.getTime(),
      // THE NARROWED LIST, not the channel's full one — see THE MONEY EDIT
      // above. With every niche format "shorts", the shorts list IS the full
      // list, so today's Shorts arrive with exactly the ids they always did.
      nicheIds: formatNicheIds.get(video.channelId)?.[format] ?? [],
      // Not a claim this module is making on trust: the query above loaded only
      // owned, active channels, so every row that reaches here is one. The
      // engine re-checks the flag anyway, which is how a future caller that
      // widens the query fails safe rather than silently paying for a
      // competitor's viral Short.
      isOwnChannel: true,
      // Null is ordinary, not an error: on this account only 59 Shorts have any
      // snapshot inside seven days of publishing, and nothing has been
      // evaluated for the rest. The engine turns that absence into "miss" or
      // "unknown" by inference rather than into a hit.
      evaluation: evidenceByVideoId.get(video.id) ?? null,
    });
  }

  return shorts;
}
