import "server-only";

import { z } from "zod";
import { prisma } from "@/server/db";
import { errors } from "@/server/errors";
import {
  listAuditEvents,
  recordAudit,
  type AuditEntryDTO,
} from "@/server/audit/audit-service";
import { revokeAllSessionsForUser } from "@/server/auth/session";
import {
  GRANTABLE_PERMISSIONS,
  ROLE_ORDER,
  isRole,
  roleDefinition,
} from "@/lib/auth/permissions";
import { createInvitation } from "./auth-service";
import { isEmailConfigured, sendInvitationEmail } from "./email-service";
import { getCurrentOrgId, getScope } from "./user-service";

/**
 * User administration — the read models and state changes behind /api/admin.
 *
 * WHY THIS IS A SERVICE AND NOT SEVEN ROUTE HANDLERS
 * Three of these operations share the same two invariants (below), and the
 * admin user list is assembled the same way whether it is being listed or
 * returned after an edit. Duplicating either across route files is how one copy
 * quietly loses a guard.
 *
 * THE TWO INVARIANTS
 *   1. Nobody may lock themselves out. An admin cannot change their own role or
 *      deactivate their own account.
 *   2. The organization always keeps at least one active admin. Losing the last
 *      one is not recoverable from inside the product — it takes database
 *      access — so it is refused rather than warned about.
 *
 * SECRETS
 * `passwordHash`, `tokenHash` and the encrypted YouTube tokens are never
 * selected here. Every query lists its columns explicitly rather than returning
 * a row, so a column added to `AppUser` or `Invitation` later cannot appear in
 * an admin response by default.
 */

// ---------------------------------------------------------------------------
// WIRE TYPES
// ---------------------------------------------------------------------------

/** One member of the organization, as the admin screen needs them. */
export interface AdminUserDTO {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly role: string;
  readonly roleLabel: string;
  /** "active" | "invited" | "deactivated" */
  readonly status: string;
  readonly lastLoginAt: number | null;
  readonly deactivatedAt: number | null;
  readonly createdAt: number;
  /** Individual permissions on top of the role. */
  readonly grants: readonly string[];
  /** Sessions that could still authenticate a request right now. */
  readonly activeSessions: number;
  /** So the UI can disable the controls invariant 1 would reject anyway. */
  readonly isSelf: boolean;
}

export interface AdminInvitationDTO {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: string;
  readonly roleLabel: string;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly invitedByName: string | null;
}

export interface AdminDirectory {
  readonly users: readonly AdminUserDTO[];
  readonly invitations: readonly AdminInvitationDTO[];
}

export interface InviteResult {
  readonly invitation: AdminInvitationDTO;
  /**
   * Returned exactly once, and on purpose.
   *
   * Email is optional in this product. With no mail provider configured the
   * admin copies this link and sends it however they like — that is the
   * documented path, not a degraded one, which is why the URL is in the
   * response body rather than only in a message nobody may receive.
   */
  readonly inviteUrl: string;
  readonly emailSent: boolean;
  readonly emailConfigured: boolean;
}

export interface AdminOverview {
  readonly users: {
    readonly total: number;
    readonly active: number;
    readonly invited: number;
    readonly deactivated: number;
  };
  readonly sessions: { readonly active: number };
  readonly channels: {
    readonly own: number;
    readonly competitor: number;
    readonly total: number;
  };
  readonly niches: number;
  readonly youtube: {
    readonly connections: number;
    readonly needingReauth: number;
  };
  readonly sync: {
    readonly lastRunAt: number | null;
    readonly lastStatus: string | null;
    readonly runsLast24h: number;
    readonly failuresLast24h: number;
  };
  readonly recentActivity: readonly AuditEntryDTO[];
}

// ---------------------------------------------------------------------------
// SCHEMAS
// ---------------------------------------------------------------------------

export const inviteMemberSchema = z.object({
  email: z.string().trim().min(1, "Enter an email address.").max(320),
  name: z.string().trim().max(120).optional(),
  role: z.string().trim().min(1, "Choose a role."),
});

export const updateMemberSchema = z
  .object({
    role: z.string().trim().min(1).optional(),
    /**
     * Only the two states an admin can put someone in. "invited" is not
     * settable: it describes an account that has never chosen a password, and
     * an admin flipping somebody back to it would produce an account nobody
     * can sign into and no link to fix it with.
     */
    status: z.enum(["active", "deactivated"]).optional(),
  })
  .refine((value) => value.role !== undefined || value.status !== undefined, {
    message: "Nothing to change — send a role, a status, or both.",
  });

export const replaceGrantsSchema = z.object({
  permissions: z.array(z.string().trim().min(1)).max(GRANTABLE_PERMISSIONS.length),
});

export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

// ---------------------------------------------------------------------------
// READ: the admin directory
// ---------------------------------------------------------------------------

/**
 * The columns of `AppUser` an admin screen is entitled to.
 *
 * Hoisted to a constant so the list read and the read that follows an edit
 * cannot drift apart — and so `passwordHash` is absent in exactly one place
 * that has to be got right.
 */
const ADMIN_USER_COLUMNS = {
  id: true,
  name: true,
  email: true,
  status: true,
  lastLoginAt: true,
  deactivatedAt: true,
  createdAt: true,
} as const;

const ADMIN_MEMBER_SELECT = {
  role: true,
  grants: { select: { permission: true } },
  user: { select: ADMIN_USER_COLUMNS },
} as const;

const ADMIN_INVITATION_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  expiresAt: true,
  createdAt: true,
  createdBy: { select: { name: true, email: true } },
} as const;

interface MemberRow {
  role: string;
  grants: { permission: string }[];
  user: {
    id: string;
    name: string | null;
    email: string | null;
    status: string;
    lastLoginAt: Date | null;
    deactivatedAt: Date | null;
    createdAt: Date;
  };
}

interface InvitationRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  expiresAt: Date;
  createdAt: Date;
  createdBy: { name: string | null; email: string | null } | null;
}

function toAdminUserDTO(
  member: MemberRow,
  activeSessions: number,
  selfUserId: string,
): AdminUserDTO {
  return {
    id: member.user.id,
    name: member.user.name,
    email: member.user.email,
    role: member.role,
    roleLabel: roleDefinition(member.role).label,
    status: member.user.status,
    lastLoginAt: member.user.lastLoginAt?.getTime() ?? null,
    deactivatedAt: member.user.deactivatedAt?.getTime() ?? null,
    createdAt: member.user.createdAt.getTime(),
    grants: member.grants.map((grant) => grant.permission).sort(),
    activeSessions,
    isSelf: member.user.id === selfUserId,
  };
}

function toAdminInvitationDTO(row: InvitationRow): AdminInvitationDTO {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    roleLabel: roleDefinition(row.role).label,
    expiresAt: row.expiresAt.getTime(),
    createdAt: row.createdAt.getTime(),
    invitedByName: row.createdBy?.name ?? row.createdBy?.email ?? null,
  };
}

/**
 * How many sessions could authenticate each of these users right now.
 *
 * One grouped query rather than a count per row: this list is rendered on every
 * visit to the admin screen and an N+1 here would be a query per employee.
 * "Active" means neither revoked nor expired — a row that exists is not a way
 * in, and reporting expired ones would make a departed employee look present.
 */
async function countActiveSessions(userIds: readonly string[]): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();

  const rows = await prisma.session.groupBy({
    by: ["userId"],
    where: {
      userId: { in: [...userIds] },
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    _count: { _all: true },
  });

  return new Map(rows.map((row) => [row.userId, row._count._all]));
}

/** Most privileged first, then alphabetical — how an admin reads a team list. */
function compareMembers(a: MemberRow, b: MemberRow): number {
  const rank = (role: string): number => {
    const index = (ROLE_ORDER as readonly string[]).indexOf(role);
    // An unrecognised role sorts last rather than first: a stale or hand-edited
    // value must never be presented as the most senior person in the room.
    return index === -1 ? ROLE_ORDER.length : index;
  };

  const byRole = rank(a.role) - rank(b.role);
  if (byRole !== 0) return byRole;

  const nameA = a.user.name ?? a.user.email ?? "";
  const nameB = b.user.name ?? b.user.email ?? "";
  return nameA.localeCompare(nameB);
}

/** Everyone in the caller's organization, plus the invitations still outstanding. */
export async function listAdminDirectory(): Promise<AdminDirectory> {
  const { organizationId, userId } = await getScope();

  const [members, invitations] = await Promise.all([
    prisma.organizationMember.findMany({
      where: { organizationId },
      select: ADMIN_MEMBER_SELECT,
    }),
    prisma.invitation.findMany({
      // Outstanding means "not yet used and not called off". Expired ones are
      // deliberately included: an admin who cannot see the invite they sent
      // last week has no way to tell "it lapsed" from "it never happened", and
      // `expiresAt` is on the wire so the UI can label it. Re-inviting the same
      // address supersedes the old row, so these do not accumulate.
      where: { organizationId, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: ADMIN_INVITATION_SELECT,
    }),
  ]);

  const sessionCounts = await countActiveSessions(members.map((member) => member.user.id));

  return {
    users: [...members]
      .sort(compareMembers)
      .map((member) =>
        toAdminUserDTO(member, sessionCounts.get(member.user.id) ?? 0, userId),
      ),
    invitations: invitations.map(toAdminInvitationDTO),
  };
}

/** One member, in the same shape the list uses, so an edit can update in place. */
async function loadAdminUser(
  organizationId: string,
  targetUserId: string,
  selfUserId: string,
): Promise<AdminUserDTO> {
  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: targetUserId } },
    select: ADMIN_MEMBER_SELECT,
  });
  if (!member) throw errors.notFound("user");

  const counts = await countActiveSessions([targetUserId]);
  return toAdminUserDTO(member, counts.get(targetUserId) ?? 0, selfUserId);
}

// ---------------------------------------------------------------------------
// WRITE: invitations
// ---------------------------------------------------------------------------

export async function inviteMember(
  input: z.infer<typeof inviteMemberSchema>,
  request: Request,
): Promise<InviteResult> {
  const { organizationId, actor } = await getScope();

  // Scope and authorship come from the session, never from the body. A request
  // that could name its own `organizationId` would be a cross-tenant invite
  // API, and one that could name its own inviter would forge the audit trail.
  const created = await createInvitation(
    { email: input.email, name: input.name ?? null, role: input.role },
    {
      organizationId,
      actorUserId: actor.userId,
      actorLabel: actor.name ?? actor.email,
    },
    { request },
  );

  const roleLabel = roleDefinition(created.role).label;

  // Delivery is attempted after the invitation exists, and its failure is
  // reported rather than thrown: the invitation is valid either way and the
  // admin still has the link. Rolling this back because a mail provider was
  // down would destroy the one artefact that still works.
  const delivery = await sendInvitationEmail(created.email, created.inviteUrl, {
    inviterName: actor.name,
    roleLabel,
    organizationName: actor.organizationName,
  });

  const row = await prisma.invitation.findFirst({
    where: { id: created.id, organizationId },
    select: ADMIN_INVITATION_SELECT,
  });

  return {
    // Read back so the client gets the same shape the list returns and can
    // append the row without a refetch. The fallback covers the only way the
    // read can miss — a concurrent revoke — where reporting what we just
    // created is still the truthful answer.
    invitation: row
      ? toAdminInvitationDTO(row)
      : {
          id: created.id,
          email: created.email,
          name: input.name?.trim() || null,
          role: created.role,
          roleLabel,
          expiresAt: created.expiresAt.getTime(),
          createdAt: Date.now(),
          invitedByName: actor.name ?? actor.email,
        },
    inviteUrl: created.inviteUrl,
    emailSent: delivery.sent,
    emailConfigured: isEmailConfigured(),
  };
}

export interface RevokedInvitation {
  readonly id: string;
  readonly email: string;
  readonly revokedAt: number;
}

export async function revokeInvitation(
  invitationId: string,
  request: Request,
): Promise<RevokedInvitation> {
  const { organizationId, actor } = await getScope();

  // `findFirst` with the organization in the filter, never `findUnique` on the
  // id alone: an id from the URL is a guess until it is proven to belong to the
  // caller's organization.
  const invitation = await prisma.invitation.findFirst({
    where: { id: invitationId, organizationId },
    select: { id: true, email: true, role: true, acceptedAt: true, revokedAt: true },
  });
  if (!invitation) throw errors.notFound("invitation");

  if (invitation.acceptedAt) {
    // Revoking here would imply the account it created is gone, which it is
    // not. Deactivating that user is the action they actually want.
    throw errors.invalidInput(
      "That invitation has already been accepted. Deactivate the account instead.",
    );
  }

  // Already revoked is not an error — a double-click must not produce one — but
  // it is not a second event either, so nothing is audited.
  if (invitation.revokedAt) {
    return {
      id: invitation.id,
      email: invitation.email,
      revokedAt: invitation.revokedAt.getTime(),
    };
  }

  const revokedAt = new Date();
  await prisma.invitation.updateMany({
    where: { id: invitationId, organizationId, acceptedAt: null, revokedAt: null },
    data: { revokedAt },
  });

  await recordAudit(
    {
      organizationId,
      actorUserId: actor.userId,
      actorLabel: actor.name ?? actor.email,
      request,
    },
    {
      action: "user.invitation_revoked",
      summary: `Revoked the invitation for ${invitation.email}`,
      targetType: "invitation",
      targetId: invitation.id,
      targetLabel: invitation.email,
      metadata: { role: invitation.role },
    },
  );

  return { id: invitation.id, email: invitation.email, revokedAt: revokedAt.getTime() };
}

// ---------------------------------------------------------------------------
// WRITE: role and status
// ---------------------------------------------------------------------------

export async function updateMember(
  targetUserId: string,
  input: UpdateMemberInput,
  request: Request,
): Promise<AdminUserDTO> {
  const { organizationId, actor } = await getScope();

  if (input.role !== undefined && !isRole(input.role)) {
    throw errors.invalidInput("Choose a valid role.");
  }

  // GUARD (a) — nobody edits their own access.
  //
  // Demoting or deactivating yourself is the one mistake in this screen with no
  // undo: the controls that would reverse it are the controls you just gave
  // away. If you are the only admin it takes database access to recover, and if
  // you are not, it still means asking a colleague to fix an account you can no
  // longer see. Refusing outright is cheaper than every alternative, and an
  // admin who genuinely wants out asks another admin — which leaves a name in
  // the audit log, as it should.
  if (targetUserId === actor.userId) {
    if (input.role !== undefined) {
      throw errors.invalidInput(
        "You cannot change your own role. Ask another admin to do it.",
      );
    }
    if (input.status === "deactivated") {
      throw errors.invalidInput(
        "You cannot deactivate your own account. Ask another admin to do it.",
      );
    }
  }

  const outcome = await prisma.$transaction(async (tx) => {
    const member = await tx.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: targetUserId } },
      select: {
        id: true,
        role: true,
        user: {
          select: { id: true, name: true, email: true, status: true, deactivatedAt: true },
        },
      },
    });
    // Scoped lookup, so a valid id belonging to another organization is a 404
    // here rather than an edit.
    if (!member) throw errors.notFound("user");

    const previousRole = member.role;
    const wasActive = member.user.status === "active" && !member.user.deactivatedAt;

    let roleChanged = false;
    let statusChange: "deactivated" | "reactivated" | null = null;
    let sessionsRevoked = 0;

    if (input.role !== undefined && input.role !== previousRole) {
      await tx.organizationMember.update({
        where: { id: member.id },
        data: { role: input.role },
      });
      roleChanged = true;
    }

    if (input.status === "deactivated" && wasActive) {
      await tx.appUser.update({
        where: { id: targetUserId },
        data: { status: "deactivated", deactivatedAt: new Date() },
      });
      // Same transaction as the status flip. `deactivatedAt` alone already ends
      // access — the DAL re-reads it on every request — but a half-applied
      // deactivation, either half, is a state nobody should have to reason
      // about while dealing with a compromised account.
      sessionsRevoked = await revokeAllSessionsForUser(targetUserId, tx);
      statusChange = "deactivated";
    } else if (input.status === "active" && !wasActive) {
      await tx.appUser.update({
        where: { id: targetUserId },
        data: {
          status: "active",
          deactivatedAt: null,
          // Cleared too, because a lockout that outlives a reactivation looks
          // exactly like a reactivation that silently failed. Sessions are not
          // restored: revocation is one-way and they sign in again.
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      statusChange = "reactivated";
    }

    // GUARD (b) — the organization keeps at least one active admin.
    //
    // Counted INSIDE the transaction and AFTER the write, which is what makes
    // it a real check rather than a courtesy. Counting beforehand asks "are
    // there two admins?", and two concurrent demotions both get "yes" and both
    // proceed. Counting afterwards asks the only question that matters — "does
    // an active admin remain?" — sees this transaction's own change, and rolls
    // it back if the answer is no.
    //
    // Under PostgreSQL's default READ COMMITTED a narrow window survives: two
    // transactions can each count before the other commits. Closing it entirely
    // needs SERIALIZABLE, which the SQLite/PostgreSQL portability contract in
    // prisma/schema.prisma makes awkward to set here. This ordering removes the
    // race an admin can actually hit — two browser tabs, one slow click — and
    // the residual one requires overlapping requests measured in milliseconds.
    const targetWasActiveAdmin = previousRole === "admin" && wasActive;
    if (targetWasActiveAdmin && (roleChanged || statusChange === "deactivated")) {
      const remainingAdmins = await tx.organizationMember.count({
        where: {
          organizationId,
          role: "admin",
          user: { status: "active", deactivatedAt: null },
        },
      });
      if (remainingAdmins === 0) {
        throw errors.invalidInput(
          "This is the last active admin. Promote someone else to admin first — an organization with no admin cannot be repaired from inside the app.",
        );
      }
    }

    return {
      previousRole,
      roleChanged,
      statusChange,
      sessionsRevoked,
      label: member.user.name ?? member.user.email ?? targetUserId,
    };
  });

  // Audited after the commit, never inside it: an entry written in a
  // transaction that later rolls back would claim a change that did not happen.
  const auditContext = {
    organizationId,
    actorUserId: actor.userId,
    actorLabel: actor.name ?? actor.email,
    request,
  };

  if (outcome.roleChanged && input.role !== undefined) {
    await recordAudit(auditContext, {
      action: "user.role_changed",
      summary: `Changed ${outcome.label} from ${roleDefinition(outcome.previousRole).label} to ${roleDefinition(input.role).label}`,
      targetType: "user",
      targetId: targetUserId,
      targetLabel: outcome.label,
      metadata: { from: outcome.previousRole, to: input.role },
    });
  }

  if (outcome.statusChange === "deactivated") {
    await recordAudit(auditContext, {
      action: "user.deactivated",
      summary: `Deactivated ${outcome.label} and signed out ${outcome.sessionsRevoked} session${outcome.sessionsRevoked === 1 ? "" : "s"}`,
      targetType: "user",
      targetId: targetUserId,
      targetLabel: outcome.label,
      metadata: { sessionsRevoked: outcome.sessionsRevoked, role: outcome.previousRole },
    });
  }

  if (outcome.statusChange === "reactivated") {
    await recordAudit(auditContext, {
      action: "user.reactivated",
      summary: `Reactivated ${outcome.label}`,
      targetType: "user",
      targetId: targetUserId,
      targetLabel: outcome.label,
      metadata: { role: outcome.previousRole },
    });
  }

  return loadAdminUser(organizationId, targetUserId, actor.userId);
}

// ---------------------------------------------------------------------------
// WRITE: individual permission grants
// ---------------------------------------------------------------------------

export interface GrantsResult {
  readonly userId: string;
  readonly grants: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

const GRANTABLE: ReadonlySet<string> = new Set<string>(GRANTABLE_PERMISSIONS);

/**
 * Replaces a member's individual grants with exactly this set.
 *
 * PUT rather than POST/DELETE pairs because the UI is a checklist: sending the
 * whole set means the server's answer is whatever the admin last saw, with no
 * chance of a lost tick from two half-applied requests.
 */
export async function replaceMemberGrants(
  targetUserId: string,
  permissions: readonly string[],
  request: Request,
): Promise<GrantsResult> {
  const { organizationId, actor } = await getScope();

  // Allow-list, not deny-list. `users.manage` is absent from
  // GRANTABLE_PERMISSIONS on purpose — see the note in permissions.ts: the
  // ability to create admins is the one capability that lets somebody escalate
  // themselves without limit, so it may only arrive with the Admin role, as a
  // visible decision. Anything unrecognised is rejected rather than ignored,
  // because silently dropping a permission an admin believed they granted is
  // the failure mode where the UI and reality disagree.
  const rejected = permissions.filter((permission) => !GRANTABLE.has(permission));
  if (rejected.length > 0) {
    throw errors.invalidInput(`“${rejected[0]}” is not a permission that can be granted.`);
  }

  const desired = new Set(permissions);

  const member = await prisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: targetUserId } },
    select: {
      id: true,
      grants: { select: { permission: true } },
      user: { select: { name: true, email: true } },
    },
  });
  if (!member) throw errors.notFound("user");

  const current = new Set(member.grants.map((grant) => grant.permission));
  const added = [...desired].filter((permission) => !current.has(permission)).sort();
  // Anything held but not asked for goes, including a key that has since been
  // dropped from the catalogue or was never grantable. Replacing the set is
  // what cleans those up; nothing else would.
  const removed = [...current].filter((permission) => !desired.has(permission)).sort();

  if (added.length > 0 || removed.length > 0) {
    await prisma.$transaction(async (tx) => {
      if (removed.length > 0) {
        await tx.memberPermissionGrant.deleteMany({
          where: { memberId: member.id, permission: { in: removed } },
        });
      }
      if (added.length > 0) {
        await tx.memberPermissionGrant.createMany({
          data: added.map((permission) => ({
            memberId: member.id,
            permission,
            // Who widened this person's access, kept on the row so the answer
            // survives the audit retention window.
            grantedById: actor.userId,
          })),
        });
      }
    });
  }

  const label = member.user.name ?? member.user.email ?? targetUserId;
  const auditContext = {
    organizationId,
    actorUserId: actor.userId,
    actorLabel: actor.name ?? actor.email,
    request,
  };

  // Two entries rather than one "grants updated", because granting and revoking
  // are different questions to ask the log later, and a single entry would
  // force whoever is reading it to diff the metadata to find out which happened.
  if (added.length > 0) {
    await recordAudit(auditContext, {
      action: "user.permission_granted",
      summary: `Granted ${label}: ${added.join(", ")}`,
      targetType: "user",
      targetId: targetUserId,
      targetLabel: label,
      metadata: { permissions: added, count: added.length },
    });
  }

  if (removed.length > 0) {
    await recordAudit(auditContext, {
      action: "user.permission_revoked",
      summary: `Revoked from ${label}: ${removed.join(", ")}`,
      targetType: "user",
      targetId: targetUserId,
      targetLabel: label,
      metadata: { permissions: removed, count: removed.length },
    });
  }

  return {
    userId: targetUserId,
    grants: [...desired].sort(),
    added,
    removed,
  };
}

// ---------------------------------------------------------------------------
// READ: the admin dashboard summary
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many recent audit entries the dashboard shows before "see all". */
const RECENT_ACTIVITY_LIMIT = 10;

export async function getAdminOverview(): Promise<AdminOverview> {
  const organizationId = await getCurrentOrgId();
  const now = new Date();
  const dayAgo = new Date(now.getTime() - DAY_MS);

  // A refresh run belongs to a Channel, and a Channel is shared: the same
  // YouTube channel can be tracked by two organizations, so runs are scoped
  // through this organization's own tracking rows rather than counted globally.
  const orgRuns = { channel: { trackedBy: { some: { organizationId } } } };

  const [
    memberStatuses,
    activeSessions,
    channelCounts,
    niches,
    connectionCounts,
    lastRun,
    runsLast24h,
    failuresLast24h,
    recent,
  ] = await Promise.all([
    prisma.organizationMember.findMany({
      where: { organizationId },
      select: { user: { select: { status: true, deactivatedAt: true } } },
    }),
    prisma.session.count({
      where: {
        revokedAt: null,
        expiresAt: { gt: now },
        // Scoped through membership: this is "sessions in this workspace", not
        // "sessions on this server".
        user: { memberships: { some: { organizationId } } },
      },
    }),
    prisma.trackedChannel.groupBy({
      by: ["ownershipType"],
      // Removed channels are soft-deleted, and counting them would tell an
      // admin they track more than the dashboard shows.
      where: { organizationId, isActive: true },
      _count: { _all: true },
    }),
    prisma.niche.count({ where: { organizationId } }),
    prisma.youTubeConnection.groupBy({
      by: ["status"],
      where: { organizationId },
      _count: { _all: true },
    }),
    prisma.channelRefreshRun.findFirst({
      where: orgRuns,
      orderBy: { startedAt: "desc" },
      select: { startedAt: true, status: true },
    }),
    prisma.channelRefreshRun.count({ where: { ...orgRuns, startedAt: { gte: dayAgo } } }),
    prisma.channelRefreshRun.count({
      // "error" only. "partial" is a run that finished with some channels
      // refreshed, which is a degraded success — counting it as a failure would
      // make a working sync look broken.
      where: { ...orgRuns, startedAt: { gte: dayAgo }, status: "error" },
    }),
    listAuditEvents({ organizationId, limit: RECENT_ACTIVITY_LIMIT }),
  ]);

  // Buckets are mutually exclusive, so the three always sum to `total`. A
  // deactivated account keeps whatever `status` string it had, so the
  // deactivation test comes first.
  let active = 0;
  let invited = 0;
  let deactivated = 0;
  for (const member of memberStatuses) {
    if (member.user.deactivatedAt || member.user.status === "deactivated") deactivated += 1;
    else if (member.user.status === "invited") invited += 1;
    else active += 1;
  }

  const own = channelCounts.find((row) => row.ownershipType === "own")?._count._all ?? 0;
  const competitor =
    channelCounts.find((row) => row.ownershipType === "competitor")?._count._all ?? 0;

  // A revoked connection is not a connection; it is a row kept for history.
  // Counting it would put a number on the dashboard that no sync can use.
  const connections = connectionCounts
    .filter((row) => row.status !== "revoked")
    .reduce((sum, row) => sum + row._count._all, 0);
  const needingReauth =
    connectionCounts.find((row) => row.status === "needs_reauth")?._count._all ?? 0;

  return {
    users: { total: memberStatuses.length, active, invited, deactivated },
    sessions: { active: activeSessions },
    channels: {
      own,
      competitor,
      // Summed from the grouped rows rather than counted separately, so the
      // parts and the whole cannot disagree if a third ownership type appears.
      total: channelCounts.reduce((sum, row) => sum + row._count._all, 0),
    },
    niches,
    youtube: { connections, needingReauth },
    sync: {
      // `startedAt`, not `finishedAt`: a run still in flight has no finish time,
      // and "last sync: never" while one is running would be wrong.
      lastRunAt: lastRun?.startedAt.getTime() ?? null,
      lastStatus: lastRun?.status ?? null,
      runsLast24h,
      failuresLast24h,
    },
    recentActivity: recent.entries,
  };
}
