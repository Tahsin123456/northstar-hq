"use client";

import * as React from "react";
import { Pencil, Plus, StickyNote, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import type { NoteDTO, NoteTargetType } from "@/lib/dto";
import { useCreateNote, useDeleteNote, useNotes, useUpdateNote } from "@/hooks/use-research";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Notes attached to a channel, a niche, or a single Short.
 *
 * Deliberately a plain textarea and a list — not a rich editor. These are
 * working observations ("payoff lands at 6 seconds"), written in seconds
 * between looking at numbers. Anything heavier would sit unused, and the point
 * is to keep the research loop fast.
 */
export function NotesPanel({
  targetType,
  targetId,
  title = "Notes",
  description,
  className,
  compact = false,
}: {
  targetType: NoteTargetType;
  targetId: string;
  title?: string;
  description?: string;
  className?: string;
  compact?: boolean;
}) {
  const { data, isLoading } = useNotes(targetType, targetId);
  const notes = data?.notes ?? [];

  const [draft, setDraft] = React.useState("");
  const create = useCreateNote();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;

    create.mutate(
      { targetType, targetId, body },
      {
        onSuccess: () => {
          setDraft("");
          toast.success("Note added");
        },
        onError: (error) =>
          toast.error("Could not add that note", {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <Card className={cn("flex flex-col", className)}>
      <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
            <StickyNote className="size-3.5 text-subtle-foreground" />
            {title}
            {notes.length > 0 ? (
              <span className="tnum text-[11px] font-normal text-subtle-foreground">
                {notes.length}
              </span>
            ) : null}
          </h3>
          {description ? (
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-2 px-5 pb-4">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="What did you notice?"
          rows={compact ? 2 : 3}
          maxLength={4000}
          onKeyDown={(event) => {
            // Cmd/Ctrl+Enter submits — the expected shortcut for a note field.
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submit(event);
          }}
          className={cn(
            "w-full resize-y rounded-md border border-border bg-surface-sunken px-3 py-2 text-[13px] text-foreground",
            "placeholder:text-subtle-foreground",
            "transition-colors hover:border-border-strong",
            "focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)]",
          )}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-subtle-foreground">
            {draft.trim() ? "⌘/Ctrl + Enter to save" : ""}
          </span>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={create.isPending}
            disabled={!draft.trim()}
          >
            <Plus />
            Add note
          </Button>
        </div>
      </form>

      <div className="border-t border-border">
        {isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : notes.length === 0 ? (
          <p className="px-5 py-4 text-[12px] text-subtle-foreground">
            No notes yet.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {notes.map((note) => (
              <NoteRow key={note.id} note={note} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function NoteRow({ note }: { note: NoteDTO }) {
  const [editing, setEditing] = React.useState(false);
  const update = useUpdateNote();
  const remove = useDeleteNote();

  if (editing) {
    return (
      <li className="px-5 py-3">
        <EditNoteForm
          note={note}
          saving={update.isPending}
          onCancel={() => setEditing(false)}
          onSave={(body) =>
            update.mutate(
              { id: note.id, body },
              {
                onSuccess: () => {
                  setEditing(false);
                  toast.success("Note updated");
                },
                onError: (error) =>
                  toast.error("Could not update that note", {
                    description: error instanceof Error ? error.message : undefined,
                  }),
              },
            )
          }
        />
      </li>
    );
  }

  return (
    <li className="group flex items-start gap-3 px-5 py-3">
      <div className="min-w-0 flex-1">
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
          {note.body}
        </p>
        <p className="mt-1 text-[11px] text-subtle-foreground">
          {formatRelativeTime(note.createdAt)}
          {note.updatedAt !== note.createdAt
            ? ` · edited ${formatRelativeTime(note.updatedAt)}`
            : ""}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Edit note"
          onClick={() => setEditing(true)}
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Delete note"
          loading={remove.isPending}
          onClick={() =>
            remove.mutate(note.id, {
              onSuccess: () => toast.success("Note deleted"),
              onError: (error) =>
                toast.error("Could not delete that note", {
                  description: error instanceof Error ? error.message : undefined,
                }),
            })
          }
          className="text-subtle-foreground hover:text-danger"
        >
          {remove.isPending ? null : <Trash2 />}
        </Button>
      </div>
    </li>
  );
}

function EditNoteForm({
  note,
  saving,
  onSave,
  onCancel,
}: {
  note: NoteDTO;
  saving: boolean;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = React.useState(note.body);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = body.trim();
        if (trimmed) onSave(trimmed);
      }}
      className="flex flex-col gap-2"
    >
      <textarea
        autoFocus
        value={body}
        rows={3}
        maxLength={4000}
        onChange={(event) => setBody(event.target.value)}
        className="w-full resize-y rounded-md border border-border bg-surface-sunken px-3 py-2 text-[13px] text-foreground focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)]"
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" loading={saving} disabled={!body.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}

/**
 * Notes on a single Short, in a dialog.
 *
 * A Short lives inside a scrolling feed, so its notes cannot be an inline
 * panel without wrecking the list. The dialog keeps the discovery flow intact:
 * note it, close, keep scanning.
 */
export function ShortNotesDialog({
  videoId,
  videoTitle,
  open,
  onOpenChange,
}: {
  videoId: string | null;
  videoTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="pr-6">Notes</DialogTitle>
          <DialogDescription className="truncate">{videoTitle}</DialogDescription>
        </DialogHeader>
        <DialogBody className="pt-0">
          {open && videoId ? (
            <NotesPanel
              targetType="video"
              targetId={videoId}
              title="Notes on this Short"
              compact
              className="border-0 bg-transparent"
            />
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export { X };
