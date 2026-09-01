"use client";

import * as React from "react";

import { Target } from "lucide-react";
import { toast } from "sonner";
import {
  MAX_HIT_WINDOW_HOURS,
  MAX_THRESHOLD,
  MIN_HIT_WINDOW_HOURS,
  MIN_THRESHOLD,
  THRESHOLD_PRESETS,
  hitWindowPresetsFor,
} from "@/lib/analytics/constants";
import { formatHitWindow } from "@/lib/analytics/hit-rate";
import { toNicheFormat } from "@/lib/niches/niche-format";
import { useOrgBaseCurrency } from "@/hooks/use-org-currency";
import type { NicheDTO } from "@/lib/dto";
import {
  MAX_MONEY_MINOR,
  minorToInputText,
  parseMoneyToMinor,
} from "@/lib/finance/money";
import {
  NICHE_KIND_DESCRIPTION,
  NICHE_KIND_LABEL,
  NICHE_KINDS,
  type NicheKind,
} from "@/lib/niches/niche-kind";
import {
  buildNicheRulePatch,
  leavesNicheUnpriced,
  paymentRateWithheld,
} from "@/lib/niches/niche-rule-patch";
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
 * THREE FIELDS, ONE RULE, ONE FORM. A hit is a number of views reached within a
 * set time of publishing, and — since the rate moved off the employee — what
 * reaching it is worth. All three are one decision and are made together.
 * Splitting them across separate controls would let a niche sit with a
 * threshold and no window (the old lifetime comparison, the one that scored the
 * same channels 5.9% at a week old and 18.8% at 30–90 days with nothing about
 * the work changing) or with a complete rule and no price, which scores
 * perfectly and pays nothing.
 *
 * THE PAYMENT IS HIDDEN FOR A WATCHLIST NICHE, and that is the answer to "should
 * it be?". Nobody is paid for a niche the studio watches rather than publishes
 * into, so the field could only ever collect a number that nothing would read —
 * and an admin who filled it in would reasonably expect somebody to be paid.
 * Hiding it says the thing the arrangement means. What it does NOT do is clear
 * a stored value: reclassifying a niche is reversible, and destroying the rate
 * an admin chose for GTA because somebody flipped it to watchlist for an
 * afternoon would make it not reversible.
 *
 * THE FLIP BACK IS THE HALF THAT USED TO BE BROKEN. Hiding the field on the way
 * out was never the problem; seeding it on the way IN was. The DTO withholds a
 * watchlist niche's rate, so the form opened with an empty box and then wrote
 * that emptiness over the stored number the moment somebody switched the niche
 * to production and saved — reversible on the way out and destructive on the
 * way back. `paymentUnloaded` in `NicheThresholdForm` is the fix: a field this
 * form was never given a value for is not a field it may submit.
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

/** True when they may reclassify a niche as production or watchlist. */
export function useCanManageNiches(): boolean {
  return useSession().can("niches.manage");
}

/**
 * The currency a hit payment is entered and stored in.
 *
 * `Niche.hitPaymentMinor` has no currency column of its own, and it should not:
 * one organization pays in one currency, which is exactly what
 * `OrganizationSettings.baseCurrency` already says. Read from there rather than
 * guessed, so the field's decimal places and its symbol match what every
 * payroll figure derived from it will be shown in.
 *
 * Behind `settings.manage`, which is the same permission this whole dialog is
 * gated on — so the request is never issued by somebody it would 403 for. The
 * fallback is only ever used for the frame between mount and response.
 */
export function useHitPaymentCurrency(): string {
  return useOrgBaseCurrency(useCanConfigureThreshold());
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
  const currency = useHitPaymentCurrency();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {/*
          `key={currency}` remounts the form if the organization's currency
          arrives after it opened. The payment field's initial text is formatted
          with that currency's decimal places, and a form that had already
          seeded itself from the fallback would show a number with the wrong
          number of digits — on the one field where a stray decimal place is a
          factor of a hundred.
        */}
        {open ? (
          <NicheThresholdForm
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
  currency,
  onOpenChange,
}: {
  niche: NicheDTO;
  /** The organization's base currency — what a hit payment is expressed in. */
  currency: string;
  onOpenChange: (open: boolean) => void;
}) {
  const [value, setValue] = React.useState(
    niche.hitThreshold === null ? "" : String(niche.hitThreshold),
  );
  const [windowValue, setWindowValue] = React.useState(
    niche.hitWindowHours === null ? "" : String(niche.hitWindowHours),
  );
  const [paymentValue, setPaymentValue] = React.useState(
    niche.hitPaymentMinor === null ? "" : minorToInputText(niche.hitPaymentMinor, currency),
  );
  const [kind, setKind] = React.useState<NicheKind>(niche.kind);
  const [error, setError] = React.useState<string | null>(null);
  const save = useUpdateNicheRule();
  const canSetKind = useCanManageNiches();

  const watchlist = kind === "watchlist";

  /**
   * True when this form's payment field was never loaded with what is stored.
   *
   * `toNicheDTO` ships `hitPaymentMinor: null` for a watchlist niche whatever
   * the row holds, so on one of those an empty field means NOT SHOWN, not NOT
   * SET — and the two have to be told apart before anything is written or said.
   * See `niche-rule-patch.ts`, which owns the write half of this and explains
   * why the DTO was not the place to fix it.
   *
   * Keyed off `niche.kind` — the kind the DTO was BUILT with — not `kind`,
   * which is the pending choice in this dialog.
   */
  const paymentUnloaded = paymentRateWithheld(niche.kind);

  const commit = (
    hitThreshold: number | null,
    hitWindowHours: number | null,
    hitPaymentMinor: number | null,
  ) => {
    // Which keys go on the wire is decided in one pure, tested place rather
    // than inline here: an absent key is not a write, so this object is the
    // whole of the question "can saving this destroy a stored rate?".
    const draft = {
      loadedKind: niche.kind,
      kind,
      hitThreshold,
      hitWindowHours,
      hitPaymentMinor,
      mayReclassify: canSetKind,
    };

    save.mutate(
      { id: niche.id, ...buildNicheRulePatch(draft) },
      {
        onSuccess: () => {
          const scoreable = hitThreshold !== null && hitWindowHours !== null;
          const unpriced = leavesNicheUnpriced(draft);
          toast.success(
            scoreable
              ? `${niche.name}: ${formatCompactNumber(hitThreshold)} views within ${formatHitWindow(hitWindowHours)}`
              : `${niche.name} has no complete hit rule`,
            {
              // Never silent about an incomplete rule. A niche with a bar and no
              // clock reports nothing at all, and one with a complete rule and
              // no price scores perfectly and pays nothing — an admin who
              // half-filled this form has to be told that here rather than
              // discovering it on a chart or in a payroll run.
              description: !scoreable
                ? "A hit needs both a number of views and a time to reach it in. No hit rate is reported until both are set."
                : unpriced
                  ? "No hit payment is set, so hits here score but earn nothing. The payroll run will name this niche before anybody finalizes a month."
                  : undefined,
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

        // An empty payment field clears the rate, the same way an empty
        // threshold clears the bar: the niche keeps working as a filter and
        // scoring its Shorts, and simply cannot pay for one until somebody
        // says what one is worth.
        let paymentMinor: number | null = null;
        if (!watchlist && paymentValue.trim()) {
          const parsed = parseMoneyToMinor(paymentValue, currency);
          if (parsed === null) {
            setError("Enter an amount like 5 or 5.00, or leave it empty to clear it.");
            return;
          }
          if (parsed <= 0) {
            setError(
              "A hit payment of nothing is not a rate. Leave it empty to clear it instead.",
            );
            return;
          }
          if (parsed > MAX_MONEY_MINOR) {
            setError("That is more than a hit payment can be.");
            return;
          }
          paymentMinor = parsed;
        }

        commit(threshold, windowHours, paymentMinor);
      }}
    >
      <DialogHeader>
        <DialogTitle>{niche.name} hit rule</DialogTitle>
        <DialogDescription>
          What counts as a hit in this niche — the views a Short has to reach and how
          long it has to reach them — and what one is worth. Selecting {niche.name}{" "}
          anywhere in the app uses this rule automatically.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-3">
        {/*
          THE KIND COMES FIRST, because it decides whether the third field below
          is even a question. A watchlist niche is one Northstar follows rather
          than publishes into: it keeps its own analytics, it is excluded from
          the portfolio hit rate, and nobody is paid for it.
        */}
        {canSetKind ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="niche-kind">Kind</Label>
            <div id="niche-kind" className="flex flex-wrap gap-1.5">
              {NICHE_KINDS.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={kind === option}
                  onClick={() => {
                    setKind(option);
                    setError(null);
                  }}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors",
                    kind === option
                      ? "border-accent bg-accent-subtle text-foreground"
                      : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
                  )}
                >
                  {NICHE_KIND_LABEL[option]}
                </button>
              ))}
            </div>
            <FieldHint>{NICHE_KIND_DESCRIPTION[kind]}</FieldHint>
          </div>
        ) : null}

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
          {/* The niche's own format picks the preset list: hours-to-days for a
              Shorts niche (unchanged), days-to-months for a Long Form one,
              where "reach the bar in 24 hours" is a rule nobody would mean.
              Typing any window inside the shared bounds still works. */}
          {hitWindowPresetsFor(toNicheFormat(niche.format)).map((preset) => (
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
          THE THIRD NUMBER, AND IT IS NOT SHOWN FOR A WATCHLIST NICHE.

          Nobody is paid for a niche the studio watches rather than publishes
          into, so a field here could only collect a number nothing would read —
          and an admin who filled it in would reasonably expect somebody to be
          paid for it. The sentence in its place says so, rather than leaving a
          disabled box to be puzzled over.
        */}
        {watchlist ? (
          <p className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
            A watchlist niche pays no hit bonus, so there is no payment to set. Its
            hit rate is still measured and still shown — it is simply left out of the
            portfolio hit rate, which describes the work Northstar does.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <Label htmlFor="niche-hit-payment">Payment per hit</Label>
            <Input
              id="niche-hit-payment"
              inputMode="decimal"
              placeholder="e.g. 5"
              value={paymentValue}
              invalid={Boolean(error)}
              onChange={(event) => {
                setPaymentValue(event.target.value);
                setError(null);
              }}
            />
            <FieldHint>
              What one hit in {niche.name} pays, in {currency}. This is the rate every
              new payroll run uses — a hit here is worth this to whoever is assigned to
              the niche, whatever their own profile says.{" "}
              {paymentUnloaded
                ? "Leave it empty and whatever rate this niche was carrying before it became a watchlist niche is kept."
                : "Leave it empty and hits score but earn nothing."}
            </FieldHint>
            {/*
              SAID WHERE THE EMPTY BOX IS, because an empty box is the thing
              that misleads. This niche is watchlist as far as the payload that
              built this form is concerned, so its stored rate was withheld and
              the field below is blank for that reason and not because nothing
              is set. Without this sentence an admin flipping it back to
              production reads the blank as "no rate" — which is how the old
              save came to write a null over a real one.
            */}
            {paymentUnloaded ? (
              <FieldHint>
                {niche.name} is a watchlist niche, so its stored payment is not shown
                here. Saving without typing an amount leaves it untouched; type one to
                replace it.
              </FieldHint>
            ) : null}
          </div>
        )}

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

        {/*
          A DIFFERENT WARNING FROM THE ONE ABOVE, because it is a different
          failure. A niche with half a rule reports nothing anywhere; a niche
          with a complete rule and no price scores perfectly on every chart and
          pays nobody — which is invisible until a payroll run, which is exactly
          why it is said here.
        */}
        {/*
          Silent where the rate was never loaded: this form cannot know the
          niche is unpriced when it was not shown the price, and warning that
          Shorts "will earn nothing" over a rate that is still stored would be
          the same false claim in the opposite direction. The hint on the field
          itself says what is actually true there.
        */}
        {!watchlist &&
        !paymentUnloaded &&
        Boolean(value.trim()) &&
        Boolean(windowValue.trim()) &&
        !paymentValue.trim() ? (
          <FieldHint tone="danger">
            No payment set. Shorts in {niche.name} will be scored as hits and earn
            nothing, and the payroll run will report it before a month can be
            finalized.
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
