import "server-only";

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

  // No account, or an account that cannot sign in (invited-but-not-accepted,
  // deactivated). Still spend the scrypt cost so the response time is
  // indistinguishable from a wrong password on a real account.
  if (!user || !user.passwordHash || user.status !== "active" || user.deactivatedAt) {
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
  input: { email: string; name?: string | null; role: string },
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

  const { token, tokenHash } = generateSingleUseToken();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 60 * 60 * 1000);

  const invitation = await prisma.$transaction(async (tx) => {
    // Supersede any outstanding invitation for this address, so a resend does
    // not leave two live tokens.
    await tx.invitation.updateMany({
      where: { organizationId: scope.organizationId, email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return tx.invitation.create({
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
      summary: `Invited ${email} as ${input.role}`,
      targetType: "invitation",
      targetId: invitation.id,
      targetLabel: email,
      metadata: { role: input.role },
    },
  );

  return { id: invitation.id, email, role: input.role, expiresAt, inviteUrl };
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

export async function acceptInvitation(
  input: { token: string; name: string; password: string },
  context: AuthContext,
): Promise<{ userId: string }> {
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

    const user = existing
      ? await tx.appUser.update({
          where: { id: existing.id },
          data: {
            name: input.name.trim(),
            passwordHash,
            status: "active",
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
            status: "active",
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

    return { userId: user.id, name: user.name, organizationId: invitation.organizationId };
  });

  await createSession(result.userId, {
    ipAddress: clientIpFrom(context.request),
    userAgent: userAgentFrom(context.request),
  });

  await recordAudit(
    {
      organizationId: result.organizationId,
      actorUserId: result.userId,
      actorLabel: result.name,
      request: context.request,
    },
    {
      action: "user.invitation_accepted",
      summary: `${result.name ?? "A new user"} accepted their invitation`,
      targetType: "user",
      targetId: result.userId,
    },
  );

  return { userId: result.userId };
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
        status: "active",
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

function originOf(request: Request): string | null {
  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}
