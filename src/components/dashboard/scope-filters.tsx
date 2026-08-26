"use client";

import * as React from "react";
import { Check, ChevronDown, Layers, Settings2, Users } from "lucide-react";
import Link from "next/link";
import type { NicheDTO } from "@/lib/dto";
import type { NicheFilter, OwnershipFilter } from "@/lib/filters-store";
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
import { cn } from "@/lib/utils";

/**
 * Niche and ownership scope controls.
 *
 * Styled identically to the period and threshold selectors so the toolbar reads
 * as one row of equal-weight questions rather than a growing pile of features:
 *
 *   Niche  ·  Channels  ·  Period  ·  Threshold
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
