import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Empty and error states.
 *
 * An empty dashboard is the *first* thing a new user sees, so it has to read as
 * a starting point rather than a failure. Every empty state here carries three
 * things: what this screen is for, what it will show once populated, and a
 * single obvious action.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  className,
  tone = "neutral",
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  className?: string;
  tone?: "neutral" | "danger";
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-6 py-16 text-center animate-in-fade",
        className,
      )}
    >
      {icon ? (
        <div
          className={cn(
            "mb-4 flex size-11 items-center justify-center rounded-xl border",
            tone === "danger"
              ? "border-danger/25 bg-danger-subtle text-danger"
              : "border-border bg-surface-raised text-subtle-foreground",
            "[&_svg]:size-5",
          )}
        >
          {icon}
        </div>
      ) : null}

      <h3 className="text-[15px] font-medium tracking-tight text-foreground">{title}</h3>

      {description ? (
        <div className="mt-2 max-w-md text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </div>
      ) : null}

      {action || secondaryAction ? (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}
