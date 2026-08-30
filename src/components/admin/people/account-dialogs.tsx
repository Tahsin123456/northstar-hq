"use client";

import * as React from "react";
import { UserCheck, UserMinus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import { FieldHint, Label } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSetMemberGrants, useUpdateMember } from "@/hooks/use-admin";
import {
  GRANTABLE_PERMISSIONS,
  PERMISSION_LABELS,
  ROLE_DEFINITIONS,
  ROLE_ORDER,
  roleDefinition,
  type Permission,
  type Role,
} from "@/lib/auth/permissions";
import { formatNumber, pluralize } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { AdminUserDTO } from "@/server/services/admin-service";

/**
 * The account half of a person: their role, their extra permissions, and
 * whether they can sign in at all.
 *
 * Lifted out of the old Admin › Users page unchanged when Users and Employees
 * became one People screen. They are here rather than in that page's file for
 * one reason: the merged screen carries the roster's columns as well, and a
 * single file holding both would be two thousand lines in which the thing that
 * matters — that ACCOUNT and EMPLOYMENT are governed by different permissions —
 * is easy to lose. Every one of these writes goes through `users.manage`
 * server-side; none of them can see or touch pay.
 */

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
export function RolePicker({
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
export function RoleCapabilities({ role }: { role: Role }) {
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

/** A grant may outlive the catalogue it came from, so fall back to the raw key. */
export function labelForGrant(grant: string): string {
  return PERMISSION_LABELS[grant as Permission] ?? grant;
}

// ---------------------------------------------------------------------------
// DIALOG: change role
// ---------------------------------------------------------------------------

export function ChangeRoleDialog({
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

export function ExtraPermissionsDialog({
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

                It says more now than it did, because the tick does more than it
                did: payroll moved into Finance, so this one checkbox is what
                puts the whole section in somebody's sidebar.
              */}
              {permission === "payroll.view" &&
              !roleCovers &&
              selected.has(permission) ? (
                <FieldHint tone="danger" className="pb-1 pl-9">
                  This shows {label} every colleague&rsquo;s salary, hit payment
                  and monthly total — not only their own. It also puts Finance ›
                  Payroll in their sidebar; it does not give them the rest of
                  Finance.
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

export function MemberStatusDialog({
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
              : "Their account, notes and history are kept — this is not a deletion, and it can be undone from this same menu. Their niche assignments and pay are untouched."}
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
