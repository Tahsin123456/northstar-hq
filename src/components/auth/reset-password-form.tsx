"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { AuthCard, AuthError, AuthNotice } from "@/components/auth/auth-form";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";

export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [done, setDone] = React.useState(false);

  const mismatch = confirm.length > 0 && confirm !== password;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (mismatch) return;
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? "That reset link is no longer valid.");
        setPending(false);
        return;
      }
      setDone(true);
      setPending(false);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setPending(false);
    }
  }

  if (done) {
    return (
      <AuthCard title="Password updated">
        <div className="flex flex-col gap-4">
          <AuthNotice>
            Every other signed-in device has been signed out, in case somebody else had access.
          </AuthNotice>
          <Button asChild variant="primary" className="w-full">
            <Link href="/login">Sign in</Link>
          </Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <AuthError message={error} />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            type="password"
            autoFocus
            required
            minLength={MIN_PASSWORD_LENGTH}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
          />
          <FieldHint>At least {MIN_PASSWORD_LENGTH} characters.</FieldHint>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="confirm">Confirm new password</Label>
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
          Update password
        </Button>
      </form>
    </AuthCard>
  );
}
