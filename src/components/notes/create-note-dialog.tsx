"use client";

import * as React from "react";
import { Check, Layers, Minus, Plus, Search, Tv2, Video, X } from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { nicheColor } from "@/components/niches/niche-chip";
import { VisibilityChoice } from "@/components/notes/note-visibility";
import { useDataset } from "@/hooks/use-dataset";
import { useCreateNote, type CreateNotePayload } from "@/hooks/use-research";
import type {
  DatasetChannelDTO,
  DatasetDTO,
  NicheDTO,
  NoteKind,
  NoteTargetType,
  NoteVisibility,
} from "@/lib/dto";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Write a note from the Notes page itself.
 *
 * Until this existed, every note in the log had to be started somewhere else —
 * a channel page, a card in Winners or Outliers — so the one screen dedicated
 * to notes was the only screen that could not make one. Worse, a thought that
 * was not *about* anything in particular had nowhere to go at all, and the way
 * people work around that is to file it against whatever they happen to have
 * open, which puts a wrong answer in the log's context column.
 *
 * THE SHAPE OF THE FORM IS THE ARGUMENT.
 * The body is the note. It is the first field, it is focused on open, and it
 * is the only thing needed to submit. Attaching it to a channel, a niche or a
 * Short is genuinely secondary — most notes are written in a few seconds, and
 * a picker sitting open above the textarea turns "type and save" into "answer
 * a question you did not have, then type". So the association is collapsed
 * behind one line of text, and opening it is a deliberate act.
 */
export function CreateNoteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {/* Mounted only while open, so every draft starts empty without an
            effect resetting state on the way in. Same pattern as the other
            dialogs in the app. */}
        {open ? <CreateNoteForm onOpenChange={onOpenChange} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/** What the note will be filed against — "general" until told otherwise. */
type Association =
  | { kind: "general" }
  | { kind: NoteTargetType; id: string };

const KIND_LABEL: Record<NoteKind, string> = {
  general: "Nothing",
  channel: "Channel",
  niche: "Niche",
  video: "Short",
};

const KIND_ICON: Record<NoteKind, React.ComponentType<{ className?: string }>> = {
  general: Minus,
  channel: Tv2,
  niche: Layers,
  video: Video,
};

function CreateNoteForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { data: dataset } = useDataset();
  const create = useCreateNote();

  const [body, setBody] = React.useState("");
  const [showAssociation, setShowAssociation] = React.useState(false);
  const [association, setAssociation] = React.useState<Association>({ kind: "general" });
  // Private unless the writer chooses otherwise. The form is remounted per
  // open, so this genuinely starts fresh every time — there is no previous
  // answer waiting to share the next note.
  const [visibility, setVisibility] = React.useState<NoteVisibility>("personal");

  const channels = React.useMemo(() => dataset?.channels ?? [], [dataset]);
  const niches = React.useMemo(() => dataset?.niches ?? [], [dataset]);

  // A kind chosen with nothing picked yet. The submit button is disabled on it,
  // but Cmd+Enter does not consult a button — and the request it would send is
  // one the server has to reject, so the check belongs on the path, not on the
  // control.
  const incomplete = association.kind !== "general" && !association.id;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || incomplete) return;

    // The payload is a union, not an object with an optional id, so "general"
    // cannot accidentally travel with a stale target from a picker the writer
    // opened and then backed out of.
    const payload: CreateNotePayload =
      association.kind === "general"
        ? { targetType: "general", body: trimmed, visibility }
        : {
            targetType: association.kind,
            targetId: association.id,
            body: trimmed,
            visibility,
          };

    create.mutate(payload, {
      onSuccess: () => {
        toast.success(visibility === "shared" ? "Note shared" : "Note added");
        onOpenChange(false);
      },
      onError: (error) =>
        toast.error("Could not add that note", {
          description: error instanceof Error ? error.message : undefined,
        }),
    });
  };

  // Memoised on the association, not recomputed per render: resolving a Short's
  // title means scanning the dataset's videos, and this component re-renders on
  // every character typed into the body.
  const summary = React.useMemo(
    () => describeAssociation(association, dataset),
    [association, dataset],
  );

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>New note</DialogTitle>
        <DialogDescription>
          Anything worth remembering. Attaching it to a channel, niche or Short is optional.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        <textarea
          autoFocus
          value={body}
          rows={5}
          maxLength={4000}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            // The same shortcut the inline panels use, so the reflex carries.
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submit(event);
          }}
          placeholder="What did you notice?"
          className={cn(
            "w-full resize-y rounded-md border border-border bg-surface-sunken px-3 py-2 text-[13px] leading-relaxed text-foreground",
            "placeholder:text-subtle-foreground",
            "transition-colors hover:border-border-strong",
            "focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)]",
          )}
        />

        {/* Above the association picker, not below it: who may read this is a
            decision about the note itself, and it applies just as much to a
            general note — which the picker, being about *attachment*, has
            nothing to say for. A shared general note is the one note that
            reaches the whole workspace, so the hint under this control is
            where a writer finds that out. */}
        <VisibilityChoice value={visibility} onChange={setVisibility} />

        <div className="rounded-lg border border-border bg-surface-sunken/40">
          {/* The disclosure and the clear control are siblings, not nested. A
              button inside a button is invalid HTML and reaches the
              accessibility tree as one confused control however carefully the
              inner one stops propagation. */}
          <div className="flex items-center gap-1 pr-2">
            <button
              type="button"
              onClick={() => setShowAssociation((shown) => !shown)}
              aria-expanded={showAssociation}
              className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left"
            >
              <Plus
                className={cn(
                  "size-3.5 shrink-0 text-subtle-foreground transition-transform duration-150",
                  showAssociation && "rotate-45",
                )}
              />
              <span className="shrink-0 text-[12px] font-medium text-foreground">
                Attach to
              </span>
              <span className="min-w-0 truncate text-[12px] text-muted-foreground">
                {summary}
              </span>
            </button>
            {association.kind !== "general" ? (
              // Clearing has to be reachable without reopening the picker —
              // otherwise backing out of an association costs more clicks than
              // making one, and people leave the wrong one attached.
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Attach to nothing"
                onClick={() => setAssociation({ kind: "general" })}
              >
                <X />
              </Button>
            ) : null}
          </div>

          {showAssociation ? (
            <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
              {/* "Nothing" leads, unlike NOTE_KINDS — this is a choice being
                  made, and the current answer belongs at the front of it. The
                  log's filter reads the other way round, where "General" is
                  one category among the rest. */}
              <div className="flex flex-wrap gap-1.5">
                {(["general", "channel", "niche", "video"] as const).map((kind) => {
                  const Icon = KIND_ICON[kind];
                  const selected = association.kind === kind;
                  return (
                    <button
                      key={kind}
                      type="button"
                      // Switching kind clears the id rather than remembering
                      // one per kind: a hidden selection that reappears when
                      // you toggle back is a note filed somewhere nobody chose.
                      onClick={() =>
                        setAssociation(kind === "general" ? { kind: "general" } : { kind, id: "" })
                      }
                      aria-pressed={selected}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors duration-150",
                        selected
                          ? "border-accent bg-accent-subtle text-foreground"
                          : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
                      )}
                    >
                      <Icon className="size-3" />
                      {KIND_LABEL[kind]}
                    </button>
                  );
                })}
              </div>

              {association.kind === "channel" ? (
                <ChannelPicker
                  channels={channels}
                  selectedId={association.id}
                  onSelect={(id) => setAssociation({ kind: "channel", id })}
                />
              ) : association.kind === "niche" ? (
                <NichePicker
                  niches={niches}
                  selectedId={association.id}
                  onSelect={(id) => setAssociation({ kind: "niche", id })}
                />
              ) : association.kind === "video" ? (
                <ShortPicker
                  channels={channels}
                  selectedId={association.id}
                  onSelect={(id) => setAssociation({ kind: "video", id })}
                />
              ) : (
                <FieldHint>
                  A general note. It lives in the log with everything else and is found by
                  searching its text.
                </FieldHint>
              )}
            </div>
          ) : null}
        </div>
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={create.isPending}
          disabled={!body.trim() || incomplete}
        >
          Add note
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

type DatasetChannels = readonly DatasetChannelDTO[];

/** Resolves the summary line on the collapsed row. */
function describeAssociation(
  association: Association,
  dataset: DatasetDTO | undefined,
): string {
  if (association.kind === "general") return "nothing — a general note";
  if (!association.id) return `pick a ${KIND_LABEL[association.kind].toLowerCase()}`;

  if (association.kind === "channel") {
    const found = dataset?.channels.find((entry) => entry.channel.id === association.id);
    return found?.channel.displayName ?? "a channel";
  }
  if (association.kind === "niche") {
    return dataset?.niches.find((niche) => niche.id === association.id)?.name ?? "a niche";
  }
  for (const entry of dataset?.channels ?? []) {
    const video = entry.videos.find((candidate) => candidate.id === association.id);
    if (video) return video.title;
  }
  return "a Short";
}

/** A search box over a scrollable option list — shared by the two long lists. */
function PickerShell({
  label,
  query,
  onQueryChange,
  placeholder,
  hint,
  children,
}: {
  label: string;
  query: string;
  onQueryChange: (value: string) => void;
  placeholder: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>{label}</Label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle-foreground" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={placeholder}
          className="h-8 pl-8 text-[13px]"
        />
      </div>
      <ul className="max-h-[168px] overflow-y-auto rounded-md border border-border divide-y divide-border">
        {children}
      </ul>
      {hint ? <FieldHint>{hint}</FieldHint> : null}
    </div>
  );
}

function OptionRow({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-150",
          selected ? "bg-accent-subtle" : "hover:bg-surface-hover",
        )}
      >
        <span className="min-w-0 flex-1">{children}</span>
        {selected ? <Check className="size-3.5 shrink-0 text-accent" /> : null}
      </button>
    </li>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <li className="px-2.5 py-3 text-[12px] text-subtle-foreground">{children}</li>;
}

function ChannelPicker({
  channels,
  selectedId,
  onSelect,
}: {
  channels: DatasetChannels;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = React.useState("");

  const matches = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const rows = channels.map((entry) => entry.channel);
    if (!needle) return rows;
    return rows.filter((channel) =>
      `${channel.displayName} ${channel.handle ?? ""}`.toLocaleLowerCase().includes(needle),
    );
  }, [channels, query]);

  return (
    <PickerShell
      label="Channel"
      query={query}
      onQueryChange={setQuery}
      placeholder="Search channels…"
    >
      {matches.length === 0 ? (
        <EmptyRow>No channel matches “{query.trim()}”.</EmptyRow>
      ) : (
        matches.map((channel) => (
          <OptionRow
            key={channel.id}
            selected={channel.id === selectedId}
            onSelect={() => onSelect(channel.id)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Avatar src={channel.avatarUrl} name={channel.displayName} size={18} />
              <span className="truncate text-[13px] text-foreground">
                {channel.displayName}
              </span>
            </span>
          </OptionRow>
        ))
      )}
    </PickerShell>
  );
}

function NichePicker({
  niches,
  selectedId,
  onSelect,
}: {
  niches: readonly NicheDTO[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  // No search box: niches are a handful by design, and a filter over six chips
  // is a control that costs more than it saves.
  if (niches.length === 0) {
    return (
      <FieldHint>
        No niches yet. Create one on the Niches page, or leave this note attached to nothing.
      </FieldHint>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Label>Niche</Label>
      <div className="flex flex-wrap gap-1.5">
        {niches.map((niche) => {
          const selected = niche.id === selectedId;
          return (
            <button
              key={niche.id}
              type="button"
              onClick={() => onSelect(niche.id)}
              aria-pressed={selected}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors duration-150",
                selected
                  ? "border-accent bg-accent-subtle text-foreground"
                  : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
              )}
            >
              <span
                aria-hidden
                className="size-[6px] shrink-0 rounded-full"
                style={{ background: nicheColor(niche.colorIndex) }}
              />
              {niche.name}
              {selected ? <Check className="size-3 text-accent" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** How many Shorts the list will render at once. */
const SHORT_RESULT_LIMIT = 40;

function ShortPicker({
  channels,
  selectedId,
  onSelect,
}: {
  channels: DatasetChannels;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = React.useState("");

  // Flattened once per dataset, not per keystroke. There are a few thousand
  // Shorts in the payload the page already holds, so this picker costs no
  // request — but it does have to avoid rebuilding the list on every letter.
  const shorts = React.useMemo(() => {
    const rows = channels.flatMap((entry) =>
      entry.videos
        // Shorts only. Every screen that shows a note on a video calls it a
        // "Short", and the long-form and unclassified rows in the dataset are
        // not what anyone is looking for here.
        .filter((video) => video.isShort)
        .map((video) => ({
          id: video.id,
          title: video.title,
          publishedAt: video.publishedAt,
          channelName: entry.channel.displayName,
          channelAvatarUrl: entry.channel.avatarUrl,
        })),
    );
    // Newest first: the Short somebody wants to annotate is almost always one
    // they have just been looking at.
    return rows.sort((a, b) => b.publishedAt - a.publishedAt);
  }, [channels]);

  const matches = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered = needle
      ? shorts.filter((short) =>
          `${short.title} ${short.channelName}`.toLocaleLowerCase().includes(needle),
        )
      : shorts;
    return { rows: filtered.slice(0, SHORT_RESULT_LIMIT), total: filtered.length };
  }, [shorts, query]);

  return (
    <PickerShell
      label="Short"
      query={query}
      onQueryChange={setQuery}
      placeholder="Search Shorts by title or channel…"
      hint={
        matches.total > SHORT_RESULT_LIMIT
          ? `Showing the ${SHORT_RESULT_LIMIT} most recent of ${matches.total} matches — keep typing to narrow it.`
          : undefined
      }
    >
      {matches.rows.length === 0 ? (
        <EmptyRow>
          {shorts.length === 0
            ? "No Shorts tracked yet."
            : `No Short matches “${query.trim()}”.`}
        </EmptyRow>
      ) : (
        matches.rows.map((short) => (
          <OptionRow
            key={short.id}
            selected={short.id === selectedId}
            onSelect={() => onSelect(short.id)}
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] text-foreground">{short.title}</span>
              <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-subtle-foreground">
                <Avatar src={short.channelAvatarUrl} name={short.channelName} size={12} />
                <span className="truncate">{short.channelName}</span>
                <span aria-hidden>·</span>
                <span className="shrink-0">{formatDate(short.publishedAt)}</span>
              </span>
            </span>
          </OptionRow>
        ))
      )}
    </PickerShell>
  );
}
