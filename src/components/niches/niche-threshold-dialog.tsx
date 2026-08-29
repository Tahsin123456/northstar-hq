"use client";

import * as React from "react";
import { Target } from "lucide-react";
import { toast } from "sonner";
import {
  MAX_THRESHOLD,
  MIN_THRESHOLD,
  THRESHOLD_PRESETS,
  UNCONFIGURED_THRESHOLD_EXPLANATION,
} from "@/lib/analytics/constants";
import type { NicheDTO } from "@/lib/dto";
import { formatCompactNumber } from "@/lib/format";
import { useUpdateNicheThreshold } from "@/hooks/use-niches";
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
 * Setting a niche's hit threshold, in one place.
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
  label = "Set threshold",
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
  const [error, setError] = React.useState<string | null>(null);
  const save = useUpdateNicheThreshold();

  const commit = (hitThreshold: number | null) => {
    save.mutate(
      { id: niche.id, hitThreshold },
      {
        onSuccess: () => {
          toast.success(
            hitThreshold === null
              ? `${niche.name} now has no hit rate threshold`
              : `${niche.name} hit threshold set to ${formatCompactNumber(hitThreshold)}`,
            {
              description:
                hitThreshold === null
                  ? "No hit rate will be reported for it until one is set."
                  : undefined,
            },
          );
          onOpenChange(false);
        },
        onError: (e) =>
          toast.error("Could not save that threshold", {
            description: e instanceof Error ? e.message : undefined,
          }),
      },
    );
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        // An empty field clears the threshold rather than erroring. It no longer
        // means "fall back to the account default" — it means the niche has no
        // definition of a hit, and every screen says so.
        const cleaned = value.replace(/[,\s_]/g, "");
        if (!cleaned) {
          commit(null);
          return;
        }
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
        commit(Math.trunc(parsed));
      }}
    >
      <DialogHeader>
        <DialogTitle>{niche.name} hit threshold</DialogTitle>
        <DialogDescription>
          What counts as a hit in this niche. Selecting {niche.name} anywhere in the app
          uses this number automatically.
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
          {error ? (
            <FieldHint tone="danger">{error}</FieldHint>
          ) : (
            <FieldHint>
              Leave empty to clear it. {UNCONFIGURED_THRESHOLD_EXPLANATION}
            </FieldHint>
          )}
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
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          Save threshold
        </Button>
      </DialogFooter>
    </form>
  );
}
