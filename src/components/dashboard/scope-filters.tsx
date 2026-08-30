"use client";

import * as React from "react";
import { Check, ChevronDown, Layers, Settings2, Shapes, Users } from "lucide-react";
import Link from "next/link";
import type { ContentTypeDTO, NicheDTO } from "@/lib/dto";
import type {
  ContentTypeFilter,
  NicheFilter,
  OwnershipFilter,
} from "@/lib/filters-store";
import { useFilters } from "@/components/providers/filters-provider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { nicheColor } from "@/components/niches/niche-chip";
import { contentTypeColor } from "@/components/content-types/content-type-chip";
import { cn } from "@/lib/utils";

/**
 * Niche, content-type and ownership scope controls.
 *
 * Styled identically to the period and threshold selectors so the toolbar reads
 * as one row of equal-weight questions rather than a growing pile of features:
 *
 *   Niche  ·  Type  ·  Channels  ·  Period  ·  Threshold
 *
 * Both are pure client-side predicates over the already-fetched dataset, so
 * they cost exactly as much as changing the threshold: nothing.
 */

const TRIGGER_CLASS =
  "group inline-flex h-[30px] items-center gap-2 rounded-lg border border-border bg-surface-sunken px-2.5 text-[12px] font-medium transition-colors duration-150 hover:border-border-strong";

export function NicheFilterControl({
  niches,
  unassignedCount,
  className,
}: {
  niches: readonly NicheDTO[];
  unassignedCount: number;
  className?: string;
}) {
  const { niche, setNiche } = useFilters();

  const selected = niches.find((n) => n.id === niche) ?? null;
  const label =
    niche === "all" ? "All niches" : niche === "unassigned" ? "Uncategorised" : (selected?.name ?? "All niches");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(TRIGGER_CLASS, className)}>
          {selected ? (
            <span
              aria-hidden
              className="size-[6px] shrink-0 rounded-full"
              style={{ background: nicheColor(selected.colorIndex) }}
            />
          ) : (
            <Layers className="size-3.5 text-subtle-foreground" />
          )}
          <span className="text-muted-foreground">Niche</span>
          <span className="max-w-[140px] truncate text-foreground">{label}</span>
          <ChevronDown className="size-3 text-subtle-foreground transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-[220px]">
        <DropdownMenuRadioGroup
          value={niche}
          onValueChange={(value) => setNiche(value as NicheFilter)}
        >
          <DropdownMenuRadioItem value="all">All niches</DropdownMenuRadioItem>

          {niches.length > 0 ? <DropdownMenuSeparator /> : null}

          {niches.map((item) => (
            <DropdownMenuRadioItem key={item.id} value={item.id}>
              <span className="flex w-full items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden
                    className="size-[6px] shrink-0 rounded-full"
                    style={{ background: nicheColor(item.colorIndex) }}
                  />
                  <span className="truncate">{item.name}</span>
                </span>
                <span className="tnum shrink-0 text-[11px] text-subtle-foreground">
                  {item.channelCount}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}

          {/* Only offered when it would actually match something — an empty
              "Uncategorised" option is noise. */}
          {unassignedCount > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuRadioItem value="unassigned">
                <span className="flex w-full items-center justify-between gap-3">
                  <span className="text-muted-foreground">Uncategorised</span>
                  <span className="tnum shrink-0 text-[11px] text-subtle-foreground">
                    {unassignedCount}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            </>
          ) : null}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/niches">
            <Settings2 />
            Manage niches
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Content-type scope — ONE FLAT ORG-WIDE MENU.
 *
 * This control briefly required a niche to be selected first, because a content
 * type belonged to one. It does not any more: the vocabulary is a single
 * centralised list of tags attached to channels and Shorts, so the menu offers
 * all of it, always, and pairs with any niche or none.
 *
 * What that removes is worth naming, because it was a real cost: the previous
 * version could show "Pick a niche" — a filter that had to be unlocked before it
 * could be used, in a toolbar whose other four controls are answerable
 * immediately. A row of equal-weight questions should not contain one that
 * answers "not yet".
 *
 * The catalogue arrives with archived types included. Only active ones are
 * offered, but a currently-selected archived type is kept in the list so a
 * shared `?contentType=` link does not silently widen to "All" on the
 * recipient's screen.
 *
 * Still one array pass over data already in memory. Nothing here enters a query
 * key, so selecting a content type cannot cause a fetch — the same guarantee
 * the period and threshold controls make.
 */
export function ContentTypeFilterControl({
  contentTypes,
  unassignedCount,
  shortCounts,
  channelCounts,
  unit = "channel",
  className,
}: {
  contentTypes: readonly ContentTypeDTO[];
  /**
   * How many of the rows currently in view carry no tag — the "Untagged" count.
   *
   * Counted over the rows the OTHER filters are already showing, not over the
   * whole tracker, so selecting it can never offer a number and then render a
   * different one.
   */
  unassignedCount: number;
  /**
   * typeId -> Shorts effectively carrying it. Required in the `"short"` unit.
   *
   * PASSED IN, BECAUSE THE CATALOGUE ROW CAN NO LONGER ANSWER IT. It used to
   * read `ContentTypeDTO.videoCount` — a count of stored rows — and that number
   * has stopped meaning "Shorts filed as this". A tag on a channel reaches every
   * Short beneath it without a row existing, so the catalogue's
   * `manualVideoCount` now counts only the deviations: it would offer
   * "Memes · 3" above a feed that is about to return four hundred.
   *
   * There is no honest way to fix that on the server either — the answer depends
   * on resolving every Short against its channel, which is exactly what the
   * caller has already done to produce `unassignedCount`. So it comes from the
   * same pass, and the badge and the filter cannot disagree.
   */
  shortCounts?: ReadonlyMap<string, number>;
  /**
   * typeId -> channels carrying it. Required in the `"channel"` unit.
   *
   * PASSED IN FOR THE SAME REASON `shortCounts` IS, and the reason is new. This
   * used to read `ContentTypeDTO.channelCount` off the catalogue, which was
   * exactly right while a channel carried a flat set of tags. The catalogue now
   * counts RULES — a channel that made rankings until March and again from
   * September has two — which is the honest answer to "what would deleting this
   * type destroy?" and the wrong answer to "how many rows will this filter
   * show?". It also counts channels outside a niche-scoped viewer's reach.
   *
   * Counted off the same rows the filter runs over, so the badge and the list
   * cannot disagree.
   */
  channelCounts?: ReadonlyMap<string, number>;
  /**
   * What this menu is about to narrow.
   *
   * The same filter means two things depending on the surface — the channel
   * list reads a channel's own tags, the Shorts feeds read each Short's
   * classification — and the menu has to say which, because the numbers beside
   * each row are different numbers. A menu that offered "Rankings · 6" on a
   * page whose rows are Shorts would be counting the wrong thing at the reader.
   */
  unit?: "channel" | "short";
  className?: string;
}) {
  const { contentType, setContentType } = useFilters();

  const options = React.useMemo(() => {
    const active = contentTypes.filter((type) => type.isActive);
    const selected = contentTypes.find((type) => type.id === contentType);
    return selected && !selected.isActive ? [...active, selected] : active;
  }, [contentTypes, contentType]);

  // An organization that has not defined any content types gets no control. The
  // toolbar is a row of equal-weight questions, and a question with exactly one
  // possible answer is not one — the sidebar entry is where the feature is
  // discovered. The `contentType !== "all"` escape hatch matters: a link can
  // arrive carrying a type this viewer cannot see, and hiding the control would
  // leave them narrowed with no way to widen.
  if (contentTypes.length === 0 && contentType === "all") return null;

  const selected = options.find((type) => type.id === contentType) ?? null;
  const label =
    contentType === "all"
      ? "All types"
      : contentType === "unassigned"
        ? "Untagged"
        : (selected?.name ?? "All types");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(TRIGGER_CLASS, className)}>
          {selected ? (
            <span
              aria-hidden
              className="size-[6px] shrink-0 rounded-[1px]"
              style={{ background: contentTypeColor(selected.colorIndex) }}
            />
          ) : (
            <Shapes className="size-3.5 text-subtle-foreground" />
          )}
          <span className="text-muted-foreground">Type</span>
          <span className="max-w-[140px] truncate text-foreground">{label}</span>
          <ChevronDown className="size-3 text-subtle-foreground transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-[240px]">
        <DropdownMenuLabel>
          {unit === "channel" ? "Channels that make…" : "Shorts filed as…"}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={contentType}
          onValueChange={(value) => setContentType(value as ContentTypeFilter)}
        >
          <DropdownMenuRadioItem value="all">All types</DropdownMenuRadioItem>

          {options.length > 0 ? <DropdownMenuSeparator /> : null}

          {options.map((item) => (
            <DropdownMenuRadioItem key={item.id} value={item.id}>
              <span className="flex w-full items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden
                    className="size-[6px] shrink-0 rounded-[1px]"
                    style={{ background: contentTypeColor(item.colorIndex) }}
                  />
                  <span className="truncate">{item.name}</span>
                  {!item.isActive ? (
                    <span className="shrink-0 text-[10px] text-subtle-foreground">
                      archived
                    </span>
                  ) : null}
                </span>
                {/* The count has to be in the unit this menu narrows, or it
                    promises a number of rows it will not deliver — and NEITHER
                    unit can be counted off the catalogue any more. The Shorts
                    number has to be resolved per Short; the channel number has
                    to be distinct channels rather than the catalogue's count of
                    rules. Both come from the caller's own pass over the rows in
                    view, which is the only way the badge and the list stay two
                    readings of one derivation. */}
                <span className="tnum shrink-0 text-[11px] text-subtle-foreground">
                  {unit === "channel"
                    ? (channelCounts?.get(item.id) ?? 0)
                    : (shortCounts?.get(item.id) ?? 0)}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}

          {/* "Untagged" only means something once there is a vocabulary — with
              an empty list it would select every channel and read as a bug. */}
          {unassignedCount > 0 && options.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuRadioItem value="unassigned">
                <span className="flex w-full items-center justify-between gap-3">
                  <span className="text-muted-foreground">Untagged</span>
                  <span className="tnum shrink-0 text-[11px] text-subtle-foreground">
                    {unassignedCount}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            </>
          ) : null}
        </DropdownMenuRadioGroup>

        {options.length === 0 ? (
          <p className="px-2 py-2 text-[11px] leading-relaxed text-subtle-foreground">
            No content types yet. They are whatever vocabulary your team actually
            argues in &mdash; &ldquo;Funny Moment&rdquo;, &ldquo;Ranking&rdquo;,
            &ldquo;Cutscene&rdquo;.
          </p>
        ) : null}

        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/content-types">
            <Settings2 />
            Manage content types
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const OWNERSHIP_LABELS: Record<OwnershipFilter, string> = {
  all: "All channels",
  own: "Our channels",
  competitor: "Competitors",
};

export function OwnershipFilterControl({
  ownCount,
  competitorCount,
  className,
}: {
  ownCount: number;
  competitorCount: number;
  className?: string;
}) {
  const { ownership, setOwnership, ownFirst, setOwnFirst } = useFilters();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn(TRIGGER_CLASS, className)}>
          <Users className="size-3.5 text-subtle-foreground" />
          <span className="text-muted-foreground">Channels</span>
          <span className="text-foreground">{OWNERSHIP_LABELS[ownership]}</span>
          <ChevronDown className="size-3 text-subtle-foreground transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-[212px]">
        <DropdownMenuRadioGroup
          value={ownership}
          onValueChange={(value) => setOwnership(value as OwnershipFilter)}
        >
          <DropdownMenuRadioItem value="all">
            <span className="flex w-full items-center justify-between gap-3">
              All channels
              <span className="tnum text-[11px] text-subtle-foreground">
                {ownCount + competitorCount}
              </span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="own">
            <span className="flex w-full items-center justify-between gap-3">
              Our channels
              <span className="tnum text-[11px] text-subtle-foreground">{ownCount}</span>
            </span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="competitor">
            <span className="flex w-full items-center justify-between gap-3">
              Competitors
              <span className="tnum text-[11px] text-subtle-foreground">
                {competitorCount}
              </span>
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        <DropdownMenuLabel>Ordering</DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={(event) => {
            // Keep the menu open: this is a modifier on the current view, and
            // closing would make trying it on and off tedious.
            event.preventDefault();
            setOwnFirst(!ownFirst);
          }}
        >
          <span className="flex w-full items-center justify-between gap-3">
            Our channels first
            {ownFirst ? <Check className="size-3.5 text-accent" /> : null}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Compact "showing X of Y" note with a one-click reset. */
export function ScopeSummary({
  shown,
  total,
  className,
}: {
  shown: number;
  total: number;
  className?: string;
}) {
  const { hasScopeFilter, clearScopeFilters } = useFilters();
  if (!hasScopeFilter) return null;

  return (
    <span className={cn("inline-flex items-center gap-2 text-[11px]", className)}>
      <span className="tnum text-subtle-foreground">
        {shown} of {total} channels
      </span>
      <button
        type="button"
        onClick={clearScopeFilters}
        className="text-accent transition-colors hover:text-accent-hover"
      >
        Clear filters
      </button>
    </span>
  );
}
