import * as React from "react";
import { X } from "lucide-react";
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
 * ==========================================================================
 * INHERITED AND MANUAL ARE THE SAME TAG, SAID BY DIFFERENT PEOPLE
 * ==========================================================================
 *
 * A Short's tags now come from two places — the channel's, which every one of
 * its Shorts carries without anything being stored against it, and the Short's
 * own, which exist precisely because somebody disagreed with the channel. Both
 * are *true of this Short*, so both render; but "the channel says so" and
 * "somebody said so about this one" are different claims, and a table that drew
 * them identically would hide the only interesting half.
 *
 * THE DISTINCTION IS CARRIED BY SHAPE, NOT COLOUR.
 *
 * A dashed border and a hollow dot for inherited, solid and filled for manual.
 * The `colorIndex` accent still identifies *which* tag it is and must go on
 * meaning only that — reusing it to also mean "inherited" would collide with
 * the six-colour cycle and would say nothing to a reader who cannot separate
 * the hues. Dashes and a hollow centre survive both themes for free, because
 * neither is a colour: they are the same `--border` and `--chart-*` tokens the
 * solid chip already uses, drawn differently.
 *
 * It also happens to be the right metaphor. Nothing is stored for an inherited
 * tag; the outline draws a label that is real but has no row behind it.
 *
 * AND IT STAYS QUIET. This renders on every row of a table that can run to
 * hundreds, where the overwhelmingly common case is "every Short inherits the
 * same two tags from its channel". A treatment loud enough to notice once is a
 * rash two hundred times over, so inherited is the *lighter* of the two — the
 * eye passes over the wallpaper and catches the solid chip, which is the row
 * that deviates and the only one worth stopping on.
 */

interface ContentTypeChipBaseProps {
  contentType: ContentTypeRefDTO;
  className?: string;
  size?: "sm" | "md";
  /** Dimmed styling for a type that has since been archived. */
  muted?: boolean;
  /**
   * This tag comes from the channel rather than from this Short.
   *
   * Orthogonal to `muted`, which is about the *catalogue* entry being retired.
   * A Short can perfectly well inherit an archived tag, and the two treatments
   * compose rather than override each other.
   */
  inherited?: boolean;
  /** A write is in flight. See the panel's note on why it locks every control. */
  removeDisabled?: boolean;
}

/**
 * The removable chip is a PAIR, never one half of one.
 *
 * A union rather than two optional props, so a "×" cannot ship without a label.
 * That is not a style rule: the honest wording differs by origin — "Remove
 * Reaction from this Short" for a manual tag, "Stop applying Memes to this Short
 * — the channel keeps it" for an inherited one — so there is no default this
 * component could supply that would be true in both cases. A generic "Remove"
 * would be actively wrong on the inherited half, which is the half a person is
 * most likely to click by mistake. Making it a type error is cheaper than
 * catching it in review the day somebody adds a third caller.
 *
 * `onRemove` hangs the × INSIDE the chip rather than beside it, because what is
 * being removed is the thing the border draws — a detached × next to a run of
 * chips belongs to whichever one the eye pairs it with, which on a wrapped line
 * is the wrong one. Only the Short's own panel passes it; the dense surfaces
 * reach removal through the popover menu, where a per-chip hit target that small
 * would be a misfire waiting to happen in a table row.
 *
 * A `<button>` inside a `<span>` is valid, and the span is not itself clickable,
 * so there is no nesting to trip over.
 */
export type ContentTypeChipRemoveProps =
  | { onRemove: () => void; removeLabel: string }
  | { onRemove?: undefined; removeLabel?: undefined };

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
  inherited = false,
  onRemove,
  removeLabel,
  removeDisabled = false,
}: ContentTypeChipBaseProps & ContentTypeChipRemoveProps) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded border",
        // The whole distinction, and it is two properties: the border's dashes
        // and the fill behind it. `bg-transparent` rather than a second surface
        // token so the chip sits on whatever the row is doing — including the
        // hover tint, which a raised fill would punch a hole in.
        inherited
          ? "border-dashed border-border-strong bg-transparent"
          : "border-border bg-surface-raised",
        muted || inherited ? "text-subtle-foreground" : "text-muted-foreground",
        size === "sm" ? "px-1.5 py-px text-[10px]" : "px-2 py-0.5 text-[11px]",
        className,
      )}
      title={chipTitle(contentType.name, { muted, inherited })}
    >
      {/*
       * Hollow for inherited, filled for manual — the second non-colour carrier,
       * and the one that still reads at a glance once the border is only 1px of
       * dashes. `boxShadow` draws the ring in the tag's own accent rather than
       * `border`, which at 5px would leave nothing in the middle to see.
       */}
      <span
        aria-hidden
        className={cn(
          "size-[5px] shrink-0 rounded-[1px]",
          muted && "opacity-50",
          inherited && "opacity-80",
        )}
        style={
          inherited
            ? { boxShadow: `inset 0 0 0 1px ${contentTypeColor(contentType.colorIndex)}` }
            : { background: contentTypeColor(contentType.colorIndex) }
        }
      />
      <span className="truncate">{contentType.name}</span>
      {/*
       * The distinction spoken, not just drawn. `title` is a hover affordance
       * and reaches neither a screen reader reliably nor a touch device at all,
       * and "inherited from the channel" is a fact about the data rather than
       * decoration — so it goes in the accessibility tree as text.
       */}
      {inherited ? <span className="sr-only"> (from the channel)</span> : null}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          disabled={removeDisabled}
          aria-label={removeLabel}
          title={removeLabel}
          className={cn(
            "-mr-0.5 grid shrink-0 place-items-center rounded-[3px] transition-colors",
            "text-subtle-foreground hover:bg-surface-hover hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
            "disabled:pointer-events-none disabled:opacity-40",
            size === "sm" ? "size-3" : "size-3.5",
          )}
        >
          <X className={size === "sm" ? "size-2" : "size-2.5"} />
        </button>
      ) : null}
    </span>
  );
}

/** The hover string, assembled once so both call sites below agree. */
function chipTitle(
  name: string,
  { muted, inherited }: { muted: boolean; inherited: boolean },
): string {
  const notes: string[] = [];
  if (inherited) notes.push("from the channel");
  if (muted) notes.push("archived");
  return notes.length > 0 ? `${name} (${notes.join(", ")})` : name;
}

/** No tag on this Short is inherited. A stable identity, so memos downstream hold. */
const NOTHING_INHERITED: ReadonlySet<string> = new Set();

/**
 * Manual tags before inherited ones, catalogue order preserved inside each half.
 *
 * A plain function rather than a `useMemo`, so this module stays renderable from
 * anywhere: it is presentational, the input is a handful of chips, and a partition
 * of two elements costs less than the dependency comparison would. Returns the
 * input array untouched when there is nothing to reorder, so the common cases —
 * a channel's chips, an all-inherited row — allocate nothing.
 */
function orderManualFirst(
  contentTypes: readonly ContentTypeRefDTO[],
  inheritedIds: ReadonlySet<string>,
): readonly ContentTypeRefDTO[] {
  if (inheritedIds.size === 0 || contentTypes.length < 2) return contentTypes;

  // A stable partition rather than a comparator: `sort` is not required to be
  // stable on every engine's fallback path, and the catalogue order inside each
  // half is a promise the rest of the app already relies on.
  const manual = contentTypes.filter((type) => !inheritedIds.has(type.id));
  if (manual.length === 0 || manual.length === contentTypes.length) return contentTypes;
  return [...manual, ...contentTypes.filter((type) => inheritedIds.has(type.id))];
}

/**
 * A Short's content types, collapsed past a limit.
 *
 * Same overflow rule as `NicheChips`: a Short filed under four types must not
 * make its row taller than its neighbours, so the surplus becomes a "+2" whose
 * title attribute carries the full list.
 *
 * MANUAL FIRST, THEN INHERITED, each in the catalogue order it arrived in.
 *
 * The one place this component reorders what it is given, and it earns it at the
 * overflow: with `limit={2}` on a channel whose Shorts all inherit the same two
 * tags, catalogue order would spend both visible slots on the wallpaper and hide
 * the one tag somebody actually filed behind a "+1". The manual tag is the news
 * on the row — it is the reason a row differs from its neighbours — so it is the
 * one guaranteed to survive the collapse.
 *
 * The cost is a little horizontal jitter between rows that deviate and rows that
 * do not, which is the correct thing to spend: rows that differ *should* look
 * like they differ.
 */
export function ContentTypeChips({
  contentTypes,
  inheritedIds = NOTHING_INHERITED,
  limit = 2,
  size = "sm",
  className,
  emptyLabel,
}: {
  contentTypes: readonly ContentTypeRefDTO[];
  /**
   * Which of `contentTypes` came from the channel rather than this Short.
   *
   * A set rather than a second array so a caller passes ONE resolved list and
   * says which half of it is inherited — rather than two lists this component
   * would have to re-join against the catalogue to order. Defaults to none,
   * which is exactly right for the surfaces where the subject is a channel and
   * nothing can be inherited.
   */
  inheritedIds?: ReadonlySet<string>;
  limit?: number;
  size?: "sm" | "md";
  className?: string;
  emptyLabel?: string;
}) {
  const ordered = orderManualFirst(contentTypes, inheritedIds);

  if (ordered.length === 0) {
    return emptyLabel ? (
      <span className={cn("text-[11px] text-subtle-foreground", className)}>
        {emptyLabel}
      </span>
    ) : null;
  }

  const shown = ordered.slice(0, limit);
  const overflow = ordered.length - shown.length;

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", className)}>
      {shown.map((contentType) => (
        <ContentTypeChip
          key={contentType.id}
          contentType={contentType}
          size={size}
          inherited={inheritedIds.has(contentType.id)}
        />
      ))}
      {overflow > 0 ? (
        <span
          className="shrink-0 text-[10px] text-subtle-foreground"
          // The collapsed names still say which are the channel's, because the
          // "+2" is exactly where a reader goes to ask what they are missing.
          title={ordered
            .map((type) =>
              inheritedIds.has(type.id) ? `${type.name} (from the channel)` : type.name,
            )
            .join(", ")}
        >
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}
