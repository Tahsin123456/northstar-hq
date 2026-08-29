import * as React from "react";
import type { ContentTypeRefDTO } from "@/lib/dto";
import { cn } from "@/lib/utils";

/**
 * Accent tokens the content-type chips cycle through.
 *
 * The same six `--chart-*` variables the niche chips use, and deliberately a
 * second copy of the list rather than an import: the server cycles content-type
 * colours over its own `CONTENT_TYPE_COLOR_COUNT`, and the two taxonomies must
 * be free to grow different palettes without one silently re-colouring the
 * other's stored `colorIndex`.
 */
const CONTENT_TYPE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
] as const;

export function contentTypeColor(colorIndex: number): string {
  return CONTENT_TYPE_COLORS[Math.abs(colorIndex) % CONTENT_TYPE_COLORS.length];
}

/**
 * A content-type label.
 *
 * A squared dot rather than the niche chip's round one — the only difference,
 * and the point of it. Both taxonomies appear side by side on a Short, and two
 * identical chips carrying different meanings would be worse than no chip at
 * all. Everything else is shared so the row still reads as one register.
 */
export function ContentTypeChip({
  contentType,
  className,
  size = "md",
  muted = false,
}: {
  contentType: ContentTypeRefDTO;
  className?: string;
  size?: "sm" | "md";
  /** Dimmed styling for a type that has since been archived. */
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded border border-border bg-surface-raised",
        muted ? "text-subtle-foreground" : "text-muted-foreground",
        size === "sm" ? "px-1.5 py-px text-[10px]" : "px-2 py-0.5 text-[11px]",
        className,
      )}
      title={muted ? `${contentType.name} (archived)` : contentType.name}
    >
      <span
        aria-hidden
        className={cn("size-[5px] shrink-0 rounded-[1px]", muted && "opacity-50")}
        style={{ background: contentTypeColor(contentType.colorIndex) }}
      />
      <span className="truncate">{contentType.name}</span>
    </span>
  );
}

/**
 * A Short's content types, collapsed past a limit.
 *
 * Same overflow rule as `NicheChips`: a Short filed under four types must not
 * make its row taller than its neighbours, so the surplus becomes a "+2" whose
 * title attribute carries the full list.
 */
export function ContentTypeChips({
  contentTypes,
  limit = 2,
  size = "sm",
  className,
  emptyLabel,
}: {
  contentTypes: readonly ContentTypeRefDTO[];
  limit?: number;
  size?: "sm" | "md";
  className?: string;
  emptyLabel?: string;
}) {
  if (contentTypes.length === 0) {
    return emptyLabel ? (
      <span className={cn("text-[11px] text-subtle-foreground", className)}>
        {emptyLabel}
      </span>
    ) : null;
  }

  const shown = contentTypes.slice(0, limit);
  const overflow = contentTypes.length - shown.length;

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      {shown.map((contentType) => (
        <ContentTypeChip key={contentType.id} contentType={contentType} size={size} />
      ))}
      {overflow > 0 ? (
        <span
          className="shrink-0 text-[10px] text-subtle-foreground"
          title={contentTypes.map((type) => type.name).join(", ")}
        >
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}
