"use client";

import * as React from "react";
import { CheckCircle2, ChevronRight, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ApiError } from "@/lib/api-client";
import { formatMoney } from "@/lib/finance/money";
import { EM_DASH, formatNumber, pluralize } from "@/lib/format";
import { useMarkRecordPaid } from "@/hooks/use-payroll";
import { cn } from "@/lib/utils";
import { AdjustRecordDialog } from "./adjust-record-dialog";
import { PaymentStatusBadge } from "./period-status-badge";
import { RecordBreakdown } from "./record-breakdown";
import { isStoredRecord, subtotalsByCurrency, type StoredPayrollRecord } from "./payroll-format";
import type {
  PayrollPeriodDTO,
  PayrollRecordDTO,
} from "@/server/services/payroll-service";

/**
 * Everyone's line for one period, with the whole calculation one click away.
 *
 * Shared by the payroll screen and the history detail rather than written
 * twice, because the two are the same table over the same DTO — the only
 * difference is whether the figures came from the engine or from storage, and
 * `period.isDraft` already carries that. Two copies would drift, and the way
 * they would drift is one of them quietly rounding or summing something the
 * other does not.
 *
 * NOTHING HERE COMPUTES A FIGURE. Every amount is read off the DTO, and the
 * totals row is the server's own `period.totals` rather than a sum of the rows
 * above it. A table that adds up its own column is a table that can disagree
 * with the record it is displaying — on a payroll screen that is not a
 * cosmetic bug.
 */
export function PayrollTable({
  period,
  mayManage,
}: {
  period: PayrollPeriodDTO;
  mayManage: boolean;
}) {
  const [expanded, setExpanded] = React.useState<string | null>(null);

  if (period.records.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Users />}
          title="Nobody is on payroll for this period"
          description={
            <>
              A person appears here once they have an employee profile with a
              salary on it, and once their employment dates overlap the period.
              Pay configuration lives in its own table, separate from the account
              — which is what stops an ordinary member query widening into a
              salary.
            </>
          }
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-left">
          <thead>
            <tr className="border-b border-border bg-surface-sunken">
              <th className={HEAD_CELL}>Employee</th>
              <th className={cn(HEAD_CELL, "text-right")}>Salary</th>
              <th className={cn(HEAD_CELL, "text-right")}>Hits</th>
              <th className={cn(HEAD_CELL, "text-right")}>Hit bonus</th>
              <th className={cn(HEAD_CELL, "text-right text-accent")}>Total</th>
              {/* A draft period has no payment state to report — there are no
                  rows yet — so the column is absent rather than full of dashes. */}
              {period.isDraft ? null : (
                <th className={cn(HEAD_CELL, "text-right")}>Payment</th>
              )}
              <th className={cn(HEAD_CELL, "w-8")}>
                <span className="sr-only">Breakdown</span>
              </th>
            </tr>
          </thead>

          <tbody>
            {period.records.map((record) => (
              <EmployeeRow
                key={record.userId}
                record={record}
                period={period}
                mayManage={mayManage}
                expanded={expanded === record.userId}
                onToggle={() =>
                  setExpanded((current) =>
                    current === record.userId ? null : record.userId,
                  )
                }
              />
            ))}
          </tbody>

          <TotalsFoot period={period} />
        </table>
      </div>

      <p className="border-t border-border px-4 py-2.5 text-[11px] leading-relaxed text-subtle-foreground">
        The totals row is the server&rsquo;s own figure for the run, not a sum of
        the rows above it, so what is shown here and what would be paid out
        cannot drift apart. Click any employee for the whole calculation: every
        niche&rsquo;s hits, the rate each paid, and the threshold each was judged
        against.
      </p>
    </Card>
  );
}

const HEAD_CELL =
  "px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground";
const CELL = "px-4 py-2.5 text-[13px]";

function EmployeeRow({
  record,
  period,
  mayManage,
  expanded,
  onToggle,
}: {
  record: PayrollRecordDTO;
  period: PayrollPeriodDTO;
  mayManage: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [adjusting, setAdjusting] = React.useState<StoredPayrollRecord | null>(null);
  const markPaid = useMarkRecordPaid();
  const columnCount = period.isDraft ? 6 : 7;

  async function onMarkPaid(id: string) {
    try {
      await markPaid.mutateAsync(id);
      toast.success(`${record.employeeName} is recorded as paid.`, {
        description: "No money moved — this records a transfer made elsewhere.",
      });
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "That payment could not be recorded.",
      );
    }
  }

  return (
    <>
      <tr
        className={cn(
          "border-b border-border transition-colors last:border-b-0",
          expanded ? "bg-surface-hover/50" : "hover:bg-surface-hover/40",
        )}
      >
        <td className={cn(CELL, "text-foreground")}>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="flex min-w-0 flex-col items-start text-left"
          >
            <span className="truncate font-medium">{record.employeeName}</span>
            <span className="truncate text-[11px] text-subtle-foreground">
              {record.roleLabel}
            </span>
          </button>
        </td>

        <td className={cn(CELL, "tnum text-right text-muted-foreground")}>
          {formatMoney(record.baseSalaryMinor, record.currency)}
        </td>

        <td className={cn(CELL, "tnum text-right text-muted-foreground")}>
          {/* A zero here is a real finding — this person earned no bonus — so it
              is printed as a figure rather than as the em dash the house rule
              reserves for data that is missing. */}
          {formatNumber(record.hitCount)}
        </td>

        <td className={cn(CELL, "tnum text-right text-muted-foreground")}>
          {formatMoney(record.hitBonusMinor, record.currency)}
        </td>

        <td className={cn(CELL, "tnum text-right font-medium text-foreground")}>
          {formatMoney(record.totalMinor, record.currency)}
          {record.adjustmentMinor !== 0 ? (
            <span className="block text-[10px] font-normal text-subtle-foreground">
              includes{" "}
              {formatMoney(record.adjustmentMinor, record.currency, {
                signDisplay: "always",
              })}
            </span>
          ) : null}
        </td>

        {period.isDraft ? null : (
          <td className={cn(CELL, "text-right")}>
            <PaymentStatusBadge status={record.paymentStatus} />
          </td>
        )}

        <td className={cn(CELL, "text-right")}>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} ${record.employeeName}'s calculation`}
            className="rounded p-1 text-subtle-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <ChevronRight
              className={cn("size-4 transition-transform", expanded && "rotate-90")}
            />
          </button>
        </td>
      </tr>

      {expanded ? (
        <tr className="border-b border-border bg-surface-sunken/60 last:border-b-0">
          <td colSpan={columnCount} className="px-4 py-4">
            <RecordBreakdown record={record} />

            {/* Both actions need a row to act on. A draft period's figures have
                no id — there is nothing in the database yet — so offering the
                controls there would be offering an action that cannot succeed. */}
            {mayManage && isStoredRecord(record) ? (
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setAdjusting(record)}
                >
                  {/* A paid record can still be corrected — an underpayment
                      discovered afterwards is a real event — but the button
                      says so, because the consequence is different: the total
                      moves after the transfer, and the difference is settled
                      outside this app. */}
                  {record.paymentStatus === "paid"
                    ? "Adjust after payment"
                    : record.adjustmentMinor === 0
                      ? "Adjust this figure"
                      : "Change the adjustment"}
                </Button>

                {record.paymentStatus === "pending" ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={markPaid.isPending}
                    onClick={() => onMarkPaid(record.id)}
                  >
                    <CheckCircle2 />
                    Mark paid
                  </Button>
                ) : null}

                <span className="text-[11px] text-subtle-foreground">
                  {record.paymentStatus === "paid"
                    ? "This one is already paid. An adjustment still requires a reason, and is logged under its own action so a correction made after payment can be found."
                    : "An adjustment requires a reason, which is recorded in the audit log."}
                </span>

                {adjusting ? (
                  <AdjustRecordDialog
                    record={adjusting}
                    periodLabel={period.label}
                    open
                    onOpenChange={(open) => {
                      if (!open) setAdjusting(null);
                    }}
                  />
                ) : null}
              </div>
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * The run's totals.
 *
 * When the run mixes currencies the total column shows the per-currency split
 * rather than one symbol on a meaningless sum, and the salary and bonus columns
 * fall back to an em dash for the same reason — cents added to yen is not an
 * amount of money, and payroll has no rate table to convert with.
 */
function TotalsFoot({ period }: { period: PayrollPeriodDTO }) {
  const { totals } = period;
  const mixed = totals.currencyMixed;
  const subtotals = React.useMemo(
    () => (mixed ? subtotalsByCurrency(period.records) : []),
    [mixed, period.records],
  );

  return (
    <tfoot>
      <tr className="border-t border-border-strong bg-surface-sunken">
        <td className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-subtle-foreground">
          {formatNumber(totals.employeeCount)}{" "}
          {pluralize(totals.employeeCount, "employee")}
        </td>
        <td className="tnum px-4 py-2.5 text-right text-[12px] font-medium text-foreground">
          {mixed ? EM_DASH : formatMoney(totals.baseSalaryMinor, totals.currency)}
        </td>
        <td className="tnum px-4 py-2.5 text-right text-[12px] font-medium text-foreground">
          {formatNumber(totals.hitCount)}
        </td>
        <td className="tnum px-4 py-2.5 text-right text-[12px] font-medium text-foreground">
          {mixed ? EM_DASH : formatMoney(totals.hitBonusMinor, totals.currency)}
        </td>
        <td className="tnum px-4 py-2.5 text-right text-[13px] font-semibold text-foreground">
          {mixed ? (
            <span className="flex flex-col items-end gap-0.5">
              {subtotals.map((part) => (
                <span key={part.currency}>
                  {formatMoney(part.totalMinor, part.currency, { withCode: true })}
                </span>
              ))}
            </span>
          ) : (
            formatMoney(totals.totalMinor, totals.currency)
          )}
        </td>
        {period.isDraft ? null : (
          <td className="tnum px-4 py-2.5 text-right text-[11px] text-subtle-foreground">
            {mixed
              ? EM_DASH
              : `${formatMoney(totals.paidMinor, totals.currency)} paid`}
          </td>
        )}
        <td />
      </tr>
    </tfoot>
  );
}
