"use client";

import * as React from "react";
import { use } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  History,
  Pencil,
  ShieldAlert,
  Tags,
  UserCheck,
  UserRoundX,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/error-state";
import { StatusPill } from "@/components/admin/status-pill";
import { nicheColor } from "@/components/niches/niche-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IfPermitted, useSession } from "@/components/providers/session-provider";
import {
  useApproveEmployee,
  useEmployee,
  useRejectEmployee,
  useSetEmployeeNiches,
  useUpdateEmployeePay,
} from "@/hooks/use-employees";
import { useNicheList } from "@/hooks/use-niches";
import { useNow } from "@/hooks/use-now";
import { auditActionLabel } from "@/lib/audit/actions";
import { PERMISSION_LABELS } from "@/lib/auth/permissions";
import { ApiError, type EmployeePayPatch } from "@/lib/api-client";
import {
  CURRENCIES,
  MAX_MONEY_MINOR,
  formatMoneyTrimmed,
  minorUnitsFor,
  parseMoneyToMinor,
} from "@/lib/finance/money";
import {
  EM_DASH,
  formatDate,
  formatDateTime,
  formatNumber,
  formatRelativeTime,
  formatThreshold,
  pluralize,
} from "@/lib/format";
import { cn } from "@/lib/utils";

import type {
  EmployeeAccountDTO,
  EmployeeNicheDTO,
  EmployeePaymentDTO,
  EmployeePayrollDTO,
  EmployeeProfileDTO,
} from "@/server/services/employee-service";
import type { AuditEntryDTO } from "@/server/audit/audit-service";

/**
 * Admin › Employees › one person.
 *
 * Four sections, in the order somebody actually asks about a colleague: who they
 * are, what they work on, what they are paid, and what they have been doing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PAYROLL SECTION IS RENDERED FROM THE RESPONSE, NOT FROM A PERMISSION CHECK
 * ─────────────────────────────────────────────────────────────────────────────
 * `EmployeeProfileDTO.payroll` is an OPTIONAL property: the route resolves
 * `payroll.view` from the session and, for a caller without it, the key is
 * genuinely absent from the JSON — not present and null, and one level down the
 * service never selects `salaryMinor` from the database at all. So the honest
 * test on this screen is "did the server send it?", which is also the only test
 * that cannot disagree with the server. `IfPermitted` appears here exactly once,
 * around the controls that EDIT pay, where the question really is a different
 * one: `payroll.manage` is a permission a viewer can lack while still seeing the
 * figures.
 *
 * THE ACTIVITY FEED IS NOT AN AUDIT DUMP
 * The service hands back a filtered allow-list of actions rather than every row
 * this person appears in — a feed of everything a colleague touched is employee
 * monitoring wearing a profile page's clothes. This screen narrows it further by
 * rendering only the action label, the summary and the time. `AuditEntryDTO`
 * also carries `metadata`, `ipAddress` and `userAgent`; for `employee.pay_updated`
 * that metadata contains the old and new salary, so printing "the rest of the
 * row" here would route straight around the reason payroll is gated at all.
 */
export default function EmployeeProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const session = useSession();

  // An affordance, not a boundary — the route re-checks `users.manage` server
  // side. See the matching note on the Employees list.
  if (!session.can("users.manage")) {
    return (
      <PageContainer className="flex flex-col gap-5">
        <PageHeader title="Employee" description="A member of the team." />
        <Card>
          <EmptyState
            icon={<ShieldAlert />}
            title="You don't have access to employee profiles"
            description={
              <>
                Viewing someone&rsquo;s assignments and employment details needs the{" "}
                <span className="text-foreground">{PERMISSION_LABELS["users.manage"]}</span>{" "}
                permission. Ask an admin if you need it.
              </>
            }
          />
        </Card>
      </PageContainer>
    );
  }

  return <ProfileScreen userId={id} />;
}

function ProfileScreen({ userId }: { userId: string }) {
  const { data, isLoading, error, refetch } = useEmployee(userId);
  const now = useNow();

  if (error) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <PageContainer className="flex flex-col gap-5">
        <BackLink />
        <Card>
          {missing ? (
            <EmptyState
              icon={<Users />}
              title="Employee not found"
              description="Nobody with that id belongs to this organization. They may have been removed, or the link may be from another workspace."
              action={
                <Button variant="primary" size="sm" asChild>
                  <Link href="/admin/employees">Back to Employees</Link>
                </Button>
              }
            />
          ) : (
            <ErrorState error={error} onRetry={() => refetch()} />
          )}
        </Card>
      </PageContainer>
    );
  }

  if (isLoading || !data) {
    return (
      <PageContainer className="flex flex-col gap-6">
        <BackLink />
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </PageContainer>
    );
  }

  const employee: EmployeeProfileDTO = data.employee;
  const { account } = employee;
  const label = account.name ?? account.email ?? "This employee";
  const isPending = account.status === "pending_approval";

  return (
    <PageContainer className="flex flex-col gap-6">
      <BackLink />

      <PageHeader
        title={label}
        description={account.email ?? "No email address on this account."}
        actions={
          isPending ? (
            <ApprovalActions userId={account.userId} label={label} roleLabel={account.roleLabel} />
          ) : undefined
        }
      />

      {isPending ? <PendingNotice label={label} roleLabel={account.roleLabel} /> : null}

      <AccountSection account={account} now={now} />

      <NichesSection userId={account.userId} assigned={employee.assignedNiches} label={label} />

      {employee.payroll ? (
        <PayrollSection userId={account.userId} payroll={employee.payroll} label={label} />
      ) : null}

      <ActivitySection entries={employee.recentActivity} now={now} />
    </PageContainer>
  );
}

function BackLink() {
  return (
    <Link
      href="/admin/employees"
      className="inline-flex w-fit items-center gap-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-3.5" />
      Employees
    </Link>
  );
}

// ---------------------------------------------------------------------------
// APPROVAL GATE
// ---------------------------------------------------------------------------

/**
 * The same decision the list offers, repeated at the top of the profile.
 *
 * Deliberate duplication: an admin who opened somebody's profile to decide
 * whether to let them in should be able to act from the screen that answered the
 * question, rather than navigating back to a table row.
 */
function ApprovalActions({
  userId,
  label,
  roleLabel,
}: {
  userId: string;
  label: string;
  roleLabel: string;
}) {
  const [rejectOpen, setRejectOpen] = React.useState(false);
  const [rejectError, setRejectError] = React.useState<string | null>(null);
  const approve = useApproveEmployee();
  const reject = useRejectEmployee();

  return (
    <>
      <Button
        variant="primary"
        size="sm"
        loading={approve.isPending}
        disabled={reject.isPending}
        onClick={() =>
          approve.mutate(userId, {
            onSuccess: () =>
              toast.success(`${label} approved`, {
                description: `They can sign in as ${roleLabel} from now on.`,
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
        disabled={approve.isPending || reject.isPending}
        onClick={() => setRejectOpen(true)}
      >
        <X />
        Reject
      </Button>

      <Dialog
        open={rejectOpen}
        onOpenChange={(next) => {
          if (!next) setRejectError(null);
          setRejectOpen(next);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reject {label}?</DialogTitle>
            <DialogDescription>They will not be able to sign in.</DialogDescription>
          </DialogHeader>

          <DialogBody className="flex flex-col gap-3">
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Rejecting deactivates the account rather than deleting it. The account,
              the invitation behind it and the record of this decision are kept —
              that is the evidence somebody applied and was refused.
            </p>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              If you change your mind, reactivate them from the Users screen.
            </p>
            {rejectError ? <FieldHint tone="danger">{rejectError}</FieldHint> : null}
          </DialogBody>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={reject.isPending}
              onClick={() =>
                reject.mutate(userId, {
                  onSuccess: () => {
                    toast.success(`${label} rejected`, {
                      description: "Their account is deactivated and cannot sign in.",
                    });
                    setRejectOpen(false);
                  },
                  onError: (e) =>
                    setRejectError(
                      e instanceof Error ? e.message : "Could not reject that account.",
                    ),
                })
              }
            >
              <UserRoundX />
              Reject and deactivate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PendingNotice({ label, roleLabel }: { label: string; roleLabel: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3">
      <UserCheck className="mt-0.5 size-4 shrink-0 text-warning" />
      <p className="text-[13px] leading-relaxed text-foreground">
        <span className="font-medium">Waiting for approval.</span> {label} has
        accepted their invitation and chosen a password, and cannot sign in until
        an admin approves them. Approving lets them in as {roleLabel}.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ACCOUNT
// ---------------------------------------------------------------------------

function AccountSection({ account, now }: { account: EmployeeAccountDTO; now: number }) {
  return (
    <Section
      title="Account"
      description="Who this is, and the state of their access."
      icon={<Users className="size-3.5" />}
    >
      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        <Detail label="Name">
          <span className="flex items-center gap-2">
            {account.name ?? EM_DASH}
            {account.isSelf ? (
              <Badge variant="outline" size="sm" className="normal-case tracking-normal">
                You
              </Badge>
            ) : null}
          </span>
        </Detail>

        <Detail label="Email">{account.email ?? EM_DASH}</Detail>

        <Detail label="Role">
          <Badge
            variant={account.role === "admin" ? "accent" : "outline"}
            size="sm"
            className="normal-case tracking-normal"
          >
            {account.roleLabel}
          </Badge>
        </Detail>

        <Detail label="Status">
          <StatusPill
            status={account.status}
            deactivatedAt={account.deactivatedAt}
            now={now}
          />
        </Detail>

        <Detail label="Invited">
          {account.invitedAt === null ? (
            // No surviving invitation row. The first admin account was created
            // at setup rather than invited, and an old invitation can be tidied
            // away — neither means the person arrived improperly.
            <span className="text-subtle-foreground">No invitation on record</span>
          ) : (
            <span title={formatDateTime(account.invitedAt)}>
              {formatDate(account.invitedAt)}
            </span>
          )}
        </Detail>

        <Detail label="Account created">
          <span title={formatDateTime(account.createdAt)}>{formatDate(account.createdAt)}</span>
        </Detail>

        {/*
         * Employment dates, not account dates — the day they started the job,
         * which is what payroll prorates a first or last month against. They are
         * ungated roster information, the same class of fact as a role; the money
         * beside them in EmployeeProfile is not, which is why only the figures
         * live behind `payroll.view`.
         */}
        <Detail label="Joined">
          {account.joinedOn === null ? (
            <span className="text-subtle-foreground">Not set</span>
          ) : (
            formatDate(account.joinedOn)
          )}
        </Detail>

        {account.employmentEndedOn !== null ? (
          <Detail label="Employment ended">{formatDate(account.employmentEndedOn)}</Detail>
        ) : null}

        <Detail label="Last login">
          {account.lastLoginAt === null ? (
            <span className="text-subtle-foreground">Never</span>
          ) : (
            <span title={formatDateTime(account.lastLoginAt)}>
              {now === 0
                ? formatDate(account.lastLoginAt)
                : formatRelativeTime(account.lastLoginAt, now)}
            </span>
          )}
        </Detail>
      </dl>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// NICHES
// ---------------------------------------------------------------------------

function NichesSection({
  userId,
  assigned,
  label,
}: {
  userId: string;
  assigned: readonly EmployeeNicheDTO[];
  label: string;
}) {
  const [editing, setEditing] = React.useState(false);

  return (
    <Section
      title="Niches"
      description="What this person works on. A niche-scoped role sees only these niches' channels, and payroll pays bonuses only for hits inside them."
      icon={<Tags className="size-3.5" />}
      action={
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          <Pencil />
          Edit niches
        </Button>
      }
    >
      {assigned.length === 0 ? (
        <p className="text-[13px] text-subtle-foreground">
          No niches assigned. A niche-scoped role with no niches sees no channels
          at all, and earns no hit bonuses.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {assigned.map((niche) => (
            <span
              key={niche.id}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-raised px-2 py-1 text-[12px] text-foreground"
            >
              <span
                aria-hidden
                className="size-[6px] shrink-0 rounded-full"
                style={{ background: nicheColor(niche.colorIndex) }}
              />
              {niche.name}
            </span>
          ))}
        </div>
      )}

      <EditNichesDialog
        open={editing}
        onOpenChange={setEditing}
        userId={userId}
        assigned={assigned}
        label={label}
      />
    </Section>
  );
}

function EditNichesDialog({
  open,
  onOpenChange,
  userId,
  assigned,
  label,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  assigned: readonly EmployeeNicheDTO[];
  label: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {/* Mounted only while open, so the checklist always opens on what is
            actually assigned rather than on a stale draft from last time. */}
        {open ? (
          <EditNichesForm
            userId={userId}
            assigned={assigned}
            label={label}
            onOpenChange={onOpenChange}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The assignment checklist.
 *
 * A replace, not a diff: the request carries every ticked box, which is the
 * honest description of what the admin is looking at. Two in-flight edits then
 * resolve to whichever was saved last, rather than each applying half of what
 * the other saw. Every id is re-validated against the organization on the
 * server — the list here is a convenience, never a claim.
 */
function EditNichesForm({
  userId,
  assigned,
  label,
  onOpenChange,
}: {
  userId: string;
  assigned: readonly EmployeeNicheDTO[];
  label: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isLoading, error } = useNicheList();
  const save = useSetEmployeeNiches();

  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    () => new Set(assigned.map((niche) => niche.id)),
  );
  const [formError, setFormError] = React.useState<string | null>(null);

  const niches = data?.niches ?? [];
  const initial = React.useMemo(
    () => new Set(assigned.map((niche) => niche.id)),
    [assigned],
  );

  const changed =
    selected.size !== initial.size || [...selected].some((id) => !initial.has(id));

  const toggle = (id: string, checked: boolean) => {
    setFormError(null);
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    save.mutate(
      { userId, nicheIds: [...selected] },
      {
        onSuccess: (result) => {
          const parts: string[] = [];
          if (result.added.length > 0) parts.push(`added ${result.added.join(", ")}`);
          if (result.removed.length > 0) parts.push(`removed ${result.removed.join(", ")}`);
          toast.success(`Niches updated for ${label}`, {
            // The server reports what it actually changed, which is not always
            // what the form thought it was sending — report its answer.
            description: parts.length === 0 ? "Nothing changed." : `${parts.join("; ")}.`,
          });
          onOpenChange(false);
        },
        onError: (e) =>
          setFormError(e instanceof Error ? e.message : "Could not save those niches."),
      },
    );
  };

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Niches for {label}</DialogTitle>
        <DialogDescription>
          Tick every niche this person works. This changes what a niche-scoped role
          can see and which hits earn them a bonus.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex max-h-[55vh] flex-col gap-1 overflow-y-auto">
        {error ? (
          <FieldHint tone="danger">
            Could not load this organization&apos;s niches. Close and try again.
          </FieldHint>
        ) : isLoading ? (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-8 w-full" />)
        ) : niches.length === 0 ? (
          <FieldHint>
            There are no niches in this workspace yet. Create one on the Niches
            screen, then come back to assign it.
          </FieldHint>
        ) : (
          niches.map((niche) => {
            const id = `niche-${userId}-${niche.id}`;
            const checked = selected.has(niche.id);
            return (
              <div
                key={niche.id}
                className="flex items-center gap-2.5 rounded-md px-2 py-2 transition-colors hover:bg-surface-hover"
              >
                <Checkbox
                  id={id}
                  checked={checked}
                  onCheckedChange={(state) => toggle(niche.id, state === true)}
                />
                <Label htmlFor={id} className="flex flex-1 cursor-pointer items-center gap-2">
                  <span
                    aria-hidden
                    className="size-[6px] shrink-0 rounded-full"
                    style={{ background: nicheColor(niche.colorIndex) }}
                  />
                  {niche.name}
                </Label>
                <span className="text-[11px] text-subtle-foreground">
                  {niche.hitThreshold === null
                    ? "Account default"
                    : formatThreshold(niche.hitThreshold)}
                </span>
              </div>
            );
          })
        )}

        {formError ? <FieldHint tone="danger">{formError}</FieldHint> : null}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!changed}>
          {changed ? "Save niches" : "No change"}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------
// PAYROLL
// ---------------------------------------------------------------------------

function PayrollSection({
  userId,
  payroll,
  label,
}: {
  userId: string;
  payroll: EmployeePayrollDTO;
  label: string;
}) {
  const [editing, setEditing] = React.useState(false);

  return (
    <Section
      title="Payroll"
      description="What this person is paid, what they have earned this period, and what has been paid before."
      icon={<Wallet className="size-3.5" />}
      action={
        // The one genuine permission question on this screen: `payroll.manage`
        // is not grantable from the ordinary checklist and arrives only with the
        // Admin role, so a viewer can hold `payroll.view` — and be reading every
        // figure below — without being allowed to change any of them. The API
        // refuses the write either way.
        <IfPermitted to="payroll.manage">
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            <Pencil />
            {payroll.configured ? "Edit pay" : "Set up pay"}
          </Button>
        </IfPermitted>
      }
    >
      {!payroll.configured ? (
        <div className="rounded-md border border-dashed border-border px-4 py-5 text-center">
          <p className="text-[13px] font-medium text-foreground">Pay is not set up</p>
          <p className="mx-auto mt-1 max-w-[52ch] text-[12px] leading-relaxed text-muted-foreground">
            Nobody has configured a salary or a hit payment for {label}. Until
            somebody does, they are calculated at nothing — an unset rate, not a
            decision that they earn zero.
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-5">
        <PayConfiguration payroll={payroll} />
        <CurrentPeriod payroll={payroll} />
        <PaymentHistory
          history={payroll.history}
          currentYear={payroll.currentPeriod.year}
          currentMonth={payroll.currentPeriod.month}
        />
      </div>

      <EditPayDialog
        open={editing}
        onOpenChange={setEditing}
        userId={userId}
        payroll={payroll}
        label={label}
      />
    </Section>
  );
}

function PayConfiguration({ payroll }: { payroll: EmployeePayrollDTO }) {
  return (
    <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
      <Detail label="Monthly salary">
        <span className="tnum text-[15px] font-medium text-foreground">
          {formatMoneyTrimmed(payroll.salaryMinor, payroll.currency)}
        </span>
      </Detail>
      <Detail label="Per hit">
        <span className="tnum text-[15px] font-medium text-foreground">
          {formatMoneyTrimmed(payroll.hitPaymentMinor, payroll.currency)}
        </span>
      </Detail>
      <Detail label="Currency">{payroll.currency}</Detail>
    </dl>
  );
}

/**
 * This period's figures, shown as a calculation.
 *
 * A total on its own invites the one question this screen exists to answer —
 * "why that number?" — so every line is listed: the base salary, then one row
 * per niche reading `120 hits × $10`, then any adjustment, then the sum.
 *
 * WHICH FIGURES THESE ARE IS THE SERVER'S ANSWER, NOT A GUESS HERE.
 * A period can be finalized at any point — including mid-month, with `force` —
 * and from that moment the PayrollRecord is what gets paid. `currentPeriod`
 * follows the same rule the Payroll page does: a live recalculation while
 * `isDraft`, the stored record once it is not. This card reads that flag rather
 * than inferring the state from the history table below it, so the two screens
 * cannot end up describing one month differently.
 *
 * NOTHING HERE IS RECOMPUTED. Each `bonusMinor` is the figure the server sent,
 * and the total is its `totalMinor`. The rate and the hit count beside them are
 * shown to explain the amount, not to derive it — if a future attribution rule
 * ever made `hits × rate` differ from the bonus, this would keep displaying the
 * bonus that will actually be paid rather than a plausible-looking number
 * nobody could reconcile.
 */
function CurrentPeriod({ payroll }: { payroll: EmployeePayrollDTO }) {
  const period = payroll.currentPeriod;
  const currency = payroll.currency;
  const finalized = !period.isDraft;

  return (
    <div className="rounded-lg border border-border bg-surface-sunken">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-foreground">{period.label}</span>
          {finalized ? (
            <Badge variant="neutral" size="sm" className="normal-case tracking-normal">
              Finalized
            </Badge>
          ) : (
            <Badge variant="accent" size="sm" className="normal-case tracking-normal">
              Estimate
            </Badge>
          )}
        </div>
        <span className="text-[11px] text-subtle-foreground">
          Pay date {formatDate(period.payOn)} · {formatNumber(period.hitCount)}{" "}
          {pluralize(period.hitCount, "hit")}
          {finalized ? " recorded" : " so far"}
        </span>
      </div>

      <div className="flex flex-col px-4 py-3">
        <CalculationRow label="Base salary" amount={period.baseSalaryMinor} currency={currency} />

        {period.byNiche.length === 0 ? (
          <p className="py-1.5 text-[12px] text-subtle-foreground">
            No niches assigned, so no hit bonus can be earned this period.
          </p>
        ) : (
          period.byNiche.map((bucket) => (
            <CalculationRow
              // A frozen line's `nicheId` is null once the niche is deleted —
              // the stored name is what survives, and it is what grouped the
              // hits onto this line in the first place.
              key={bucket.nicheId ?? `name:${bucket.nicheName}`}
              label={bucket.nicheName}
              detail={`${formatNumber(bucket.hitCount)} ${pluralize(bucket.hitCount, "hit")} × ${formatMoneyTrimmed(payroll.hitPaymentMinor, currency)}`}
              hint={`A hit in ${bucket.nicheName} is ${formatThreshold(bucket.thresholdApplied)} views.`}
              amount={bucket.bonusMinor}
              currency={currency}
            />
          ))
        )}

        {/* Only when there is one. A zero adjustment row on every draft would
            be a line about a correction nobody made — and without this row a
            corrected record renders as parts that do not sum to its total. */}
        {period.adjustmentMinor !== 0 ? (
          <CalculationRow
            label="Adjustment"
            detail="Recorded correction"
            hint="A signed correction an admin made after this period was finalized. The reason is in the payment history below and in the audit log."
            amount={period.adjustmentMinor}
            currency={currency}
          />
        ) : null}

        <div className="mt-1.5 flex items-baseline justify-between gap-4 border-t border-border pt-2.5">
          <span className="text-[13px] font-medium text-foreground">Total</span>
          <span className="tnum text-[15px] font-semibold text-foreground">
            {formatMoneyTrimmed(period.totalMinor, currency)}
          </span>
        </div>
      </div>

      <p className="border-t border-border px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
        {finalized ? (
          <>
            This period has been finalized. The figures above are the recorded run
            read back from storage — not a recalculation — so they no longer move
            with the view counts, and they are what will actually be paid.
          </>
        ) : (
          <>
            Recalculated from live view counts. Views still climb, so this can only
            go up until the period closes on {formatDate(period.endsAt)} and the run
            is finalized.
          </>
        )}
      </p>
    </div>
  );
}

function CalculationRow({
  label,
  detail,
  hint,
  amount,
  currency,
}: {
  label: string;
  detail?: string;
  hint?: string;
  amount: number;
  currency: string;
}) {
  const name = (
    <span className="text-[13px] text-foreground">
      {label}
      {detail ? (
        <span className="ml-2 text-[12px] text-muted-foreground">{detail}</span>
      ) : null}
    </span>
  );

  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      {hint ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default">{name}</span>
          </TooltipTrigger>
          <TooltipContent>{hint}</TooltipContent>
        </Tooltip>
      ) : (
        name
      )}
      <span className="tnum shrink-0 text-[13px] text-foreground">
        {formatMoneyTrimmed(amount, currency)}
      </span>
    </div>
  );
}

/**
 * What has actually been recorded, period by period.
 *
 * These rows are PayrollRecords — frozen at finalization, with their own stored
 * hit payment — so each one is rendered from its own figures rather than from
 * today's configuration. A rate that changed in March must not silently rewrite
 * what February's payslip said.
 */
function PaymentHistory({
  history,
  currentYear,
  currentMonth,
}: {
  history: readonly EmployeePaymentDTO[];
  currentYear: number;
  currentMonth: number;
}) {
  if (history.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-4 py-5 text-center">
        <p className="text-[13px] font-medium text-foreground">No payments recorded yet</p>
        <p className="mt-1 text-[12px] text-muted-foreground">
          A period appears here once it has been finalized.
        </p>
      </div>
    );
  }

  const mixedCurrency = new Set(history.map((payment) => payment.currency)).size > 1;

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[12px] font-medium text-foreground">Payment history</h3>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[720px] border-collapse text-left">
          <thead>
            <tr className="border-b border-border bg-surface-sunken">
              <th className={HISTORY_HEAD}>Period</th>
              <th className={cn(HISTORY_HEAD, "text-right")}>Hits</th>
              <th className={cn(HISTORY_HEAD, "text-right")}>Base</th>
              <th className={cn(HISTORY_HEAD, "text-right")}>Bonus</th>
              <th className={cn(HISTORY_HEAD, "text-right")}>Adjustment</th>
              <th className={cn(HISTORY_HEAD, "text-right")}>Total</th>
              <th className={HISTORY_HEAD}>Payment</th>
            </tr>
          </thead>
          <tbody>
            {history.map((payment) => (
              <tr
                key={payment.periodId}
                className="border-b border-border last:border-b-0"
              >
                <td className={cn(HISTORY_CELL, "text-foreground")}>
                  <span className="flex items-center gap-1.5">
                    {payment.label}
                    {payment.year === currentYear && payment.month === currentMonth ? (
                      <Badge
                        variant="outline"
                        size="sm"
                        className="normal-case tracking-normal"
                      >
                        This period
                      </Badge>
                    ) : null}
                  </span>
                </td>
                <td className={cn(HISTORY_CELL, "tnum text-right text-muted-foreground")}>
                  {formatNumber(payment.hitCount)}
                </td>
                <td className={cn(HISTORY_CELL, "tnum text-right text-muted-foreground")}>
                  {formatMoneyTrimmed(payment.baseSalaryMinor, payment.currency)}
                </td>
                <td className={cn(HISTORY_CELL, "tnum text-right text-muted-foreground")}>
                  {formatMoneyTrimmed(payment.hitBonusMinor, payment.currency)}
                </td>
                <td className={cn(HISTORY_CELL, "tnum text-right")}>
                  <Adjustment payment={payment} />
                </td>
                <td className={cn(HISTORY_CELL, "tnum text-right font-medium text-foreground")}>
                  {formatMoneyTrimmed(payment.totalMinor, payment.currency)}
                  {mixedCurrency ? (
                    <span className="ml-1 text-[10px] text-subtle-foreground">
                      {payment.currency}
                    </span>
                  ) : null}
                </td>
                <td className={HISTORY_CELL}>
                  <PaymentStatus payment={payment} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {mixedCurrency ? (
        <FieldHint>
          These periods were recorded in more than one currency, so the column is
          not a running total — each row is shown in the currency it was paid in.
        </FieldHint>
      ) : null}
    </div>
  );
}

const HISTORY_HEAD =
  "px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground";
const HISTORY_CELL = "px-3 py-2 text-[12px]";

/**
 * A hand-made correction, shown as one.
 *
 * Kept out of the base and bonus columns for the same reason the database keeps
 * it in its own column: an adjustment is somebody's decision, and folding it into
 * a computed figure disguises it as arithmetic. The reason travels with it — an
 * entry recording that a total moved without recording why is not an
 * accountability record.
 */
function Adjustment({ payment }: { payment: EmployeePaymentDTO }) {
  if (payment.adjustmentMinor === 0) {
    return <span className="text-subtle-foreground">{EM_DASH}</span>;
  }

  const amount = formatMoneyTrimmed(payment.adjustmentMinor, payment.currency, {
    signDisplay: "always",
  });

  if (!payment.adjustmentReason) {
    return <span className="text-foreground">{amount}</span>;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default text-foreground underline decoration-dotted underline-offset-2">
          {amount}
        </span>
      </TooltipTrigger>
      <TooltipContent>{payment.adjustmentReason}</TooltipContent>
    </Tooltip>
  );
}

function PaymentStatus({ payment }: { payment: EmployeePaymentDTO }) {
  if (payment.paymentStatus === "paid") {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
        {payment.paidAt === null ? "Paid" : `Paid ${formatDate(payment.paidAt)}`}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
      {/* The record's own status, not the period's: a finalized period can still
          hold unpaid records, and that difference is the whole point of the
          column. */}
      Pending
    </span>
  );
}

// ---------------------------------------------------------------------------
// DIALOG: edit pay
// ---------------------------------------------------------------------------

function EditPayDialog({
  open,
  onOpenChange,
  userId,
  payroll,
  label,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  payroll: EmployeePayrollDTO;
  label: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {open ? (
          <EditPayForm
            userId={userId}
            payroll={payroll}
            label={label}
            onOpenChange={onOpenChange}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface PayDraft {
  salaryText: string;
  hitPaymentText: string;
  currency: string;
  joinedOn: string;
  employmentEndedOn: string;
}

/**
 * Salary, hit payment and employment dates.
 *
 * THE AMOUNTS ARE PARSED WITH `parseMoneyToMinor`, THE SERVER'S OWN PARSER.
 * What this form previews is exactly what gets stored: money crosses the wire as
 * integer minor units, and nothing here multiplies or divides by 100 to get
 * there. The API rejects a fractional cent rather than rounding it, because a
 * request carrying one means the caller has a bug and quietly rounding would
 * hide that bug inside somebody's salary.
 *
 * ONLY WHAT CHANGED IS SENT. The endpoint is a PATCH and the service resolves
 * every absent field against what is stored, so an admin correcting a hit rate
 * cannot blank a salary they never touched — and clearing a date is expressed as
 * an explicit `null` rather than as an absence.
 */
function EditPayForm({
  userId,
  payroll,
  label,
  onOpenChange,
}: {
  userId: string;
  payroll: EmployeePayrollDTO;
  label: string;
  onOpenChange: (open: boolean) => void;
}) {
  const update = useUpdateEmployeePay();

  const [draft, setDraft] = React.useState<PayDraft>(() => ({
    salaryText: minorToInputText(payroll.salaryMinor, payroll.currency),
    hitPaymentText: minorToInputText(payroll.hitPaymentMinor, payroll.currency),
    currency: payroll.currency,
    joinedOn: toDateFieldValue(payroll.joinedOn),
    employmentEndedOn: toDateFieldValue(payroll.employmentEndedOn),
  }));
  const [serverError, setServerError] = React.useState<string | null>(null);

  const patchDraft = <K extends keyof PayDraft>(key: K, value: PayDraft[K]) => {
    setServerError(null);
    setDraft((previous) => ({ ...previous, [key]: value }));
  };

  const salaryMinor = parseMoneyToMinor(draft.salaryText, draft.currency);
  const hitPaymentMinor = parseMoneyToMinor(draft.hitPaymentText, draft.currency);

  const salaryError = amountProblem(draft.salaryText, salaryMinor);
  const hitPaymentError = amountProblem(draft.hitPaymentText, hitPaymentMinor);
  // Compared as `YYYY-MM-DD` strings, which sort lexicographically — the same
  // check the service makes on the resolved dates, so the refusal is visible
  // while the field still has focus rather than after a round trip.
  const dateError =
    draft.joinedOn && draft.employmentEndedOn && draft.employmentEndedOn < draft.joinedOn
      ? "Employment cannot end before it began."
      : null;

  const patch = buildPayPatch(payroll, draft, salaryMinor, hitPaymentMinor);
  const nothingChanged = Object.keys(patch).length === 0;
  const blocked =
    salaryError !== null || hitPaymentError !== null || dateError !== null || nothingChanged;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (blocked) return;

    update.mutate(
      { userId, patch },
      {
        onSuccess: (result) => {
          toast.success(`Pay updated for ${label}`, {
            description: `${formatMoneyTrimmed(result.pay.salaryMinor, result.pay.currency)} per month, ${formatMoneyTrimmed(result.pay.hitPaymentMinor, result.pay.currency)} per hit.`,
          });
          onOpenChange(false);
        },
        // In the dialog rather than as a toast: the server's refusals here are
        // sentences the admin has to read before choosing differently, and a
        // toast that fades takes the explanation with it.
        onError: (e) =>
          setServerError(e instanceof Error ? e.message : "Could not save that pay change."),
      },
    );
  };

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Pay for {label}</DialogTitle>
        <DialogDescription>
          The monthly salary and the bonus paid for each Short that clears its
          niche&apos;s threshold. Both feed the payroll run directly.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="pay-salary">Monthly salary</Label>
            <Input
              id="pay-salary"
              autoFocus
              inputMode="decimal"
              value={draft.salaryText}
              invalid={Boolean(salaryError)}
              placeholder="4000"
              onChange={(event) => patchDraft("salaryText", event.target.value)}
            />
            {salaryError ? (
              <FieldHint tone="danger">{salaryError}</FieldHint>
            ) : (
              <FieldHint>
                {salaryMinor === null
                  ? "Paid in full for any month they were employed."
                  : `Stores as ${formatMoneyTrimmed(salaryMinor, draft.currency)}.`}
              </FieldHint>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="pay-hit">Payment per hit</Label>
            <Input
              id="pay-hit"
              inputMode="decimal"
              value={draft.hitPaymentText}
              invalid={Boolean(hitPaymentError)}
              placeholder="10"
              onChange={(event) => patchDraft("hitPaymentText", event.target.value)}
            />
            {hitPaymentError ? (
              <FieldHint tone="danger">{hitPaymentError}</FieldHint>
            ) : (
              <FieldHint>
                {hitPaymentMinor === null
                  ? "Paid once per qualifying Short."
                  : `Stores as ${formatMoneyTrimmed(hitPaymentMinor, draft.currency)} per hit.`}
              </FieldHint>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="pay-currency">Currency</Label>
          <CurrencySelect
            id="pay-currency"
            value={draft.currency}
            onChange={(next) => patchDraft("currency", next)}
          />
          <FieldHint>
            Both amounts above are read in this currency. Changing it does not
            convert them — it relabels what the numbers mean.
          </FieldHint>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="pay-joined">Employment started</Label>
            <Input
              id="pay-joined"
              type="date"
              value={draft.joinedOn}
              invalid={Boolean(dateError)}
              onChange={(event) => patchDraft("joinedOn", event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="pay-ended">Employment ended</Label>
            <Input
              id="pay-ended"
              type="date"
              value={draft.employmentEndedOn}
              invalid={Boolean(dateError)}
              onChange={(event) => patchDraft("employmentEndedOn", event.target.value)}
            />
          </div>
        </div>

        {dateError ? (
          <FieldHint tone="danger">{dateError}</FieldHint>
        ) : (
          <FieldHint>
            Payroll pays only for periods that overlap these dates. Leave the end
            date empty while somebody still works here; clearing it puts them back
            on the payroll.
          </FieldHint>
        )}

        {serverError ? <FieldHint tone="danger">{serverError}</FieldHint> : null}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={update.isPending} disabled={blocked}>
          {nothingChanged ? "No change" : "Save pay"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The currency chooser.
 *
 * A Radix dropdown rather than a native `<select>`, matching every other choice
 * in this app: a raw select would be the only OS-styled widget on the page, and
 * the only one that ignores the theme.
 */
function CurrencySelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const selected = CURRENCIES.find((currency) => currency.code === value) ?? null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          id={id}
          type="button"
          className={cn(
            "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-surface-sunken px-3 text-sm text-foreground",
            "transition-colors duration-150 hover:border-border-strong",
            "focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)]",
          )}
        >
          <span className="truncate">
            {selected ? `${selected.code} — ${selected.name}` : value}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-subtle-foreground" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        className="max-h-[300px] w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto"
      >
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {CURRENCIES.map((currency) => (
            <DropdownMenuRadioItem key={currency.code} value={currency.code}>
              <span className="truncate">
                {currency.code} — {currency.name}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// ACTIVITY
// ---------------------------------------------------------------------------

function ActivitySection({
  entries,
  now,
}: {
  entries: readonly AuditEntryDTO[];
  now: number;
}) {
  return (
    <Section
      title="Activity"
      description="Recent actions this person took, from the audit trail."
      icon={<History className="size-3.5" />}
    >
      {entries.length === 0 ? (
        <p className="text-[13px] text-subtle-foreground">
          Nothing recorded for this person yet.
        </p>
      ) : (
        <ul className="flex flex-col">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="flex items-baseline gap-3 border-b border-border py-2 last:border-b-0"
            >
              {/* Never the raw action key: `auditActionLabel` is the only way an
                  action reaches this screen, so a key nobody has labelled shows
                  as itself rather than as a guess at what it meant. */}
              <span className="hidden w-[168px] shrink-0 truncate text-[11px] font-medium text-muted-foreground sm:block">
                {auditActionLabel(entry.action)}
              </span>
              <span className="min-w-0 flex-1 text-[12px] text-foreground">
                {entry.summary}
              </span>
              <span
                className="tnum w-[84px] shrink-0 text-right text-[11px] text-subtle-foreground"
                title={formatDateTime(entry.createdAt)}
              >
                {now === 0 ? formatDate(entry.createdAt) : formatRelativeTime(entry.createdAt, now)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <FieldHint className="mt-3">
        Sign-ins are deliberately not listed. They are recorded so a security
        incident can be investigated, not so a profile page can be read as an
        attendance sheet.
      </FieldHint>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// SHARED PIECES
// ---------------------------------------------------------------------------

function Section({
  title,
  description,
  icon,
  action,
  children,
}: {
  title: string;
  description: string;
  icon: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-1.5">
            <span className="text-subtle-foreground">{icon}</span>
            {title}
          </CardTitle>
          <CardDescription className="mt-0.5 text-[12px]">{description}</CardDescription>
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
        {label}
      </dt>
      <dd className="mt-1 truncate text-[13px] text-foreground">{children}</dd>
    </div>
  );
}

/**
 * Minor units back into something the amount field can hold.
 *
 * Plain digits and a dot, never a localised group separator: the value goes
 * straight back into `parseMoneyToMinor`, and a round trip through the user's
 * locale is a chance for the number to change on the way. The same helper the
 * finance ledger's entry form uses, for the same reason.
 */
function minorToInputText(minor: number, currency: string): string {
  const digits = minorUnitsFor(currency);
  if (digits === 0) return String(minor);
  const sign = minor < 0 ? "-" : "";
  const magnitude = String(Math.abs(minor)).padStart(digits + 1, "0");
  return `${sign}${magnitude.slice(0, -digits)}.${magnitude.slice(-digits)}`;
}

/**
 * Epoch ms to the `YYYY-MM-DD` a date input wants — read in UTC.
 *
 * Deliberately not the local-date helper the finance ledger uses. An employment
 * date is stored as `new Date("2026-08-01")`, i.e. UTC midnight, because the
 * payroll periods are half-open UTC windows; formatting it in local time would
 * shift a start date to 31 July for anyone west of Greenwich and quietly move
 * which month somebody gets paid for.
 */
function toDateFieldValue(ms: number | null): string {
  return ms === null ? "" : new Date(ms).toISOString().slice(0, 10);
}

/**
 * Inline validation that mirrors the server's own bounds.
 *
 * Not a substitute for it — the API validates everything again — but a rejected
 * amount should be visible while the field still has focus.
 */
function amountProblem(text: string, parsed: number | null): string | null {
  if (!text.trim()) {
    return "Enter an amount. Use 0 for no salary rather than leaving this empty.";
  }
  if (parsed === null) {
    return "That is not an amount this can read. Try 4000, 4,000.00 or 4.000,00.";
  }
  if (parsed < 0) {
    return "Pay cannot be negative.";
  }
  if (parsed > MAX_MONEY_MINOR) {
    return "That amount is larger than this system can store.";
  }
  return null;
}

/**
 * Exactly what the admin changed, and nothing else.
 *
 * Building the diff here rather than sending the whole form is what makes the
 * PATCH honest: an untouched field is absent from the body, so the service
 * resolves it against what is stored and two admins editing different fields
 * cannot overwrite each other's work. An emptied date is sent as `null` —
 * a value meaning "clear this" — which is a different request from not
 * mentioning the date at all.
 */
function buildPayPatch(
  payroll: EmployeePayrollDTO,
  draft: PayDraft,
  salaryMinor: number | null,
  hitPaymentMinor: number | null,
): EmployeePayPatch {
  const patch: {
    salaryMinor?: number;
    hitPaymentMinor?: number;
    currency?: string;
    joinedOn?: string | null;
    employmentEndedOn?: string | null;
  } = {};

  if (salaryMinor !== null && salaryMinor !== payroll.salaryMinor) {
    patch.salaryMinor = salaryMinor;
  }
  if (hitPaymentMinor !== null && hitPaymentMinor !== payroll.hitPaymentMinor) {
    patch.hitPaymentMinor = hitPaymentMinor;
  }
  if (draft.currency !== payroll.currency) {
    patch.currency = draft.currency;
  }

  // Both sides compared as the field's own `YYYY-MM-DD` string, with "" standing
  // for "no date" on each — so the only thing that can differ is what the admin
  // actually typed. An emptied field becomes an explicit `null` on the wire.
  if (draft.joinedOn !== toDateFieldValue(payroll.joinedOn)) {
    patch.joinedOn = draft.joinedOn || null;
  }
  if (draft.employmentEndedOn !== toDateFieldValue(payroll.employmentEndedOn)) {
    patch.employmentEndedOn = draft.employmentEndedOn || null;
  }

  return patch;
}
