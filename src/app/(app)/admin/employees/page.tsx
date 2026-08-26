"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ShieldAlert, UserCheck, UserRoundX, Users, X } from "lucide-react";
import { toast } from "sonner";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/error-state";
import { StatusPill } from "@/components/admin/status-pill";
import { NicheChips } from "@/components/niches/niche-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldHint } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IfPermitted, useSession } from "@/components/providers/session-provider";
import { useApproveEmployee, useEmployees, useRejectEmployee } from "@/hooks/use-employees";
import { useNow } from "@/hooks/use-now";
import { PERMISSION_LABELS } from "@/lib/auth/permissions";
import { EM_DASH, formatDate, formatDateTime, formatRelativeTime, pluralize } from "@/lib/format";
/**
 * `formatMoneyTrimmed`, not `formatMoney`, for every figure on this screen.
 *
 * Same formatter underneath — money is integer minor units and is never divided
 * by hand — with the fraction dropped when it is genuinely zero, so a salary
 * reads "$4,000" here exactly as it does in the payday message, while $4,000.50
 * still reads $4,000.50.
 */
import { formatMoneyTrimmed } from "@/lib/finance/money";
import { cn } from "@/lib/utils";

import type { EmployeeListItemDTO } from "@/server/services/employee-service";

/**
 * Admin › Employees — who works here, on what, and what they are owed.
 *
 * The sibling of Admin › Users, and deliberately a different question. Users
 * answers "who can reach our data?"; this answers "who is on the team?". They
 * are separate screens over separate tables for the same reason the services
 * behind them are separate: an admin managing access should not need — and must
 * not incidentally receive — a colleague's salary.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PAY COLUMNS ARE NOT PROTECTED BY `IfPermitted`
 * ─────────────────────────────────────────────────────────────────────────────
 * They are protected by the API, which omits `pay` from every row for a caller
 * without `payroll.view` — the key is genuinely absent from the JSON, not
 * present and null, and one level down the service does not even select
 * `salaryMinor` from the database. The `IfPermitted` wrappers below are an
 * affordance: they stop a viewer who cannot see salaries from staring at three
 * columns of em dashes and wondering what is broken. Nothing on this page is
 * what keeps a figure away from someone who may not see it.
 *
 * THE APPROVAL GATE IS THE POINT OF THE TABLE
 * Accepting an invitation no longer signs anybody in — it leaves the account at
 * `pending_approval`, unable to authenticate until an administrator says yes.
 * That queue lives here, so the row that needs a decision carries a badge, a
 * tinted background and the two buttons that resolve it, and the count is
 * repeated above the table. It should be impossible to walk past.
 */
export default function AdminEmployeesPage() {
  const session = useSession();

  // An affordance, not a boundary: every /api/admin/employees route re-checks
  // `users.manage` server-side. Rendering this instead of the table only avoids
  // walking someone into a screen whose every query would 403.
  if (!session.can("users.manage")) {
    return (
      <PageContainer className="flex flex-col gap-5">
        <PageHeader title="Employees" description="The team, their niches and their pay." />
        <Card>
          <EmptyState
            icon={<ShieldAlert />}
            title="You don't have access to the employee roster"
            description={
              <>
                Seeing who works here and managing their assignments needs the{" "}
                <span className="text-foreground">{PERMISSION_LABELS["users.manage"]}</span>{" "}
                permission. It arrives only with the Admin role — it is not one an
                admin can hand out individually. Ask an admin if you need it.
              </>
            }
          />
        </Card>
      </PageContainer>
    );
  }

  return <EmployeesScreen organizationName={session.user.organizationName} />;
}

function EmployeesScreen({ organizationName }: { organizationName: string }) {
  const { data, isLoading, error, refetch } = useEmployees();
  const now = useNow();

  const employees = React.useMemo(() => data?.employees ?? [], [data]);
  const pending = React.useMemo(
    () => employees.filter((employee) => employee.status === "pending_approval"),
    [employees],
  );

  /*
   * Has this month already been frozen?
   *
   * `pay.isDraft` is a fact about the PERIOD, so every row carries the same
   * answer — `some` is reading one shared value off whichever row has pay,
   * not asking whether any individual is finalized. The API sends it per row
   * because the flag has to travel with the figure it qualifies; the header and
   * the footnote below need it once, for the whole column.
   *
   * It matters because finalizing accepts `force`: a month can be frozen while
   * it is still running, and from that moment the column is showing stored
   * records rather than a moving estimate. Calling those "estimated pay" would
   * be the wrong word for the one number on this screen people quote out loud.
   */
  const periodFrozen = React.useMemo(
    () => employees.some((employee) => employee.pay !== undefined && !employee.pay.isDraft),
    [employees],
  );

  return (
    <PageContainer className="flex flex-col gap-6">
      <PageHeader
        title="Employees"
        description={`Everyone on the team at ${organizationName}, the niches they work, and — for admins — what they are paid.`}
      />

      {error ? (
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      ) : (
        <>
          {pending.length > 0 ? <PendingBanner count={pending.length} /> : null}

          <EmployeesTable
            employees={employees}
            loading={isLoading}
            now={now}
            periodFrozen={periodFrozen}
          />

          <IfPermitted to="payroll.view">
            <FieldHint>
              {periodFrozen ? (
                <>
                  This month has already been finalized, so the last column is the
                  recorded run — the same figures the Payroll page shows, read from
                  storage rather than recalculated. They no longer move with view
                  counts, and they are what will actually be paid.
                </>
              ) : (
                <>
                  Estimated pay is this month&rsquo;s salary plus the bonuses earned so
                  far, recomputed from live view counts every time this page loads. It
                  can only go up until the period closes and is finalized — it is an
                  estimate in the honest sense, not a figure anybody is owed yet.
                </>
              )}
            </FieldHint>
          </IfPermitted>
        </>
      )}
    </PageContainer>
  );
}

/**
 * The count, above the fold.
 *
 * The rows carry the actual decision, but a pending account sorts wherever its
 * role and name put it — possibly below the fold on a large team. This says how
 * many are waiting without pretending to be the control that resolves them.
 */
function PendingBanner({ count }: { count: number }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3">
      <UserCheck className="mt-0.5 size-4 shrink-0 text-warning" />
      <p className="text-[13px] leading-relaxed text-foreground">
        <span className="font-medium">
          {count} {pluralize(count, "account")} waiting for approval.
        </span>{" "}
        They have accepted their invitation and chosen a password, and cannot sign
        in until an admin approves them. Approve or reject each one in the table
        below.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TABLE
// ---------------------------------------------------------------------------

const HEAD_CELL =
  "px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground";
const CELL = "px-4 py-2.5 text-[13px]";

function EmployeesTable({
  employees,
  loading,
  now,
  periodFrozen,
}: {
  employees: readonly EmployeeListItemDTO[];
  loading: boolean;
  now: number;
  /** The current period has been finalized — see the note where it is derived. */
  periodFrozen: boolean;
}) {
  if (!loading && employees.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Users />}
          title="No employees yet"
          description="Nobody has an account in this organization. Invite someone from the Users screen to get started."
          action={
            <Button variant="secondary" size="sm" asChild>
              <Link href="/admin/users">Open Users</Link>
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1080px] border-collapse text-left">
          <thead>
            <tr className="border-b border-border bg-surface-sunken">
              <th className={HEAD_CELL}>Employee</th>
              <th className={HEAD_CELL}>Role</th>
              <th className={HEAD_CELL}>Niches</th>
              <IfPermitted to="payroll.view">
                <th className={cn(HEAD_CELL, "text-right")}>Salary</th>
                <th className={cn(HEAD_CELL, "text-right")}>/ Hit</th>
                {/* The column is the same figure either way; the word is not.
                    "Est." next to a frozen record would describe it wrongly. */}
                <th className={cn(HEAD_CELL, "text-right")}>
                  {periodFrozen ? "This month" : "Est. pay"}
                </th>
              </IfPermitted>
              <th className={HEAD_CELL}>Status</th>
              <th className={HEAD_CELL}>Last login</th>
              <th className={cn(HEAD_CELL, "w-[168px]")}>
                <span className="sr-only">Approval</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 5 }, (_, i) => <EmployeeRowSkeleton key={i} />)
              : employees.map((employee) => (
                  <EmployeeRow key={employee.userId} employee={employee} now={now} />
                ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function EmployeeRowSkeleton() {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className={CELL}>
        <Skeleton className="h-3 w-32" />
      </td>
      <td className={CELL}>
        <Skeleton className="h-4 w-20 rounded" />
      </td>
      <td className={CELL}>
        <Skeleton className="h-3 w-24" />
      </td>
      <IfPermitted to="payroll.view">
        <td className={CELL}>
          <Skeleton className="ml-auto h-3 w-16" />
        </td>
        <td className={CELL}>
          <Skeleton className="ml-auto h-3 w-10" />
        </td>
        <td className={CELL}>
          <Skeleton className="ml-auto h-3 w-16" />
        </td>
      </IfPermitted>
      <td className={CELL}>
        <Skeleton className="h-3 w-16" />
      </td>
      <td className={CELL}>
        <Skeleton className="h-3 w-20" />
      </td>
      <td className={CELL} />
    </tr>
  );
}

function EmployeeRow({ employee, now }: { employee: EmployeeListItemDTO; now: number }) {
  const router = useRouter();
  const href = `/admin/employees/${employee.userId}`;
  const isPending = employee.status === "pending_approval";
  const label = employee.name ?? employee.email ?? "this person";

  /*
   * The whole row navigates, and the name inside it is a real link.
   *
   * Not the absolutely-positioned overlay the channel table uses: that one sits
   * in a CSS grid of divs, and making it work here would mean relying on a
   * `<tr>` as the containing block for an absolutely-positioned child — which
   * browsers have historically disagreed about. A click handler that steps aside
   * for anything interactive costs nothing and has no such caveat. The anchor is
   * what keeps the row reachable by keyboard.
   */
  const openProfile = (event: React.MouseEvent<HTMLTableRowElement>) => {
    if (event.target instanceof Element && event.target.closest("a, button, [role='menuitem']")) {
      return;
    }
    router.push(href);
  };

  return (
    <tr
      onClick={openProfile}
      className={cn(
        "cursor-pointer border-b border-border transition-colors last:border-b-0",
        isPending ? "bg-warning-subtle/40 hover:bg-warning-subtle/60" : "hover:bg-surface-hover/40",
      )}
    >
      <td className={cn(CELL, "text-foreground")}>
        <Link
          href={href}
          className="block min-w-0 transition-colors hover:text-accent"
          title={label}
        >
          <span className="block truncate font-medium">{employee.name ?? EM_DASH}</span>
          <span className="block truncate text-[11px] text-subtle-foreground">
            {employee.email ?? EM_DASH}
          </span>
        </Link>
      </td>

      <td className={CELL}>
        <Badge
          variant={employee.role === "admin" ? "accent" : "outline"}
          size="sm"
          className="normal-case tracking-normal"
        >
          {employee.roleLabel}
        </Badge>
      </td>

      <td className={CELL}>
        {/* The same chip, with the same colour, that this niche wears on the
            dashboard and in the channel table — `colorIndex` is carried all the
            way from the row so nothing is re-derived per screen. */}
        <NicheChips
          niches={employee.assignedNiches}
          limit={3}
          size="sm"
          emptyLabel="No niches"
        />
      </td>

      <IfPermitted to="payroll.view">
        <PayCells employee={employee} />
      </IfPermitted>

      <td className={CELL}>
        <StatusPill status={employee.status} now={now} />
      </td>

      <td className={cn(CELL, "text-muted-foreground")}>
        <LastLogin at={employee.lastLoginAt} now={now} />
      </td>

      <td className={cn(CELL, "text-right")}>
        {isPending ? <ApprovalActions employee={employee} label={label} /> : null}
      </td>
    </tr>
  );
}

/**
 * Salary, hit rate and this month's estimate.
 *
 * Returned as a fragment of three `<td>`s so the header and the body can be
 * gated by one `IfPermitted` each and cannot fall out of step over a column.
 *
 * `pay` is optional on the DTO — absent, not null, for a viewer without
 * `payroll.view` — and this component only ever renders inside the gate, so the
 * fallback below is for the case where the two disagree. Rendering em dashes is
 * the right answer to that: it says "no figure here", which is exactly true.
 */
function PayCells({ employee }: { employee: EmployeeListItemDTO }) {
  const pay = employee.pay;

  if (!pay) {
    return (
      <>
        <td className={cn(CELL, "text-right text-subtle-foreground")}>{EM_DASH}</td>
        <td className={cn(CELL, "text-right text-subtle-foreground")}>{EM_DASH}</td>
        <td className={cn(CELL, "text-right text-subtle-foreground")}>{EM_DASH}</td>
      </>
    );
  }

  /*
   * Nobody has configured this person's pay yet.
   *
   * The list DTO flattens an absent EmployeeProfile to zeros, so this row cannot
   * tell "unset" from "genuinely nothing" the way the profile screen can — it
   * carries a `configured` flag, this does not. Both figures being zero is the
   * one shape where "not set up" is overwhelmingly the likelier reading, and
   * printing $0.00 across three columns would assert something about a new hire
   * that nobody has decided yet. A contractor on no salary but a real per-hit
   * rate still shows both figures, because only one of them is zero.
   */
  const unset = pay.salaryMinor === 0 && pay.hitPaymentMinor === 0;

  if (unset) {
    // One cell across the three columns: three separate "not set" markers would
    // read as three separate unknowns rather than one unconfigured person.
    return (
      <td className={cn(CELL, "text-right")} colSpan={3}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default text-[12px] text-subtle-foreground">
              Pay not set
            </span>
          </TooltipTrigger>
          <TooltipContent>
            No salary or hit payment has been configured for this person. Open
            their profile to set one.
          </TooltipContent>
        </Tooltip>
      </td>
    );
  }

  return (
    <>
      <td className={cn(CELL, "tnum text-right text-foreground")}>
        {formatMoneyTrimmed(pay.salaryMinor, pay.currency)}
      </td>
      <td className={cn(CELL, "tnum text-right text-muted-foreground")}>
        {formatMoneyTrimmed(pay.hitPaymentMinor, pay.currency)}
      </td>
      <td className={cn(CELL, "tnum text-right font-medium text-foreground")}>
        {pay.isDraft ? (
          formatMoneyTrimmed(pay.estimatedPayMinor, pay.currency)
        ) : (
          /* Frozen. The figure is the stored PayrollRecord, not a recalculation,
             and it is the one that will be paid — so it is marked here as well
             as in the header, because a row is what somebody screenshots. */
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-default underline decoration-dotted underline-offset-4">
                {formatMoneyTrimmed(pay.estimatedPayMinor, pay.currency)}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              This month has been finalized. This is the recorded figure, including
              any adjustment — it no longer moves with view counts.
            </TooltipContent>
          </Tooltip>
        )}
      </td>
    </>
  );
}

/**
 * Approve or reject, on the row that needs it.
 *
 * `stopPropagation` keeps a click here from also opening the profile — the row
 * handler already steps aside for buttons, but a decision this consequential
 * should not depend on one guard.
 *
 * Approve commits immediately: it is the expected outcome, it is reversible from
 * the Users screen, and a confirmation on the common path trains people to click
 * through confirmations. Reject asks first, because it signs the person out and
 * turns their account off.
 */
function ApprovalActions({
  employee,
  label,
}: {
  employee: EmployeeListItemDTO;
  label: string;
}) {
  const [rejectOpen, setRejectOpen] = React.useState(false);
  const approve = useApproveEmployee();

  return (
    <span
      className="inline-flex items-center gap-1.5"
      onClick={(event) => event.stopPropagation()}
    >
      <Button
        variant="primary"
        size="sm"
        loading={approve.isPending}
        onClick={() =>
          approve.mutate(employee.userId, {
            onSuccess: () =>
              toast.success(`${label} approved`, {
                description: `They can sign in as ${employee.roleLabel} from now on.`,
              }),
            onError: (error) =>
              toast.error("Could not approve that account", {
                description: error instanceof Error ? error.message : undefined,
              }),
          })
        }
      >
        <Check />
        Approve
      </Button>

      <Button
        variant="ghost"
        size="sm"
        disabled={approve.isPending}
        onClick={() => setRejectOpen(true)}
      >
        <X />
        Reject
      </Button>

      {/* The dialog owns the reject mutation, so its own button is the one that
          shows the spinner and the confirmation is the only thing that can
          trigger the write. */}
      <RejectDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        employee={employee}
        label={label}
      />
    </span>
  );
}

function RejectDialog({
  open,
  onOpenChange,
  employee,
  label,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: EmployeeListItemDTO;
  label: string;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const reject = useRejectEmployee();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reject {label}?</DialogTitle>
          <DialogDescription>
            They will not be able to sign in{employee.email ? ` with ${employee.email}` : ""}.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Rejecting deactivates the account rather than deleting it. The account,
            the invitation behind it and the record of this decision are kept — that
            is the evidence somebody applied and was refused.
          </p>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            If you change your mind, reactivate them from the Users screen.
          </p>

          {error ? <FieldHint tone="danger">{error}</FieldHint> : null}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={reject.isPending}
            onClick={() =>
              reject.mutate(employee.userId, {
                onSuccess: () => {
                  toast.success(`${label} rejected`, {
                    description: "Their account is deactivated and cannot sign in.",
                  });
                  onOpenChange(false);
                },
                // Rendered in the dialog rather than as a toast: the server's
                // refusal here is a sentence the admin has to read — most often
                // "somebody else already decided this" — and a toast that fades
                // takes the explanation with it.
                onError: (e) =>
                  setError(e instanceof Error ? e.message : "Could not reject that account."),
              })
            }
          >
            <UserRoundX />
            Reject and deactivate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// SHARED BITS
// ---------------------------------------------------------------------------

/**
 * Last sign-in, relative.
 *
 * `now` is 0 during SSR and the first hydration pass (see use-now.ts), and a
 * relative label computed against the epoch would read "just now" for a login
 * from last month — so the absolute date stands in until the real clock arrives.
 */
function LastLogin({ at, now }: { at: number | null; now: number }) {
  if (at === null) {
    return <span className="text-subtle-foreground">Never</span>;
  }
  return (
    <span title={formatDateTime(at)}>
      {now === 0 ? formatDate(at) : formatRelativeTime(at, now)}
    </span>
  );
}

