"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, ...props }, ref) => (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        "h-9 w-full rounded-md border border-border bg-surface-sunken px-3 text-sm text-foreground",
        "placeholder:text-subtle-foreground",
        "transition-colors duration-150",
        "hover:border-border-strong",
        "focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)] focus:ring-offset-0",
        "disabled:cursor-not-allowed disabled:opacity-50",
        invalid && "border-danger focus:border-danger focus:ring-[var(--danger)]/30",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Label = React.forwardRef<
  HTMLLabelElement,
  React.LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  <label
    ref={ref}
    className={cn(
      "text-[13px] font-medium text-foreground leading-none",
      className,
    )}
    {...props}
  />
));
Label.displayName = "Label";

/** Helper or error text under a field. */
export function FieldHint({
  className,
  tone = "muted",
  ...props
}: React.HTMLAttributes<HTMLParagraphElement> & { tone?: "muted" | "danger" }) {
  return (
    <p
      className={cn(
        "text-[12px] leading-relaxed",
        tone === "danger" ? "text-danger" : "text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
