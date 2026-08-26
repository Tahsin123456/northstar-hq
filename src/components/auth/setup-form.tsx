"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { AuthCard, AuthError, AuthNotice } from "@/components/auth/auth-form";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { BRAND } from "@/lib/brand";

export function SetupForm() {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
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
      const response = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? "Could not complete setup.");
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
      title="Create the owner account"
      description={`This is the first and only time this screen appears. The account you create becomes the administrator for ${BRAND.company}.`}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <AuthError message={error} />

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
          <Label htmlFor="email">Work email</Label>
          <Input
            id="email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
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
          <FieldHint>
            At least {MIN_PASSWORD_LENGTH} characters. A phrase you can remember beats a short
            scramble you cannot.
          </FieldHint>
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

        <AuthNotice>
          Your existing channels, niches and saved research are already here — this account takes
          ownership of them rather than starting empty.
        </AuthNotice>

        <Button
          type="submit"
          variant="primary"
          loading={pending}
          disabled={mismatch}
          className="mt-1 w-full"
        >
          Create account and sign in
        </Button>
      </form>
    </AuthCard>
  );
}
