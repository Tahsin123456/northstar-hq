"use client";

import * as React from "react";
import { Copy, Link2, Mail, MailPlus, MoreHorizontal, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useInviteMember, useRevokeInvitation } from "@/hooks/use-admin";
import type { Role } from "@/lib/auth/permissions";
import { EM_DASH, formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import { RoleCapabilities, RolePicker } from "./account-dialogs";
import { CELL, HEAD_CELL } from "./table-cells";

import type { AdminInvitationDTO } from "@/server/services/admin-service";

/**
 * Invitations: the people who are not people here yet.
 *
 * DELIBERATELY STILL A SECOND LIST, even though Users and Employees merged into
 * one. The merge joined two descriptions of the SAME person — an account and an
 * employment — into one row. An invitation is not a third description of
 * anybody: there is no account behind it, no session to revoke, no role to
 * change, no niche to assign and no salary. Folding it into the roster would
 * put a row on that table where most of the columns and every one of the
 * controls have nothing to answer. The API returns the two separately for the
 * same reason.
 */

// ---------------------------------------------------------------------------
// TABLE
// ---------------------------------------------------------------------------

export function InvitationsTable({
  invitations,
  loading,
  now,
  onInvite,
}: {
  invitations: readonly AdminInvitationDTO[];
  loading: boolean;
  now: number;
  onInvite: () => void;
}) {
  if (loading) {
    return (
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 p-4">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      </Card>
    );
  }

  if (invitations.length === 0) {
    return (
      <Card>
        <EmptyState
          className="py-10"
          icon={<MailPlus />}
          title="No outstanding invitations"
          description="Invitations appear here until they are accepted or revoked."
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
        <table className="w-full min-w-[860px] border-collapse text-left">
          <thead>
            <tr className="border-b border-border bg-surface-sunken">
              <th className={HEAD_CELL}>Email</th>
              <th className={HEAD_CELL}>Name</th>
              <th className={HEAD_CELL}>Role</th>
              <th className={HEAD_CELL}>Invited by</th>
              <th className={HEAD_CELL}>Expires</th>
              <th className={cn(HEAD_CELL, "w-10")}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {invitations.map((invitation) => (
              <InvitationRow key={invitation.id} invitation={invitation} now={now} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function InvitationRow({
  invitation,
  now,
}: {
  invitation: AdminInvitationDTO;
  now: number;
}) {
  const [revokeOpen, setRevokeOpen] = React.useState(false);

  // `now === 0` before the clock arrives — treating that as "expired" would
  // brand every live invitation dead for one frame.
  const expired = now > 0 && invitation.expiresAt < now;

  return (
    <>
      <tr className="border-b border-border transition-colors last:border-b-0 hover:bg-surface-hover/40">
        <td className={cn(CELL, "text-foreground")}>{invitation.email}</td>
        <td className={cn(CELL, "text-muted-foreground")}>
          {invitation.name ?? EM_DASH}
        </td>
        <td className={CELL}>
          <Badge
            variant={invitation.role === "admin" ? "accent" : "outline"}
            size="sm"
            className="normal-case tracking-normal"
          >
            {invitation.roleLabel}
          </Badge>
        </td>
        <td className={cn(CELL, "text-muted-foreground")}>
          {invitation.invitedByName ?? EM_DASH}
        </td>
        <td className={CELL}>
          {expired ? (
            <Badge variant="danger" size="sm" className="normal-case tracking-normal">
              Expired {formatDate(invitation.expiresAt)}
            </Badge>
          ) : (
            // Shown as a date, not "in 6 days": formatRelativeTime reports any
            // future timestamp as "just now", which would be a lie about the
            // one field an admin checks before chasing someone.
            <span className="text-muted-foreground" title={formatDateTime(invitation.expiresAt)}>
              {formatDate(invitation.expiresAt)}
            </span>
          )}
        </td>
        <td className={cn(CELL, "text-right")}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions for the invitation to ${invitation.email}`}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem tone="danger" onSelect={() => setRevokeOpen(true)}>
                <Trash2 />
                Revoke invitation
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </td>
      </tr>

      <RevokeInvitationDialog
        invitation={invitation}
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// DIALOG: invite
// ---------------------------------------------------------------------------

export function InviteUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {/* Mounted only while open, so the form — and the mutation state that
            holds the one-time invite link — starts clean on every invitation. */}
        {open ? <InviteUserForm onOpenChange={onOpenChange} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function InviteUserForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<Role>("short_form_editor");
  const [error, setError] = React.useState<string | null>(null);
  const invite = useInviteMember();

  // The link is returned exactly once, so the dialog stops being a form and
  // becomes the only place it exists as soon as delivery did not happen.
  const result = invite.data;
  if (result && !result.emailSent) {
    return (
      <InviteLinkPanel
        email={result.invitation.email}
        roleLabel={result.invitation.roleLabel}
        inviteUrl={result.inviteUrl}
        expiresAt={result.invitation.expiresAt}
        emailConfigured={result.emailConfigured}
        onDone={() => onOpenChange(false)}
      />
    );
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError("Enter the email address to invite.");
      return;
    }

    invite.mutate(
      { email: trimmedEmail, name: name.trim() || undefined, role },
      {
        onSuccess: (data) => {
          // Only the delivered case closes here. The other branch re-renders
          // above with the link, because closing would destroy it.
          if (data.emailSent) {
            toast.success(`Invitation sent to ${data.invitation.email}`, {
              description: `They will join as ${data.invitation.roleLabel}.`,
            });
            onOpenChange(false);
          }
        },
        onError: (e) =>
          setError(e instanceof Error ? e.message : "Could not send that invitation."),
      },
    );
  };

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Invite user</DialogTitle>
        <DialogDescription>
          They choose their own password from the invitation link — you never set
          one for them.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
        <div className="flex flex-col gap-2">
          <Label htmlFor="invite-name">Name</Label>
          <Input
            id="invite-name"
            autoFocus
            value={name}
            maxLength={120}
            placeholder="e.g. Sam Okafor"
            onChange={(event) => setName(event.target.value)}
          />
          <FieldHint>
            Optional — it only labels the invitation until they set their own.
          </FieldHint>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="invite-email">Email</Label>
          <Input
            id="invite-email"
            type="email"
            value={email}
            maxLength={320}
            invalid={Boolean(error)}
            placeholder="name@company.com"
            onChange={(event) => {
              setEmail(event.target.value);
              setError(null);
            }}
          />
          {error ? <FieldHint tone="danger">{error}</FieldHint> : null}
        </div>

        <div className="flex flex-col gap-2">
          <Label>Role</Label>
          <RolePicker name="invite-role" value={role} onChange={setRole} />
          <RoleCapabilities role={role} />
        </div>

        {/* Where the rest of them are set, and where they are NOT. Niches and
            pay belong to an employment that does not exist until somebody
            accepts and an admin approves them, so there is nothing here to
            collect them into. */}
        <FieldHint>
          Their niches and their pay are set on their profile once they have
          accepted and been approved.
        </FieldHint>
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={invite.isPending}
          disabled={!email.trim()}
        >
          Send invitation
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The invitation worked; the email did not go out.
 *
 * This is a supported way to run the product, not a failure: email is optional
 * in Northstar HQ, and the invite URL is in the response body precisely so an
 * admin can pass it on by whatever channel they already use. The wording says
 * that outright, because an admin who reads this as an error will sit waiting
 * for a message that is never coming.
 */
function InviteLinkPanel({
  email,
  roleLabel,
  inviteUrl,
  expiresAt,
  emailConfigured,
  onDone,
}: {
  email: string;
  roleLabel: string;
  inviteUrl: string;
  expiresAt: number;
  emailConfigured: boolean;
  onDone: () => void;
}) {
  return (
    <div>
      <DialogHeader>
        <DialogTitle>Invitation created — send this link</DialogTitle>
        <DialogDescription>
          {emailConfigured
            ? // Configured but undelivered is a different fact from not configured,
              // and only one of them is fixed by looking at the mail provider.
              `${email} was invited as ${roleLabel}, but the email could not be delivered. The invitation itself is valid — send them this link and it will work.`
            : `${email} was invited as ${roleLabel}. Email delivery isn't set up on this deployment, so nothing was sent — that's expected. Copy the link below and send it to them however you normally would.`}
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 rounded-md border border-accent/30 bg-accent-subtle p-3">
          <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-accent">
            <Link2 className="size-3" />
            One-time invitation link
          </span>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              readOnly
              value={inviteUrl}
              aria-label="Invitation link"
              className="font-mono text-[12px]"
              onFocus={(event) => event.currentTarget.select()}
            />
            <CopyButton value={inviteUrl} label="Copy link" />
          </div>
        </div>

        <FieldHint>
          Shown once. It expires on {formatDateTime(expiresAt)} and stops working the
          moment they use it — nobody can see it again from this screen, so copy it
          before closing. Inviting the same address again issues a fresh link and
          retires this one.
        </FieldHint>
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="primary" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </div>
  );
}

/** Copies to the clipboard, and says so plainly when the browser refuses. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      type="button"
      variant={copied ? "secondary" : "primary"}
      size="sm"
      className="shrink-0"
      onClick={async () => {
        try {
          // Absent entirely over plain HTTP and in some embedded browsers, in
          // which case this throws and the field beside it is still selectable.
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          toast.error("Couldn't copy to the clipboard", {
            description:
              "Your browser blocked clipboard access. Select the link in the box and copy it manually.",
          });
        }
      }}
    >
      <Copy />
      {copied ? "Copied" : label}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// DIALOG: revoke invitation
// ---------------------------------------------------------------------------

function RevokeInvitationDialog({
  invitation,
  open,
  onOpenChange,
}: {
  invitation: AdminInvitationDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const revoke = useRevokeInvitation();

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
          <DialogTitle>Revoke this invitation?</DialogTitle>
          <DialogDescription>
            The link sent to {invitation.email} stops working.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          <p className="flex items-start gap-2 text-[12px] leading-relaxed text-muted-foreground">
            <Mail className="mt-0.5 size-3.5 shrink-0 text-subtle-foreground" />
            <span>
              No account exists behind an invitation yet, so there is nothing else to
              undo. You can invite {invitation.email} again at any time, which issues
              a new link.
            </span>
          </p>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            If they have already accepted it, revoking is refused — deactivate the
            account instead.
          </p>

          {error ? <FieldHint tone="danger">{error}</FieldHint> : null}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={revoke.isPending}
            onClick={() =>
              revoke.mutate(invitation.id, {
                onSuccess: () => {
                  toast.success(`Invitation for ${invitation.email} revoked`);
                  onOpenChange(false);
                },
                onError: (e) =>
                  setError(
                    e instanceof Error
                      ? e.message
                      : "Could not revoke that invitation.",
                  ),
              })
            }
          >
            <Trash2 />
            Revoke invitation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
