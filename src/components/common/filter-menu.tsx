"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * One labelled "narrow this list by…" dropdown.
 *
 * Lifted out of the Notes page rather than copied into the Saved page beside
 * it. The two screens are the same round's answer to the same request — filter
 * the team's research by who made it and when — and they sit one nav item
 * apart, so a reader moving between them should not be operating two controls
 * that merely resemble each other. Sharing the component is what makes the
 * label placement, the truncation width and the separator identical by
 * construction instead of by somebody remembering.
 *
 * Deliberately presentational and deliberately dumb: it renders the options it
 * is handed and reports the chosen id. It knows nothing about notes, saves,
 * employees or dates, which is why the same file can serve a menu of four
 * literals and a menu of the whole roster.
 */
export function FilterMenu({
  label,
  value,
  options,
  current,
  onChange,
  className,
}: {
  /** The quiet prefix — "Author", "Saved", "Sort". */
  label: string;
  /** The chosen option's text, resolved by the caller. */
  value: string;
  options: readonly { id: string; label: string }[];
  current: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "group inline-flex h-[30px] items-center gap-2 rounded-lg border border-border bg-surface-sunken px-2.5 text-[12px] font-medium transition-colors duration-150 hover:border-border-strong",
            className,
          )}
        >
          <span className="text-muted-foreground">{label}</span>
          <span className="max-w-[130px] truncate text-foreground">{value}</span>
          <ChevronDown className="size-3 text-subtle-foreground transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[320px] overflow-y-auto">
        <DropdownMenuRadioGroup value={current} onValueChange={onChange}>
          {options.map((option, index) => (
            <React.Fragment key={option.id}>
              {/* After the first option only. Every menu here leads with its
                  "no narrowing" choice — Anyone, Any time, All saved — and the
                  rule separates that from the actual narrowings below it. */}
              {index === 1 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuRadioItem value={option.id}>
                <span className="max-w-[220px] truncate">{option.label}</span>
              </DropdownMenuRadioItem>
            </React.Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The date ranges the research screens offer, and the cut-off each one means.
 *
 * ==========================================================================
 * THE CUT-OFF IS RESOLVED WHEN THE RANGE IS CHOSEN, NOT DURING RENDER
 * ==========================================================================
 * These filters go to the server, so the chosen instant becomes part of a query
 * key. A value derived from a ticking clock would therefore produce a new key —
 * and a new request — on every render that happened to cross a millisecond
 * boundary, refetching the list under a reader who had not touched anything and
 * scrolling their place away. "Last 7 days" is a question asked at a moment;
 * `resolveDateFilter` records that moment.
 */
export type DateFilterId = "all" | "7d" | "30d" | "90d";

export const DATE_FILTER_IDS: readonly DateFilterId[] = ["all", "7d", "30d", "90d"];

export const DATE_FILTER_LABELS: Record<DateFilterId, string> = {
  all: "Any time",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

/** A chosen range, with its cut-off already fixed. */
export interface ResolvedDateFilter {
  readonly id: DateFilterId;
  /** Epoch ms, or undefined for "Any time" — which asks the server for nothing. */
  readonly since?: number;
}

const DAY_MS = 86_400_000;

/**
 * Turn a chosen range into an absolute cut-off.
 *
 * Call this from the change handler, never from render — see the note above.
 */
export function resolveDateFilter(id: DateFilterId): ResolvedDateFilter {
  if (id === "all") return { id };
  return { id, since: Date.now() - Number(id.replace("d", "")) * DAY_MS };
}
