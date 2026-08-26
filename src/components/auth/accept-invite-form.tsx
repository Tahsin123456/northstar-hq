"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { AuthCard, AuthError, AuthNotice } from "@/components/auth/auth-form";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";

/**
 * Accepting an invitation.
 *
 * The email and role are fixed by the invitation and shown read-only: they came
 * from the admin who issued it, and letting the invitee edit either would mean
 * a link intended for one person could mint an account for another — or a
 * Channel Director could award themselves Admin on the way in.
 *
 * ACCEPTING IS NOT SIGNING IN
 * Setting a password creates the account and stops there: it sits waiting for
 * an administrator to approve it, and no session cookie comes back. So this
 * form does not navigate anywhere on success. It swaps itself for the screen
 * below, which says what happened and what has to happen next — the previous
 * behaviour, redirecting to the dashboard, would now land the person on a login
 * page that refuses them for reasons it cannot explain.
 */
export function AcceptInviteForm({
  token,
  email,
  suggestedName,
  roleLabel,
  organizationName,
}: {
  token: string;
  email: string;
  suggestedName: string | null;
  roleLabel: string;
  organizationName: string;
}) {
  const [name, setName] = React.useState(suggestedName ?? "");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [accepted, setAccepted] = React.useState(false);

  const mismatch = confirm.length > 0 && confirm !== password;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (mismatch) return;
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name, password }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? "Could not complete your account setup.");
        setPending(false);
        return;
      }
      // The account exists and the token is spent. `pending` stays true so the
      // button cannot be pressed again in the frame before the screen swaps —
      // a second submit would only be told the link is no longer valid, which
      // reads as a failure right after a success.
      setAccepted(true);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setPending(false);
    }
  }

  if (accepted) {
    return <AwaitingApproval email={email} organizationName={organizationName} />;
  }

  return (
    <AuthCard
      title={`Join ${organizationName}`}
      description="Choose a password to finish setting up your account."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <AuthError message={error} />

        <AuthNotice>
          <span className="text-foreground">{email}</span> · {roleLabel}
        </AuthNotice>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">Your name</Label>
          <Input
            id="name"
            autoFocus
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="name"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
          />
          <FieldHint>At least {MIN_PASSWORD_LENGTH} characters.</FieldHint>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="confirm">Confirm password</Label>
          <Input
            id="confirm"
            type="password"
            required
            invalid={mismatch}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
          />
          {mismatch ? <FieldHint tone="danger">Those do not match.</FieldHint> : null}
        </div>

        <Button
          type="submit"
          variant="primary"
          loading={pending}
          disabled={mismatch}
          className="w-full"
        >
          Create account
        </Button>
      </form>
    </AuthCard>
  );
}

/**
 * The end of the invitation flow.
 *
 * Deliberately not an error state — nothing went wrong, and styling it in red
 * would tell somebody their brand-new account is broken. It says three things,
 * in this order: your account exists, somebody has to approve it, and there is
 * nothing further for you to do. The last one matters most: without it the
 * natural next move is to try signing in repeatedly, which does nothing except
 * walk the account towards a lockout.
 */
function AwaitingApproval({
  email,
  organizationName,
}: {
  email: string;
  organizationName: string;
}) {
  return (
    <AuthCard
      title="Your account is waiting for approval"
      description={`Your password is set and your account has been created. An administrator at ${organizationName} has to approve it before you can sign in — you do not need to do anything else.`}
    >
      <div className="flex flex-col gap-4">
        <AuthNotice>
          <span className="text-foreground">{email}</span> · Pending approval
        </AuthNotice>

        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Signing in before then will tell you the account is still pending. If it has been a
          while, the person who invited you is the one who can approve it.
        </p>

        <Button asChild variant="ghost" className="w-full">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    </AuthCard>
  );
}
