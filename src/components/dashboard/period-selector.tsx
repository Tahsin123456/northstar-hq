"use client";

import * as React from "react";
import { CalendarRange } from "lucide-react";
import { PERIOD_PRESETS } from "@/lib/analytics/constants";
import type { PeriodPresetId } from "@/lib/analytics/types";
import { useFilters } from "@/components/providers/filters-provider";
import {
  customRangeFromDates,
  fromDateInputValue,
  toDateInputValue,
} from "@/lib/date-range";
import { Button } from "@/components/ui/button";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";

/**
 * The period control: 7D | 30D | 90D | 180D | Custom.
 *
 * A segmented control rather than a dropdown, because switching between
 * periods is the primary comparison gesture in this product — you look at 30D,
 * then 90D, then back — and that should cost one click, not two. Changing it
 * mutates client state only; no request is made.
 */
export function PeriodSelector({ className }: { className?: string }) {
  const { period, setPeriodPreset, setCustomRange, range } = useFilters();
  const [customOpen, setCustomOpen] = React.useState(false);

  const handleSelect = (preset: PeriodPresetId) => {
    if (preset === "custom") {
      setCustomOpen(true);
      return;
    }
    setPeriodPreset(preset);
  };

  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface-sunken p-0.5",
        className,
      )}
      role="group"
      aria-label="Analysis period"
    >
      {PERIOD_PRESETS.filter((p) => p.id !== "custom").map((preset) => {
        const isActive = period.preset === preset.id;
        return (
          <button
            key={preset.id}
            type="button"
            onClick={() => handleSelect(preset.id)}
            aria-pressed={isActive}
            title={preset.label}
            className={cn(
              "rounded-[5px] px-2.5 py-1 text-[12px] font-medium transition-colors duration-150",
              isActive
                ? "bg-surface-raised text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.2)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {preset.shortLabel}
          </button>
        );
      })}

      <Popover open={customOpen} onOpenChange={setCustomOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-pressed={period.preset === "custom"}
            className={cn(
              "flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-[12px] font-medium transition-colors duration-150",
              period.preset === "custom"
                ? "bg-surface-raised text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.2)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <CalendarRange className="size-3.5" />
            Custom
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[290px]">
          <CustomRangeForm
            initialStart={range.startMs}
            initialEnd={range.endMs}
            onApply={(startMs, endMs) => {
              setCustomRange(startMs, endMs);
              setCustomOpen(false);
            }}
            onCancel={() => setCustomOpen(false)}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function CustomRangeForm({
  initialStart,
  initialEnd,
  onApply,
  onCancel,
}: {
  initialStart: number;
  initialEnd: number;
  onApply: (startMs: number, endMs: number) => void;
  onCancel: () => void;
}) {
  const [start, setStart] = React.useState(() => toDateInputValue(initialStart));
  // The stored end bound is exclusive midnight of the following day; step back
  // one millisecond so the picker shows the last day the user actually included.
  const [end, setEnd] = React.useState(() => toDateInputValue(initialEnd - 1));
  const [error, setError] = React.useState<string | null>(null);

  // From the shared clock store rather than Date.now(), which would be an
  // impure read during render. Omitted until the store has a value, which only
  // costs the `max` attribute for a frame.
  const now = useNow();
  const today = now > 0 ? toDateInputValue(now) : undefined;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();

    const startDate = fromDateInputValue(start);
    const endDate = fromDateInputValue(end);

    if (!startDate || !endDate) {
      setError("Enter both a start and an end date.");
      return;
    }
    if (startDate > endDate) {
      setError("The start date must be on or before the end date.");
      return;
    }

    const selection = customRangeFromDates(startDate, endDate);
    onApply(selection.customStartMs!, selection.customEndMs!);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="range-start">Start date</Label>
        <Input
          id="range-start"
          type="date"
          value={start}
          max={today}
          onChange={(e) => {
            setStart(e.target.value);
            setError(null);
          }}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="range-end">End date</Label>
        <Input
          id="range-end"
          type="date"
          value={end}
          max={today}
          onChange={(e) => {
            setEnd(e.target.value);
            setError(null);
          }}
        />
      </div>

      {error ? <FieldHint tone="danger">{error}</FieldHint> : null}

      <FieldHint>
        Both dates are inclusive. Only Shorts uploaded inside this range are
        counted.
      </FieldHint>

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm">
          Apply range
        </Button>
      </div>
    </form>
  );
}
