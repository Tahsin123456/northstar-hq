"use client";

import * as React from "react";
import Link from "next/link";
import { History, Lock, ShieldAlert } from "lucide-react";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/error-state";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { InfoTip } from "@/components/ui/tooltip";
import { useSession } from "@/components/providers/session-provider";
import { FinalizeDialog } from "@/components/admin/payroll/finalize-dialog";
import { PeriodStatusBadge } from "@/components/admin/payroll/period-status-badge";
import { PayrollTable } from "@/components/admin/payroll/payroll-table";
import { TelegramCard } from "@/components/admin/payroll/telegram-card";
import {
  formatRunTotalWithRecords,
  periodSentence,
  periodState,
  periodWindowSentence,
} from "@/components/admin/payroll/payroll-format";
import { usePayroll, usePayrollPeriod } from "@/hooks/use-payroll";
import { PERMISSION_LABELS } from "@/lib/auth/permissions";
import { formatMoney } from "@/lib/finance/money";
import { EM_DASH, formatNumber, pluralize } from "@/lib/format";
import type {
  PayrollPeriodDTO,
  PayrollPeriodSummaryDTO,
} from "@/server/services/payroll-service";

/**
 * Admin › Payroll — what the team is owed for the month in progress.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE THING THIS SCREEN MUST GET RIGHT
 * ─────────────────────────────────────────────────────────────────────────────
 * The headline figure here is a DRAFT. It was calculated seconds ago against
 * view counts that are still climbing, and it will be a different number
 * tomorrow. Everything about the layout says so — the state badge, the sentence
 * under the total, the wording of the finalize dialog — because the failure
 * mode of a payroll screen is not a rendering bug, it is somebody paying
 * against a number they believed was settled.
 *
 * The two acts this screen supports are deliberately different in weight.
 * READING what is owed is what it does by default; FREEZING a month is a
 * confirmed, explained, one-way action behind `payroll.manage`. Only the second
 * one produces a financial document.
 *
 * WHY THE PERMISSION CHECK HERE IS NOT THE BOUNDARY
 * `/api/admin/payroll` calls `requirePermission("payroll.view")` as its first
 * statement, and the service calls it again. The check below only avoids
 * walking a colleague into a screen whose every request would 403 — the same
 * pattern the Users screen uses, for the same reason.
 */
export default function AdminPayrollPage() {
  const session = useSession();

  if (!session.can("payroll.view")) {
    return (
      <PageContainer className="flex flex-col gap-5">
        <PageHeader title="Payroll" description={PAGE_DESCRIPTION} />
        <Card>
          <EmptyState
            icon={<ShieldAlert />}
            title="You don't have access to payroll"
            /*
             * WHAT THIS SENTENCE MUST NOT DO IS LIE ABOUT THE PERMISSION MODEL.
             * `payroll.view` IS in GRANTABLE_PERMISSIONS, deliberately: the
             * brief reads "ADMIN = full access, HEAD_OF_SHORTS / DIRECTORS = no
             * access unless explicitly granted", and the grant is how the
             * second half of that sentence happens. Telling a Channel Director
             * the door is bolted shut sends them away from a request an admin
             * can actually say yes to. What is worth saying instead is the part
             * that makes it a considered grant rather than a stray tick: it is
             * everyone's pay, not their own.
             */
            description={
              <>
                Salaries, hit payments and payroll runs need the{" "}
                <span className="text-foreground">
                  {PERMISSION_LABELS["payroll.view"]}
                </span>{" "}
                permission. It comes with the Admin role by default; an admin
                can also grant it to one specific person. Bear in mind that it
                is not a view of your own pay — it shows every colleague&rsquo;s
                salary and payroll total. Ask an admin if you need it.
              </>
            }
          />
        </Card>
      </PageContainer>
    );
  }

  return <PayrollScreen />;
}

const PAGE_DESCRIPTION =
  "What the team is owed this month, how every figure was reached, and where the payday summary goes.";

function PayrollScreen() {
  const session = useSession();
  const { data, isLoading, error, refetch } = usePayroll();
  const mayManage = session.can("payroll.manage");

  const [finalizeOpen, setFinalizeOpen] = React.useState(false);

  return (
    <PageContainer className="flex flex-col gap-6">
      <PageHeader
        title="Payroll"
        description={PAGE_DESCRIPTION}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" asChild>
              <Link href="/admin/payroll/history">
                <History />
                Payroll history
              </Link>
            </Button>
            {mayManage && data ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => setFinalizeOpen(true)}
                // Already frozen: the action would be a no-op, and a button that
                // does nothing is worse than one that is visibly unavailable.
                disabled={!data.period.isDraft}
              >
                <Lock />
                Finalize period
              </Button>
            ) : null}
          </div>
        }
      />

      {error ? (
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      ) : isLoading || !data ? (
        <PayrollSkeleton />
      ) : (
        <>
          <UpcomingHeader period={data.period} />
          <PayrollTable period={data.period} mayManage={mayManage} />
          {data.previous ? (
            <PreviousPeriodStrip previous={data.previous} mayManage={mayManage} />
          ) : null}
          <TelegramCard />
        </>
      )}

      {data && mayManage ? (
        <FinalizeDialog
          period={data.period}
          open={finalizeOpen}
          onOpenChange={setFinalizeOpen}
        />
      ) : null}
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// THE HEADLINE
// ---------------------------------------------------------------------------

/**
 * "UPCOMING PAYROLL", the pay date, and the total.
 *
 * The period is stated in words — "August 2026 · paid 1 September" — rather
 * than as a date range, because that is the sentence somebody repeats out loud
 * when they ask whether payroll has gone out. The exact window sits underneath
 * for anyone checking which Shorts are in scope.
 *
 * The pay date is formatted in UTC by `periodSentence`. `payOn` is a calendar
 * date stored as UTC midnight, and rendering it locally would show 31 August to
 * anybody west of Greenwich — see the note in payroll-format.ts.
 */
function UpcomingHeader({ period }: { period: PayrollPeriodDTO }) {
  const state = periodState(period);
  const total = formatRunTotalWithRecords(period.totals, period.records);
  const mixed = period.totals.currencyMixed;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col gap-5 px-5 py-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
            Upcoming payroll
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[17px] font-semibold tracking-tight text-foreground">
              {periodSentence(period)}
            </h2>
            <PeriodStatusBadge period={period} />
          </div>
          <p className="max-w-prose text-[12px] leading-relaxed text-muted-foreground">
            {state.meaning}
          </p>
          <p className="text-[11px] text-subtle-foreground">
            Counts Shorts published {periodWindowSentence(period)}, on channels
            this organization owns, in niches each person is assigned to.
          </p>
        </div>

        <div className="flex shrink-0 flex-col gap-1 sm:items-end sm:text-right">
          <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
            Total
            {mixed ? (
              <InfoTip>
                This run pays people in more than one currency. Payroll has no
                exchange-rate table, so the figures are listed per currency
                rather than converted into one — a converted total would be a
                number nobody agreed on.
              </InfoTip>
            ) : null}
          </span>
          <span className="tnum text-[26px] font-semibold leading-none tracking-tight text-foreground">
            {total}
          </span>
          <span className="text-[11px] text-subtle-foreground">
            {formatNumber(period.totals.employeeCount)}{" "}
            {pluralize(period.totals.employeeCount, "employee")} ·{" "}
            {formatNumber(period.totals.hitCount)}{" "}
            {pluralize(period.totals.hitCount, "hit")}
          </span>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// LAST MONTH
// ---------------------------------------------------------------------------

/**
 * The month that just ended.
 *
 * This is the run that actually gets finalized and paid — on the 1st nobody is
 * freezing the month they are standing in — so it has to be reachable from the
 * screen somebody opens on payday, not only from history.
 *
 * The full period is fetched lazily, and only when an admin asks to finalize
 * it. `previous` is a summary with no per-employee rows, and the finalize
 * dialog has to show what it is about to write down; fetching that up front
 * would mean a second full engine run over last month on every load of this
 * page, for a dialog most visits never open.
 */
function PreviousPeriodStrip({
  previous,
  mayManage,
}: {
  previous: PayrollPeriodSummaryDTO;
  mayManage: boolean;
}) {
  const [wanted, setWanted] = React.useState(false);
  const detail = usePayrollPeriod(
    wanted ? { year: previous.year, month: previous.month } : null,
  );

  /**
   * The dialog is open exactly when it has something to be about.
   *
   * Derived rather than held in state: "the admin asked for this, and the
   * period has arrived" IS the open condition, and an effect flipping a
   * separate `open` boolean when the fetch lands would be that same fact stored
   * twice. One click then reads as one action — the button spins, and the
   * dialog appears with the figures already in it.
   */
  const dialogPeriod = wanted ? (detail.data?.period ?? null) : null;

  const total = previous.totals.currencyMixed
    ? EM_DASH
    : formatMoney(previous.totals.totalMinor, previous.totals.currency);

  return (
    <>
      <Card className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
            Last month
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-medium text-foreground">
              {periodSentence(previous)}
            </span>
            <PeriodStatusBadge period={previous} />
          </div>
          <span className="tnum text-[12px] text-muted-foreground">
            {total} · {formatNumber(previous.totals.employeeCount)}{" "}
            {pluralize(previous.totals.employeeCount, "employee")}
            {previous.totals.currencyMixed ? " · mixed currencies" : ""}
          </span>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {mayManage && previous.isDraft ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setWanted(true)}
              loading={wanted && detail.isLoading}
            >
              <Lock />
              Finalize {previous.label}
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" asChild>
            <Link
              href={`/admin/payroll/history?year=${previous.year}&month=${previous.month}`}
            >
              Open
            </Link>
          </Button>
        </div>
      </Card>

      {dialogPeriod && mayManage ? (
        <FinalizeDialog
          period={dialogPeriod}
          open
          onOpenChange={(open) => {
            // Closing clears the request, so a second click asks for the period
            // again rather than re-opening a dialog built from figures that
            // have since moved.
            if (!open) setWanted(false);
          }}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// LOADING
// ---------------------------------------------------------------------------

/** Mirrors the real layout so nothing jumps when the payload lands. */
function PayrollSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-3 px-5 py-5">
        <Skeleton className="h-2.5 w-28" />
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-3 w-80" />
      </Card>
      <Card className="overflow-hidden">
        <div className="flex flex-col">
          {Array.from({ length: 5 }, (_, index) => (
            <div
              key={index}
              className="flex items-center justify-between gap-4 border-b border-border px-4 py-3 last:border-b-0"
            >
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-10" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-24" />
            </div>
          ))}
        </div>
      </Card>
      <Skeleton className="h-[280px] w-full rounded-lg" />
    </div>
  );
}
