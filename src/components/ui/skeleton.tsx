import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Loading placeholder.
 *
 * Skeletons here mirror the *shape* of the content they replace — a table row
 * skeleton has the same column widths as a real row — so the layout does not
 * jump when data arrives. A pulsing grey box that reflows on load is worse than
 * a spinner, not better.
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn("animate-shimmer rounded bg-surface-hover", className)}
      {...props}
    />
  );
}

export function SkeletonText({
  lines = 1,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton
          key={i}
          className={cn("h-3", i === lines - 1 && lines > 1 ? "w-2/3" : "w-full")}
        />
      ))}
    </div>
  );
}
