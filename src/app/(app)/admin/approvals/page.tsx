"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Inbox, ShieldAlert, UserRoundX, X } from "lucide-react";
import { toast } from "sonner";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/error-state";
import { NicheChips } from "@/components/niches/niche-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { EmptyState } from "@/components/ui/empty-state";
import { FieldHint, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/components/providers/session-provider";
import {
  useApproveApprovals,
  useDenyApprovals,
  usePendingApprovals,
} from "@/hooks/use-employees";
import { useNow } from "@/hooks/use-now";
import { PERMISSION_LABELS } from "@/lib/auth/permissions";
import { EM_DASH, formatDate, formatDateTime, formatRelativeTime, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";

import type {
  BulkApprovalResult,
  PendingApprovalDTO,
} from "@/server/services/employee-service";

/**
 * Admin › Approvals — the accounts waiting to be let in.
 *
 * WHY THIS SCREEN EXISTS AT ALL
 * The decision was already possible: accepting an invitation leaves an account
 * at `pending_approval`, and the Employees table has carried an Approve and a
 * Reject button on those rows for as long as the gate has existed. What it did
 * not have was a place to *go*. The pending row sorts wherever the person's
 * role and name put it, in a table of everybody who has ever worked here, on a
 * tab called Employees — so the owner with one person waiting had to know the
 * queue existed, know which screen it was on, and then find it. A queue nobody
 * can find is a queue nobody works.
 *
 * So this is a list with exactly one job, and every decision below follows from
 * that: no roster columns, no pay, no profile links that lead away mid-task.
 * Approve and Deny are on every row, visible, never behind a row menu — the
 * whole point is that the action is the first thing you see, not something you
 * discover.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ROW LEAVES WHEN THE SERVER SAYS SO, NOT WHEN THE BUTTON IS CLICKED
 * ─────────────────────────────────────────────────────────────────────────────
 * There is no optimistic removal here. Two admins working the same queue is the
 * normal case rather than the exotic one, and the service makes every
 * transition a compare-and-set precisely so the second click loses — which
 * means "it looked approved and then came back" is a state this screen would
 * reach regularly if it guessed. Instead the row stays put and goes disabled,
 * the mutation waits for the refetch it triggered (see `useApproveApprovals`),
 * and the row disappears because the new list does not contain it.
 *
 * PERMISSION IS AN AFFORDANCE HERE AND A BOUNDARY ON THE SERVER. Every route
 * under /api/admin/approvals calls `requirePermission("users.manage")`. The
 * check below only avoids walking somebody into a screen whose every request
 * would 403.
 */
export default function AdminApprovalsPage() {
  const session = useSession();

  if (!session.can("users.manage")) {
    return (
      <PageContainer className="flex flex-col gap-5">
        <PageHeader title="Approvals" description="Accounts waiting to be let in." />
        <Card>
          <EmptyState
            icon={<ShieldAlert />}
            title="You don't have access to the approvals queue"
            description={
              <>
                Letting somebody into the workspace needs the{" "}
                <span className="text-foreground">{PERMISSION_LABELS["users.manage"]}</span>{" "}
                permission. It arrives only with the Admin role — it is not one an admin
                can hand out individually. Ask an admin if you need it.
              </>
            }
          />
        </Card>
      </PageContainer>
    );
  }

  return <ApprovalsScreen />;
}

// ---------------------------------------------------------------------------
// SCREEN
// ---------------------------------------------------------------------------

/** What a batch was: the wording of every toast on this screen depends on it. */
type Decision = "approve" | "deny";

function ApprovalsScreen() {
  const { data, isLoading, error, refetch } = usePendingApprovals();
  const now = useNow();

  const approve = useApproveApprovals();
  const deny = useDenyApprovals();

  const approvals = React.useMemo(() => data?.approvals ?? [], [data]);

  /*
   * Ticked rows, and rows a request is currently out for.
   *
   * Both are sets of user ids rather than indexes, because the list underneath
   * them is refetched after every decision and an index would silently start
   * pointing at somebody else.
   *
   * `selection` is deliberately NOT pruned when the list changes. An id that has
   * left the queue is filtered out wherever the selection is actually used
   * (`selected` below), so a stale entry can never be actioned — and pruning in
   * an effect would mean a render where the checkbox and the count disagree.
   */
  const [selection, setSelection] = React.useState<ReadonlySet<string>>(() => new Set());
  const [inFlight, setInFlight] = React.useState<ReadonlySet<string>>(() => new Set());

  /** Bulk deny is the only action that opens a dialog; a row deny opens the same one. */
  const [denyTarget, setDenyTarget] = React.useState<readonly PendingApprovalDTO[] | null>(null);

  const selected = React.useMemo(
    () => approvals.filter((approval) => selection.has(approval.userId)),
    [approvals, selection],
  );

  /**
   * Names for the failure report, by id.
   *
   * The server cannot supply one: an outcome that failed because the account
   * could not be read has no name to return, which is exactly the row an admin
   * most needs identified. The queue on screen still knows who they were.
   */
  const labelById = React.useMemo(() => {
    const byId = new Map<string, string>();
    for (const approval of approvals) byId.set(approval.userId, displayName(approval));
    return byId;
  }, [approvals]);

  /**
   * Runs one decision over a set of rows and reports what came back.
   *
   * The ids go in-flight before the request and come out only after the
   * mutation has resolved — which, because the hook's `onSuccess` returns the
   * invalidation, is after the queue has been refetched. So a row is disabled
   * for exactly as long as its fate is unknown, and by the time it is
   * re-enabled it has either left the list or is genuinely still waiting.
   */
  const decide = React.useCallback(
    async (rows: readonly PendingApprovalDTO[], decision: Decision, reason?: string) => {
      const userIds = rows.map((row) => row.userId);
      if (userIds.length === 0) return;

      setInFlight((previous) => new Set([...previous, ...userIds]));

      try {
        const result =
          decision === "approve"
            ? await approve.mutateAsync(userIds)
            : await deny.mutateAsync({ userIds, reason });

        reportOutcome(result, decision, labelById);

        // Only the ones that actually applied leave the selection. A row that
        // failed stays ticked, so "try the failures again" is one more click
        // rather than a re-selection.
        const applied = new Set(
          result.results.filter((outcome) => outcome.ok).map((outcome) => outcome.userId),
        );
        setSelection((previous) => new Set([...previous].filter((id) => !applied.has(id))));
      } catch (thrown) {
        // Only a malformed request or a lost connection reaches here — a batch
        // where some accounts failed resolves normally and is reported above.
        toast.error(
          decision === "approve" ? "Could not approve those accounts" : "Could not deny those accounts",
          { description: thrown instanceof Error ? thrown.message : undefined },
        );
      } finally {
        setInFlight((previous) => {
          const next = new Set(previous);
          for (const id of userIds) next.delete(id);
          return next;
        });
      }
    },
    [approve, deny, labelById],
  );

  /*
   * Two different questions about the same set.
   *
   * `busy` disables every bulk control while ANY decision is out, so two
   * overlapping batches cannot be launched over the same rows. `selectionBusy`
   * is narrower and drives the spinner: a spinner on "Approve selected" while
   * somebody's per-row Deny is in flight would claim this batch is running when
   * it has not been sent.
   */
  const busy = inFlight.size > 0;
  const selectionBusy = selected.some((approval) => inFlight.has(approval.userId));

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader
        title="Approvals"
        description="People who have accepted their invitation and chosen a password. They cannot sign in until somebody here says yes."
        actions={
          approvals.length > 0 ? (
            <Badge variant="accent" size="lg" className="tabular-nums">
              {approvals.length} waiting
            </Badge>
          ) : undefined
        }
      />

      {error ? (
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      ) : (
        <>
          {/* Only present when something is ticked — an empty toolbar sitting
              permanently above the table would be one more thing to read past
              on a screen whose whole claim is that the action is obvious. */}
          {selected.length > 0 ? (
            <BulkBar
              count={selected.length}
              busy={busy}
              running={selectionBusy}
              onApprove={() => void decide(selected, "approve")}
              onDeny={() => setDenyTarget(selected)}
              onClear={() => setSelection(new Set())}
            />
          ) : null}

          <ApprovalsTable
            approvals={approvals}
            loading={isLoading}
            now={now}
            selection={selection}
            inFlight={inFlight}
            onToggle={(userId, ticked) =>
              setSelection((previous) => {
                const next = new Set(previous);
                if (ticked) next.add(userId);
                else next.delete(userId);
                return next;
              })
            }
            onToggleAll={(ticked) =>
              setSelection(ticked ? new Set(approvals.map((a) => a.userId)) : new Set())
            }
            onApprove={(approval) => void decide([approval], "approve")}
            onDeny={(approval) => setDenyTarget([approval])}
          />

          <FieldHint>
            Approving lets somebody sign in with the role their invitation named. Denying
            deactivates the account rather than deleting it — the account, the invitation
            behind it and the record of the decision are all kept, and an admin who
            changes their mind can reactivate it from{" "}
            <Link href="/admin/users" className="text-accent underline-offset-4 hover:underline">
              Users
            </Link>
            .
          </FieldHint>
        </>
      )}

      <DenyDialog
        target={denyTarget}
        onOpenChange={(open) => {
          if (!open) setDenyTarget(null);
        }}
        onConfirm={async (rows, reason) => {
          setDenyTarget(null);
          await decide(rows, "deny", reason);
        }}
      />
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------
// BULK BAR
// ---------------------------------------------------------------------------

/**
 * The two bulk actions, and how many rows they will hit.
 *
 * Sticky, because the point of ticking twelve boxes is to act on twelve boxes,
 * and a control that scrolls away while you are still selecting is a control
 * you have to go back for.
 */
function BulkBar({
  count,
  busy,
  running,
  onApprove,
  onDeny,
  onClear,
}: {
  count: number;
  /** Any decision anywhere on the screen is out — nothing here may be started. */
  busy: boolean;
  /** One of the SELECTED rows is out. Only this earns a spinner. */
  running: boolean;
  onApprove: () => void;
  onDeny: () => void;
  onClear: () => void;
}) {
  return (
    <div className="sticky top-2 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-accent/30 bg-accent-subtle px-4 py-2.5 shadow-sm">
      <span className="text-[13px] font-medium text-foreground">
        {count} {pluralize(count, "account")} selected
      </span>

      <div className="ml-auto flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onClear} disabled={busy}>
          Clear
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onApprove}
          loading={running}
          disabled={busy}
        >
          <Check />
          Approve selected
        </Button>
        <Button variant="danger" size="sm" onClick={onDeny} disabled={busy}>
          <X />
          Deny selected
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TABLE
// ---------------------------------------------------------------------------

const HEAD_CELL =
  "px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground";
const CELL = "px-4 py-3 text-[13px] align-top";

function ApprovalsTable({
  approvals,
  loading,
  now,
  selection,
  inFlight,
  onToggle,
  onToggleAll,
  onApprove,
  onDeny,
}: {
  approvals: readonly PendingApprovalDTO[];
  loading: boolean;
  now: number;
  selection: ReadonlySet<string>;
  inFlight: ReadonlySet<string>;
  onToggle: (userId: string, ticked: boolean) => void;
  onToggleAll: (ticked: boolean) => void;
  onApprove: (approval: PendingApprovalDTO) => void;
  onDeny: (approval: PendingApprovalDTO) => void;
}) {
  if (!loading && approvals.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Inbox />}
          title="Nobody is waiting"
          description="Everyone who has accepted an invitation has been let in or turned away. New requests appear here the moment somebody accepts theirs and chooses a password."
          action={
            <Button variant="secondary" size="sm" asChild>
              <Link href="/admin/users">Invite someone</Link>
            </Button>
          }
        />
      </Card>
    );
  }

  const ticked = approvals.filter((approval) => selection.has(approval.userId)).length;
  const allTicked = approvals.length > 0 && ticked === approvals.length;

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] border-collapse text-left">
          <thead>
            <tr className="border-b border-border bg-surface-sunken">
              <th className={cn(HEAD_CELL, "w-10")}>
                <Checkbox
                  // Indeterminate whenever the selection is a strict subset, so
                  // the header states what is true rather than rounding it to
                  // "some" or "none".
                  checked={allTicked ? true : ticked > 0 ? "indeterminate" : false}
                  onCheckedChange={(value) => onToggleAll(value === true)}
                  disabled={loading || approvals.length === 0}
                  aria-label={allTicked ? "Clear selection" : "Select every waiting account"}
                />
              </th>
              <th className={HEAD_CELL}>User</th>
              <th className={HEAD_CELL}>Request</th>
              <th className={HEAD_CELL}>Role</th>
              <th className={HEAD_CELL}>Date</th>
              <th className={cn(HEAD_CELL, "w-[210px] text-right")}>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 3 }, (_, i) => <ApprovalRowSkeleton key={i} />)
              : approvals.map((approval) => (
                  <ApprovalRow
                    key={approval.userId}
                    approval={approval}
                    now={now}
                    selected={selection.has(approval.userId)}
                    inFlight={inFlight.has(approval.userId)}
                    onToggle={onToggle}
                    onApprove={onApprove}
                    onDeny={onDeny}
                  />
                ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ApprovalRowSkeleton() {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className={CELL} />
      <td className={CELL}>
        <Skeleton className="h-3 w-36" />
      </td>
      <td className={CELL}>
        <Skeleton className="h-3 w-28" />
      </td>
      <td className={CELL}>
        <Skeleton className="h-4 w-24 rounded" />
      </td>
      <td className={CELL}>
        <Skeleton className="h-3 w-20" />
      </td>
      <td className={CELL}>
        <Skeleton className="ml-auto h-8 w-40 rounded-md" />
      </td>
    </tr>
  );
}

function ApprovalRow({
  approval,
  now,
  selected,
  inFlight,
  onToggle,
  onApprove,
  onDeny,
}: {
  approval: PendingApprovalDTO;
  now: number;
  selected: boolean;
  /** A decision for this row is out with the server and has not come back. */
  inFlight: boolean;
  onToggle: (userId: string, ticked: boolean) => void;
  onApprove: (approval: PendingApprovalDTO) => void;
  onDeny: (approval: PendingApprovalDTO) => void;
}) {
  const label = displayName(approval);

  return (
    <tr
      className={cn(
        "border-b border-border transition-colors last:border-b-0",
        selected ? "bg-accent-subtle/40" : "hover:bg-surface-hover/40",
        // Dimmed, not removed. The row is the receipt for a decision that has
        // been made and not yet confirmed; taking it away here is the exact
        // guess this screen refuses to make.
        inFlight && "pointer-events-none opacity-55",
      )}
      aria-busy={inFlight || undefined}
    >
      <td className={CELL}>
        <Checkbox
          checked={selected}
          disabled={inFlight}
          onCheckedChange={(value) => onToggle(approval.userId, value === true)}
          aria-label={`Select ${label}`}
        />
      </td>

      <td className={cn(CELL, "text-foreground")}>
        <span className="block truncate font-medium">{approval.name ?? EM_DASH}</span>
        <span className="block truncate text-[11px] text-subtle-foreground">
          {approval.email ?? EM_DASH}
        </span>
      </td>

      <td className={CELL}>
        <span className="block text-muted-foreground">Sign-in access</span>
        <span className="block text-[11px] text-subtle-foreground">
          {approval.invitedBy ? `Invited by ${approval.invitedBy}` : "Invitation accepted"}
        </span>
      </td>

      <td className={CELL}>
        <Badge
          variant={approval.role === "admin" ? "accent" : "outline"}
          size="sm"
          className="normal-case tracking-normal"
        >
          {approval.roleLabel}
        </Badge>
        {approval.assignedNiches.length > 0 ? (
          <div className="mt-1.5">
            {/* The same chip, with the same colour, this niche wears everywhere
                else — an admin approving a Channel Director is deciding what
                they will be able to see, and the niches are that answer. */}
            <NicheChips niches={approval.assignedNiches} limit={2} size="sm" />
          </div>
        ) : null}
      </td>

      <td className={cn(CELL, "text-muted-foreground")}>
        <WaitingSince acceptedAt={approval.acceptedAt} now={now} />
        {approval.invitedAt !== null ? (
          <span className="block text-[11px] text-subtle-foreground">
            Invited {formatDate(approval.invitedAt)}
          </span>
        ) : null}
      </td>

      <td className={cn(CELL, "text-right")}>
        <span className="inline-flex items-center gap-1.5">
          <Button
            variant="primary"
            size="sm"
            loading={inFlight}
            onClick={() => onApprove(approval)}
          >
            <Check />
            Approve
          </Button>
          {/* Deny is a real button on the row, not an item in a menu. The brief
              for this screen is that both decisions are one click from the list;
              hiding the destructive one behind an affordance people have to
              discover is how a queue stops being worked. */}
          <Button variant="danger" size="sm" disabled={inFlight} onClick={() => onDeny(approval)}>
            <X />
            Deny
          </Button>
        </span>
      </td>
    </tr>
  );
}

/**
 * How long this person has been unable to sign in.
 *
 * `now` is 0 during SSR and the first hydration pass (see use-now.ts), and a
 * relative label computed against the epoch would read "just now" for somebody
 * who accepted last month — so the absolute date stands in until the real clock
 * arrives.
 */
function WaitingSince({ acceptedAt, now }: { acceptedAt: number | null; now: number }) {
  if (acceptedAt === null) {
    return <span className="block text-subtle-foreground">Unknown</span>;
  }

  return (
    <span className="block text-foreground" title={formatDateTime(acceptedAt)}>
      {now === 0 ? formatDate(acceptedAt) : formatRelativeTime(acceptedAt, now)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// DENY
// ---------------------------------------------------------------------------

/**
 * One dialog, two buttons, one optional field — for a single row and for a
 * batch alike.
 *
 * Approve commits immediately: it is the expected outcome, it is reversible
 * from the Users screen, and a confirmation on the common path is how people
 * learn to click through confirmations without reading them. Denying signs
 * somebody out and turns their account off, so it asks once.
 *
 * The reason is optional and stays optional. It is written into each denial's
 * audit entry — a note for whoever reads the trail in six months — and nothing
 * sends it to the person who was denied.
 */
function DenyDialog({
  target,
  onOpenChange,
  onConfirm,
}: {
  /** The rows to deny, or null when the dialog is closed. */
  target: readonly PendingApprovalDTO[] | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (rows: readonly PendingApprovalDTO[], reason?: string) => void;
}) {
  const [reason, setReason] = React.useState("");

  const rows = target ?? [];
  const single = rows.length === 1 ? rows[0] : null;

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        // Cancel, Escape and the close button all land here. Confirming does
        // NOT — the dialog closes because `target` becomes null, which Radix
        // has no way to notice on a controlled `open` — so the confirm handler
        // clears the field itself. A reason typed for one batch must not follow
        // the admin into the next person's audit entry.
        if (!open) setReason("");
        onOpenChange(open);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {single
              ? `Deny ${displayName(single)}?`
              : `Deny ${rows.length} ${pluralize(rows.length, "account")}?`}
          </DialogTitle>
          <DialogDescription>
            {single
              ? `They will not be able to sign in${single.email ? ` with ${single.email}` : ""}.`
              : "None of them will be able to sign in. Their accounts are deactivated, not deleted."}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-2">
          <Label htmlFor="deny-reason">Reason (optional)</Label>
          <textarea
            id="deny-reason"
            value={reason}
            rows={2}
            maxLength={500}
            placeholder="Recorded in the audit log — not sent to them"
            onChange={(event) => setReason(event.target.value)}
            className={cn(
              "w-full resize-y rounded-md border border-border bg-surface-sunken px-3 py-2 text-[13px] text-foreground",
              "placeholder:text-subtle-foreground",
              "transition-colors hover:border-border-strong",
              "focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)]",
            )}
          />
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              const trimmed = reason.trim();
              setReason("");
              onConfirm(rows, trimmed.length > 0 ? trimmed : undefined);
            }}
          >
            <UserRoundX />
            {single ? "Deny and deactivate" : `Deny ${rows.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// REPORTING WHAT HAPPENED
// ---------------------------------------------------------------------------

/**
 * Turns a per-user result into one toast.
 *
 * THE PARTIAL CASE IS THE ONE THAT MATTERS. Both endpoints answer 200 with a
 * breakdown, because one stale id must not abandon the other nine — so a screen
 * that only looked at whether the promise resolved would cheerfully report five
 * approvals when four landed. The three shapes are reported differently on
 * purpose: all good is a success, none good is an error, and a mixed batch is a
 * warning that names who did not go through and why.
 */
function reportOutcome(
  result: BulkApprovalResult,
  decision: Decision,
  labelById: ReadonlyMap<string, string>,
) {
  const { succeeded, failed, results } = result;
  const verb = decision === "approve" ? "approved" : "denied";

  const succeededLabel = (): string => {
    const first = results.find((outcome) => outcome.ok);
    if (succeeded === 1 && first) {
      return first.name ?? first.email ?? labelById.get(first.userId) ?? "That account";
    }
    return `${succeeded} ${pluralize(succeeded, "account")}`;
  };

  if (failed === 0) {
    toast.success(`${succeededLabel()} ${verb}`, {
      description:
        decision === "approve"
          ? "They can sign in from now on."
          : "Their accounts are deactivated and cannot sign in.",
    });
    return;
  }

  const description = describeFailures(results, labelById);

  if (succeeded === 0) {
    toast.error(
      failed === 1
        ? `Could not ${decision} that account`
        : `Could not ${decision} ${failed} ${pluralize(failed, "account")}`,
      { description },
    );
    return;
  }

  toast.warning(`${succeededLabel()} ${verb}, ${failed} could not be`, { description });
}

/** Up to three named failures, so the admin knows WHICH ones to look at. */
function describeFailures(
  results: BulkApprovalResult["results"],
  labelById: ReadonlyMap<string, string>,
): string {
  const failures = results.filter((outcome) => !outcome.ok);
  const shown = failures.slice(0, 3).map((outcome) => {
    // The server has no name for a row it could not read; the queue on screen
    // does. Falling back to the raw id is still better than an anonymous
    // "one account failed" the admin cannot act on.
    const label = outcome.name ?? labelById.get(outcome.userId) ?? outcome.userId;
    return `${label}: ${outcome.error ?? "Unknown error."}`;
  });

  const remaining = failures.length - shown.length;
  return remaining > 0
    ? `${shown.join(" ")} …and ${remaining} more.`
    : shown.join(" ");
}

/** The name to print for somebody, falling back the way the server's log does. */
function displayName(approval: PendingApprovalDTO): string {
  return approval.name ?? approval.email ?? "this person";
}
