"use client";

import * as React from "react";
import { DollarSign } from "lucide-react";
import { toast } from "sonner";
import {
  MAX_RPM_MAJOR_PER_THOUSAND,
  RPM_IMPLAUSIBLE_MAJOR_PER_THOUSAND,
  formatRpm,
  maxRpmMinorPerMillion,
  parseRpmToMinorPerMillion,
  rpmToInputText,
  rpmDigitsFor,
} from "@/lib/analytics/niche-rpm";
import type { NicheDTO } from "@/lib/dto";
import {
  buildNicheRpmPatch,
  leavesNicheUnpriced,
  rpmWithheld,
} from "@/lib/niches/niche-rpm-patch";
import { useOrgBaseCurrency } from "@/hooks/use-org-currency";
import { useSetNicheRpm } from "@/hooks/use-niches";
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

/**
 * Setting what 1,000 views in a niche are worth.
 *
 * A SEPARATE DIALOG FROM THE HIT RULE, deliberately, and the reasons are worth
 * stating because putting two more boxes in the existing form was the obvious
 * move:
 *
 *   • That form's whole thesis is "three fields, one rule, one form" — a bar, a
 *     clock, and what clearing them pays. An RPM decides neither what a hit is
 *     nor what one is worth to an employee; it says what the MARKET pays for
 *     views, which is a fact about the outside world rather than about
 *     Northstar's own scoring.
 *   • Its title is "{niche} hit rule" and its button says "Save hit rule".
 *     Writing a price through a control labelled that way is a mislabelled act.
 *   • It hides its payment field for a watchlist niche. A watchlist niche is
 *     exactly where a hand-entered RPM matters most — the studio has no channel
 *     there, so no rate can ever be derived — so one `watchlist` boolean would
 *     have to drive two opposite conditionals in one form.
 *   • It carries ONE `error` string that every input reads as `invalid`, so a
 *     bad RPM low bound would redden the threshold and the window too.
 *
 * WHO MAY OPEN IT
 * `settings.manage` AND `finance.view`. The first because a rate is
 * organization-wide analysis configuration, like the hit rule. The second
 * because the stored range is only ever SHOWN to somebody holding
 * `finance.view` — and a writer who cannot read what is there would open two
 * empty boxes over a stored range and destroy it on save. Requiring both makes
 * that state unreachable instead of merely unlikely. The service enforces the
 * same pair, which is where the rule actually holds.
 */

/** True when the signed-in user may see niche economics at all. */
export function useCanReadNicheEconomics(): boolean {
  return useSession().can("finance.view");
}

/** True when they may also set the range. Both permissions, see above. */
export function useCanConfigureRpm(): boolean {
  const session = useSession();
  return session.can("settings.manage") && session.can("finance.view");
}

export function NicheRpmDialog({
  niche,
  open,
  onOpenChange,
}: {
  niche: NicheDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const currency = useOrgBaseCurrency(useCanConfigureRpm());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {/*
          `key={currency}` remounts the form if the organization's currency
          arrives after it opened, for the same reason the hit-rule dialog does
          it: the fields' initial text is formatted at that currency's precision,
          and an RPM carries three digits beyond it — so a form seeded from the
          fallback would show a number of a different magnitude entirely.
        */}
        {open ? (
          <NicheRpmForm
            key={currency}
            niche={niche}
            currency={currency}
            onOpenChange={onOpenChange}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * A button that opens the dialog, for a surface that only wants "let somebody
 * fix this from here".
 *
 * Renders nothing without the permission rather than a disabled control,
 * following `SetNicheThresholdButton`: somebody looking at an unpriced niche is
 * not being denied something, they are looking at work that belongs to
 * somebody else, and a greyed-out button would suggest otherwise.
 */
export function SetNicheRpmButton({
  niche,
  label = "Set RPM range",
}: {
  niche: NicheDTO;
  label?: string;
}) {
  const canConfigure = useCanConfigureRpm();
  const [open, setOpen] = React.useState(false);

  if (!canConfigure) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[11px] font-medium text-accent transition-colors hover:text-accent-hover"
      >
        {label}
      </button>
      <NicheRpmDialog niche={niche} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** The stored range as this form's two boxes, or empty strings. */
function seedFields(
  niche: NicheDTO,
  currency: string,
): { low: string; high: string } {
  const rpm = niche.rpm;
  // The stored range travels on the resolution whether or not it is the one in
  // force: a derived rate carries the range it is OVERRIDING, precisely so this
  // form can show the admin what they typed rather than an empty box.
  // `enteredRange`, never `range`. The two differ only when the stored range
  // was converted into the organization's base on read — and the boxes have to
  // show the digits somebody typed, not a converted figure nobody did.
  const range =
    rpm === null
      ? null
      : rpm.source === "manual"
        ? rpm.enteredRange
        : rpm.source === "derived"
          ? rpm.supersededRange
          : rpm.unconvertibleRange;
  if (range === null || range.currency !== currency) {
    // A range stored in another currency is not seeded into fields labelled
    // with this one. Converting it here would put a number in the box that
    // nobody typed, and showing the digits under the wrong symbol would be
    // worse still; the form starts empty and the strip says what is stored.
    return { low: "", high: "" };
  }
  return {
    low: rpmToInputText(range.lowMinorPerMillion, currency),
    high: rpmToInputText(range.highMinorPerMillion, currency),
  };
}

function NicheRpmForm({
  niche,
  currency,
  onOpenChange,
}: {
  niche: NicheDTO;
  /** The organization's base currency — what the range is entered in. */
  currency: string;
  onOpenChange: (open: boolean) => void;
}) {
  const seeded = React.useMemo(() => seedFields(niche, currency), [niche, currency]);
  const [lowValue, setLowValue] = React.useState(seeded.low);
  const [highValue, setHighValue] = React.useState(seeded.high);
  /*
   * A message PER FIELD, not one shared string.
   *
   * The hit-rule dialog has a single `error` that every input reads as
   * `invalid`, which is tolerable across three unrelated fields and would not
   * be here: these two are a pair, and reddening both because one of them is
   * unreadable would hide which end the reader has to fix.
   */
  const [lowError, setLowError] = React.useState<string | null>(null);
  const [highError, setHighError] = React.useState<string | null>(null);
  const [rangeError, setRangeError] = React.useState<string | null>(null);
  const save = useSetNicheRpm();

  /** True when this form was never shown the stored range. See the patch module. */
  const unloaded = rpmWithheld(niche.rpm);

  const parseEnd = (
    text: string,
    setError: (message: string | null) => void,
  ): { ok: true; value: number | null } | { ok: false } => {
    if (!text.trim()) return { ok: true, value: null };
    const parsed = parseRpmToMinorPerMillion(text, currency);
    if (parsed === null) {
      setError("Enter an amount like 0.04 or 1.50, or leave both empty to clear the range.");
      return { ok: false };
    }
    if (parsed <= 0) {
      // The same refusal the hit payment makes, for the same reason: an RPM of
      // nothing is not an estimate, it is a claim that the niche pays nothing,
      // and it would multiply the niche's whole view count by zero.
      setError("An RPM of nothing is not an estimate. Leave both empty to clear it instead.");
      return { ok: false };
    }
    if (parsed > maxRpmMinorPerMillion(currency)) {
      setError(
        `That is more than ${MAX_RPM_MAJOR_PER_THOUSAND} ${currency} per 1,000 views, which is higher than any format has ever paid — check the decimal point.`,
      );
      return { ok: false };
    }
    return { ok: true, value: parsed };
  };

  // The soft warning, shown while typing rather than on submit. A rate this
  // high is far more likely to be a decimal place in the wrong place than a
  // considered estimate, and saying so before the save costs nothing.
  const implausible = React.useMemo(() => {
    const ceiling =
      RPM_IMPLAUSIBLE_MAJOR_PER_THOUSAND * 10 ** rpmDigitsFor(currency);
    const parsed = parseRpmToMinorPerMillion(highValue || lowValue, currency);
    return parsed !== null && parsed > ceiling;
  }, [highValue, lowValue, currency]);

  const halfFilled = Boolean(lowValue.trim()) !== Boolean(highValue.trim());

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setLowError(null);
        setHighError(null);
        setRangeError(null);

        const low = parseEnd(lowValue, setLowError);
        if (!low.ok) return;
        const high = parseEnd(highValue, setHighError);
        if (!high.ok) return;

        if ((low.value === null) !== (high.value === null)) {
          setRangeError(
            "An RPM needs both ends. Enter a low and a high, or clear both to leave the niche unpriced.",
          );
          return;
        }
        if (low.value !== null && high.value !== null && high.value < low.value) {
          setRangeError("The low end has to be at or below the high end.");
          return;
        }

        const draft = {
          loadedRpm: niche.rpm,
          lowMinorPerMillion: low.value,
          highMinorPerMillion: high.value,
          currency,
        };
        const patch = buildNicheRpmPatch(draft);

        /*
         * NOTHING TO SEND is a successful save, not a silent failure.
         *
         * It happens only when the range was withheld from this form and
         * nothing was typed — so the stored range is untouched, which is
         * exactly what leaving the boxes alone should mean. Sending three nulls
         * here is the bug this whole path exists to prevent.
         */
        if (patch === null) {
          onOpenChange(false);
          return;
        }

        const unpriced = leavesNicheUnpriced(draft);
        save.mutate(
          { id: niche.id, ...patch },
          {
            onSuccess: () => {
              toast.success(
                unpriced
                  ? `${niche.name} has no RPM estimate`
                  : `${niche.name}: ${formatRpm(low.value ?? 0, currency)}–${formatRpm(
                      high.value ?? 0,
                      currency,
                    )} per 1,000 views`,
                {
                  description: unpriced
                    ? "No money figure is shown for this niche until somebody prices it again, or a monetized channel here starts reporting revenue."
                    : "This is a fallback. If Northstar runs a monetized channel in this niche, that channel's own rate is used instead.",
                },
              );
              onOpenChange(false);
            },
            onError: (e) =>
              toast.error("Could not save that RPM range", {
                description: e instanceof Error ? e.message : undefined,
              }),
          },
        );
      }}
    >
      <DialogHeader>
        <DialogTitle>{niche.name} RPM</DialogTitle>
        <DialogDescription>
          What 1,000 views in {niche.name} are worth, as a low–high range. This is used
          to estimate how much the tracked niche is generating and how much of it
          Northstar is capturing. If Northstar operates a monetized channel here, that
          channel&rsquo;s own measured rate is used instead of this.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="niche-rpm-low">Low ({currency} per 1,000 views)</Label>
            <Input
              id="niche-rpm-low"
              autoFocus
              inputMode="decimal"
              placeholder="e.g. 0.03"
              value={lowValue}
              invalid={Boolean(lowError)}
              onChange={(event) => {
                setLowValue(event.target.value);
                setLowError(null);
                setRangeError(null);
              }}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="niche-rpm-high">High</Label>
            <Input
              id="niche-rpm-high"
              inputMode="decimal"
              placeholder="e.g. 0.08"
              value={highValue}
              invalid={Boolean(highError)}
              onChange={(event) => {
                setHighValue(event.target.value);
                setHighError(null);
                setRangeError(null);
              }}
            />
          </div>
        </div>

        {lowError ? <FieldHint tone="danger">{lowError}</FieldHint> : null}
        {highError ? <FieldHint tone="danger">{highError}</FieldHint> : null}
        {rangeError ? <FieldHint tone="danger">{rangeError}</FieldHint> : null}

        <FieldHint>
          A range rather than a single number, because this is a judgement and not a
          measurement. Shorts rates are usually well under {formatRpm(
            10 ** rpmDigitsFor(currency) / 10,
            currency,
          )}{" "}
          per 1,000 views. Leave both empty to clear the estimate.
        </FieldHint>

        {/*
          Said where the empty boxes are, because empty boxes are the thing that
          misleads. This form was not shown the stored range — the payload
          withheld it — so a blank field here does not mean "nothing is set".
          Unreachable today, because writing the range requires the permission
          that reads it; kept because the two gates can drift apart and this is
          the sentence that would stop the drift destroying a number.
        */}
        {unloaded ? (
          <FieldHint>
            {niche.name}&rsquo;s stored RPM is not shown here. Saving without typing
            anything leaves it untouched; type a range to replace it.
          </FieldHint>
        ) : null}

        {halfFilled ? (
          <FieldHint tone="danger">
            An RPM needs both ends. With only one of them set, no money figure is shown
            for {niche.name}.
          </FieldHint>
        ) : null}

        {implausible ? (
          <FieldHint tone="danger">
            That is above {RPM_IMPLAUSIBLE_MAJOR_PER_THOUSAND} {currency} per 1,000
            views. Shorts rates are two orders of magnitude below that, so check the
            decimal point before saving.
          </FieldHint>
        ) : null}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          <DollarSign />
          Save RPM range
        </Button>
      </DialogFooter>
    </form>
  );
}
