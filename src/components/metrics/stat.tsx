import * as React from "react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * A labelled figure.
 *
 * Intentionally plain: a small uppercase label, a large tabular number, and an
 * optional caption. The spec asks not to turn every fact into a giant coloured
 * card, so the visual weight here comes from typography and whitespace rather
 * than borders and fills. Cards are applied by the *container*, not by this.
 */
export function Stat({
  label,
  value,
  caption,
  hint,
  emphasis = "normal",
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  caption?: React.ReactNode;
  /** Rendered next to the label, typically an InfoTip. */
  hint?: React.ReactNode;
  emphasis?: "normal" | "strong" | "muted";
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="flex items-center gap-1">
        <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
          {label}
        </span>
        {hint}
      </div>

      <div
        className={cn(
          "tnum truncate font-semibold leading-none tracking-tight",
          emphasis === "strong" ? "text-[26px]" : "text-[19px]",
          emphasis === "muted" ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {value}
      </div>

      {caption ? (
        <div className="truncate text-[11px] leading-tight text-subtle-foreground">
          {caption}
        </div>
      ) : null}
    </div>
  );
}

export function StatSkeleton({ emphasis = "normal" }: { emphasis?: "normal" | "strong" }) {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-2.5 w-16" />
      <Skeleton className={emphasis === "strong" ? "h-6 w-28" : "h-4 w-20"} />
      <Skeleton className="h-2.5 w-24" />
    </div>
  );
}

/**
 * A small trend indicator in percentage points.
 * Green for improving, red for declining, muted for flat — the one place in
 * this UI where directional colour genuinely carries meaning.
 */
export function TrendPill({
  delta,
  className,
}: {
  delta: number | null;
  className?: string;
}) {
  if (delta === null) return null;

  const tone =
    Math.abs(delta) < 0.05
      ? "text-muted-foreground"
      : delta > 0
        ? "text-success"
        : "text-danger";

  const sign = delta > 0.05 ? "▲" : delta < -0.05 ? "▼" : "•";

  return (
    <span className={cn("tnum inline-flex items-center gap-1 text-[11px]", tone, className)}>
      <span aria-hidden className="text-[8px]">
        {sign}
      </span>
      {Math.abs(delta).toFixed(1)} pts
    </span>
  );
}
