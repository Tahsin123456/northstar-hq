import "server-only";

import { prisma } from "@/server/db";
import type {
  PayrollEmployee,
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
 * Three reads that do not depend on each other run together; the Shorts query
 * waits only because it needs the set of owned channels first.
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

  const shorts = await loadShorts(ownedChannels, period);

  return { employees: members, shorts, niches };
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
async function loadEmployeeMembers(
  organizationId: string,
  onlyUserId?: string,
): Promise<PayrollEmployee[]> {
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
              hitPaymentMinor: true,
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

  const employees: PayrollEmployee[] = [];

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
      hitPaymentMinor: profile.hitPaymentMinor,
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
 * Every niche in the organization, with its canonical threshold.
 *
 * All of them, not only those attached to owned channels: the engine looks
 * niches up by id from two directions — the employee's assignments and the
 * channel's — and a missing entry would silently drop a hit that should have
 * paid. `hitThreshold` stays nullable all the way through, and the engine reads
 * a null as "nothing here can be a hit" rather than resolving it to anything —
 * so the column is carried, never coerced.
 */
async function loadNiches(organizationId: string): Promise<PayrollNiche[]> {
  return prisma.niche.findMany({
    where: { organizationId },
    select: { id: true, name: true, hitThreshold: true },
  });
}

// ---------------------------------------------------------------------------
// SHORTS
// ---------------------------------------------------------------------------

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
 * Shorts published inside the period on an owned channel.
 *
 * THE WINDOW IS HALF-OPEN, [startsAt, endsAt), matching every other date range
 * in this codebase. A Short published at exactly midnight on the 1st of
 * September belongs to September, once, rather than to both months or to
 * neither.
 *
 * `isAvailable` is deliberately not filtered on. A Short that hit a million
 * views in August and was taken down in September was still a hit in August,
 * and the person who made it is still owed for it.
 *
 * Views are the *current* stored counter, which is exactly what makes an open
 * period a live figure and a finalized one a frozen snapshot: `PayrollHit`
 * records the count as it stood at finalization precisely because this number
 * keeps moving.
 */
async function loadShorts(
  ownedChannels: readonly OwnedChannel[],
  period: PayrollPeriodWindow,
): Promise<PayrollShort[]> {
  if (ownedChannels.length === 0) return [];

  const channelById = new Map(ownedChannels.map((channel) => [channel.channelId, channel]));

  const videos = await prisma.video.findMany({
    where: {
      channelId: { in: [...channelById.keys()] },
      isShort: true,
      publishedAt: { gte: new Date(period.startsAtMs), lt: new Date(period.endsAtMs) },
    },
    select: {
      id: true,
      title: true,
      channelId: true,
      viewCount: true,
      publishedAt: true,
    },
  });

  const shorts: PayrollShort[] = [];

  for (const video of videos) {
    const channel = channelById.get(video.channelId);
    if (!channel) continue;

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
      nicheIds: channel.nicheIds,
      // Not a claim this module is making on trust: the query above loaded only
      // owned, active channels, so every row that reaches here is one. The
      // engine re-checks the flag anyway, which is how a future caller that
      // widens the query fails safe rather than silently paying for a
      // competitor's viral Short.
      isOwnChannel: true,
    });
  }

  return shorts;
}
