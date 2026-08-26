"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The card every signed-out form sits in, plus its error region.
 *
 * Errors are rendered into an `aria-live` region and focused-adjacent so a
 * screen-reader user hears "that combination is not recognised" instead of
 * silently failing — sign-in is the one screen where a missed error message
 * means the person simply cannot get in.
 */
export function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-6 shadow-sm">
      <h2 className="text-[15px] font-medium tracking-tight text-foreground">{title}</h2>
      {description ? (
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      <div className="mt-5">{children}</div>
    </div>
  );
}

export function AuthError({ message }: { message: string | null }) {
  return (
    <div aria-live="polite" className={cn(message ? "mb-4" : "sr-only")}>
      {message ? (
        <p className="rounded-md border border-danger/40 bg-danger-subtle px-3 py-2 text-[12px] leading-relaxed text-danger">
          {message}
        </p>
      ) : null}
    </div>
  );
}

export function AuthNotice({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}
