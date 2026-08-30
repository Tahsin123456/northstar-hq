"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Check,
  MoreHorizontal,
  ShieldAlert,
  SlidersHorizontal,
  UserCheck,
  UserCog,
  UserMinus,
  UserPlus,
  UserRound,
  UserRoundX,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/error-state";
import { StatusPill } from "@/components/admin/status-pill";
import {
  ChangeRoleDialog,
  ExtraPermissionsDialog,
  MemberStatusDialog,
  labelForGrant,
} from "@/components/admin/people/account-dialogs";
import { InvitationsTable, InviteUserDialog } from "@/components/admin/people/invitations";
import { CELL, HEAD_CELL } from "@/components/admin/people/table-cells";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldHint } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IfPermitted, useSession } from "@/components/providers/session-provider";
import { useAdminUsers } from "@/hooks/use-admin";
import { useApproveEmployee, useEmployees, useRejectEmployee } from "@/hooks/use-employees";
import { useNow } from "@/hooks/use-now";
import { isNicheScoped, PERMISSION_LABELS, roleDefinition } from "@/lib/auth/permissions";
import {
  EM_DASH,
  formatDate,
  formatDateTime,
  formatNumber,
  formatRelativeTime,
  pluralize,
} from "@/lib/format";
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

/**
 * Wire shapes imported from the services that produce them.
 *
 * `import type` is erased before bundling, so naming a `server-only` module
 * here adds no server code to the browser — the same precedent `api-client.ts`
 * and `session-provider.tsx` already set. The point is that a field change on
 * either DTO breaks this screen's build rather than quietly rendering a blank
 * cell.
 */
import type { AdminUserDTO } from "@/server/services/admin-service";
import type { EmployeeListItemDTO } from "@/server/services/employee-service";

/**
 * Admin › People — everyone here, as one row each.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SCREEN EXISTS AT ALL
 * ─────────────────────────────────────────────────────────────────────────────
 * It replaces Users and Employees, which were two tables over the same set of
 * people. Users answered "who can reach our data?" and Employees answered "who
 * works here?" — and every real question an admin has is about one person and
 * spans both. Somebody joins: approve the account HERE, then assign their
 * niches THERE. Somebody leaves: deactivate HERE, and the roster over THERE
 * still shows them with a salary and an estimate. Two lists of the same people
 * is two places to look and one place to forget.
 *
 * So a row is a PERSON, and their account and their employment are two aspects
 * of them rather than two records to reconcile. The join is by user id, from the
 * two reads that already existed — `/api/admin/users` for the account and
 * `/api/admin/employees` for the employment — because those are also the two
 * permission boundaries, and merging them server-side into one payload would
 * have been the one change this merge must not make.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE SCREEN, TWO GATES. THE PERMISSIONS DID NOT MERGE.
 * ─────────────────────────────────────────────────────────────────────────────
 * `users.manage` governs the account: the role, the extra permissions, the
 * deactivation, the invitations, and admission to this screen at all. It is the
 * same gate both old screens had.
 *
 * `payroll.view` governs pay, and nothing else on this page moves with it. The
 * pay columns are ABSENT for somebody without it, exactly as they were on
 * Employees — and not because of the `IfPermitted` wrappers below, which are an
 * affordance that stops a viewer staring at three columns of em dashes. The
 * control is the API: it omits `pay` from every row for a caller without the
 * permission, the key is genuinely not in the JSON, and one level down the
 * service does not select `salaryMinor` from the database at all. Merging two
 * screens must not widen anybody's access, and the way to be sure of that is
 * that neither request changed.
 *
 * THE APPROVAL GATE IS STILL THE POINT OF THE TABLE. Accepting an invitation
 * does not sign anybody in: the account sits at `pending_approval` until an
 * administrator says yes. That row carries a badge, a tinted background and the
 * two buttons that resolve it, the count is repeated above the table, and the
 * queue with bulk selection on it is one click away in Approvals.
 */
export default function AdminPeoplePage() {
  const session = useSession();

  // An affordance, not a boundary: every /api/admin route re-checks
  // `users.manage` server-side. Rendering this instead of the table only avoids
  // walking someone into a screen whose every query would 403.
  if (!session.can("users.manage")) {
    return (
      <PageContainer className="flex flex-col gap-5">
        <PageHeader title="People" description="Accounts, roles, niches and pay." />
        <Card>
          <EmptyState
            icon={<ShieldAlert />}
            title="You don't have access to people administration"
            description={
              <>
                Managing accounts, roles, invitations and the roster needs the{" "}
                <span className="text-foreground">
                  {PERMISSION_LABELS["users.manage"]}
                </span>{" "}
                permission. It arrives only with the Admin role — it is not one an
                admin can hand out individually. Ask an admin if you need it.
              </>
            }
          />
        </Card>
      </PageContainer>
    );
  }

  return <PeopleScreen organizationName={session.user.organizationName} />;
}

/**
 * One person: their account, and their employment if they have one yet.
 *
 * Kept as two named sub-objects rather than flattened into a wide row type,
 * because the two halves are governed differently and the dialogs on each side
 * take their own DTO. Flattening would mean re-deriving `AdminUserDTO` to hand
 * to `ChangeRoleDialog`, which is exactly the reconciliation this screen exists
 * to remove.
 */
interface Person {
  readonly account: AdminUserDTO;
  /**
   * Absent only in the moment between the two requests — both read the same
   * `OrganizationMember` rows — so this is a race, not a state. The row renders
   * without niches or pay and gets them on the next refetch, rather than
   * disappearing from an administrator's roster.
   */
  readonly employment: EmployeeListItemDTO | undefined;
}

function PeopleScreen({ organizationName }: { organizationName: string }) {
  // Two reads, two permissions, one table. Neither request changed when the
  // screens merged — see the note at the top of this file.
  const directory = useAdminUsers();
  const roster = useEmployees();
  const now = useNow();
  const [inviteOpen, setInviteOpen] = React.useState(false);

  const people = React.useMemo<Person[]>(() => {
    const employmentByUserId = new Map(
      (roster.data?.employees ?? []).map((employee) => [employee.userId, employee]),
    );
    // The directory is the spine because every row needs an account: the role,
    // the status and every control in the row menu come from it. Both lists are
    // sorted by the same rule server-side — role seniority, then display name —
    // so joining onto it preserves the roster ordering rather than imposing a
    // second one.
    return (directory.data?.users ?? []).map((account) => ({
      account,
      employment: employmentByUserId.get(account.id),
    }));
  }, [directory.data, roster.data]);

  const pendingCount = people.filter(
    (person) => person.account.status === "pending_approval",
  ).length;

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
  const periodFrozen = people.some(
    (person) => person.employment?.pay !== undefined && !person.employment.pay.isDraft,
  );

  // Either read failing leaves a row half-described, so neither is rendered
  // partially. Retrying refetches both — an admin should not have to work out
  // which half of the screen failed.
  const error = directory.error ?? roster.error;
  const loading = directory.isLoading || roster.isLoading;

  return (
    <PageContainer className="flex flex-col gap-6">
      <PageHeader
        title="People"
        description={`Everyone at ${organizationName}: what they can reach, what they work on, and — for admins — what they are paid.`}
        actions={
          <Button variant="primary" size="sm" onClick={() => setInviteOpen(true)}>
            <UserPlus />
            Invite user
          </Button>
        }
      />

      {error ? (
        <Card>
          <ErrorState
            error={error}
            onRetry={() => {
              void directory.refetch();
              void roster.refetch();
            }}
          />
        </Card>
      ) : (
        <>
          {pendingCount > 0 ? <PendingBanner count={pendingCount} /> : null}

          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-[13px] font-medium text-foreground">Team</h2>
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                A role sets the floor of what someone can reach; extra permissions
                widen it. Both are changed from the row menu. Their niches and their
                pay are on their own profile — open a row to get there.
              </p>
            </div>

            <PeopleTable
              people={people}
              loading={loading}
              now={now}
              periodFrozen={periodFrozen}
              onInvite={() => setInviteOpen(true)}
            />

            <IfPermitted to="payroll.view">
              <FieldHint>
                {periodFrozen ? (
                  <>
                    This month has already been finalized, so the pay column is the
                    recorded run — the same figures Finance › Payroll shows, read
                    from storage rather than recalculated. They no longer move with
                    view counts, and they are what will actually be paid.
                  </>
                ) : (
                  <>
                    Estimated pay is this month&rsquo;s salary plus the bonuses earned
                    so far, recomputed from live view counts every time this page
                    loads. It can only go up until the period closes and is finalized
                    — it is an estimate in the honest sense, not a figure anybody is
                    owed yet.
                  </>
                )}
              </FieldHint>
            </IfPermitted>
          </section>

          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-[13px] font-medium text-foreground">
                Pending invitations
              </h2>
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                Invitations nobody has accepted yet — nobody in this list has an
                account, a niche or a salary. An expired link cannot be used; invite
                the person again to issue a fresh one.
              </p>
            </div>
            <InvitationsTable
              invitations={directory.data?.invitations ?? []}
              loading={loading}
              now={now}
              onInvite={() => setInviteOpen(true)}
            />
          </section>
        </>
      )}

      <InviteUserDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </PageContainer>
  );
}

/**
 * The count, above the fold.
 *
 * The rows carry the actual decision, but a pending account sorts wherever its
 * role and name put it — possibly below the fold on a large team. This says how
 * many are waiting without pretending to be the control that resolves them.
 *
 * It points at Admin › Approvals: that screen is the same decision over the same
 * service calls, with the queue as its only content and bulk selection on top —
 * which is what an admin with six people waiting actually wants. The per-row
 * buttons below stay exactly as they are: somebody already looking at the team
 * should not have to go somewhere else to say yes to one person.
 */
function PendingBanner({ count }: { count: number }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-warning/30 bg-warning-subtle px-4 py-3">
      <UserCheck className="size-4 shrink-0 text-warning" />
      <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-foreground">
        <span className="font-medium">
          {count} {pluralize(count, "account")} waiting for approval.
        </span>{" "}
        They have accepted their invitation and chosen a password, and cannot sign
        in until an admin approves them. Approve or reject each one in the table
        below.
      </p>
      <Button variant="secondary" size="sm" asChild>
        <Link href="/admin/approvals">Open the queue</Link>
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TABLE
// ---------------------------------------------------------------------------

function PeopleTable({
  people,
  loading,
  now,
  periodFrozen,
  onInvite,
}: {
  people: readonly Person[];
  loading: boolean;
  now: number;
  /** The current period has been finalized — see the note where it is derived. */
  periodFrozen: boolean;
  onInvite: () => void;
}) {
  if (!loading && people.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Users />}
          title="Nobody here yet"
          description="No one has an account in this organization. Invite someone to get started."
          action={
            <Button variant="secondary" size="sm" onClick={onInvite}>
              <UserPlus />
              Invite user
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1180px] border-collapse text-left">
          <thead>
            <tr className="border-b border-border bg-surface-sunken">
              {/* Person, then what they can reach, then what they work on, then
                  what they cost. The account columns and the employment columns
                  are interleaved rather than blocked, because the row is one
                  person: an admin reads across it, not down two halves. */}
              <th className={HEAD_CELL}>Person</th>
              <th className={HEAD_CELL}>Role</th>
              <th className={HEAD_CELL}>Niches</th>
              <IfPermitted to="payroll.view">
                <th className={cn(HEAD_CELL, "text-right")}>Salary</th>
                {/* The employee-level per-hit rate, which is now historical:
                    a hit is priced by its niche. Labelled so nobody reads this
                    column as what somebody is being paid today. */}
                <th className={cn(HEAD_CELL, "text-right")}>/ Hit (old)</th>
                {/* The column is the same figure either way; the word is not.
                    "Est." next to a frozen record would describe it wrongly. */}
                <th className={cn(HEAD_CELL, "text-right")}>
                  {periodFrozen ? "This month" : "Est. pay"}
                </th>
              </IfPermitted>
              <th className={HEAD_CELL}>Status</th>
              <th className={HEAD_CELL}>Last login</th>
              <th className={cn(HEAD_CELL, "text-right")}>Sessions</th>
              <th className={cn(HEAD_CELL, "w-[200px]")}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 5 }, (_, i) => <PersonRowSkeleton key={i} />)
              : people.map((person) => (
                  <PersonRow key={person.account.id} person={person} now={now} />
                ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function PersonRowSkeleton() {
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
      <td className={CELL}>
        <Skeleton className="ml-auto h-3 w-6" />
      </td>
      <td className={CELL} />
    </tr>
  );
}

function PersonRow({ person, now }: { person: Person; now: number }) {
  const router = useRouter();
  const { account, employment } = person;

  const [roleOpen, setRoleOpen] = React.useState(false);
  const [permissionsOpen, setPermissionsOpen] = React.useState(false);
  const [statusOpen, setStatusOpen] = React.useState(false);

  const href = `/admin/people/${account.id}`;
  const label = account.name ?? account.email ?? "this person";
  const isPending = account.status === "pending_approval";

  // `status` is the DTO's word, but `deactivatedAt` is what actually ends
  // access — the DAL re-reads it on every request. Trusting either alone would
  // let a half-applied state show the wrong action in the menu.
  const isDeactivated = account.status === "deactivated" || account.deactivatedAt !== null;

  // The grants that are genuinely extra: anything the role already carries is
  // not news on a row whose next cell is the role.
  const rolePermissions = roleDefinition(account.role).permissions as readonly string[];
  const extraGrants = account.grants.filter((grant) => !rolePermissions.includes(grant));

  const selfReason =
    "This is your own account. The API refuses self-edits so an admin cannot lock themselves out — ask another admin to make this change.";

  /*
   * The whole row navigates, and the name inside it is a real link.
   *
   * Not the absolutely-positioned overlay the channel table uses: that one sits
   * in a CSS grid of divs, and making it work here would mean relying on a
   * `<tr>` as the containing block for an absolutely-positioned child — which
   * browsers have historically disagreed about. A click handler that steps aside
   * for anything interactive costs nothing and has no such caveat. The anchor is
   * what keeps the row reachable by keyboard, and the step-aside is what keeps
   * the row menu — added when Users merged in here — from also opening the
   * profile behind it.
   */
  const openProfile = (event: React.MouseEvent<HTMLTableRowElement>) => {
    if (event.target instanceof Element && event.target.closest("a, button, [role='menuitem']")) {
      return;
    }
    router.push(href);
  };

  return (
    <>
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
            <span className="flex items-center gap-2">
              <span className="truncate font-medium">{account.name ?? EM_DASH}</span>
              {account.isSelf ? (
                <Badge variant="outline" size="sm" className="normal-case tracking-normal">
                  You
                </Badge>
              ) : null}
            </span>
            <span className="block truncate text-[11px] text-subtle-foreground">
              {account.email ?? EM_DASH}
            </span>
          </Link>
        </td>

        <td className={CELL}>
          <span className="flex items-center gap-1.5">
            <Badge
              variant={account.role === "admin" ? "accent" : "outline"}
              size="sm"
              className="normal-case tracking-normal"
            >
              {account.roleLabel}
            </Badge>
            {extraGrants.length > 0 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="neutral"
                    size="sm"
                    className="tnum cursor-default normal-case tracking-normal"
                  >
                    +{extraGrants.length}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  Granted on top of the role:{" "}
                  {extraGrants.map((grant) => labelForGrant(grant)).join(", ")}.
                </TooltipContent>
              </Tooltip>
            ) : null}
          </span>
        </td>

        <td className={CELL}>
          <AssignedNiches
            employment={employment}
            role={account.role}
            roleLabel={account.roleLabel}
          />
        </td>

        <IfPermitted to="payroll.view">
          <PayCells employment={employment} />
        </IfPermitted>

        <td className={CELL}>
          <StatusPill
            status={account.status}
            deactivatedAt={account.deactivatedAt}
            now={now}
          />
        </td>

        <td className={cn(CELL, "text-muted-foreground")}>
          <LastLogin at={account.lastLoginAt} now={now} />
        </td>

        <td className={cn(CELL, "tnum text-right text-muted-foreground")}>
          {formatNumber(account.activeSessions)}
        </td>

        <td className={cn(CELL, "text-right")}>
          <span className="inline-flex items-center justify-end gap-1.5">
            {isPending ? (
              <ApprovalActions
                userId={account.id}
                roleLabel={account.roleLabel}
                email={account.email}
                label={label}
              />
            ) : null}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${label}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <GuardedMenuItem
                  disabled={account.isSelf}
                  reason={selfReason}
                  onSelect={() => setRoleOpen(true)}
                >
                  <UserCog />
                  Change role
                </GuardedMenuItem>

                {/* Not self-guarded: the API's self-edit rule covers role and
                    status, and an admin already holds every grantable permission,
                    so there is nothing here they could give themselves. */}
                <DropdownMenuItem onSelect={() => setPermissionsOpen(true)}>
                  <SlidersHorizontal />
                  Extra permissions
                </DropdownMenuItem>

                {/* Niches and pay are not in this menu, and that is not an
                    omission. Both are editors rather than one-click decisions —
                    a checklist of niches, a currency field — and both already
                    live on the profile the row opens. */}
                <DropdownMenuItem asChild>
                  <Link href={href}>
                    <UserRound />
                    Open profile
                  </Link>
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                <GuardedMenuItem
                  disabled={account.isSelf}
                  reason={selfReason}
                  tone={isDeactivated ? "default" : "danger"}
                  onSelect={() => setStatusOpen(true)}
                >
                  {isDeactivated ? <UserCheck /> : <UserMinus />}
                  {isDeactivated ? "Reactivate" : "Deactivate"}
                </GuardedMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </td>
      </tr>

      <ChangeRoleDialog user={account} open={roleOpen} onOpenChange={setRoleOpen} />
      <ExtraPermissionsDialog
        user={account}
        open={permissionsOpen}
        onOpenChange={setPermissionsOpen}
      />
      <MemberStatusDialog
        user={account}
        deactivated={isDeactivated}
        open={statusOpen}
        onOpenChange={setStatusOpen}
      />
    </>
  );
}

/**
 * A menu item that may be refused, with the reason attached.
 *
 * A disabled Radix item carries `pointer-events: none`, so it can never be its
 * own tooltip trigger — the wrapper is what the pointer actually lands on. The
 * item stays genuinely `disabled` rather than merely dimmed, so keyboard
 * navigation skips it instead of offering a request the server will reject.
 */
function GuardedMenuItem({
  disabled = false,
  reason,
  tone = "default",
  onSelect,
  children,
}: {
  disabled?: boolean;
  reason?: string;
  tone?: "default" | "danger";
  onSelect: () => void;
  children: React.ReactNode;
}) {
  const item = (
    <DropdownMenuItem disabled={disabled} tone={tone} onSelect={() => onSelect()}>
      {children}
    </DropdownMenuItem>
  );

  if (!disabled || !reason) return item;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block">{item}</span>
      </TooltipTrigger>
      <TooltipContent side="left">{reason}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The niches column — and what an EMPTY one means, which is not one thing.
 *
 * "No niches" reads the same on every row and hides the only difference that
 * matters. For a niche-scoped role it is a broken account: `resolveVisibleNicheIds`
 * fails closed, so an editor with nothing assigned sees no channels at all —
 * they sign in to an empty app, and nothing else on this screen would say so.
 * For a role that is not niche-scoped it is ordinary: they are outside the
 * mechanism and see everything regardless. What both share is payroll, which
 * credits hits per assigned niche and therefore credits none.
 *
 * Same fact, opposite severity, so the tone follows the role rather than the
 * emptiness. The role's own `nicheScoped` flag decides — this file compares no
 * role strings of its own.
 */
function AssignedNiches({
  employment,
  role,
  roleLabel,
}: {
  employment: EmployeeListItemDTO | undefined;
  role: string;
  roleLabel: string;
}) {
  // No employment row in this render: the roster read has not landed, or landed
  // a moment apart from the directory. An em dash says "no answer here yet",
  // which is true; "None" would be a claim about their assignments.
  if (!employment) {
    return <span className="text-[11px] text-subtle-foreground">{EM_DASH}</span>;
  }

  if (employment.assignedNiches.length > 0) {
    // The same chip, with the same colour, that this niche wears on the
    // dashboard and in the channel table — `colorIndex` is carried all the way
    // from the row so nothing is re-derived per screen.
    return <NicheChips niches={employment.assignedNiches} limit={3} size="sm" />;
  }

  const scoped = isNicheScoped(role);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11px]",
        scoped ? "text-warning" : "text-subtle-foreground",
      )}
      // The long form as a title rather than a tooltip: this cell sits inside a
      // row that navigates on click, and a focusable trigger on every row would
      // put a tab stop between an admin and the person they are looking for.
      title={
        scoped
          ? `${roleLabel} only sees the niches assigned to them. With none assigned this account sees no channels at all, and can earn no hit bonus.`
          : `${roleLabel} sees every niche either way. Hit bonuses are paid per niche, so none can be credited until one is assigned.`
      }
    >
      {scoped ? <ShieldAlert className="size-3 shrink-0" /> : null}
      {scoped ? "None — sees nothing" : "None"}
    </span>
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
function PayCells({ employment }: { employment: EmployeeListItemDTO | undefined }) {
  const pay = employment?.pay;

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

// ---------------------------------------------------------------------------
// APPROVAL
// ---------------------------------------------------------------------------

/**
 * Approve or reject, on the row that needs it.
 *
 * `stopPropagation` keeps a click here from also opening the profile — the row
 * handler already steps aside for buttons, but a decision this consequential
 * should not depend on one guard.
 *
 * Approve commits immediately: it is the expected outcome, it is reversible from
 * the row menu beside it, and a confirmation on the common path trains people to
 * click through confirmations. Reject asks first, because it signs the person out
 * and turns their account off.
 */
function ApprovalActions({
  userId,
  roleLabel,
  email,
  label,
}: {
  userId: string;
  roleLabel: string;
  email: string | null;
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
        userId={userId}
        email={email}
        label={label}
      />
    </span>
  );
}

function RejectDialog({
  open,
  onOpenChange,
  userId,
  email,
  label,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  email: string | null;
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
            They will not be able to sign in{email ? ` with ${email}` : ""}.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Rejecting deactivates the account rather than deleting it. The account,
            the invitation behind it and the record of this decision are kept — that
            is the evidence somebody applied and was refused.
          </p>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            If you change your mind, reactivate them from this row&rsquo;s menu.
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
              reject.mutate(userId, {
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
 * Uses the house `formatRelativeTime` ("3 days ago") rather than a second,
 * terser time formatter — one clock vocabulary across the app beats a slightly
 * tighter column here. `now` is 0 during SSR and the first hydration pass (see
 * use-now.ts), and a relative label computed against the epoch would read "just
 * now" for a login from last month, so the absolute date stands in until the
 * real clock arrives.
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
