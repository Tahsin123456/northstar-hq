"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ExternalLink,
  Layers,
  Pencil,
  StickyNote,
  Trash2,
  Tv2,
  Video,
} from "lucide-react";
import { toast } from "sonner";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/error-state";
import { SearchInput } from "@/components/dashboard/search-input";
import { NicheChips, nicheColor } from "@/components/niches/niche-chip";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useDeleteNote, useUpdateNote } from "@/hooks/use-research";
import { useDataset } from "@/hooks/use-dataset";
import { useNow } from "@/hooks/use-now";
import { api } from "@/lib/api-client";
import type { NoteTargetType, NoteWithContextDTO } from "@/lib/dto";
import { formatDate, formatRelativeTime, youtubeShortsUrl } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Notes — the research log.
 *
 * Everything written anywhere in the app, in one searchable place. Notes are
 * only worth writing if they can be found again, and a note attached to a Short
 * you looked at three weeks ago is otherwise unreachable without remembering
 * which Short it was.
 *
 * Every row carries its own context — channel, niche, Short — and links back to
 * it, so the log doubles as a way to navigate to whatever prompted the thought.
 */

const TRIGGER_CLASS =
  "group inline-flex h-[30px] items-center gap-2 rounded-lg border border-border bg-surface-sunken px-2.5 text-[12px] font-medium transition-colors duration-150 hover:border-border-strong";

type TypeFilter = "all" | NoteTargetType;
type DateFilter = "all" | "7d" | "30d" | "90d";

const TYPE_LABELS: Record<TypeFilter, string> = {
  all: "All types",
  channel: "Channel",
  niche: "Niche",
  video: "Short",
};

const DATE_LABELS: Record<DateFilter, string> = {
  all: "Any time",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

export default function NotesPage() {
  const { data: dataset } = useDataset();
  const {
    data,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["notes", "all"],
    queryFn: api.listAllNotes,
    staleTime: 30_000,
  });

  const [query, setQuery] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState<TypeFilter>("all");
  const [channelFilter, setChannelFilter] = React.useState<string>("all");
  const [nicheFilter, setNicheFilter] = React.useState<string>("all");
  const [dateFilter, setDateFilter] = React.useState<DateFilter>("all");
  const now = useNow();

  const notes = React.useMemo(() => data?.notes ?? [], [data]);
  const channels = React.useMemo(() => dataset?.channels ?? [], [dataset]);
  const niches = React.useMemo(() => dataset?.niches ?? [], [dataset]);

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    // From the shared clock store rather than Date.now(), which would be an
    // impure read during render. Zero before the store subscribes, which simply
    // means no date cut-off for that first frame.
    const cutoff =
      dateFilter === "all" || now === 0
        ? 0
        : now - Number(dateFilter.replace("d", "")) * 86_400_000;

    return notes.filter((note) => {
      if (typeFilter !== "all" && note.targetType !== typeFilter) return false;
      if (channelFilter !== "all" && note.channelId !== channelFilter) return false;
      if (nicheFilter !== "all" && !note.niches.some((n) => n.id === nicheFilter)) return false;
      if (cutoff > 0 && note.createdAt < cutoff) return false;

      if (!needle) return true;
      const haystack = [
        note.body,
        note.targetLabel,
        note.channelName ?? "",
        ...note.niches.map((n) => n.name),
      ]
        .join(" ")
        .toLocaleLowerCase();
      return haystack.includes(needle);
    });
  }, [notes, query, typeFilter, channelFilter, nicheFilter, dateFilter, now]);

  const hasFilters =
    typeFilter !== "all" || channelFilter !== "all" || nicheFilter !== "all" || dateFilter !== "all";

  if (error) {
    return (
      <PageContainer>
        <Card>
          <ErrorState error={error} onRetry={() => refetch()} />
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="flex flex-col gap-5">
      <PageHeader
        title="Notes"
        description="Everything you have written, across channels, niches and individual Shorts."
        actions={
          notes.length > 0 ? (
            <span className="tnum text-[12px] text-muted-foreground">
              {filtered.length === notes.length
                ? `${notes.length} ${notes.length === 1 ? "note" : "notes"}`
                : `${filtered.length} of ${notes.length}`}
            </span>
          ) : undefined
        }
      />

      {isLoading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ) : notes.length === 0 ? (
        <Card>
          <EmptyState
            icon={<StickyNote />}
            title="No notes yet"
            description="Add a note from any channel page, niche card, or Short in Winners, Outliers or Saved. They all collect here."
            action={
              <Button variant="primary" asChild>
                <Link href="/winners">Browse Winners</Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <FilterMenu
                label="Type"
                value={TYPE_LABELS[typeFilter]}
                options={(["all", "channel", "niche", "video"] as TypeFilter[]).map((id) => ({
                  id,
                  label: TYPE_LABELS[id],
                }))}
                current={typeFilter}
                onChange={(v) => setTypeFilter(v as TypeFilter)}
              />

              <FilterMenu
                label="Channel"
                value={
                  channelFilter === "all"
                    ? "Any"
                    : (channels.find((c) => c.channel.id === channelFilter)?.channel
                        .displayName ?? "Any")
                }
                options={[
                  { id: "all", label: "Any channel" },
                  ...channels.map((c) => ({ id: c.channel.id, label: c.channel.displayName })),
                ]}
                current={channelFilter}
                onChange={setChannelFilter}
              />

              <FilterMenu
                label="Niche"
                value={
                  nicheFilter === "all"
                    ? "Any"
                    : (niches.find((n) => n.id === nicheFilter)?.name ?? "Any")
                }
                options={[
                  { id: "all", label: "Any niche" },
                  ...niches.map((n) => ({ id: n.id, label: n.name })),
                ]}
                current={nicheFilter}
                onChange={setNicheFilter}
              />

              <FilterMenu
                label="Created"
                value={DATE_LABELS[dateFilter]}
                options={(["all", "7d", "30d", "90d"] as DateFilter[]).map((id) => ({
                  id,
                  label: DATE_LABELS[id],
                }))}
                current={dateFilter}
                onChange={(v) => setDateFilter(v as DateFilter)}
              />

              {hasFilters ? (
                <button
                  type="button"
                  onClick={() => {
                    setTypeFilter("all");
                    setChannelFilter("all");
                    setNicheFilter("all");
                    setDateFilter("all");
                  }}
                  className="text-[11px] text-accent transition-colors hover:text-accent-hover"
                >
                  Clear filters
                </button>
              ) : null}
            </div>

            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Search notes…"
              resultCount={query ? filtered.length : undefined}
              className="w-full lg:w-72"
            />
          </div>

          {filtered.length === 0 ? (
            <Card>
              <EmptyState
                icon={<StickyNote />}
                title="No notes match"
                description="Search looks at the note text, the channel, the niche and the Short title."
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setQuery("");
                      setTypeFilter("all");
                      setChannelFilter("all");
                      setNicheFilter("all");
                      setDateFilter("all");
                    }}
                  >
                    Clear everything
                  </Button>
                }
              />
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {filtered.map((note) => (
                <NoteCard key={note.id} note={note} />
              ))}
            </div>
          )}
        </>
      )}
    </PageContainer>
  );
}

function FilterMenu({
  label,
  value,
  options,
  current,
  onChange,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  current: string;
  onChange: (value: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={TRIGGER_CLASS}>
          <span className="text-muted-foreground">{label}</span>
          <span className="max-w-[130px] truncate text-foreground">{value}</span>
          <ChevronDown className="size-3 text-subtle-foreground transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[320px] overflow-y-auto">
        <DropdownMenuRadioGroup value={current} onValueChange={onChange}>
          {options.map((option, index) => (
            <React.Fragment key={option.id}>
              {index === 1 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuRadioItem value={option.id}>
                <span className="max-w-[220px] truncate">{option.label}</span>
              </DropdownMenuRadioItem>
            </React.Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const TYPE_ICON: Record<NoteTargetType, React.ComponentType<{ className?: string }>> = {
  channel: Tv2,
  niche: Layers,
  video: Video,
};

function NoteCard({ note }: { note: NoteWithContextDTO }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(note.body);
  const update = useUpdateNote();
  const remove = useDeleteNote();

  const Icon = TYPE_ICON[note.targetType];

  return (
    <Card className="group p-4">
      <div className="flex items-start justify-between gap-3">
        <Badge variant="outline" size="md" className="shrink-0 gap-1.5">
          <Icon className="size-3" />
          {TYPE_LABELS[note.targetType]}
        </Badge>

        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Edit note"
            onClick={() => {
              setDraft(note.body);
              setEditing(true);
            }}
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
                onError: (e) =>
                  toast.error("Could not delete", {
                    description: e instanceof Error ? e.message : undefined,
                  }),
              })
            }
            className="text-subtle-foreground hover:text-danger"
          >
            {remove.isPending ? null : <Trash2 />}
          </Button>
        </div>
      </div>

      {editing ? (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const body = draft.trim();
            if (!body) return;
            update.mutate(
              { id: note.id, body },
              {
                onSuccess: () => {
                  setEditing(false);
                  toast.success("Note updated");
                },
                onError: (e) =>
                  toast.error("Could not update", {
                    description: e instanceof Error ? e.message : undefined,
                  }),
              },
            );
          }}
        >
          <textarea
            autoFocus
            value={draft}
            rows={3}
            maxLength={4000}
            onChange={(event) => setDraft(event.target.value)}
            className="w-full resize-y rounded-md border border-border bg-surface-sunken px-3 py-2 text-[13px] text-foreground focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)]"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={update.isPending}
              disabled={!draft.trim()}
            >
              Save
            </Button>
          </div>
        </form>
      ) : (
        <p className="mt-2.5 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
          {note.body}
        </p>
      )}

      {/* Context row: what this was about, and a way back to it. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border pt-3 text-[11px]">
        {note.targetType === "video" && note.youtubeVideoId ? (
          <a
            href={youtubeShortsUrl(note.youtubeVideoId)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-[280px] items-center gap-1.5 text-muted-foreground transition-colors hover:text-accent"
            title={note.targetLabel}
          >
            <Video className="size-3 shrink-0" />
            <span className="truncate">{note.targetLabel}</span>
            <ExternalLink className="size-2.5 shrink-0 opacity-50" />
          </a>
        ) : null}

        {note.channelId ? (
          <Link
            href={`/channels/${note.channelId}`}
            className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-accent"
          >
            <Avatar
              src={note.channelAvatarUrl}
              name={note.channelName ?? "?"}
              size={14}
            />
            <span className="max-w-[160px] truncate">{note.channelName}</span>
          </Link>
        ) : null}

        {note.targetType === "niche" && note.niches[0] ? (
          <Link
            href={`/?niche=${encodeURIComponent(note.niches[0].id)}`}
            className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-accent"
          >
            <span
              aria-hidden
              className="size-[6px] shrink-0 rounded-full"
              style={{ background: nicheColor(note.niches[0].colorIndex) }}
            />
            {note.niches[0].name}
          </Link>
        ) : note.niches.length > 0 ? (
          <NicheChips niches={note.niches} limit={2} size="sm" />
        ) : null}

        <span aria-hidden className="text-border-strong">
          ·
        </span>
        <span
          className="text-subtle-foreground"
          title={`Created ${formatDate(note.createdAt)}`}
        >
          {formatRelativeTime(note.createdAt)}
          {note.updatedAt !== note.createdAt
            ? ` · edited ${formatRelativeTime(note.updatedAt)}`
            : ""}
        </span>
      </div>
    </Card>
  );
}

export { cn };
