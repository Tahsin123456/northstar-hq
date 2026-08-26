"use client";

import * as React from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Channel search.
 *
 * Filters synchronously against the in-memory row list, so results appear as
 * the user types with no debounce and no request. Debouncing would only add
 * latency here — there is nothing to wait for.
 */
export function SearchInput({
  value,
  onChange,
  placeholder = "Search channels…",
  className,
  resultCount,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  resultCount?: number;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  // "/" focuses search, Escape clears it — table-stakes for a dense data tool.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typingElsewhere =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;

      if (event.key === "/" && !typingElsewhere) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle-foreground" />
      <input
        ref={inputRef}
        type="search"
        role="searchbox"
        value={value}
        placeholder={placeholder}
        aria-label="Search channels"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onChange("");
            inputRef.current?.blur();
          }
        }}
        className={cn(
          "h-[30px] w-full rounded-lg border border-border bg-surface-sunken pl-8 pr-16 text-[13px] text-foreground",
          "placeholder:text-subtle-foreground",
          "transition-colors duration-150 hover:border-border-strong",
          "focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)]",
          "[&::-webkit-search-cancel-button]:appearance-none",
        )}
      />

      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
        {value ? (
          <>
            {resultCount !== undefined ? (
              <span className="tnum text-[11px] text-subtle-foreground">{resultCount}</span>
            ) : null}
            <button
              type="button"
              onClick={() => onChange("")}
              aria-label="Clear search"
              className="rounded p-0.5 text-subtle-foreground transition-colors hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </>
        ) : (
          <kbd className="hidden rounded border border-border bg-surface px-1 text-[10px] leading-4 text-subtle-foreground sm:block">
            /
          </kbd>
        )}
      </div>
    </div>
  );
}
