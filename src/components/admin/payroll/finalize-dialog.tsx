"use client";

import * as React from "react";
import { AlertTriangle, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api-client";
import { formatNumber, pluralize } from "@/lib/format";
import { useFinalizePeriod } from "@/hooks/use-payroll";
import { formatRunTotalWithRecords, periodSentence, periodWindowSentence } from "./payroll-format";
import type { PayrollPeriodDTO } from "@/server/services/payroll-service";

/**
 * "Finalize period", and what that actually costs.
 *
 * WHY THE COPY IS THIS LONG
 * Finalizing is the only irreversible act on either payroll screen. There is no
 * un-finalize: from here on the month is read from storage, a Short that
 * crosses a million views next week will not change it, and a salary corrected
 * tomorrow will not rewrite it. The only way to move a figure afterwards is an
 * adjustment carrying a reason, in the audit log, on one person's record.
 *
 * A confirmation that says "Are you sure?" tells somebody nothing they did not
 * already know. This one says what changes, what stops changing, and what is
 * still possible afterwards — which is the difference between a dialog that
 * prevents a mistake and one that only records that a mistake was confirmed.
 *
 * THE UNFINISHED-MONTH CASE
 * The server refuses to freeze a period that has not ended unless `force` is
 * set, because Shorts published this month are still gaining views and the
 * figure recorded would be one that was never right. That refusal is surfaced
 * here as a deliberate second decision rather than hidden behind a retry: the
 * checkbox is the admin saying "yes, close the books early", which is a real
 * instruction and not a mistake to route around.
 */
export function FinalizeDialog({
  period,
  open,
  onOpenChange,
}: {
  period: PayrollPeriodDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {/* Mounted only while open, the same pattern the invite dialog uses.
            The "close the books early" checkbox is a decision about THIS
            opening; a fresh mount is what guarantees it cannot arrive already
            ticked from the last time somebody backed out of this dialog. */}
        {open ? (
          <FinalizeForm period={period} onOpenChange={onOpenChange} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function FinalizeForm({
  period,
  onOpenChange,
}: {
  period: PayrollPeriodDTO;
  onOpenChange: (open: boolean) => void;
}) {
  const finalize = useFinalizePeriod();
  const [force, setForce] = React.useState(false);

  const needsForce = !period.hasEnded;
  const blocked = needsForce && !force;

  async function onConfirm() {
    try {
      await finalize.mutateAsync({
        year: period.year,
        month: period.month,
        // Sent only when the month is genuinely unfinished, so a stray ticked
        // box on a completed period cannot mean anything.
        force: needsForce ? force : undefined,
      });
      toast.success(`${period.label} payroll is finalized.`, {
        description: "These figures are now the record of what was owed.",
      });
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "That period could not be finalized. Try again in a moment.",
      );
    }
  }

  const total = formatRunTotalWithRecords(period.totals, period.records);
  const headcount = period.totals.employeeCount;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Finalize {period.label} payroll?</DialogTitle>
        <DialogDescription>{periodSentence(period)}</DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        <div className="rounded-lg border border-border bg-surface-sunken px-4 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[11px] font-medium uppercase tracking-wider text-subtle-foreground">
              Being recorded
            </span>
            <span className="tnum text-[17px] font-semibold text-foreground">
              {total}
            </span>
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">
            {formatNumber(headcount)} {pluralize(headcount, "employee")} ·{" "}
            {formatNumber(period.totals.hitCount)}{" "}
            {pluralize(period.totals.hitCount, "hit")} ·{" "}
            {periodWindowSentence(period)}
          </p>
        </div>

        <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-muted-foreground">
          <p>
            <strong className="font-medium text-foreground">
              The figures stop moving.
            </strong>{" "}
            Right now this month is recalculated every time somebody opens it,
            against view counts that are still climbing. Finalizing writes each
            person&rsquo;s line down — salary, hits, bonus, total — and every
            qualifying Short with the views and threshold that qualified it.
            From then on the month is read back, never recomputed.
          </p>
          <p>
            <strong className="font-medium text-foreground">
              That is the point, and it is not undoable.
            </strong>{" "}
            A Short that goes viral in three weeks will not change what this
            month cost, and editing somebody&rsquo;s salary later will not
            rewrite what they were owed here.
          </p>
          <p>
            A figure can still be corrected afterwards, one person at a time,
            with an <strong className="font-medium text-foreground">adjustment</strong>{" "}
            that requires a written reason and is recorded in the audit log.
            The original calculation stays visible beside it.
          </p>
        </div>

        {needsForce ? (
          <div className="flex gap-3 rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="flex flex-col gap-2">
              <p className="text-[13px] leading-relaxed text-foreground">
                {period.label} has not finished yet. Shorts published this month
                are still gaining views, so the total above is not the total
                this month will end on.
              </p>
              <label className="flex cursor-pointer items-start gap-2 text-[13px] text-muted-foreground">
                <Checkbox
                  checked={force}
                  onCheckedChange={(checked) => setForce(checked === true)}
                  className="mt-0.5"
                />
                <span>
                  Close the books early anyway. I understand the recorded
                  figures will be lower than the finished month&rsquo;s.
                </span>
              </label>
            </div>
          </div>
        ) : null}
      </DialogBody>

      <DialogFooter>
        <Button
          variant="ghost"
          onClick={() => onOpenChange(false)}
          disabled={finalize.isPending}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={onConfirm}
          loading={finalize.isPending}
          disabled={blocked}
        >
          <Lock />
          Finalize {period.label}
        </Button>
      </DialogFooter>
    </>
  );
}
