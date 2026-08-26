"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { AuthCard, AuthError, AuthNotice } from "@/components/auth/auth-form";

export function ForgotPasswordForm() {
  const [email, setEmail] = React.useState("");
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? "Could not send a reset link right now.");
        setPending(false);
        return;
      }
      // Success regardless of whether the address exists — see the note below.
      setSent(true);
      setPending(false);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setPending(false);
    }
  }

  if (sent) {
    return (
      <AuthCard title="Check your email">
        <div className="flex flex-col gap-4">
          <AuthNotice>
            If an account exists for that address, a reset link is on its way. It works once and
            expires in an hour.
          </AuthNotice>
          <p className="text-[12px] leading-relaxed text-subtle-foreground">
            Nothing arrived? Email delivery may not be configured on this deployment — ask an
            admin, who can generate a link for you directly.
          </p>
          <Button asChild variant="ghost" className="w-full">
            <Link href="/login">Back to sign in</Link>
          </Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      description="Enter your work email and we'll send you a link to choose a new password."
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <AuthError message={error} />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoFocus
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
          />
        </div>

        <Button type="submit" variant="primary" loading={pending} className="w-full">
          Send reset link
        </Button>

        <Button asChild variant="ghost" className="w-full">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </form>
    </AuthCard>
  );
}
