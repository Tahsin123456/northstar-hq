import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { errors } from "@/server/errors";
import {
  fakeVerifyPassword,
  hashPassword,
  validatePasswordStrength,
  verifyPassword,
} from "@/server/auth/password";
import { createSession, revokeAllSessionsForUser } from "@/server/auth/session";
import { generateSingleUseToken, hashToken } from "@/server/auth/tokens";
import {
  RATE_LIMITS,
  clientIpFrom,
  enforceRateLimit,
  resetRateLimit,
  userAgentFrom,
} from "@/server/auth/rate-limit";
import { recordAudit } from "@/server/audit/audit-service";
import { resolveAppUrl } from "@/server/auth/auth-env";
import { isRole, type Role } from "@/lib/auth/permissions";

/**
 * Authentication flows: sign in, first-run setup, invitations, password resets.
 *
 * Two principles run through the whole file.
 *
 * IT MUST NOT SAY WHO WORKS HERE.
 * Every failure path is written so an unauthenticated caller cannot tell an
 * unknown email from a known one — same message, same status, and the same
 * amount of CPU burned (see `fakeVerifyPassword`). Otherwise the login form
 * becomes a way to enumerate Northstar's staff, which is reconnaissance for a
 * phishing campaign.
 *
 * NOBODY HANDLES SOMEBODY ELSE'S PASSWORD.
 * An admin creates an account shell and the employee sets their own secret
 * through a single-use link. There is deliberately no code path anywhere in
 * this application that lets one person set another's password, and no way to
 * read one — the hash is never selected into a DTO.
 */

const LOCKOUT_THRESHOLD = 8;
const LOCKOUT_MINUTES = 15;
const INVITATION_TTL_HOURS = 72;
const RESET_TTL_MINUTES = 60;

/**
 * The account has a password but no permission to use it yet.
 *
 * Accepting an invitation lands here rather than in "active": choosing a
 * password proves the person read their email, which is not the same thing as
 * an administrator deciding they belong in the workspace. The session layer
 * already refuses everything that is not "active" (see `getActor`), so this
 * state needs no new enforcement — only the two things below: acceptance must
 * not mint a session, and sign-in must explain itself.
 */
const PENDING_APPROVAL = "pending_approval";

export interface AuthContext {
  readonly request: Request;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// SIGN IN
// ---------------------------------------------------------------------------

export async function authenticate(
  input: { email: string; password: string },
  context: AuthContext,
): Promise<{ userId: string }> {
  const email = normalizeEmail(input.email);
  const ip = clientIpFrom(context.request);

  // Two independent limits: one stops a single source hammering the endpoint,
  // the other stops a distributed attempt against one known employee.
  await enforceRateLimit(RATE_LIMITS.loginByIp, ip);
  await enforceRateLimit(RATE_LIMITS.loginByAccount, email);

  const user = await prisma.appUser.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      passwordHash: true,
      status: true,
      deactivatedAt: true,
      failedLoginCount: true,
      lockedUntil: true,
      memberships: {
        select: { organizationId: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 1,
      },
    },
  });

  // An account waiting for approval is the one non-active status that gets to
  // have its password checked. Everything else — no account, invited but never
  // accepted, deactivated, anything unrecognised — is refused here, before a
  // single byte about it is disclosed.
  const isPendingApproval = user?.status === PENDING_APPROVAL;
  const mayAttempt = user?.status === "active" || isPendingApproval;

  // No account, or an account that cannot sign in (invited-but-not-accepted,
  // deactivated). Still spend the scrypt cost so the response time is
  // indistinguishable from a wrong password on a real account.
  if (!user || !user.passwordHash || !mayAttempt || user.deactivatedAt) {
    await fakeVerifyPassword(input.password);
    if (user) {
      await recordFailure(user.id, user.email, user.memberships[0]?.organizationId, context);
    }
    throw invalidCredentials();
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    await fakeVerifyPassword(input.password);
    const seconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
    throw errors.tooManyAttempts(seconds);
  }

  const { valid, needsRehash } = await verifyPassword(input.password, user.passwordHash);

  if (!valid) {
    await recordFailure(user.id, user.email, user.memberships[0]?.organizationId, context);
    throw invalidCredentials();
  }

  /**
   * The credential is right, but the account has not been let in yet.
   *
   * WHY THIS MESSAGE IS SPECIFIC WHEN EVERY OTHER ONE IS NOT
   * The generic "that combination is not recognised" exists so the login form
   * cannot be used to enumerate who works here. That reasoning applies to
   * anyone who has *not* proved the credential. This person has: they typed the
   * password that matches the stored hash, so they already know the account
   * exists and is theirs. Telling them why they cannot get in leaks nothing
   * they did not just demonstrate.
   *
   * The order is the whole point. Saying "waiting for approval" before the
   * password is verified would answer "does this address have an account here?"
   * for anybody who asks — the enumeration oracle the rest of this file is
   * written to avoid. So the check sits *after* `verifyPassword`, never before,
   * and a wrong password on a pending account is indistinguishable from a wrong
   * password on any other.
   *
   * No session is created, nothing is written: this is not a sign-in.
   */
  if (isPendingApproval) {
    throw errors.invalidInput(
      "Your account is waiting for an administrator to approve it. You will be able to sign in as soon as somebody does.",
    );
  }

  // Success. Clear the failure state and, if the stored hash predates a cost
  // increase, transparently upgrade it now that the plaintext is in hand.
  await prisma.appUser.update({
    where: { id: user.id },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      ...(needsRehash ? { passwordHash: await hashPassword(input.password) } : {}),
    },
  });

  await resetRateLimit(RATE_LIMITS.loginByAccount, email);

  await createSession(user.id, {
    ipAddress: ip,
    userAgent: userAgentFrom(context.request),
  });

  const organizationId = user.memberships[0]?.organizationId;
  if (organizationId) {
    await recordAudit(
      { organizationId, actorUserId: user.id, actorLabel: user.name ?? user.email, request: context.request },
      { action: "auth.signed_in", summary: `${user.name ?? user.email} signed in` },
    );
  }

  return { userId: user.id };
}

/**
 * One message for every credential failure.
 *
 * "No account with that email" and "wrong password" are the same 401 with the
 * same text on purpose.
 */
function invalidCredentials() {
  return errors.invalidInput("That email and password combination is not recognised.");
}

async function recordFailure(
  userId: string,
  email: string | null,
  organizationId: string | undefined,
  context: AuthContext,
): Promise<void> {
  const updated = await prisma.appUser.update({
    where: { id: userId },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true, name: true },
  });

  const shouldLock = updated.failedLoginCount >= LOCKOUT_THRESHOLD;
  if (shouldLock) {
    await prisma.appUser.update({
      where: { id: userId },
      data: { lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) },
    });
  }

  if (organizationId) {
    await recordAudit(
      { organizationId, actorUserId: userId, actorLabel: updated.name ?? email, request: context.request },
      {
        action: shouldLock ? "auth.locked_out" : "auth.sign_in_failed",
        summary: shouldLock
          ? `Account locked for ${LOCKOUT_MINUTES} minutes after ${updated.failedLoginCount} failed attempts`
          : `Failed sign-in attempt (${updated.failedLoginCount})`,
        targetType: "user",
        targetId: userId,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// FIRST-RUN SETUP
// ---------------------------------------------------------------------------

/**
 * True when the deployment has no usable administrator yet.
 *
 * This is what gates /setup. It is checked on the server on every call, so the
 * window closes the instant the first admin exists — there is no flag to forget
 * to flip, and no way to re-open it from the outside.
 */
export async function needsSetup(): Promise<boolean> {
  const admin = await prisma.organizationMember.findFirst({
    where: {
      role: "admin",
      user: { status: "active", deactivatedAt: null, passwordHash: { not: null } },
    },
    select: { id: true },
  });
  return admin === null;
}

/**
 * Claims the first administrator account.
 *
 * If the pre-auth bootstrap user row exists it is claimed rather than replaced,
 * so every niche, channel and saved Short it authored keeps its byline instead
 * of pointing at a deleted account.
 */
export async function completeSetup(
  input: { name: string; email: string; password: string },
  context: AuthContext,
): Promise<{ userId: string }> {
  await enforceRateLimit(RATE_LIMITS.tokenExchangeByIp, clientIpFrom(context.request));

  if (!(await needsSetup())) {
    // Not "already done" — this endpoint must not confirm anything about the
    // deployment's state to an unauthenticated caller.
    throw errors.forbidden("complete setup");
  }

  const policyIssue = validatePasswordStrength(input.password);
  if (policyIssue) throw errors.invalidInput(policyIssue.message);

  const email = normalizeEmail(input.email);
  // Ordered so the choice is deterministic if more than one workspace row
  // somehow exists; the oldest is the one the backfill created.
  const organization = await prisma.organization.findFirst({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!organization) {
    throw errors.internal(new Error("No organization exists; run scripts/backfill-organization.mjs"));
  }

  const passwordHash = await hashPassword(input.password);

  const userId = await prisma.$transaction(async (tx) => {
    // Re-assert the window INSIDE the transaction.
    //
    // The check above is a fast rejection; on its own it is a time-of-check to
    // time-of-use race. Two setup requests arriving together could both observe
    // "no admin yet" and both proceed, and because the membership upsert is
    // keyed on (organization, user) they would not overwrite each other — the
    // deployment would end up with two co-equal administrators, one of them
    // whoever raced the operator's first click.
    const existingAdmin = await tx.organizationMember.findFirst({
      where: {
        role: "admin",
        user: { status: "active", deactivatedAt: null, passwordHash: { not: null } },
      },
      select: { id: true },
    });
    if (existingAdmin) throw errors.forbidden("complete setup");

    const conflicting = await tx.appUser.findUnique({ where: { email }, select: { id: true } });

    // Prefer an existing account with this email; otherwise adopt the
    // credential-less bootstrap row so its authorship survives.
    const bootstrap =
      conflicting ??
      (await tx.appUser.findFirst({
        where: { passwordHash: null, email: null },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      }));

    const user = bootstrap
      ? await tx.appUser.update({
          where: { id: bootstrap.id },
          data: {
            name: input.name.trim(),
            email,
            passwordHash,
            status: "active",
            deactivatedAt: null,
            failedLoginCount: 0,
            lockedUntil: null,
          },
          select: { id: true },
        })
      : await tx.appUser.create({
          data: {
            name: input.name.trim(),
            email,
            passwordHash,
            status: "active",
            settings: { create: {} },
          },
          select: { id: true },
        });

    await tx.organizationMember.upsert({
      where: { organizationId_userId: { organizationId: organization.id, userId: user.id } },
      update: { role: "admin" },
      create: { organizationId: organization.id, userId: user.id, role: "admin" },
    });

    return user.id;
  });

  await createSession(userId, {
    ipAddress: clientIpFrom(context.request),
    userAgent: userAgentFrom(context.request),
  });

  await recordAudit(
    { organizationId: organization.id, actorUserId: userId, actorLabel: input.name, request: context.request },
    {
      action: "user.created",
      summary: `${input.name} claimed the first administrator account`,
      targetType: "user",
      targetId: userId,
    },
  );

  return { userId };
}

// ---------------------------------------------------------------------------
// INVITATIONS
// ---------------------------------------------------------------------------

export interface CreatedInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly expiresAt: Date;
  /**
   * The full acceptance URL, returned exactly once.
   *
   * Deliberately not stored: only its hash is. If email delivery is not
   * configured the admin copies this link and sends it themselves, which is why
   * the invitation flow works with no mail provider at all.
   */
  readonly inviteUrl: string;
}

export async function createInvitation(
  input: {
    email: string;
    name?: string | null;
    role: string;
    /**
     * Which niches this person will be able to see, for the roles where that
     * question has an answer. Chosen by the admin at invite time and applied
     * here — never supplied by the invitee, who would then be choosing their
     * own access on the way in.
     */
    nicheIds?: readonly string[];
  },
  scope: { organizationId: string; actorUserId: string; actorLabel: string | null },
  context: AuthContext,
): Promise<CreatedInvitation> {
  const email = normalizeEmail(input.email);
  if (!email.includes("@")) throw errors.invalidInput("Enter a valid email address.");
  if (!isRole(input.role)) throw errors.invalidInput("Choose a valid role.");

  const existing = await prisma.appUser.findUnique({
    where: { email },
    select: { id: true, status: true, deactivatedAt: true },
  });
  if (existing && existing.status === "active" && !existing.deactivatedAt) {
    throw errors.invalidInput("Someone with that email already has an active account.");
  }

  const nicheIds = await verifyNichesBelongToOrg(scope.organizationId, input.nicheIds ?? []);

  const { token, tokenHash } = generateSingleUseToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 60 * 60 * 1000);

  const invitation = await prisma.$transaction(async (tx) => {
    // Supersede any outstanding invitation for this address, so a resend does
    // not leave two live tokens.
    await tx.invitation.updateMany({
      where: { organizationId: scope.organizationId, email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const created = await tx.invitation.create({
      data: {
        organizationId: scope.organizationId,
        email,
        name: input.name?.trim() || null,
        role: input.role,
        tokenHash,
        expiresAt,
        createdById: scope.actorUserId,
      },
      select: { id: true },
    });

    // The niche assignment is filed now, in the same transaction as the
    // invitation, rather than carried inside the link. See
    // `assignInvitedMemberNiches` for why.
    if (nicheIds.length > 0) {
      await assignInvitedMemberNiches(tx, {
        organizationId: scope.organizationId,
        email,
        name: input.name?.trim() || null,
        role: input.role,
        nicheIds,
        assignedById: scope.actorUserId,
      });
    }

    return created;
  });

  const baseUrl = resolveAppUrl(originOf(context.request));
  const inviteUrl = `${baseUrl}/invite/${token}`;

  await recordAudit(
    {
      organizationId: scope.organizationId,
      actorUserId: scope.actorUserId,
      actorLabel: scope.actorLabel,
      request: context.request,
    },
    {
      action: "user.invited",
      summary:
        nicheIds.length > 0
          ? `Invited ${email} as ${input.role}, scoped to ${nicheIds.length} niche${nicheIds.length === 1 ? "" : "s"}`
          : `Invited ${email} as ${input.role}`,
      targetType: "invitation",
      targetId: invitation.id,
      targetLabel: email,
      // Niche ids are organizational facts, not personal ones — recording which
      // scope somebody was granted on the way in is exactly what this log is
      // for. Nothing about pay or employment goes near it.
      metadata: { role: input.role, nicheIds },
    },
  );

  return { id: invitation.id, email, role: input.role, expiresAt, inviteUrl };
}

/**
 * Narrows a set of niche ids to the ones this organization actually owns.
 *
 * Both an integrity check and a tenancy one: an id from another workspace must
 * not be assignable, and an id for a niche somebody deleted five minutes ago
 * must not be written. Rejects rather than silently dropping, so an admin who
 * picked four niches never ends up having granted three without being told —
 * the same contract `setChannelNiches` uses.
 */
async function verifyNichesBelongToOrg(
  organizationId: string,
  nicheIds: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(nicheIds)];
  if (unique.length === 0) return [];

  const owned = await prisma.niche.findMany({
    where: { id: { in: unique }, organizationId },
    select: { id: true },
  });
  if (owned.length !== unique.length) {
    throw errors.invalidInput("One or more of those niches no longer exists.");
  }

  return unique;
}

/**
 * Files the invitee's niche assignment at invite time.
 *
 * WHY THE ASSIGNMENT CANNOT WAIT FOR ACCEPTANCE
 * A niche assignment is a `MemberNiche` row, and `MemberNiche` hangs off
 * `OrganizationMember` — so it needs a membership to exist. The `Invitation`
 * table has no niche column and the schema is not ours to change, and the two
 * places the ids could otherwise have been smuggled are both worse than they
 * look: the invitation link is documented as an opaque lookup key carrying no
 * payload to trust (`src/server/auth/tokens.ts`), and the audit log is an
 * account of what happened, not a queue the application reads back. Writing the
 * real row, in the real table, is the only version of this that does not lie
 * about where access comes from.
 *
 * So inviting somebody *with* niches now also creates the account shell it
 * needs: no password, status "invited" — the state `AppUser.status` already
 * defaults to and which `authenticate` already refuses. It cannot sign in, it
 * holds no session, and it grants nothing until an admin approves the account
 * after acceptance. Invitations with no niches are untouched by any of this and
 * behave exactly as they did.
 *
 * A revoked invitation leaves the shell behind, deliberately. Deleting accounts
 * as a side effect of revoking a link is how bylines disappear; an admin who
 * wants it gone deactivates it like any other account.
 */
async function assignInvitedMemberNiches(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    email: string;
    name: string | null;
    role: string;
    nicheIds: readonly string[];
    assignedById: string;
  },
): Promise<void> {
  const existing = await tx.appUser.findUnique({
    where: { email: params.email },
    select: { id: true },
  });

  // Only ever *created*, never updated: an account that already exists keeps
  // its name, its status and its password. Acceptance is what changes those,
  // and an invitation must not be able to edit somebody's account from outside.
  const user =
    existing ??
    (await tx.appUser.create({
      data: {
        email: params.email,
        name: params.name,
        status: "invited",
        settings: { create: {} },
      },
      select: { id: true },
    }));

  // `update: {}` on purpose. If the person is already a member — a returning
  // colleague being re-invited — their current role stands until they accept,
  // because acceptance is the moment the invitation's role is applied and
  // audited. Inviting somebody must not quietly re-role a live account.
  const member = await tx.organizationMember.upsert({
    where: {
      organizationId_userId: { organizationId: params.organizationId, userId: user.id },
    },
    update: {},
    create: { organizationId: params.organizationId, userId: user.id, role: params.role },
    select: { id: true },
  });

  // Replace rather than merge: the admin is looking at a form that shows the
  // whole set, so "these are the niches" is what they mean by submitting it.
  await tx.memberNiche.deleteMany({ where: { memberId: member.id } });
  await tx.memberNiche.createMany({
    data: params.nicheIds.map((nicheId) => ({
      memberId: member.id,
      nicheId,
      // Attribution: who put this person on this niche. The audit log records
      // the same fact for the invitation; this is the one the assignment
      // screens read.
      assignedById: params.assignedById,
    })),
  });
}

export interface InvitationPreview {
  readonly email: string;
  readonly name: string | null;
  readonly role: string;
  readonly organizationName: string;
}

/** Validates a token for the acceptance page without consuming it. */
export async function previewInvitation(token: string): Promise<InvitationPreview> {
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      email: true,
      name: true,
      role: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      organization: { select: { name: true } },
    },
  });

  if (
    !invitation ||
    invitation.acceptedAt ||
    invitation.revokedAt ||
    invitation.expiresAt.getTime() <= Date.now()
  ) {
    throw errors.invalidInput("This invitation link is no longer valid. Ask an admin for a new one.");
  }

  return {
    email: invitation.email,
    name: invitation.name,
    role: invitation.role,
    organizationName: invitation.organization.name,
  };
}

/**
 * What acceptance produces now: an account, and a wait.
 *
 * Returned instead of a session so the page has something concrete to render —
 * the invitee needs to be told, on the screen they are already looking at, that
 * their password was accepted and that somebody has to let them in. Dropping
 * them at a login form that will refuse them looks like a broken invitation.
 */
export interface AcceptedInvitation {
  readonly userId: string;
  /** Always `pending_approval` today; named so the page branches on a value, not a guess. */
  readonly status: typeof PENDING_APPROVAL;
  readonly email: string;
  readonly name: string | null;
  readonly organizationName: string;
}

export async function acceptInvitation(
  input: { token: string; name: string; password: string },
  context: AuthContext,
): Promise<AcceptedInvitation> {
  await enforceRateLimit(RATE_LIMITS.tokenExchangeByIp, clientIpFrom(context.request));

  const policyIssue = validatePasswordStrength(input.password);
  if (policyIssue) throw errors.invalidInput(policyIssue.message);

  const tokenHash = hashToken(input.token);
  const passwordHash = await hashPassword(input.password);

  const result = await prisma.$transaction(async (tx) => {
    const invitation = await tx.invitation.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        organizationId: true,
        email: true,
        role: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
        // Read here so the "waiting for approval" screen can name the workspace
        // the person just joined. One query rather than a second lookup for a
        // string the transaction already has in hand.
        organization: { select: { name: true } },
      },
    });

    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt.getTime() <= Date.now()
    ) {
      throw errors.invalidInput("This invitation link is no longer valid.");
    }

    const existing = await tx.appUser.findUnique({
      where: { email: invitation.email },
      select: { id: true },
    });

    // Both branches land on `pending_approval`, never "active". Accepting an
    // invitation now means "I have set my password", which is a statement about
    // the person; being allowed in is a decision an administrator makes. A
    // returning colleague whose account was deactivated goes through the same
    // gate — a link that could silently reinstate a departed employee is
    // precisely what this flow exists to prevent.
    const user = existing
      ? await tx.appUser.update({
          where: { id: existing.id },
          data: {
            name: input.name.trim(),
            passwordHash,
            status: PENDING_APPROVAL,
            deactivatedAt: null,
            failedLoginCount: 0,
            lockedUntil: null,
          },
          select: { id: true, name: true },
        })
      : await tx.appUser.create({
          data: {
            name: input.name.trim(),
            email: invitation.email,
            passwordHash,
            status: PENDING_APPROVAL,
            settings: { create: {} },
          },
          select: { id: true, name: true },
        });

    await tx.organizationMember.upsert({
      where: {
        organizationId_userId: { organizationId: invitation.organizationId, userId: user.id },
      },
      update: { role: invitation.role },
      create: {
        organizationId: invitation.organizationId,
        userId: user.id,
        role: invitation.role,
      },
    });

    // Single use: consumed inside the same transaction that created the
    // account, so a replayed link cannot mint a second one.
    await tx.invitation.update({
      where: { id: invitation.id },
      data: { acceptedAt: new Date() },
    });

    return {
      userId: user.id,
      name: user.name,
      email: invitation.email,
      organizationId: invitation.organizationId,
      organizationName: invitation.organization.name,
    };
  });

  // NO SESSION IS CREATED HERE.
  //
  // This is the whole gate. `getActor` refuses anything that is not "active",
  // so a session minted now would be dead on arrival — but issuing one anyway
  // would put a cookie in the browser that authenticates nobody, and the
  // resulting "signed in, but every page redirects to /login" is the worst
  // possible way to tell somebody they are waiting for approval. They get a
  // screen that says so instead.

  await recordAudit(
    {
      organizationId: result.organizationId,
      actorUserId: result.userId,
      actorLabel: result.name,
      request: context.request,
    },
    {
      action: "user.invitation_accepted",
      // Worded so the admin reading the log knows there is something for them
      // to do: this event is now the start of an approval, not the end of an
      // onboarding.
      summary: `${result.name ?? "A new user"} accepted their invitation and is waiting for approval`,
      targetType: "user",
      targetId: result.userId,
    },
  );

  return {
    userId: result.userId,
    status: PENDING_APPROVAL,
    email: result.email,
    name: result.name,
    organizationName: result.organizationName,
  };
}

// ---------------------------------------------------------------------------
// PASSWORD RESET
// ---------------------------------------------------------------------------

export interface PasswordResetRequest {
  /**
   * Present only when email delivery is unconfigured, so an admin can pass the
   * link on. Returned to the *requester* never — see the route handler.
   */
  readonly resetUrl: string | null;
}

/**
 * Starts a reset. Always reports success to the caller.
 *
 * Whether the address exists is never disclosed: a reset form that says "no
 * such user" is the same enumeration oracle as a login form that does.
 */
export async function requestPasswordReset(
  input: { email: string },
  context: AuthContext,
): Promise<PasswordResetRequest> {
  const email = normalizeEmail(input.email);
  await enforceRateLimit(RATE_LIMITS.passwordResetByIp, clientIpFrom(context.request));
  await enforceRateLimit(RATE_LIMITS.passwordResetByAccount, email);

  const user = await prisma.appUser.findUnique({
    where: { email },
    select: {
      id: true,
      name: true,
      status: true,
      deactivatedAt: true,
      memberships: {
        select: { organizationId: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 1,
      },
    },
  });

  if (!user || user.deactivatedAt || user.status === "deactivated") {
    return { resetUrl: null };
  }

  const { token, tokenHash } = generateSingleUseToken();

  await prisma.$transaction(async (tx) => {
    // Invalidate outstanding tokens so only the newest link works.
    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000),
      },
    });
  });

  const organizationId = user.memberships[0]?.organizationId;
  if (organizationId) {
    await recordAudit(
      { organizationId, actorUserId: user.id, actorLabel: user.name, request: context.request },
      { action: "auth.password_reset_requested", summary: "Password reset requested" },
    );
  }

  const baseUrl = resolveAppUrl(originOf(context.request));
  return { resetUrl: `${baseUrl}/reset-password/${token}` };
}

export async function resetPassword(
  input: { token: string; password: string },
  context: AuthContext,
): Promise<void> {
  await enforceRateLimit(RATE_LIMITS.tokenExchangeByIp, clientIpFrom(context.request));

  const policyIssue = validatePasswordStrength(input.password);
  if (policyIssue) throw errors.invalidInput(policyIssue.message);

  const passwordHash = await hashPassword(input.password);

  const result = await prisma.$transaction(async (tx) => {
    const record = await tx.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(input.token) },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        usedAt: true,
        user: {
          select: {
            name: true,
            deactivatedAt: true,
            memberships: {
        select: { organizationId: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 1,
      },
          },
        },
      },
    });

    if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) {
      throw errors.invalidInput("This reset link is no longer valid. Request a new one.");
    }
    if (record.user.deactivatedAt) {
      throw errors.invalidInput("This reset link is no longer valid. Request a new one.");
    }

    await tx.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    await tx.appUser.update({
      where: { id: record.userId },
      data: {
        passwordHash,
        // `status` is deliberately NOT set here, and used to be set to "active".
        //
        // Once acceptance leaves an account in `pending_approval`, a reset that
        // promoted it would be a way around the entire approval gate: accept
        // the invitation, click "forgot password", set the password again, and
        // let yourself in. A reset proves control of the mailbox, which is what
        // it is for; it has never been evidence that an administrator wants
        // this person in the workspace.
        //
        // Nothing is lost by dropping it. A deactivated account is already
        // refused above, an active one is unchanged, and an account still
        // waiting for approval carries on waiting with a new password.
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    return {
      userId: record.userId,
      name: record.user.name,
      organizationId: record.user.memberships[0]?.organizationId,
    };
  });

  // Every existing session is killed. A password reset is the standard response
  // to "somebody else may have my account", so leaving their other sessions
  // alive would defeat the point.
  await revokeAllSessionsForUser(result.userId);

  if (result.organizationId) {
    await recordAudit(
      {
        organizationId: result.organizationId,
        actorUserId: result.userId,
        actorLabel: result.name,
        request: context.request,
      },
      { action: "auth.password_reset_completed", summary: "Password reset completed" },
    );
  }
}

/** Changes the signed-in user's own password, requiring the current one. */
export async function changeOwnPassword(
  input: { currentPassword: string; newPassword: string },
  scope: { userId: string; organizationId: string; actorLabel: string | null; sessionId: string },
  context: AuthContext,
): Promise<void> {
  const policyIssue = validatePasswordStrength(input.newPassword);
  if (policyIssue) throw errors.invalidInput(policyIssue.message);

  const user = await prisma.appUser.findUnique({
    where: { id: scope.userId },
    select: { passwordHash: true },
  });

  const { valid } = await verifyPassword(input.currentPassword, user?.passwordHash);
  if (!valid) throw errors.invalidInput("Your current password is not correct.");

  await prisma.appUser.update({
    where: { id: scope.userId },
    data: { passwordHash: await hashPassword(input.newPassword) },
  });

  // Sign out other devices but keep this one, so changing a password does not
  // eject the person who just changed it.
  await prisma.session.updateMany({
    where: { userId: scope.userId, revokedAt: null, id: { not: scope.sessionId } },
    data: { revokedAt: new Date() },
  });

  await recordAudit(
    {
      organizationId: scope.organizationId,
      actorUserId: scope.userId,
      actorLabel: scope.actorLabel,
      request: context.request,
    },
    { action: "auth.password_changed", summary: "Password changed; other sessions signed out" },
  );
}

// ---------------------------------------------------------------------------
// YOUR OWN ACCOUNT
//
// Name, email address and password. Personal state, all of it — nothing here
// touches the organization, and nothing here can address another account: the
// user id comes from the session on every path below, exactly as it does in
// `changeOwnPassword` above.
// ---------------------------------------------------------------------------

export interface ProfileUpdateInput {
  readonly name?: string;
  readonly email?: string;
  /** Required to change the email address; see the note in `updateOwnProfile`. */
  readonly currentPassword?: string;
}

export interface UpdatedProfile {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
  /** True when the login identifier moved, so the client can say so plainly. */
  readonly emailChanged: boolean;
}

/**
 * Changes the signed-in person's own name and/or email address.
 *
 * WHY AN EMAIL CHANGE NEEDS THE CURRENT PASSWORD AND A NAME CHANGE DOES NOT
 * The email address is the login identifier and the address a password-reset
 * link is sent to. Anyone who reaches an unattended, unlocked browser could
 * otherwise point both at themselves and own the account a minute later, with
 * the real employee locked out and no way back. Re-asking for the password is
 * the same control `changeOwnPassword` applies for the same reason. A display
 * name grants nothing, so it does not carry the friction.
 *
 * WHY IT CANNOT TAKE SOMEBODY ELSE'S ADDRESS
 * Two guards, and both are needed. The lookup below is the one that produces a
 * sentence a person can act on — but it is a check-then-write, so two requests
 * racing for the same free address would both pass it. `AppUser.email` is
 * unique in the database, so the loser's write fails with P2002, which is
 * caught and turned into the same message. The constraint is what actually
 * holds; the lookup only makes the common case legible.
 *
 * Addresses are normalised before both the comparison and the write, so
 * "Ada@Example.com" cannot slip past a check on "ada@example.com" and then sit
 * in the table as a second row that only differs by case.
 */
export async function updateOwnProfile(
  input: ProfileUpdateInput,
  scope: { userId: string; organizationId: string; actorLabel: string | null },
  context: AuthContext,
): Promise<UpdatedProfile> {
  const name = input.name?.trim();
  const email = input.email === undefined ? undefined : normalizeEmail(input.email);

  if (name === undefined && email === undefined) {
    throw errors.invalidInput("Nothing to change — send a name, an email address, or both.");
  }
  if (name !== undefined && name.length === 0) {
    throw errors.invalidInput("Enter your name.");
  }
  if (name !== undefined && name.length > 120) {
    throw errors.invalidInput("That name is too long.");
  }

  const current = await prisma.appUser.findUnique({
    where: { id: scope.userId },
    select: { email: true, name: true, passwordHash: true },
  });
  if (!current) throw errors.unauthenticated();

  // An "email change" that changes nothing is a no-op, not a re-authentication
  // prompt: a form that submits every field would otherwise demand a password
  // from somebody who only edited their name.
  const emailChanged = email !== undefined && email !== current.email;

  if (emailChanged) {
    if (!email.includes("@")) throw errors.invalidInput("Enter a valid email address.");
    if (email.length > 320) throw errors.invalidInput("That email address is too long.");

    const { valid } = await verifyPassword(input.currentPassword ?? "", current.passwordHash);
    if (!valid) {
      throw errors.invalidInput(
        "Enter your current password to change the email address on your account.",
      );
    }

    const taken = await prisma.appUser.findUnique({
      where: { email },
      select: { id: true },
    });
    // Deliberately the same message whether the address belongs to a colleague
    // or to a deactivated account: this endpoint is authenticated, so it is not
    // the staff-enumeration risk the login form is, but there is still no
    // reason for it to confirm who holds which address.
    if (taken && taken.id !== scope.userId) {
      throw errors.invalidInput("That email address is already in use.");
    }
  }

  const data: Prisma.AppUserUpdateInput = {};
  if (name !== undefined) data.name = name;
  if (emailChanged) data.email = email;

  let updated;
  try {
    updated = await prisma.appUser.update({
      where: { id: scope.userId },
      data,
      select: { id: true, name: true, email: true },
    });
  } catch (caught) {
    // The race the lookup above cannot close. The unique index is what actually
    // prevents the collision; this turns its error into the same sentence.
    if (isUniqueConstraintViolation(caught)) {
      throw errors.invalidInput("That email address is already in use.");
    }
    throw caught;
  }

  await recordAudit(
    {
      organizationId: scope.organizationId,
      actorUserId: scope.userId,
      actorLabel: scope.actorLabel,
      request: context.request,
    },
    emailChanged
      ? {
          action: "auth.email_changed",
          summary: "Email address changed",
          targetType: "user",
          targetId: scope.userId,
        }
      : {
          action: "auth.profile_updated",
          summary: "Profile updated",
          targetType: "user",
          targetId: scope.userId,
        },
  );

  return { ...updated, emailChanged };
}

/**
 * Prisma reports a unique-constraint violation as error code P2002.
 *
 * Duck-typed rather than `instanceof PrismaClientKnownRequestError`, matching
 * `notification-service.ts`: the code is part of Prisma's documented contract
 * and this module does not need a runtime import of the namespace for one
 * branch.
 */
function isUniqueConstraintViolation(caught: unknown): boolean {
  return (
    typeof caught === "object" &&
    caught !== null &&
    "code" in caught &&
    (caught as { readonly code?: unknown }).code === "P2002"
  );
}

function originOf(request: Request): string | null {
  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}
