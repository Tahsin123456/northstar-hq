"use client";

import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDate, formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * An account's status, as a dot and a word.
 *
 * Shared by Admin › People, the person's own profile and the approvals queue,
 * because they describe the same accounts from different angles and the one
 * thing they must not do is disagree about what state somebody is in. A second
 * copy of this mapping is how "Pending approval" ends up rendered as the raw
 * enum on one screen a month after it was added to the other.
 *
 * `status` is typed as a plain string rather than a union on purpose: it comes
 * off the wire, and a value this component has never heard of is shown verbatim
 * instead of being mapped to a friendlier word. Guessing what an unrecognised
 * status meant would be inventing a fact about somebody's access.
 */
export function StatusPill({
  status,
  deactivatedAt = null,
  now = 0,
}: {
  status: string;
  /** Omit where the payload does not carry it; only the tooltip depends on it. */
  deactivatedAt?: number | null;
  /** `useNow()`, or 0 — see the note below on why the tooltip falls back to a date. */
  now?: number;
}) {
  const deactivated = status === "deactivated" || deactivatedAt !== null;

  const tone = deactivated
    ? { dot: "bg-border-strong", text: "text-subtle-foreground", label: "Deactivated" }
    : status === "active"
      ? { dot: "bg-success", text: "text-muted-foreground", label: "Active" }
      : status === "invited"
        ? { dot: "bg-warning", text: "text-muted-foreground", label: "Invited" }
        : // Accepted their invitation, set a password, and is waiting for an
          // admin to let them in. Distinct from "Invited" because the ball is
          // now in the administrator's court rather than theirs.
          status === "pending_approval"
          ? { dot: "bg-warning", text: "text-foreground", label: "Pending approval" }
          : { dot: "bg-border-strong", text: "text-muted-foreground", label: status };

  const pill = (
    <span className={cn("inline-flex items-center gap-1.5", tone.text)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
      {tone.label}
    </span>
  );

  if (!deactivated || deactivatedAt === null) return pill;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default">{pill}</span>
      </TooltipTrigger>
      <TooltipContent>
        {/* `now` is 0 during SSR and the first hydration pass, and a relative
            label computed against the epoch would read "just now" for something
            that happened last month. The absolute date stands in until the real
            clock arrives. */}
        Deactivated{" "}
        {now === 0 ? formatDate(deactivatedAt) : formatRelativeTime(deactivatedAt, now)}
        {" — "}
        {formatDateTime(deactivatedAt)}.
      </TooltipContent>
    </Tooltip>
  );
}
