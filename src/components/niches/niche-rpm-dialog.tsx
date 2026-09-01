"use client";

import * as React from "react";
import { DollarSign } from "lucide-react";
import { toast } from "sonner";
import {
  ENGAGED_VIEWS_GLOSS,
  MAX_RPM_MAJOR_PER_THOUSAND,
  formatRpm,
  manualRpmBasis,
  maxRpmMinorPerMillion,
  parseRpmToMinorPerMillion,
  rpmImplausibleMajorPerThousand,
  rpmQuoteUnit,
  rpmToInputText,
  rpmDigitsFor,
} from "@/lib/analytics/niche-rpm";
import { toNicheFormat } from "@/lib/niches/niche-format";
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
 * What the "…" menu item is called, in one place.
 *
 * Exported so the value strip can POINT at it by name — "set it from this
 * card's … menu, under RPM range" — rather than describing a label that could
 * be renamed here tomorrow and leave the sentence pointing at nothing.
 *
 * THIS REPLACED A BUTTON. `SetNicheRpmButton` used to render an inline accent
 * link inside the money strip, at two places, and the owner's word for the
 * result was "ugly": a control dressed as prose, sitting in the middle of a
 * paragraph that explains why there is no number. The dialog is opened from the
 * card's menu now, beside the card's other four actions, which is also where
 * somebody looks for it. The component was deleted rather than left exported
 * with no callers — dead exported code reads as "something else must use this".
 */
export const RPM_MENU_ITEM_LABEL = "RPM range";

/**
 * THE UNIT UNDER THIS FIELD CHANGED, AND THE STORED NUMBER DID NOT.
 *
 * The previous release asked for "what 1,000 views in {niche} are worth" and
 * multiplied the answer by the full view count. This release asks for the same
 * column as 1,000 ENGAGED views and multiplies it by the engaged subset —
 * roughly half. The migration is additive by design and rewrites no niche row,
 * which is correct (a backfill would be this code guessing which unit somebody
 * meant), but it means any range entered before this deploy now produces about
 * half the money it did yesterday with nothing on screen to explain the drop.
 *
 * Nobody can check the production table from here, and "we assume no niche is
 * priced yet" is an assumption in a comment rather than a fact. So the form
 * says it, once, and only to a reader who actually has a stored range in the
 * boxes — the only person who can be affected, and the only one who can fix it.
 * It is a note rather than a blocking confirmation because the number may well
 * still be right; what it must not be is a silent halving.
 */
export const RPM_UNIT_CHANGED_NOTICE =
  "Heads up: this range is now read as revenue per 1,000 ENGAGED views. Earlier versions of this dialog asked for it per 1,000 total views. If this figure was entered before that change, check it against the engaged unit — otherwise the niche will be valued at roughly half of what it was.";

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
  /*
   * The niche's own format decides the UNIT this whole form speaks in.
   *
   * A Shorts range is quoted per 1,000 ENGAGED views — the unit the market
   * quotes a Shorts RPM in, with the engaged-view share applied before it. A
   * Long Form range is per 1,000 PLAIN views, no share applied, because that
   * is how a long-form RPM is quoted everywhere somebody would copy one from.
   * Same rule as `manualRpmBasis`, read from the same DTO field, so the label,
   * the warning bound and the pricing arithmetic cannot disagree.
   */
  const format = toNicheFormat(niche.format);
  const basis = manualRpmBasis(format);

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
        `That is more than ${MAX_RPM_MAJOR_PER_THOUSAND} ${currency} ${rpmQuoteUnit(
          basis,
        )}, which is higher than any format has ever paid — check the decimal point.`,
      );
      return { ok: false };
    }
    return { ok: true, value: parsed };
  };

  // The soft warning, shown while typing rather than on submit. A rate this
  // high is far more likely to be a decimal place in the wrong place than a
  // considered estimate, and saying so before the save costs nothing. The
  // bound is per format — $10 for shorts, $50 for long form — because the two
  // markets genuinely pay an order of magnitude apart, and warning long-form
  // entries at the Shorts bound would cry wolf on almost every honest one.
  const implausible = React.useMemo(() => {
    const ceiling =
      rpmImplausibleMajorPerThousand(format) * 10 ** rpmDigitsFor(currency);
    const parsed = parseRpmToMinorPerMillion(highValue || lowValue, currency);
    return parsed !== null && parsed > ceiling;
  }, [highValue, lowValue, currency, format]);

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
                    )} ${rpmQuoteUnit(basis)}`,
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
          {/* RPM glossed on first use, because this dialog is where somebody
              who has never met the term is asked to supply one. The unit is
              the format's own: engaged views for a Shorts niche, plain views
              for a Long Form one — see `manualRpmBasis`. */}
          {format === "shorts" ? (
            <>
              RPM is revenue per 1,000 views. This is what 1,000 ENGAGED views in{" "}
              {niche.name} are worth, as a low–high range — engaged views being the
              paid subset YouTube actually counts, which is the unit a Shorts RPM is
              quoted in everywhere else. Northstar assumes they are a set share of
              the public view count, editable under Settings, and applies that share
              before this rate. The result estimates how much the tracked niche is
              generating and how much of it Northstar is capturing. If Northstar
              operates a monetized channel here, that channel&rsquo;s own measured
              rate is used instead of this — and that one already accounts for
              engagement, so it is applied to the full view count.
            </>
          ) : (
            <>
              RPM is revenue per 1,000 views. This is what 1,000 views in{" "}
              {niche.name} are worth, as a low–high range — per 1,000 plain views,
              the unit a long-form RPM is quoted in everywhere else. No engaged-view
              share applies: unlike a Shorts rate, this one is multiplied by the
              full public view count. The result estimates how much the tracked
              niche is generating and how much of it Northstar is capturing. If
              Northstar operates a monetized channel here, that channel&rsquo;s own
              measured rate is used instead of this.
            </>
          )}
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-3">
        {/* Only for a reader who is actually looking at a pre-existing range,
            and only on a SHORTS niche — the unit change it describes is the
            engaged-view one, which never applied to Long Form.
            See `RPM_UNIT_CHANGED_NOTICE`. */}
        {format === "shorts" && (seeded.low || seeded.high) ? (
          <p
            role="note"
            className="rounded-md border border-accent/30 bg-accent-subtle px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground"
          >
            {RPM_UNIT_CHANGED_NOTICE}
          </p>
        ) : null}

        {/*
          =====================================================================
          WHY THE TWO BOXES DID NOT LINE UP, AND WHAT ACTUALLY FIXES IT
          =====================================================================
          The owner reported the low and high boxes sitting at different
          heights. There were TWO independent causes and both had to go — fixing
          either alone leaves the bug on some currency or some viewport.

          (1) THE LABELS WERE ASYMMETRIC. The left one read "Low (USD per 1,000
              views)" — 25 characters — against a bare "High". The dialog is
              `max-w-sm` (384px) less 24px of body padding each side less a 12px
              gap, so each column is 162px; 25 characters at 13px runs about
              170px and wrapped to two lines while "High" stayed on one. The
              right-hand input therefore sat exactly one label line-height
              higher. It was not a near miss either: `currency` is dynamic, so
              any code longer than three characters wraps it for certain.

              The unit is now stated ONCE, above the pair, which also fixes an
              accessibility gap nobody had noticed — a screen-reader user heard
              "Low, USD per 1,000 views" and then a bare "High" with no unit at
              all. `aria-describedby` now gives both fields the same unit.

          (2) NOTHING PINNED THE INPUTS TO A SHARED LINE. Both cells were
              top-packed flex columns: no `items-end`, no `self-end`, no
              `mt-auto`, no minimum height on the label. So they aligned only
              for as long as the two labels happened to occupy the same number
              of lines, which is alignment by coincidence.

              `h-full` on each cell (the grid already stretches its items) plus
              `mt-auto` on each input pins both inputs to the BOTTOM of the
              tallest cell. That holds whatever any future label does — a longer
              currency code, a translation, a wrapped word — which is the
              difference between fixing this instance and fixing the cause.
        */}
        <div className="flex flex-col gap-2">
          {/* A span rather than a `<Label>`: it names the pair, not one input,
              and a `<label>` with no `for` is a label pointing at nothing. The
              two inputs reach it through `aria-describedby` instead, so both
              carry the unit in their accessible description. */}
          <span
            id="niche-rpm-unit"
            className="text-[13px] font-medium leading-none text-foreground"
          >
            {currency} {rpmQuoteUnit(basis)}
          </span>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex h-full flex-col gap-2">
              <Label htmlFor="niche-rpm-low">Low</Label>
              <Input
                id="niche-rpm-low"
                autoFocus
                inputMode="decimal"
                placeholder="e.g. 0.03"
                value={lowValue}
                invalid={Boolean(lowError)}
                aria-describedby="niche-rpm-unit"
                className="mt-auto"
                onChange={(event) => {
                  setLowValue(event.target.value);
                  setLowError(null);
                  setRangeError(null);
                }}
              />
            </div>
            <div className="flex h-full flex-col gap-2">
              <Label htmlFor="niche-rpm-high">High</Label>
              <Input
                id="niche-rpm-high"
                inputMode="decimal"
                placeholder="e.g. 0.08"
                value={highValue}
                invalid={Boolean(highError)}
                aria-describedby="niche-rpm-unit"
                className="mt-auto"
                onChange={(event) => {
                  setHighValue(event.target.value);
                  setHighError(null);
                  setRangeError(null);
                }}
              />
            </div>
          </div>
        </div>

        {lowError ? <FieldHint tone="danger">{lowError}</FieldHint> : null}
        {highError ? <FieldHint tone="danger">{highError}</FieldHint> : null}
        {rangeError ? <FieldHint tone="danger">{rangeError}</FieldHint> : null}

        <FieldHint>
          A range rather than a single number, because this is a judgement and not a
          measurement.{" "}
          {format === "shorts" ? (
            <>
              Shorts rates are usually well under {formatRpm(
                10 ** rpmDigitsFor(currency) / 10,
                currency,
              )}{" "}
              {rpmQuoteUnit(basis)}.
            </>
          ) : (
            <>
              This is per 1,000 views — no engaged-view share applies to a
              long-form rate, so it is multiplied by the full view count.
            </>
          )}{" "}
          Leave both empty to clear the estimate.
        </FieldHint>

        {/* THE GLOSS, at the point of entry, for the format the term applies
            to. This is the box where a rate quoted in the wrong unit does its
            damage: on a Shorts niche, type a per-raw-view figure here and
            every money figure in the niche doubles. Saying what engaged views
            are, right under the field, is cheaper than any validation could be
            — the two units are both plausible numbers and no parser can tell
            them apart. A Long Form niche has no engaged step, so the gloss
            would only introduce the confusion it exists to remove. */}
        {basis === "engaged" ? <FieldHint>{ENGAGED_VIEWS_GLOSS}</FieldHint> : null}

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
            That is above {rpmImplausibleMajorPerThousand(format)} {currency}{" "}
            {rpmQuoteUnit(basis)}.{" "}
            {format === "shorts"
              ? "Shorts rates are two orders of magnitude below that, so check the decimal point before saving."
              : "Only the very best-paying long-form verticals reach that, so check the decimal point before saving."}
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
