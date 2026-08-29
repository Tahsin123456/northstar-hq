"use client";

import * as React from "react";
import { Pencil, Plus, StickyNote, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import {
  UNKNOWN_AUTHOR_LABEL,
  type NoteDTO,
  type NoteTargetType,
  type NoteVisibility,
} from "@/lib/dto";
import { useCreateNote, useDeleteNote, useNotes, useUpdateNote } from "@/hooks/use-research";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  NoteVisibilityToggle,
  VisibilityBadge,
  VisibilityChoice,
} from "@/components/notes/note-visibility";
import { useSession } from "@/components/providers/session-provider";
import { formatDate, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Notes attached to a channel, a niche, or a single Short.
 *
 * Deliberately a plain textarea and a list — not a rich editor. These are
 * working observations ("payoff lands at 6 seconds"), written in seconds
 * between looking at numbers. Anything heavier would sit unused, and the point
 * is to keep the research loop fast.
 *
 * The list now holds two kinds of row: the reader's own, and the ones a
 * colleague shared about this same channel / niche / Short. That is the whole
 * value of sharing — the observation shows up where the thing it is about is
 * being looked at — so the panel has to make three things obvious: whose a note
 * is, that a shared one is shared, and that somebody else's is not yours to
 * edit.
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
  // Private until the writer says otherwise, and reset to private after every
  // save: a sticky "shared" would quietly share the next note, which is the one
  // decision this control must never make on somebody's behalf.
  const [visibility, setVisibility] = React.useState<NoteVisibility>("personal");
  const create = useCreateNote();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;

    create.mutate(
      { targetType, targetId, body, visibility },
      {
        onSuccess: () => {
          setDraft("");
          setVisibility("personal");
          toast.success(visibility === "shared" ? "Note shared" : "Note added");
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
        {/* The choice sits with the draft, not behind a menu on the saved row:
            who can read a note is part of writing it, and a control you find
            afterwards is one people find after the note is already shared. */}
        <VisibilityChoice value={visibility} onChange={setVisibility} />

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

  // EVERY note says who wrote it, the viewer's own included.
  //
  // This list is the viewer's own notes, plus any a colleague shared about this
  // same thing, plus — for an admin — everybody's. It printed a byline only on
  // the rows that were not "mine", which made a missing byline carry meaning by
  // its absence; next to Edit and Delete that is the mistake worth preventing,
  // and on an admin's screen it read as missing data rather than as ownership.
  //
  // The name comes from the stored `createdBy` relation, never the session, so
  // it survives a rename and stays attached after the author leaves.
  // `createdById` is `SetNull`, so a departed author arrives as a null id AND a
  // null name; the fallback says so plainly rather than guessing why.
  const session = useSession();
  const viewerId = session.user.id;
  const isMine = note.createdById === viewerId;
  const byline = note.createdByName ?? UNKNOWN_AUTHOR_LABEL;

  // A shared note is somebody else's writing that you happen to be able to
  // read. The server refuses the edit anyway; showing the pencil would only
  // mean finding that out after typing.
  const canEdit = isMine || session.can("users.manage");

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
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-subtle-foreground">
          {/* Spelled out rather than a bare name: this line sits under a note
              about a channel or a Short, where an unlabelled name is as easily
              read as the subject as the author. */}
          <span className="text-foreground/70">Created by {byline} · </span>
          {/* Absolute, matching the notes log. An edit stays relative: "edited
              2 days ago" is about how stale what you are reading is, which is a
              question about now, where the creation date is about when. */}
          <span title={formatRelativeTime(note.createdAt)}>
            {formatDate(note.createdAt)}
            {note.updatedAt !== note.createdAt
              ? ` · edited ${formatRelativeTime(note.updatedAt)}`
              : ""}
          </span>
          <VisibilityBadge visibility={note.visibility} />
        </p>
      </div>

      {canEdit ? (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <NoteVisibilityToggle note={note} />
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
      ) : null}
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

/*
 * The single-Short dialog used to live here as `ShortNotesDialog`.
 *
 * It is now `ShortDetailDialog` in `components/shorts/short-detail-dialog.tsx`,
 * because it stopped being about notes: a Short opened on its own also shows
 * its niche and lets its content type be changed, and a notes module is the
 * wrong place for a component that composes two taxonomies. It still renders
 * `NotesPanel` — that is the part that belongs here.
 */

export { X };
