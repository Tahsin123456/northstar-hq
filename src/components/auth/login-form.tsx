"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { AuthCard, AuthError } from "@/components/auth/auth-form";

/**
 * Sign-in.
 *
 * The server answers every credential failure identically, so this form does
 * not try to be more helpful than that — distinguishing "no such account" from
 * "wrong password" here would leak exactly what the API refuses to.
 */
export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  /**
   * Where to go after signing in.
   *
   * Only a same-site path is honoured. Accepting an absolute URL here would
   * turn the login page into an open redirect: a link to
   * /login?next=https://evil.example would bounce a freshly-authenticated
   * employee straight onto an attacker's page.
   */
  const nextParam = searchParams.get("next");
  const destination =
    nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/";

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? "That email and password combination is not recognised.");
        setPending(false);
        return;
      }

      // replace + refresh rather than a hard reload: refresh discards the
      // cached RSC payload so the (app) server layout re-runs and picks up the
      // session cookie this response just set, and replace keeps the sign-in
      // screen out of the back-button history.
      router.replace(destination);
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setPending(false);
    }
  }

  return (
    <AuthCard title="Sign in" description="Use your Northstar Studios work email.">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <AuthError message={error} />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            name="email"
            autoComplete="username"
            autoFocus
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@northstarstudios.com"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="password">Password</Label>
            <Link
              href="/forgot-password"
              className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <Button type="submit" variant="primary" loading={pending} className="mt-1 w-full">
          Sign in
        </Button>

        <FieldHint>
          No account? Northstar HQ is invite-only — ask an admin to send you one.
        </FieldHint>
      </form>
    </AuthCard>
  );
}
