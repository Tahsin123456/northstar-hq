"use client";

import * as React from "react";
import { Check, ChevronDown, RotateCcw, Save, Target } from "lucide-react";
import { toast } from "sonner";
import {
  EMPLOYEE_THRESHOLD_NOTICE,
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  THRESHOLD_PRESETS,
  UNCONFIGURED_THRESHOLD_SHORT,
} from "@/lib/analytics/constants";
import {
  useFilters,
  type ThresholdSource,
} from "@/components/providers/filters-provider";
import { useCanConfigureThreshold } from "@/components/niches/niche-threshold-dialog";
import { useUpdateNicheThreshold } from "@/hooks/use-niches";
import { formatCompactNumber, formatNumber } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The hit-threshold control.
 *
 * Sits beside the niche and period selectors because the three together *are*
 * the question: "of the Shorts uploaded in {period} by {niche} channels, how
 * many passed {threshold}?"
 *
 * WHY IT SHOWS ITS SOURCE
 * Different niches can define a hit differently — 1M for GTA, 250K for
 * Science — so a bare number is ambiguous. The control always states where the
 * active value came from: the niche default, an account default, or a
 * temporary override. Without that, someone could compare two niches without
 * realising the word "hit" meant different things in each.
 *
 * Changing it is always a *temporary override*. Writing the niche default is a
 * separate, explicit action, so experimenting on a view can never silently
 * reconfigure a niche for every future session.
 *
 * WHEN THERE IS NO NUMBER
 * A selected niche with no configured threshold shows "Not configured" rather
 * than a figure. Anyone can still type an override — that is a deliberate,
 * clearly-labelled "show me what this would look like at 1M" — but only
 * somebody with `settings.manage` is offered "Save as … default", because only
 * they can turn that experiment into the team's answer.
 */
export function ThresholdSelector({
  className,
  effective,
}: {
  className?: string;
  /**
   * Overrides what the chip reports, for a screen that judges by something
   * narrower than the global filter — a channel page uses its own niche's
   * threshold, and a chip still reading the account default there would
   * contradict every number beside it.
   */
  effective?: {
    threshold: number | null;
    source: ThresholdSource;
    nicheName: string | null;
  };
}) {
  const {
    threshold: globalThreshold,
    thresholdSource: globalSource,
    nicheDefaultThreshold,
    nicheName: globalNicheName,
    niche,
    setThreshold,
    clearThresholdOverride,
  } = useFilters();

  // `effective` is present-or-absent as a whole, so its threshold is read from
  // the same object as its source. `?? globalThreshold` would be wrong here:
  // an effective threshold of `null` is a real answer ("unconfigured"), not a
  // missing one, and coalescing it would put the account default back on screen
  // beside a chip that says the niche has none.
  const threshold = effective ? effective.threshold : globalThreshold;
  const thresholdSource = effective?.source ?? globalSource;
  const nicheName = effective?.nicheName ?? globalNicheName;
  const isUnconfigured = thresholdSource === "unconfigured";

  const [open, setOpen] = React.useState(false);
  const isPreset = THRESHOLD_PRESETS.includes(
    threshold as (typeof THRESHOLD_PRESETS)[number],
  );

  const saveNicheDefault = useUpdateNicheThreshold();
  const canSaveToNiche = niche !== "all" && niche !== "unassigned";
  // Writing the niche default is `settings.manage`, the same permission the
  // service enforces. Without it the "Save as … default" action is not offered.
  const canConfigure = useCanConfigureThreshold();

  const sourceLabel =
    thresholdSource === "override"
      ? "Override"
      : thresholdSource === "niche"
        ? `Default for ${nicheName}`
        : thresholdSource === "unconfigured"
          ? `${nicheName ?? "This niche"} has no threshold`
          : "Account default";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "group inline-flex h-[30px] items-center gap-2 rounded-lg border bg-surface-sunken px-2.5",
            "text-[12px] font-medium transition-colors duration-150",
            // An override is visually distinct so a temporarily changed view is
            // never mistaken for the configured default. An unconfigured niche
            // gets the warning tone for the same reason in reverse: the chip
            // must not look like it is reporting a settled number.
            thresholdSource === "override"
              ? "border-accent/50 hover:border-accent"
              : isUnconfigured
                ? "border-warning/50 hover:border-warning"
                : "border-border hover:border-border-strong",
            className,
          )}
        >
          <Target className="size-3.5 text-subtle-foreground" />
          <span className="text-muted-foreground">Hit</span>
          {isUnconfigured || threshold === null ? (
            <span className="text-warning">{UNCONFIGURED_THRESHOLD_SHORT}</span>
          ) : (
            <span className="tnum text-foreground">
              ≥ {formatCompactNumber(threshold)}
            </span>
          )}
          {thresholdSource === "override" ? (
            <span className="rounded bg-accent-subtle px-1 py-px text-[9px] uppercase tracking-wider text-accent">
              Override
            </span>
          ) : null}
          <ChevronDown className="size-3 text-subtle-foreground transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-[270px] p-2">
        <div className="flex items-baseline justify-between gap-2 px-1 pb-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
            Views required for a hit
          </span>
        </div>

        <div className="mb-2 rounded-md border border-border bg-surface-sunken px-2 py-1.5">
          {threshold === null ? (
            <div className="text-[13px] text-foreground">
              {UNCONFIGURED_THRESHOLD_SHORT}
            </div>
          ) : (
            <div className="tnum text-[13px] text-foreground">
              ≥ {formatNumber(threshold)}
            </div>
          )}
          <div className="mt-0.5 text-[11px] text-subtle-foreground">{sourceLabel}</div>
          {isUnconfigured ? (
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {canConfigure
                ? "Pick a number below and save it as the niche default, or set it on the Niches page."
                : EMPLOYEE_THRESHOLD_NOTICE}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-0.5">
          {THRESHOLD_PRESETS.map((preset) => {
            const active = threshold === preset;
            const isNicheDefault = nicheDefaultThreshold === preset;
            return (
              <button
                key={preset}
                type="button"
                onClick={() => {
                  setThreshold(preset);
                  setOpen(false);
                }}
                className={cn(
                  "flex items-center justify-between rounded px-2 py-1.5 text-[13px] transition-colors duration-100",
                  active
                    ? "bg-surface-hover text-foreground"
                    : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                )}
              >
                <span className="tnum">≥ {formatCompactNumber(preset)}</span>
                <span className="flex items-center gap-2">
                  {isNicheDefault ? (
                    <span className="text-[9px] uppercase tracking-wider text-subtle-foreground">
                      niche
                    </span>
                  ) : null}
                  {active ? <Check className="size-3.5 text-accent" /> : null}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-2 border-t border-border pt-2">
          <CustomThresholdForm
            current={threshold}
            isCustom={!isPreset}
            onApply={(value) => {
              setThreshold(value);
              setOpen(false);
            }}
          />
        </div>

        {/* Making the override explicit and reversible is what keeps niche
            configuration safe from casual experimentation. */}
        {thresholdSource === "override" ? (
          <div className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              onClick={() => {
                clearThresholdOverride();
                setOpen(false);
              }}
            >
              <RotateCcw />
              {/* Three destinations, and the third is not a number. Clearing an
                  override on an unconfigured niche returns the screen to "Not
                  configured", and saying "Reset to account default" there would
                  promise exactly the fallback that no longer happens. */}
              {nicheDefaultThreshold !== null
                ? `Reset to ${nicheName} default`
                : niche !== "all" && niche !== "unassigned"
                  ? "Clear override (no threshold set)"
                  : "Reset to account default"}
            </Button>

            {canSaveToNiche && canConfigure && threshold !== null ? (
              <Button
                variant="secondary"
                size="sm"
                className="justify-start"
                loading={saveNicheDefault.isPending}
                onClick={() =>
                  saveNicheDefault.mutate(
                    { id: niche, hitThreshold: threshold },
                    {
                      onSuccess: () => {
                        clearThresholdOverride();
                        setOpen(false);
                        toast.success(
                          `${nicheName} hit threshold set to ${formatCompactNumber(threshold)}`,
                        );
                      },
                      onError: (e) =>
                        toast.error("Could not save that default", {
                          description: e instanceof Error ? e.message : undefined,
                        }),
                    },
                  )
                }
              >
                <Save />
                Save as {nicheName} default
              </Button>
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function CustomThresholdForm({
  current,
  isCustom,
  onApply,
}: {
  /** `null` when the active niche has no threshold — the field starts empty. */
  current: number | null;
  isCustom: boolean;
  onApply: (value: number) => void;
}) {
  const [value, setValue] = React.useState(() =>
    isCustom && current !== null ? String(current) : "",
  );
  const [error, setError] = React.useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    // Accept "1,000,000" and "1 000 000" — people paste view counts.
    const cleaned = value.replace(/[,\s_]/g, "");
    const parsed = Number(cleaned);

    if (!cleaned || !Number.isFinite(parsed)) {
      setError("Enter a number.");
      return;
    }
    if (parsed < MIN_THRESHOLD) {
      setError(`The threshold must be at least ${MIN_THRESHOLD}.`);
      return;
    }
    if (parsed > MAX_THRESHOLD) {
      setError("That is higher than any video has ever been viewed.");
      return;
    }
    onApply(Math.trunc(parsed));
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 px-1">
      <Label htmlFor="custom-threshold" className="text-[11px] text-muted-foreground">
        Custom threshold
      </Label>
      <div className="flex items-center gap-1.5">
        <Input
          id="custom-threshold"
          inputMode="numeric"
          placeholder="e.g. 750000"
          value={value}
          invalid={Boolean(error)}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          className="h-8 text-[13px]"
        />
        <Button type="submit" variant="primary" size="sm" className="shrink-0">
          Set
        </Button>
      </div>
      {error ? <FieldHint tone="danger">{error}</FieldHint> : null}
    </form>
  );
}
