"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Archive,
  ArrowLeft,
  BadgeCheck,
  ChevronRight,
  Lock,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/error-state";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/components/providers/session-provider";
import { FinalizeDialog } from "@/components/admin/payroll/finalize-dialog";
import { PeriodStatusBadge } from "@/components/admin/payroll/period-status-badge";
import { PayrollTable } from "@/components/admin/payroll/payroll-table";
import {
  formatRunTotal,
  formatRunTotalWithRecords,
  formatUtcDay,
  periodSentence,
  periodState,
} from "@/components/admin/payroll/payroll-format";
import {
  useMarkPeriodPaid,
  usePayrollPeriod,
  usePayrollPeriods,
} from "@/hooks/use-payroll";
import { ApiError } from "@/lib/api-client";
import { PERMISSION_LABELS } from "@/lib/auth/permissions";
import { formatMoney } from "@/lib/finance/money";
import { EM_DASH, formatDateTime, formatNumber, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PayrollPeriodSummaryDTO } from "@/server/services/payroll-service";

/**
 * Admin › Payroll › History — what was actually owed, month by month.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THESE ARE STORED FIGURES
 * ─────────────────────────────────────────────────────────────────────────────
 * That sentence is the whole design brief for this screen, and it is repeated
 * on it in plain words rather than left implicit. A finalized period is read
 * back from PayrollRecord and PayrollHit rows exactly as they were written; it
 * is not the engine run again over today's data. That distinction is what makes
 * historical payroll checkable at all — a Short that crossed a million views
 * last week must not change what March cost, and a salary corrected yesterday
 * must not rewrite what somebody was paid in March.
 *
 * A month that was opened but never finalized still appears here, and it is
 * labelled a live draft, because for that one the figures genuinely are being
 * recalculated. Showing the two states identically would be the single most
 * misleading thing this screen could do.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE OPEN PERIOD IS IN THE URL
 * ─────────────────────────────────────────────────────────────────────────────
 * `?year=&month=` rather than component state, so "look at August" is a link
 * somebody can send, and so the Open button on the payroll screen lands here
 * already showing the month it meant. The detail is fetched only for the period
 * actually opened — an un-finalized month costs a full engine run to render,
 * and prefetching a year of them to fill a list would be a dozen heavy queries
 * for one table.
 */
export default function AdminPayrollHistoryPage() {
  const session = useSession();

  if (!session.can("payroll.view")) {
    return (
      <PageContainer className="flex flex-col gap-5">
        <PageHeader title="Payroll history" description={PAGE_DESCRIPTION} />
        <Card>
          <EmptyState
            icon={<ShieldAlert />}
            title="You don't have access to payroll"
            description={
              <>
                Past payroll runs need the{" "}
                <span className="text-foreground">
                  {PERMISSION_LABELS["payroll.view"]}
                </span>{" "}
                permission, which comes with the Admin role by default, and an admin can also grant it to one specific person. Ask an admin
                if you need it.
              </>
            }
          />
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex flex-col gap-6">
      <PageHeader
        title="Payroll history"
        description={PAGE_DESCRIPTION}
        actions={
          <Button variant="secondary" size="sm" asChild>
            <Link href="/admin/payroll">
              <ArrowLeft />
              Current payroll
            </Link>
          </Button>
        }
      />

      {/* `useSearchParams` needs a Suspense boundary. The fallback mirrors the
          list so the page does not collapse and jump while it resolves. */}
      <React.Suspense fallback={<HistorySkeleton />}>
        <HistoryScreen />
      </React.Suspense>
    </PageContainer>
  );
}

const PAGE_DESCRIPTION =
  "Every payroll run that was opened or finalized, newest first. Finalized months are stored records, read back exactly as they were written.";

function HistoryScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data, isLoading, error, refetch } = usePayrollPeriods();

  const opened = React.useMemo(() => {
    const year = Number(searchParams.get("year"));
    const month = Number(searchParams.get("month"));
    // Both or neither. A half-specified period in the URL is a typo, not a
    // request, and guessing the other half would open a month nobody asked for.
    if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
    if (month < 1 || month > 12) return null;
    return { year, month };
  }, [searchParams]);

  const select = React.useCallback(
    (period: { year: number; month: number } | null) => {
      // `replace`, not `push`: opening months one after another is browsing a
      // single table, and it should not take six Back presses to leave.
      router.replace(
        period
          ? `/admin/payroll/history?year=${period.year}&month=${period.month}`
          : "/admin/payroll/history",
        { scroll: false },
      );
    },
    [router],
  );

  if (error) {
    return (
      <Card>
        <ErrorState error={error} onRetry={() => refetch()} />
      </Card>
    );
  }

  if (isLoading || !data) return <HistorySkeleton />;

  if (data.periods.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Archive />}
          title="No payroll runs yet"
          description={
            <>
              A month appears here once it has been finalized, or once the
              scheduled job has opened it. Months nobody ever ran are absent
              rather than listed as zero — &ldquo;we owed nothing in July&rdquo;
              and &ldquo;July was never run&rdquo; are different claims, and only
              one of them would be true.
            </>
          }
          action={
            <Button variant="primary" asChild>
              <Link href="/admin/payroll">Open current payroll</Link>
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PeriodList periods={data.periods} opened={opened} onSelect={select} />
      {opened ? <PeriodDetail year={opened.year} month={opened.month} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// THE LIST
// ---------------------------------------------------------------------------

const HEAD_CELL =
  "px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground";
const CELL = "px-4 py-2.5 text-[13px]";

function PeriodList({
  periods,
  opened,
  onSelect,
}: {
  periods: readonly PayrollPeriodSummaryDTO[];
  opened: { year: number; month: number } | null;
  onSelect: (period: { year: number; month: number } | null) => void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left">
          <thead>
            <tr className="border-b border-border bg-surface-sunken">
              <th className={HEAD_CELL}>Month</th>
              <th className={cn(HEAD_CELL, "text-right")}>Total</th>
              <th className={cn(HEAD_CELL, "text-right")}>Employees</th>
              <th className={HEAD_CELL}>Status</th>
              <th className={cn(HEAD_CELL, "text-right")}>Pay date</th>
              <th className={cn(HEAD_CELL, "w-8")}>
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>

          <tbody>
            {periods.map((period) => {
              const isOpen =
                opened?.year === period.year && opened?.month === period.month;

              return (
                <tr
                  key={`${period.year}-${period.month}`}
                  className={cn(
                    "cursor-pointer border-b border-border transition-colors last:border-b-0",
                    isOpen ? "bg-surface-hover/50" : "hover:bg-surface-hover/40",
                  )}
                  onClick={() =>
                    onSelect(
                      isOpen ? null : { year: period.year, month: period.month },
                    )
                  }
                >
                  <td className={cn(CELL, "font-medium text-foreground")}>
                    {period.label}
                  </td>

                  <td className={cn(CELL, "tnum text-right text-foreground")}>
                    {/* `formatRunTotal` returns null for a run that mixes
                        currencies — there is no single total, and one symbol on
                        a sum of cents and yen would be a fabrication. The
                        per-currency split is one click away, in the detail. */}
                    {formatRunTotal(period.totals) ?? (
                      <span
                        className="text-subtle-foreground"
                        title="This run pays people in more than one currency, so it has no single total. Open it for the per-currency figures."
                      >
                        {EM_DASH} mixed
                      </span>
                    )}
                  </td>

                  <td className={cn(CELL, "tnum text-right text-muted-foreground")}>
                    {formatNumber(period.totals.employeeCount)}
                  </td>

                  <td className={CELL}>
                    <PeriodStatusBadge period={period} />
                  </td>

                  <td className={cn(CELL, "tnum text-right text-muted-foreground")}>
                    {formatUtcDay(period.payOn, { withYear: true })}
                  </td>

                  <td className={cn(CELL, "text-right")}>
                    <ChevronRight
                      className={cn(
                        "inline size-4 text-subtle-foreground transition-transform",
                        isOpen && "rotate-90",
                      )}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="border-t border-border px-4 py-2.5 text-[11px] leading-relaxed text-subtle-foreground">
        The pay date is the 1st of the following month. A finalized total is the
        figure that was recorded; a live draft is being recalculated right now
        and will keep moving until the month is frozen.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// THE DETAIL
// ---------------------------------------------------------------------------

function PeriodDetail({ year, month }: { year: number; month: number }) {
  const session = useSession();
  const mayManage = session.can("payroll.manage");
  const { data, isLoading, error, refetch } = usePayrollPeriod({ year, month });

  const markPaid = useMarkPeriodPaid();
  const [finalizeOpen, setFinalizeOpen] = React.useState(false);

  if (error) {
    return (
      <Card>
        <ErrorState error={error} onRetry={() => refetch()} />
      </Card>
    );
  }

  if (isLoading || !data) {
    return <Skeleton className="h-[280px] w-full rounded-lg" />;
  }

  const period = data.period;
  const state = periodState(period);
  const total = formatRunTotalWithRecords(period.totals, period.records);
  const settled = period.totals.pendingMinor === 0 && !period.isDraft;

  async function onMarkPeriodPaid() {
    try {
      await markPaid.mutateAsync({ year, month });
      toast.success(`${period.label} payroll is recorded as paid.`, {
        description:
          "No money moved — this records transfers that happened elsewhere.",
      });
    } catch (caught) {
      toast.error(
        caught instanceof ApiError
          ? caught.message
          : "That period could not be marked paid.",
      );
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <Card className="flex flex-col gap-4 px-5 py-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[17px] font-semibold tracking-tight text-foreground">
                {periodSentence(period)}
              </h2>
              <PeriodStatusBadge period={period} />
            </div>

            <p className="max-w-prose text-[12px] leading-relaxed text-muted-foreground">
              {state.meaning}
            </p>

            {/* The provenance line. Who froze this month and when is what makes
                a stored figure answerable to a person rather than to a job. */}
            {period.finalizedAt !== null ? (
              <p className="text-[11px] text-subtle-foreground">
                Finalized {formatDateTime(period.finalizedAt)}
                {period.finalizedByName
                  ? ` by ${period.finalizedByName}`
                  : " by the scheduled job"}
                .
              </p>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-col gap-1 sm:items-end sm:text-right">
            <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
              {period.isDraft ? "Calculated total" : "Recorded total"}
            </span>
            <span className="tnum text-[24px] font-semibold leading-none tracking-tight text-foreground">
              {total}
            </span>
            <span className="text-[11px] text-subtle-foreground">
              {formatNumber(period.totals.employeeCount)}{" "}
              {pluralize(period.totals.employeeCount, "employee")} ·{" "}
              {formatNumber(period.totals.hitCount)}{" "}
              {pluralize(period.totals.hitCount, "hit")}
            </span>
            {!period.isDraft && !period.totals.currencyMixed ? (
              <span className="tnum text-[11px] text-subtle-foreground">
                {formatMoney(period.totals.paidMinor, period.totals.currency)}{" "}
                paid ·{" "}
                {formatMoney(period.totals.pendingMinor, period.totals.currency)}{" "}
                outstanding
              </span>
            ) : null}
          </div>
        </div>

        {mayManage ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
            {period.isDraft ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => setFinalizeOpen(true)}
              >
                <Lock />
                Finalize {period.label}
              </Button>
            ) : settled ? (
              <span className="flex items-center gap-1.5 text-[12px] text-success">
                <BadgeCheck className="size-3.5" />
                Every line in this period is recorded as paid.
              </span>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={onMarkPeriodPaid}
                loading={markPaid.isPending}
              >
                <BadgeCheck />
                Mark the whole period paid
              </Button>
            )}

            <span className="text-[11px] text-subtle-foreground">
              {period.isDraft
                ? "Freezing this month turns the calculation below into the record of what was owed."
                : "Marking paid moves no money — it records transfers made elsewhere, so “who has been paid” stays answerable."}
            </span>
          </div>
        ) : null}
      </Card>

      <PayrollTable period={period} mayManage={mayManage} />

      {mayManage ? (
        <FinalizeDialog
          period={period}
          open={finalizeOpen}
          onOpenChange={setFinalizeOpen}
        />
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// LOADING
// ---------------------------------------------------------------------------

function HistorySkeleton() {
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col">
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
          >
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-8" />
            <Skeleton className="h-4 w-20 rounded" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </div>
    </Card>
  );
}
