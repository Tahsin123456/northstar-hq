"use client";

import * as React from "react";
import { Lock, Users } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useUpdateNote } from "@/hooks/use-research";
import type { NoteDTO, NoteVisibility } from "@/lib/dto";
import { cn } from "@/lib/utils";

/**
 * Who a note is for, on screen.
 *
 * One file for the badge, the toggle and the words they use, because the same
 * three appear in the research log, in the panel on a channel page and in the
 * composer — and "shared" meaning something slightly different in one of them
 * is exactly the confusion that gets somebody's candid note read by the team.
 *
 * WHAT "SHARED" IS PROMISED TO MEAN HERE
 * Not "everyone in the workspace". A shared note reaches the colleagues who can
 * already see what it is about — the people who hold that niche — which is what
 * the copy below says in as few words as it can. The rule itself is enforced in
 * `noteScope()` on the server; this is the part the writer reads before
 * deciding, so it must not overstate or understate what they are about to do.
 */

export const VISIBILITY_LABEL: Record<NoteVisibility, string> = {
  personal: "Private",
  shared: "Shared",
};

/**
 * The sentence under the choice. Deliberately concrete about the limit — a
 * writer who believes "shared" means the whole company will either overshare or
 * never share, and both are the same misunderstanding.
 */
export const VISIBILITY_HINT: Record<NoteVisibility, string> = {
  personal: "Only you — and an admin — can read this.",
  shared: "Colleagues who can already see what this note is about can read it.",
};

export const VISIBILITY_ICON: Record<
  NoteVisibility,
  React.ComponentType<{ className?: string }>
> = {
  personal: Lock,
  shared: Users,
};

/**
 * Marks a shared note. Renders nothing for a personal one.
 *
 * Personal is the default and the quiet case: badging every row "Private" would
 * put a chip on almost every note in the log and train people to stop reading
 * chips — which is the one thing this badge cannot afford, because the row it
 * does mark is the row somebody else can read.
 */
export function VisibilityBadge({
  visibility,
  className,
}: {
  visibility: NoteVisibility;
  className?: string;
}) {
  if (visibility !== "shared") return null;

  const Icon = VISIBILITY_ICON.shared;
  return (
    <Badge variant="accent" size="md" className={cn("shrink-0 gap-1.5", className)}>
      <Icon className="size-3" />
      {VISIBILITY_LABEL.shared}
    </Badge>
  );
}

/**
 * Flips a note between personal and shared.
 *
 * Renders only where the caller has already established that this reader is the
 * author or an admin. The server enforces the same rule — a colleague reading a
 * shared note gets a 404 from the PATCH, not a re-share — so this is an
 * affordance, not the boundary.
 */
export function NoteVisibilityToggle({
  note,
}: {
  note: Pick<NoteDTO, "id" | "visibility">;
}) {
  const update = useUpdateNote();
  const next: NoteVisibility = note.visibility === "shared" ? "personal" : "shared";
  const Icon = VISIBILITY_ICON[note.visibility];

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      // The label says what the click DOES, not what the note currently is: a
      // control announced as "Shared" reads as a state, and a reader using a
      // screen reader cannot tell whether pressing it shares or un-shares.
      aria-label={next === "shared" ? "Share with the team" : "Make private"}
      title={
        note.visibility === "shared"
          ? `Shared — ${VISIBILITY_HINT.shared} Click to make it private again.`
          : `Private — ${VISIBILITY_HINT.personal} Click to share it.`
      }
      loading={update.isPending}
      onClick={() =>
        update.mutate(
          { id: note.id, visibility: next },
          {
            onSuccess: () =>
              toast.success(next === "shared" ? "Note shared" : "Note made private"),
            onError: (error) =>
              toast.error("Could not change who can see that note", {
                description: error instanceof Error ? error.message : undefined,
              }),
          },
        )
      }
      className={cn(note.visibility === "shared" && "text-accent")}
    >
      {update.isPending ? null : <Icon />}
    </Button>
  );
}

/**
 * The choice, as a pair of buttons, for a note that does not exist yet.
 *
 * A segmented control rather than a checkbox because "private" is a real
 * selected state and not merely the absence of sharing — the writer should see
 * which one they are on before they type something they would rather nobody
 * read.
 */
export function VisibilityChoice({
  value,
  onChange,
  className,
}: {
  value: NoteVisibility;
  onChange: (value: NoteVisibility) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex flex-wrap gap-1.5">
        {(["personal", "shared"] as const).map((option) => {
          const Icon = VISIBILITY_ICON[option];
          const selected = value === option;
          return (
            <button
              key={option}
              type="button"
              onClick={() => onChange(option)}
              aria-pressed={selected}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors duration-150",
                selected
                  ? "border-accent bg-accent-subtle text-foreground"
                  : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
              )}
            >
              <Icon className="size-3" />
              {VISIBILITY_LABEL[option]}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] leading-relaxed text-subtle-foreground">
        {VISIBILITY_HINT[value]}
      </p>
    </div>
  );
}
