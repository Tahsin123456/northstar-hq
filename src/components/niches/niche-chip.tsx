import * as React from "react";
import type { NicheRefDTO } from "@/lib/dto";
import { cn } from "@/lib/utils";

/** Accent tokens the niche chips cycle through. */
const NICHE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
] as const;

export function nicheColor(colorIndex: number): string {
  return NICHE_COLORS[Math.abs(colorIndex) % NICHE_COLORS.length];
}

/**
 * A niche label.
 *
 * A 5px colour dot plus plain text, not a filled pill. In a table where most
 * rows carry one or two of these, saturated pills would dominate the row and
 * compete with the numbers — which are the point. The dot gives instant
 * grouping at a glance while costing almost no visual weight.
 */
export function NicheChip({
  niche,
  className,
  size = "md",
}: {
  niche: NicheRefDTO;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded border border-border bg-surface-raised text-muted-foreground",
        size === "sm" ? "px-1.5 py-px text-[10px]" : "px-2 py-0.5 text-[11px]",
        className,
      )}
      title={niche.name}
    >
      <span
        aria-hidden
        className="size-[5px] shrink-0 rounded-full"
        style={{ background: nicheColor(niche.colorIndex) }}
      />
      <span className="truncate">{niche.name}</span>
    </span>
  );
}

/**
 * A row's niches, collapsed past a limit.
 *
 * Channels with several niches would otherwise push the metric columns around;
 * showing "+2" keeps every row the same height.
 */
export function NicheChips({
  niches,
  limit = 2,
  size = "sm",
  className,
  emptyLabel,
}: {
  niches: readonly NicheRefDTO[];
  limit?: number;
  size?: "sm" | "md";
  className?: string;
  emptyLabel?: string;
}) {
  if (niches.length === 0) {
    return emptyLabel ? (
      <span className={cn("text-[11px] text-subtle-foreground", className)}>{emptyLabel}</span>
    ) : null;
  }

  const shown = niches.slice(0, limit);
  const overflow = niches.length - shown.length;

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      {shown.map((niche) => (
        <NicheChip key={niche.id} niche={niche} size={size} />
      ))}
      {overflow > 0 ? (
        <span
          className="shrink-0 text-[10px] text-subtle-foreground"
          title={niches.map((n) => n.name).join(", ")}
        >
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}
