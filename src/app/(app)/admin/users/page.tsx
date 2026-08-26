"use client";

import * as React from "react";
import {
  Copy,
  Link2,
  Mail,
  MailPlus,
  MoreHorizontal,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  UserCheck,
  UserCog,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/error-state";
// Shared with Admin › Employees, which lists the same accounts: one vocabulary
// for what a status means, in one file.
import { StatusPill } from "@/components/admin/status-pill";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSession } from "@/components/providers/session-provider";
import {
  useAdminUsers,
  useInviteMember,
  useRevokeInvitation,
  useSetMemberGrants,
  useUpdateMember,
} from "@/hooks/use-admin";
import { useNow } from "@/hooks/use-now";
import {
  GRANTABLE_PERMISSIONS,
  PERMISSION_LABELS,
  ROLE_DEFINITIONS,
  ROLE_ORDER,
  roleDefinition,
  type Permission,
  type Role,
} from "@/lib/auth/permissions";
import {
  EM_DASH,
  formatDate,
  formatDateTime,
  formatNumber,
  formatRelativeTime,
  pluralize,
} from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Wire shapes imported from the service that produces them.
 *
 * `import type` is erased before bundling, so naming a `server-only` module
 * here adds no server code to the browser — the same precedent `api-client.ts`
 * and `session-provider.tsx` already set. The point is that a field change on
 * `AdminUserDTO` breaks this screen's build rather than quietly rendering a
 * blank cell.
 */
import type {
  AdminInvitationDTO,
  AdminUserDTO,
} from "@/server/services/admin-service";

/**
 * Admin › Users — who can reach the team's data, and what they can do with it.
 *
 * Two lists, deliberately kept apart. A member has an account: sessions to
 * revoke, a role to change, permissions to widen. An invitation has none of
 * those — there is nothing behind it yet — so flattening the two would put
 * controls on rows that cannot answer them. The API returns them separately for
 * the same reason.
 *
 * NOTHING SECRET IS RENDERED HERE. `AdminUserDTO` carries no password hash, no
 * token and no OAuth credential, because `ADMIN_USER_COLUMNS` in
 * admin-service.ts never selects them. If a column ever appears on this screen
 * that looks like a secret, the bug is upstream and this file is the symptom.
 */
export default function AdminUsersPage() {
  const session = useSession();

  // An affordance, not a boundary: every /api/admin route re-checks
  // `users.manage` server-side. Rendering this instead of the table only avoids
  // walking someone into a screen whose every query would 403.
  if (!session.can("users.manage")) {
    return (
      <PageContainer className="flex flex-col gap-5">
        <PageHeader title="Users" description="Team access for this organization." />
        <Card>
          <EmptyState
            icon={<ShieldAlert />}
            title="You don't have access to user administration"
            description={
              <>
                Managing people, roles and invitations needs the{" "}
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

  return <UsersScreen organizationName={session.user.organizationName} />;
}

function UsersScreen({ organizationName }: { organizationName: string }) {
  const { data, isLoading, error, refetch } = useAdminUsers();
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const now = useNow();

  const users = data?.users ?? [];
  const invitations = data?.invitations ?? [];

  return (
    <PageContainer className="flex flex-col gap-6">
      <PageHeader
        title="Users"
        description={`Everyone with an account in ${organizationName}, what they can reach, and the invitations still outstanding.`}
        actions={
          <Button variant="primary" size="sm" onClick={() => setInviteOpen(true)}>
            <UserPlus />
            Invite user
          </Button>
        }
      />

      {error ? (
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-[13px] font-medium text-foreground">Members</h2>
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                A role sets the floor of what someone can reach; extra permissions
                widen it. Both are changed from the row menu.
              </p>
            </div>
            <MembersTable users={users} loading={isLoading} now={now} />
          </section>

          <section className="flex flex-col gap-3">
            <div>
              <h2 className="text-[13px] font-medium text-foreground">
                Pending invitations
              </h2>
              <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
                Invitations nobody has accepted yet. An expired link cannot be used —
                invite the person again to issue a fresh one.
              </p>
            </div>
            <InvitationsTable
              invitations={invitations}
              loading={isLoading}
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

// ---------------------------------------------------------------------------
// MEMBERS
// ---------------------------------------------------------------------------

const HEAD_CELL =
  "px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground";
const CELL = "px-4 py-2.5 text-[13px]";

function MembersTable({
  users,
  loading,
  now,
}: {
  users: readonly AdminUserDTO[];
  loading: boolean;
  now: number;
}) {
  if (!loading && users.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Users />}
          title="No members yet"
          description="Nobody has an account in this organization. Invite someone to get started."
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[920px] border-collapse text-left">
          <thead>
            <tr className="border-b border-border bg-surface-sunken">
              <th className={HEAD_CELL}>Name</th>
              <th className={HEAD_CELL}>Email</th>
              <th className={HEAD_CELL}>Role</th>
              <th className={HEAD_CELL}>Status</th>
              <th className={HEAD_CELL}>Last login</th>
              <th className={cn(HEAD_CELL, "text-right")}>Sessions</th>
              <th className={cn(HEAD_CELL, "w-10")}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 4 }, (_, i) => <MemberRowSkeleton key={i} />)
              : users.map((user) => (
                  <MemberRow key={user.id} user={user} now={now} />
                ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function MemberRowSkeleton() {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className={CELL}>
        <Skeleton className="h-3 w-28" />
      </td>
      <td className={CELL}>
        <Skeleton className="h-3 w-40" />
      </td>
      <td className={CELL}>
        <Skeleton className="h-4 w-20 rounded" />
      </td>
      <td className={CELL}>
        <Skeleton className="h-3 w-16" />
      </td>
      <td className={CELL}>
        <Skeleton className="h-3 w-20" />
      </td>
      <td className={cn(CELL, "text-right")}>
        <Skeleton className="ml-auto h-3 w-6" />
      </td>
      <td className={CELL} />
    </tr>
  );
}

function MemberRow({ user, now }: { user: AdminUserDTO; now: number }) {
  const [roleOpen, setRoleOpen] = React.useState(false);
  const [permissionsOpen, setPermissionsOpen] = React.useState(false);
  const [statusOpen, setStatusOpen] = React.useState(false);

  // `status` is the DTO's word, but `deactivatedAt` is what actually ends
  // access — the DAL re-reads it on every request. Trusting either alone would
  // let a half-applied state show the wrong action in the menu.
  const isDeactivated = user.status === "deactivated" || user.deactivatedAt !== null;
  const definition = roleDefinition(user.role);
  const extraGrants = user.grants.filter(
    (grant) => !(definition.permissions as readonly string[]).includes(grant),
  );

  const selfReason =
    "This is your own account. The API refuses self-edits so an admin cannot lock themselves out — ask another admin to make this change.";

  return (
    <>
      <tr className="border-b border-border transition-colors last:border-b-0 hover:bg-surface-hover/40">
        <td className={cn(CELL, "text-foreground")}>
          <span className="flex items-center gap-2">
            <span className="truncate">{user.name ?? EM_DASH}</span>
            {user.isSelf ? (
              <Badge variant="outline" size="sm" className="normal-case tracking-normal">
                You
              </Badge>
            ) : null}
          </span>
        </td>

        <td className={cn(CELL, "text-muted-foreground")}>{user.email ?? EM_DASH}</td>

        <td className={CELL}>
          <span className="flex items-center gap-1.5">
            <Badge
              variant={user.role === "admin" ? "accent" : "outline"}
              size="sm"
              className="normal-case tracking-normal"
            >
              {user.roleLabel}
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
          <StatusPill status={user.status} deactivatedAt={user.deactivatedAt} now={now} />
        </td>

        <td className={cn(CELL, "text-muted-foreground")}>
          <LastLogin at={user.lastLoginAt} now={now} />
        </td>

        <td className={cn(CELL, "tnum text-right text-muted-foreground")}>
          {formatNumber(user.activeSessions)}
        </td>

        <td className={cn(CELL, "text-right")}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions for ${user.name ?? user.email ?? "this member"}`}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <GuardedMenuItem
                disabled={user.isSelf}
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

              <DropdownMenuSeparator />

              <GuardedMenuItem
                disabled={user.isSelf}
                reason={selfReason}
                tone={isDeactivated ? "default" : "danger"}
                onSelect={() => setStatusOpen(true)}
              >
                {isDeactivated ? <UserCheck /> : <UserMinus />}
                {isDeactivated ? "Reactivate" : "Deactivate"}
              </GuardedMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </td>
      </tr>

      <ChangeRoleDialog user={user} open={roleOpen} onOpenChange={setRoleOpen} />
      <ExtraPermissionsDialog
        user={user}
        open={permissionsOpen}
        onOpenChange={setPermissionsOpen}
      />
      <MemberStatusDialog
        user={user}
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

/** A grant may outlive the catalogue it came from, so fall back to the raw key. */
function labelForGrant(grant: string): string {
  return PERMISSION_LABELS[grant as Permission] ?? grant;
}

// ---------------------------------------------------------------------------
// INVITATIONS
// ---------------------------------------------------------------------------

function InvitationsTable({
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
// SHARED PIECES
// ---------------------------------------------------------------------------

/**
 * Role chooser.
 *
 * Options and their descriptions come straight from ROLE_DEFINITIONS, and the
 * capability list below from the same definition crossed with
 * PERMISSION_LABELS. Nothing about a role is restated here, so adding a role or
 * moving a permission between roles updates this picker with no edit to this
 * file — and there is no second list to fall out of step with what the server
 * actually enforces.
 */
function RolePicker({
  value,
  onChange,
  name,
}: {
  value: Role;
  onChange: (role: Role) => void;
  name: string;
}) {
  return (
    <div className="flex flex-col gap-2" role="radiogroup" aria-label="Role">
      {ROLE_ORDER.map((id) => {
        const definition = ROLE_DEFINITIONS[id];
        const selected = value === id;
        return (
          <label
            key={id}
            className={cn(
              "flex cursor-pointer gap-2.5 rounded-md border p-3 transition-colors duration-150",
              selected
                ? "border-accent bg-accent-subtle"
                : "border-border hover:border-border-strong",
            )}
          >
            <input
              type="radio"
              name={name}
              value={id}
              checked={selected}
              onChange={() => onChange(id)}
              className="mt-0.5 size-3.5 shrink-0 accent-[var(--accent)]"
            />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-foreground">
                {definition.label}
              </span>
              <span className="mt-0.5 block text-[12px] leading-relaxed text-muted-foreground">
                {definition.description}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** What the selected role can actually do, straight from the permission table. */
function RoleCapabilities({ role }: { role: Role }) {
  const definition = ROLE_DEFINITIONS[role];
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-sunken p-3">
      <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
        What {definition.label} can do
      </span>
      <div className="flex flex-wrap gap-1.5">
        {definition.permissions.map((permission) => (
          <Badge
            key={permission}
            variant="outline"
            size="sm"
            className="normal-case tracking-normal"
          >
            {PERMISSION_LABELS[permission]}
          </Badge>
        ))}
      </div>
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
// DIALOG: invite
// ---------------------------------------------------------------------------

function InviteUserDialog({
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

// ---------------------------------------------------------------------------
// DIALOG: change role
// ---------------------------------------------------------------------------

function ChangeRoleDialog({
  user,
  open,
  onOpenChange,
}: {
  user: AdminUserDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {open ? <ChangeRoleForm user={user} onOpenChange={onOpenChange} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ChangeRoleForm({
  user,
  onOpenChange,
}: {
  user: AdminUserDTO;
  onOpenChange: (open: boolean) => void;
}) {
  // `roleDefinition` falls back to the least-privileged role for a value the
  // catalogue no longer knows, so the picker always opens on something real.
  const current = roleDefinition(user.role).id;
  const [role, setRole] = React.useState<Role>(current);
  const [error, setError] = React.useState<string | null>(null);
  const update = useUpdateMember();

  const label = user.name ?? user.email ?? "this member";
  const hasGrants = user.grants.length > 0;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (role === current) return;
        update.mutate(
          { id: user.id, role },
          {
            onSuccess: (data) => {
              toast.success(`${label} is now ${data.user.roleLabel}`);
              onOpenChange(false);
            },
            // Rendered in the dialog rather than as a toast: the server's two
            // refusals here — self-edit and last-active-admin — are sentences
            // the admin has to read before choosing differently, and a toast
            // that fades takes the explanation with it.
            onError: (e) =>
              setError(e instanceof Error ? e.message : "Could not change that role."),
          },
        );
      }}
    >
      <DialogHeader>
        <DialogTitle>Change role</DialogTitle>
        <DialogDescription>
          {label} is currently {roleDefinition(user.role).label}. A role is the floor
          of what someone can reach.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
        <RolePicker name={`role-${user.id}`} value={role} onChange={setRole} />
        <RoleCapabilities role={role} />

        {hasGrants ? (
          <FieldHint>
            Their individually granted permissions are kept through a role change —
            review them under Extra permissions if the new role should not carry
            them.
          </FieldHint>
        ) : null}

        {error ? <FieldHint tone="danger">{error}</FieldHint> : null}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={update.isPending}
          disabled={role === current}
        >
          {role === current ? "No change" : `Make ${ROLE_DEFINITIONS[role].label}`}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------
// DIALOG: extra permissions
// ---------------------------------------------------------------------------

function ExtraPermissionsDialog({
  user,
  open,
  onOpenChange,
}: {
  user: AdminUserDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {open ? <ExtraPermissionsForm user={user} onOpenChange={onOpenChange} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Individual grants — how a Channel Director is given Finance access without
 * inventing a role for them.
 *
 * Grants are additive only: the role's own permissions are shown ticked and
 * disabled, because unticking one here could not take it away. The request is a
 * PUT of the whole set, matching the checklist the admin is looking at, so two
 * half-applied writes cannot leave a tick behind.
 */
function ExtraPermissionsForm({
  user,
  onOpenChange,
}: {
  user: AdminUserDTO;
  onOpenChange: (open: boolean) => void;
}) {
  const definition = roleDefinition(user.role);
  const fromRole = React.useMemo(
    () => new Set<string>(definition.permissions),
    [definition],
  );
  const held = React.useMemo(() => new Set<string>(user.grants), [user.grants]);

  // Only the ticks the admin can actually move. Anything the role supplies is
  // out of scope for this state — see the note on submit.
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    () => new Set(user.grants.filter((grant) => !fromRole.has(grant))),
  );
  const [error, setError] = React.useState<string | null>(null);
  const save = useSetMemberGrants();

  const label = user.name ?? user.email ?? "this member";
  const editable = GRANTABLE_PERMISSIONS.filter(
    (permission) => !fromRole.has(permission),
  );

  /*
   * Grants this checklist cannot represent — a permission dropped from the
   * catalogue since it was given, or `users.manage`, which is not grantable at
   * all. They have no checkbox and cannot be sent back in a PUT (the service
   * rejects anything outside GRANTABLE_PERMISSIONS), so saving necessarily
   * clears them. Named rather than removed quietly: the service documents the
   * replace as the only thing that ever cleans these up, which makes this
   * dialog the one place an admin can act on them.
   */
  const strandedGrants = user.grants.filter(
    (grant) => !(GRANTABLE_PERMISSIONS as readonly string[]).includes(grant),
  );

  const changed =
    editable.some((permission) => selected.has(permission) !== held.has(permission)) ||
    strandedGrants.length > 0;

  const toggle = (permission: Permission, checked: boolean) => {
    setError(null);
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(permission);
      else next.delete(permission);
      return next;
    });
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();

    /*
     * The payload is what the admin ticked, PLUS any standing grant the role
     * already covers.
     *
     * Those checkboxes are disabled — the admin cannot express an intention
     * about them — so dropping them from a PUT would silently revoke something
     * invisible on this screen. It matters later rather than now: a grant that
     * duplicates the role does nothing today, but it survives a demotion, and
     * an admin who moves someone from Head of Shorts to Channel Director should
     * not find that a permission quietly disappeared because somebody opened
     * this dialog last month and pressed Save.
     *
     * Grants outside GRANTABLE_PERMISSIONS are deliberately NOT preserved: the
     * service documents the replace as the only thing that ever cleans up a key
     * dropped from the catalogue, and reinstating one here would defeat that.
     */
    const preserved = user.grants.filter(
      (grant) =>
        fromRole.has(grant) &&
        (GRANTABLE_PERMISSIONS as readonly string[]).includes(grant),
    );
    const permissions = [...new Set([...selected, ...preserved])];

    save.mutate(
      { id: user.id, permissions },
      {
        onSuccess: (result) => {
          const added = result.added.length;
          const removed = result.removed.length;
          const parts: string[] = [];
          if (added > 0) parts.push(`${added} granted`);
          if (removed > 0) parts.push(`${removed} revoked`);
          toast.success(`Permissions updated for ${label}`, {
            // The server reports what it actually changed, which is not always
            // what the form thought it was sending — report its answer.
            description: parts.length === 0 ? "Nothing changed." : `${parts.join(", ")}.`,
          });
          onOpenChange(false);
        },
        onError: (e) =>
          setError(
            e instanceof Error ? e.message : "Could not save those permissions.",
          ),
      },
    );
  };

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Extra permissions</DialogTitle>
        <DialogDescription>
          {label} is {definition.label}. Everything that role carries is ticked and
          fixed below; tick anything else to widen their access on top of it.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex max-h-[55vh] flex-col gap-1 overflow-y-auto">
        {GRANTABLE_PERMISSIONS.map((permission) => {
          const roleCovers = fromRole.has(permission);
          const alsoGranted = roleCovers && held.has(permission);
          const checked = roleCovers || selected.has(permission);
          const id = `grant-${user.id}-${permission}`;

          return (
            <React.Fragment key={permission}>
              <div
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2 py-2 transition-colors",
                  roleCovers ? "opacity-70" : "hover:bg-surface-hover",
                )}
              >
                <Checkbox
                  id={id}
                  checked={checked}
                  disabled={roleCovers}
                  onCheckedChange={(state) => toggle(permission, state === true)}
                />
                <Label htmlFor={id} className="flex-1 cursor-pointer">
                  {PERMISSION_LABELS[permission]}
                </Label>

                {roleCovers ? (
                  alsoGranted ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          variant="neutral"
                          size="sm"
                          className="cursor-default normal-case tracking-normal"
                        >
                          From role + grant
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent>
                        The {definition.label} role already includes this, and{" "}
                        {label} also holds it as an individual grant. Saving
                        keeps that grant, so it would still apply if their role
                        changed.
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <Badge
                      variant="outline"
                      size="sm"
                      className="normal-case tracking-normal"
                    >
                      From role
                    </Badge>
                  )
                ) : selected.has(permission) ? (
                  <Badge
                    variant="accent"
                    size="sm"
                    className="normal-case tracking-normal"
                  >
                    Granted
                  </Badge>
                ) : null}
              </div>

              {/*
                Payroll is the one tick on this list whose blast radius is other
                people. Every other permission widens what somebody can do with
                the organization's own data; this one hands them the whole
                team's salaries, and the label — "View payroll & salaries" —
                reads like the name of a page rather than like that. It is
                grantable on purpose, so the answer is not to hide it: it is to
                say the consequence out loud at the moment the box is ticked,
                where an admin is still deciding, rather than in a permanent
                line under the list that everyone would stop seeing.
              */}
              {permission === "payroll.view" &&
              !roleCovers &&
              selected.has(permission) ? (
                <FieldHint tone="danger" className="pb-1 pl-9">
                  This shows {label} every colleague&rsquo;s salary, hit payment
                  and monthly total — not only their own.
                </FieldHint>
              ) : null}
            </React.Fragment>
          );
        })}

        <FieldHint className="mt-2">
          {PERMISSION_LABELS["users.manage"]} is not on this list. It is the one
          capability that lets a person create administrators, so it arrives only
          with the Admin role — as a visible decision rather than a checkbox.
        </FieldHint>

        {strandedGrants.length > 0 ? (
          <FieldHint tone="danger">
            {label} holds{" "}
            {strandedGrants.map((grant) => `“${labelForGrant(grant)}”`).join(", ")},
            which cannot be granted individually and so has no checkbox above.
            Saving will remove{" "}
            {strandedGrants.length === 1 ? "it" : "them"}.
          </FieldHint>
        ) : null}

        {error ? <FieldHint tone="danger">{error}</FieldHint> : null}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={save.isPending}
          disabled={!changed}
        >
          {changed ? "Save permissions" : "No change"}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------
// DIALOG: deactivate / reactivate
// ---------------------------------------------------------------------------

function MemberStatusDialog({
  user,
  deactivated,
  open,
  onOpenChange,
}: {
  user: AdminUserDTO;
  deactivated: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const update = useUpdateMember();

  const label = user.name ?? user.email ?? "this member";
  const sessions = user.activeSessions;

  const commit = () => {
    update.mutate(
      { id: user.id, status: deactivated ? "active" : "deactivated" },
      {
        onSuccess: () => {
          toast.success(
            deactivated ? `${label} reactivated` : `${label} deactivated`,
            {
              description: deactivated
                ? "They can sign in again from now on."
                : sessions > 0
                  ? `Signed out of ${formatNumber(sessions)} active ${pluralize(sessions, "session")}.`
                  : "They had no active sessions to sign out.",
            },
          );
          onOpenChange(false);
        },
        onError: (e) =>
          setError(
            e instanceof Error
              ? e.message
              : deactivated
                ? "Could not reactivate that account."
                : "Could not deactivate that account.",
          ),
      },
    );
  };

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
          <DialogTitle>
            {deactivated ? `Reactivate ${label}?` : `Deactivate ${label}?`}
          </DialogTitle>
          <DialogDescription>
            {deactivated
              ? "This restores their access with the role and permissions they had."
              : "This takes effect immediately."}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {deactivated ? (
              <>
                {label} will be able to sign in again. Their previous sessions are
                not restored — revoking a session is one-way, so they sign in fresh.
                Any failed-login lockout is cleared at the same time.
              </>
            ) : (
              <>
                {label} is signed out immediately and every one of their sessions is
                revoked
                {sessions > 0
                  ? ` — ${formatNumber(sessions)} ${pluralize(sessions, "session")} active right now`
                  : ""}
                . Anything open in their browser stops working on the next request;
                they cannot sign back in until someone reactivates them.
              </>
            )}
          </p>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {deactivated
              ? "Nothing about their history changes."
              : "Their account, notes and history are kept — this is not a deletion, and it can be undone from this same menu."}
          </p>

          {error ? <FieldHint tone="danger">{error}</FieldHint> : null}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={deactivated ? "primary" : "danger"}
            loading={update.isPending}
            onClick={commit}
          >
            {deactivated ? (
              <>
                <UserCheck />
                Reactivate
              </>
            ) : (
              <>
                <UserMinus />
                Deactivate and sign out
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
