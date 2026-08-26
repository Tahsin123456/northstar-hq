"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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
  const router = useRouter();
  const [name, setName] = React.useState(suggestedName ?? "");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

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
      // replace + refresh rather than a hard reload: refresh discards the
      // cached RSC payload so the (app) server layout re-runs and picks up the
      // session cookie this response just set, and replace keeps the sign-in
      // screen out of the back-button history.
      router.replace("/");
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setPending(false);
    }
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
