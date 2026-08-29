"use client";

import * as React from "react";
import { Target } from "lucide-react";
import { toast } from "sonner";
import {
  HIT_WINDOW_PRESETS,
  MAX_HIT_WINDOW_HOURS,
  MAX_THRESHOLD,
  MIN_HIT_WINDOW_HOURS,
  MIN_THRESHOLD,
  THRESHOLD_PRESETS,
} from "@/lib/analytics/constants";
import { formatHitWindow } from "@/lib/analytics/hit-rate";
import type { NicheDTO } from "@/lib/dto";
import { formatCompactNumber } from "@/lib/format";
import { useUpdateNicheRule } from "@/hooks/use-niches";
import { useSession } from "@/components/providers/session-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Setting a niche's hit rule, in one place.
 *
 * BOTH HALVES, IN ONE FORM. A hit is a number of views reached within a set
 * time of publishing, so the bar and the clock are one decision and are made
 * together. Splitting them across two controls would let a niche sit with a
 * threshold and no window — which is the old lifetime comparison, the one that
 * scored the same channels 5.9% at a week old and 18.8% at 30–90 days with
 * nothing about the work changing.
 *
 * This used to live inside the Niches page. It moved here because the same
 * control now has to appear in three places — the Niches page, the admin's
 * niche list, and the "Not configured" banner on any filtered screen — and
 * three copies of a form that writes an organization-wide analysis constant is
 * three chances for them to validate differently.
 *
 * WHO MAY OPEN IT
 * `settings.manage`. A hit threshold is not a per-niche preference; it is the
 * definition of a hit for everybody's charts, payroll included, which is the
 * same class of decision as the organization-wide default this permission
 * already guards. The check here hides the control; the service refuses the
 * write regardless, which is where the rule actually holds.
 */

/** True when the signed-in user may set or change a hit threshold. */
export function useCanConfigureThreshold(): boolean {
  return useSession().can("settings.manage");
}

export function NicheThresholdDialog({
  niche,
  open,
  onOpenChange,
}: {
  niche: NicheDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {open ? <NicheThresholdForm niche={niche} onOpenChange={onOpenChange} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * A button that opens the dialog, for callers that only want "let an admin fix
 * this from here".
 *
 * Renders nothing without the permission rather than rendering a disabled
 * button: an employee looking at an unconfigured niche is not being denied
 * something, they are simply looking at work that belongs to somebody else, and
 * a greyed-out control would suggest otherwise.
 */
export function SetNicheThresholdButton({
  niche,
  label = "Set hit rule",
  variant = "secondary",
  size = "sm",
}: {
  niche: NicheDTO;
  label?: string;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
}) {
  const canConfigure = useCanConfigureThreshold();
  const [open, setOpen] = React.useState(false);

  if (!canConfigure) return null;

  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        <Target />
        {label}
      </Button>
      <NicheThresholdDialog niche={niche} open={open} onOpenChange={setOpen} />
    </>
  );
}

function NicheThresholdForm({
  niche,
  onOpenChange,
}: {
  niche: NicheDTO;
  onOpenChange: (open: boolean) => void;
}) {
  const [value, setValue] = React.useState(
    niche.hitThreshold === null ? "" : String(niche.hitThreshold),
  );
  const [windowValue, setWindowValue] = React.useState(
    niche.hitWindowHours === null ? "" : String(niche.hitWindowHours),
  );
  const [error, setError] = React.useState<string | null>(null);
  const save = useUpdateNicheRule();

  const commit = (hitThreshold: number | null, hitWindowHours: number | null) => {
    save.mutate(
      { id: niche.id, hitThreshold, hitWindowHours },
      {
        onSuccess: () => {
          const complete = hitThreshold !== null && hitWindowHours !== null;
          toast.success(
            complete
              ? `${niche.name}: ${formatCompactNumber(hitThreshold)} views within ${formatHitWindow(hitWindowHours)}`
              : `${niche.name} has no complete hit rule`,
            {
              // Never silent about an incomplete rule. A niche with a bar and no
              // clock reports nothing at all, and an admin who half-filled this
              // form has to be told that rather than discovering it on a chart.
              description: complete
                ? undefined
                : "A hit needs both a number of views and a time to reach it in. No hit rate is reported until both are set.",
            },
          );
          onOpenChange(false);
        },
        onError: (e) =>
          toast.error("Could not save that hit rule", {
            description: e instanceof Error ? e.message : undefined,
          }),
      },
    );
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        // An empty field clears that half rather than erroring. It no longer
        // means "fall back to the account default" — it means the niche has no
        // definition of a hit, and every screen says so.
        const cleaned = value.replace(/[,\s_]/g, "");
        const cleanedWindow = windowValue.replace(/[,\s_]/g, "");

        let threshold: number | null = null;
        if (cleaned) {
          const parsed = Number(cleaned);
          if (!Number.isFinite(parsed) || parsed < MIN_THRESHOLD) {
            setError(
              `Enter a number of at least ${MIN_THRESHOLD}, or leave it empty to clear the threshold.`,
            );
            return;
          }
          if (parsed > MAX_THRESHOLD) {
            setError("That is higher than any video has ever been viewed.");
            return;
          }
          threshold = Math.trunc(parsed);
        }

        let windowHours: number | null = null;
        if (cleanedWindow) {
          const parsed = Number(cleanedWindow);
          if (!Number.isFinite(parsed) || parsed < MIN_HIT_WINDOW_HOURS) {
            setError(
              `Enter a window of at least ${MIN_HIT_WINDOW_HOURS} hour, or leave it empty to clear it.`,
            );
            return;
          }
          if (parsed > MAX_HIT_WINDOW_HOURS) {
            setError("A window longer than a year stops meaning anything.");
            return;
          }
          windowHours = Math.trunc(parsed);
        }

        commit(threshold, windowHours);
      }}
    >
      <DialogHeader>
        <DialogTitle>{niche.name} hit rule</DialogTitle>
        <DialogDescription>
          What counts as a hit in this niche: the views a Short has to reach, and how long
          it has to reach them. Selecting {niche.name} anywhere in the app uses this rule
          automatically.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="niche-threshold">Views required</Label>
          <Input
            id="niche-threshold"
            autoFocus
            inputMode="numeric"
            placeholder="e.g. 750000"
            value={value}
            invalid={Boolean(error)}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
          />
          {error ? <FieldHint tone="danger">{error}</FieldHint> : null}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {THRESHOLD_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => {
                setValue(String(preset));
                setError(null);
              }}
              className={cn(
                "tnum rounded-md border px-2 py-1 text-[12px] font-medium transition-colors",
                Number(value) === preset
                  ? "border-accent bg-accent-subtle text-foreground"
                  : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
              )}
            >
              ≥ {formatCompactNumber(preset)}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="niche-window">Within</Label>
          <Input
            id="niche-window"
            inputMode="numeric"
            placeholder="e.g. 168"
            value={windowValue}
            invalid={Boolean(error)}
            onChange={(event) => {
              setWindowValue(event.target.value);
              setError(null);
            }}
          />
          <FieldHint>
            Hours from publishing. A Short that reaches the threshold after this has
            missed — which is what stops an older Short scoring better than a newer one
            for no reason but the calendar.
          </FieldHint>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {HIT_WINDOW_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => {
                setWindowValue(String(preset));
                setError(null);
              }}
              className={cn(
                "tnum rounded-md border px-2 py-1 text-[12px] font-medium transition-colors",
                Number(windowValue) === preset
                  ? "border-accent bg-accent-subtle text-foreground"
                  : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
              )}
            >
              {formatHitWindow(preset)}
            </button>
          ))}
        </div>

        {/*
          Said before saving, not after. An admin who fills one field and not the
          other has configured nothing, and a niche that silently reports no hit
          rate is exactly the state this product keeps having to explain.
        */}
        {Boolean(value.trim()) !== Boolean(windowValue.trim()) ? (
          <FieldHint tone="danger">
            A hit needs both halves. With only one of them set, no hit rate is reported
            for {niche.name}.
          </FieldHint>
        ) : null}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          Save hit rule
        </Button>
      </DialogFooter>
    </form>
  );
}
