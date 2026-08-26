"use client";

import * as React from "react";
import { AlertTriangle, ScrollText } from "lucide-react";
import { toast } from "sonner";
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
import { ApiError } from "@/lib/api-client";
import { formatDate } from "@/lib/format";
import { formatMoney, parseMoneyToMinor, symbolFor } from "@/lib/finance/money";
import { useAdjustRecord } from "@/hooks/use-payroll";
import type { StoredPayrollRecord } from "./payroll-format";

/**
 * Correct one finalized figure.
 *
 * WHY AN ADJUSTMENT RATHER THAN AN EDIT
 * A finalized record is a document. Editing the salary or the hit count in
 * place would destroy the thing finalizing exists to create — a reproducible
 * account of what the engine calculated. So the correction is a separate,
 * signed line that sits beside the computed parts: the record still shows what
 * was calculated, what a person changed, and why. `adjustRecord` recomputes the
 * total from base + bonus + adjustment rather than nudging the old total, so
 * two corrections in a row cannot compound.
 *
 * WHY THE REASON IS MANDATORY
 * The amount is not in the audit log and never will be — `audit.view` is
 * grantable to people who may not see pay, so a salary in audit metadata would
 * route straight around the reason EmployeeProfile is a separate table. The
 * REASON is what gets recorded, and it is therefore the entire accountability
 * trail for a changed payroll figure. An adjustment with no reason would be an
 * untraceable change to what somebody is owed, which is why the server refuses
 * one and why this form will not send one.
 *
 * SIGNED, ON PURPOSE. Clawing back an overpayment is as legitimate as adding a
 * bonus, so a leading minus — or the accounting "(50)" — is accepted and
 * parsed by the same `parseMoneyToMinor` the finance ledger uses.
 *
 * WHY A PAID RECORD CAN STILL BE ADJUSTED
 * "We underpaid them in August" is a real correction and refusing it here would
 * only move it somewhere nobody can audit. But it is not the same act as
 * correcting a figure that has not been paid yet: the total moves after the
 * money left, the period's paid total moves with it, `paidAt` goes on pointing
 * at the transfer that actually happened, and somebody now has to settle the
 * difference by hand. So the form says all of that before it will send, and the
 * server records it under `payroll.paid_record_adjusted` rather than the
 * ordinary key. Neither the status nor `paidAt` is rewound — claiming the
 * payment never happened would be the one dishonest way out of this.
 */
export function AdjustRecordDialog({
  record,
  periodLabel,
  open,
  onOpenChange,
}: {
  /**
   * Narrowed to a record that actually has a row. A draft period's figures have
   * no id to PATCH, and the type is what stops this dialog being opened over
   * one — see `isStoredRecord`.
   */
  record: StoredPayrollRecord;
  periodLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {/* Mounted only while open, the pattern the invite dialog established.
            The form is seeded from the record at mount, so it starts fresh on
            every opening without an effect reaching in to reset it. */}
        {open ? (
          <AdjustRecordForm
            record={record}
            periodLabel={periodLabel}
            onOpenChange={onOpenChange}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The form, seeded from what is already on the record.
 *
 * An adjustment REPLACES the previous one rather than stacking on it — the
 * server writes `adjustmentMinor`, it does not add to it — so an empty form
 * over an existing +$50 would silently mean "make it zero". Opening with the
 * current value is what makes the replacement obvious.
 */
function AdjustRecordForm({
  record,
  periodLabel,
  onOpenChange,
}: {
  record: StoredPayrollRecord;
  periodLabel: string;
  onOpenChange: (open: boolean) => void;
}) {
  const adjust = useAdjustRecord();

  // Read from the record rather than from the period: `markRecordPaid` settles
  // people one at a time, so a period can hold both paid and pending lines.
  const alreadyPaid = record.paymentStatus === "paid";

  const [amount, setAmount] = React.useState(() =>
    record.adjustmentMinor === 0
      ? ""
      : formatMoney(record.adjustmentMinor, record.currency, {
          // Plain digits, not a formatted amount with a symbol: this is an
          // editable field, and the parser accepts either, but a person
          // deleting "$1,250.00" back to "-50" has more to delete.
          locale: "en-US",
        }).replace(/[^\d.,-]/g, ""),
  );
  const [reason, setReason] = React.useState(record.adjustmentReason ?? "");
  const [touched, setTouched] = React.useState(false);

  const adjustmentMinor = React.useMemo(() => {
    const trimmed = amount.trim();
    if (trimmed === "") return null;
    return parseMoneyToMinor(trimmed, record.currency);
  }, [amount, record.currency]);

  const amountError =
    touched && amount.trim() !== "" && adjustmentMinor === null
      ? "That is not an amount. Try 250, -250 or 1,250.50."
      : null;

  const trimmedReason = reason.trim();
  const reasonError =
    touched && trimmedReason.length > 0 && trimmedReason.length < 3
      ? "Say why in a few more words."
      : null;

  const canSubmit =
    adjustmentMinor !== null && trimmedReason.length >= 3 && !adjust.isPending;

  /**
   * The total this would produce, computed the way the server computes it.
   *
   * A preview rather than a claim: the number written to the database is the
   * one `adjustRecord` derives from the stored base and bonus. This exists so
   * an admin can see the consequence before committing, and it is deliberately
   * built from the same two stored parts so it cannot drift from the result.
   */
  const previewTotal =
    adjustmentMinor === null
      ? null
      : record.baseSalaryMinor + record.hitBonusMinor + adjustmentMinor;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (adjustmentMinor === null || trimmedReason.length < 3) return;

    try {
      await adjust.mutateAsync({
        id: record.id,
        adjustmentMinor,
        adjustmentReason: trimmedReason,
      });
      toast.success(
        alreadyPaid
          ? `${record.employeeName}'s ${periodLabel} figure was adjusted after payment.`
          : `${record.employeeName}'s ${periodLabel} figure was adjusted.`,
        {
          description: alreadyPaid
            ? "Logged as an adjustment after payment. The record stays marked paid — settle the difference outside this app."
            : "The reason has been recorded in the audit log.",
        },
      );
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "That adjustment could not be saved. Try again in a moment.",
      );
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <DialogHeader>
        <DialogTitle>Adjust {record.employeeName}&rsquo;s pay</DialogTitle>
        <DialogDescription>
          {periodLabel} · currently{" "}
          {formatMoney(record.totalMinor, record.currency)}
          {alreadyPaid ? " · already paid" : ""}
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        {alreadyPaid ? (
          <div className="flex gap-3 rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-foreground">
              <p>
                This record was marked paid
                {record.paidAt ? ` on ${formatDate(record.paidAt)}` : ""}. Adjusting
                it now changes the total{" "}
                <strong className="font-medium">after the money left</strong>.
              </p>
              <p className="text-muted-foreground">
                It stays marked paid — nothing here rewinds a payment that
                happened — so the period&rsquo;s paid total moves and the
                difference has to be settled outside this app. The entry is
                logged as an adjustment after payment, separately from ordinary
                ones, so it can be found later.
              </p>
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="payroll-adjustment">
            Adjustment ({record.currency})
          </Label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-subtle-foreground">
              {symbolFor(record.currency)}
            </span>
            <Input
              id="payroll-adjustment"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="250"
              inputMode="text"
              autoComplete="off"
              invalid={amountError !== null}
              className="tnum pl-7"
            />
          </div>
          <FieldHint tone={amountError ? "danger" : "muted"}>
            {amountError ??
              "A negative amount claws back an overpayment. This replaces any adjustment already on this record — it does not stack."}
          </FieldHint>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="payroll-adjustment-reason">Reason</Label>
          <Input
            id="payroll-adjustment-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="Missed hit on a Short excluded in error"
            maxLength={500}
            autoComplete="off"
            invalid={reasonError !== null}
          />
          <FieldHint tone={reasonError ? "danger" : "muted"}>
            {reasonError ?? "Required. This is what the audit log records."}
          </FieldHint>
        </div>

        {previewTotal !== null ? (
          <div className="flex items-baseline justify-between gap-3 rounded-lg border border-border bg-surface-sunken px-4 py-3">
            <span className="text-[11px] font-medium uppercase tracking-wider text-subtle-foreground">
              New total
            </span>
            <span className="tnum text-[17px] font-semibold text-foreground">
              {formatMoney(previewTotal, record.currency)}
            </span>
          </div>
        ) : null}

        <p className="flex gap-2 text-[12px] leading-relaxed text-subtle-foreground">
          <ScrollText className="mt-0.5 size-3.5 shrink-0" />
          <span>
            The reason, this period and who made the change go into the audit
            log. The amount does not — it stays on the payroll record, behind
            the payroll permission, next to the figures it changes.
          </span>
        </p>
      </DialogBody>

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          onClick={() => onOpenChange(false)}
          disabled={adjust.isPending}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={adjust.isPending}
          disabled={!canSubmit}
        >
          {/* The label names the consequence rather than the field. A button
              reading "Save adjustment" over a record that is already paid says
              less than the act deserves. */}
          {alreadyPaid ? "Adjust after payment" : "Save adjustment"}
        </Button>
      </DialogFooter>
    </form>
  );
}
