"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ExternalLink,
  Layers,
  Pencil,
  Plus,
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
  DATE_FILTER_IDS,
  DATE_FILTER_LABELS,
  FilterMenu,
  resolveDateFilter,
  type DateFilterId,
  type ResolvedDateFilter,
} from "@/components/common/filter-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { CreateNoteDialog } from "@/components/notes/create-note-dialog";
import {
  NoteVisibilityToggle,
  VisibilityBadge,
} from "@/components/notes/note-visibility";
import { useSession } from "@/components/providers/session-provider";
import { useDeleteNote, useUpdateNote } from "@/hooks/use-research";
import { useDataset } from "@/hooks/use-dataset";
import { useEmployees } from "@/hooks/use-employees";
import { api } from "@/lib/api-client";
import { AUTHOR_ME, UNKNOWN_AUTHOR_LABEL, GENERAL_NOTE_LABEL, NOTE_KINDS } from "@/lib/dto";
import type { NoteKind, NoteWithContextDTO } from "@/lib/dto";
import type { NoteLogQuery } from "@/server/services/research-service";
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
 *
 * It also WRITES now, which it did not before. Every note used to have to be
 * started from the thing it was about, which left the one screen dedicated to
 * notes unable to make one, and left a thought that was not about any one thing
 * with nowhere to go — so it got filed against whatever happened to be open.
 * "Attached to nothing" is a real answer here, and the context row below simply
 * has nothing to draw for it.
 */

type TypeFilter = "all" | NoteKind;
type SortChoice = "newest" | "oldest" | "author";

const TYPE_LABELS: Record<TypeFilter, string> = {
  all: "All types",
  channel: "Channel",
  niche: "Niche",
  video: "Short",
  // From the DTO layer rather than spelled here, so the badge on the row, this
  // filter option and the label the server resolves are the same word.
  general: GENERAL_NOTE_LABEL,
};

const SORT_LABELS: Record<SortChoice, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  author: "By author",
};

/** What the server is asked to sort by, for each choice the menu offers. */
const SORT_QUERY: Record<SortChoice, Pick<NoteLogQuery, "sort" | "direction">> = {
  newest: { sort: "created", direction: "desc" },
  oldest: { sort: "created", direction: "asc" },
  author: { sort: "author", direction: "asc" },
};

export default function NotesPage() {
  const { data: dataset } = useDataset();
  const session = useSession();
  const isAdmin = session.can("users.manage");

  const [query, setQuery] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState<TypeFilter>("all");
  const [channelFilter, setChannelFilter] = React.useState<string>("all");
  const [nicheFilter, setNicheFilter] = React.useState<string>("all");
  const [authorFilter, setAuthorFilter] = React.useState<string>("all");
  const [dateFilter, setDateFilter] = React.useState<ResolvedDateFilter>({ id: "all" });
  const [sort, setSort] = React.useState<SortChoice>("newest");
  const [composing, setComposing] = React.useState(false);

  /**
   * Everything the server is being asked, in one object.
   *
   * It is both the request and the query key, which is the point: two
   * expressions of "which notes am I looking at" would eventually disagree, and
   * the one the cache believed would win.
   */
  const params = React.useMemo<NoteLogQuery>(
    () => ({
      targetType: typeFilter === "all" ? undefined : typeFilter,
      channelId: channelFilter === "all" ? undefined : channelFilter,
      nicheId: nicheFilter === "all" ? undefined : nicheFilter,
      authorId: authorFilter === "all" ? undefined : authorFilter,
      createdAfter: dateFilter.since,
      ...SORT_QUERY[sort],
    }),
    [typeFilter, channelFilter, nicheFilter, authorFilter, dateFilter, sort],
  );

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["notes", "all", params],
    queryFn: () => api.listAllNotes(params),
    staleTime: 30_000,
    // The previous answer stays on screen while the next one loads, so
    // changing a filter does not blank the page and bounce the scroll
    // position. It is the same list, asked a slightly different question.
    placeholderData: (previous) => previous,
  });

  const notes = React.useMemo(() => data?.notes ?? [], [data]);
  const channels = React.useMemo(() => dataset?.channels ?? [], [dataset]);
  const niches = React.useMemo(() => dataset?.niches ?? [], [dataset]);

  /**
   * SEARCH IS THE ONE THING STILL NARROWED IN THE BROWSER, and deliberately.
   *
   * The filters above are server-side because they decide WHICH ROWS ARE SENT —
   * "the admin's log, filtered to one employee" must not arrive as everybody's
   * log with the rest hidden. Search only refines rows the server already
   * decided this person may read, it never widens them, and it has to feel
   * instant per keystroke. If it ever needs to reach text the payload does not
   * carry, it becomes a query parameter like the rest.
   */
  const filtered = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return notes;

    return notes.filter((note) => {
      const haystack = [
        note.body,
        note.targetLabel,
        note.channelName ?? "",
        note.createdByName ?? "",
        ...note.niches.map((n) => n.name),
      ]
        .join(" ")
        .toLocaleLowerCase();
      return haystack.includes(needle);
    });
  }, [notes, query]);

  const hasFilters =
    typeFilter !== "all" ||
    channelFilter !== "all" ||
    nicheFilter !== "all" ||
    authorFilter !== "all" ||
    dateFilter.id !== "all";

  const clearFilters = React.useCallback(() => {
    setTypeFilter("all");
    setChannelFilter("all");
    setNicheFilter("all");
    setAuthorFilter("all");
    setDateFilter({ id: "all" });
  }, []);

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
        // Says what the log actually holds now. "Everything you have written"
        // stopped being true the moment a colleague could share one into it,
        // and a heading that undersells what is on the page is how somebody
        // mistakes a shared note for their own.
        description={
          isAdmin
            ? "Every note in the workspace — about channels, niches and individual Shorts, or about nothing in particular."
            : "Everything you have written, plus what colleagues have shared with you — about channels, niches and individual Shorts, or about nothing in particular."
        }
        actions={
          <div className="flex items-center gap-3">
            {notes.length > 0 ? (
              <span className="tnum text-[12px] text-muted-foreground">
                {filtered.length === notes.length
                  ? `${notes.length} ${notes.length === 1 ? "note" : "notes"}`
                  : `${filtered.length} of ${notes.length}`}
              </span>
            ) : null}
            <Button variant="primary" size="sm" onClick={() => setComposing(true)}>
              <Plus />
              Add note
            </Button>
          </div>
        }
      />

      {isLoading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ) : notes.length === 0 && !hasFilters && !query ? (
        // Only when the log is genuinely empty. With a filter on, an empty
        // answer must keep the filter bar on screen — otherwise the controls
        // that produced the emptiness disappear along with the rows, and the
        // only way back is a page reload.
        <Card>
          <EmptyState
            icon={<StickyNote />}
            title="No notes yet"
            description="Write one here — about a channel, a niche, a Short, or nothing in particular. Notes added from a channel page or from Winners, Outliers and Saved collect here too."
            action={
              // "Write one" comes first now that this page can. Sending someone
              // to Winners was the only offer while the log had no create of
              // its own, and it answers the wrong question for a thought that
              // is not about a particular Short.
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button variant="primary" onClick={() => setComposing(true)}>
                  <Plus />
                  Add note
                </Button>
                <Button variant="secondary" asChild>
                  <Link href="/winners">Browse Winners</Link>
                </Button>
              </div>
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
                // Driven off NOTE_KINDS, so a kind added to the model shows up
                // here rather than being silently unfilterable.
                options={(["all", ...NOTE_KINDS] as TypeFilter[]).map((id) => ({
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
                value={DATE_FILTER_LABELS[dateFilter.id]}
                options={DATE_FILTER_IDS.map((id) => ({ id, label: DATE_FILTER_LABELS[id] }))}
                current={dateFilter.id}
                // Resolved in the handler, not during render: the cut-off is
                // fixed at the moment the range is chosen, so it cannot move
                // under the query key. See `resolveDateFilter`.
                onChange={(value) => setDateFilter(resolveDateFilter(value as DateFilterId))}
              />

              {/* The author filter is an ADMIN control, because it is the only
                  reader whose log holds more than one person's notes — plus
                  "Mine", which is useful to anybody who can now see colleagues'
                  shared notes alongside their own. The menu is an affordance,
                  not the boundary: the server intersects any author asked for
                  with what this reader may see, so naming a colleague never
                  widens the answer. */}
              <AuthorFilterMenu
                current={authorFilter}
                onChange={setAuthorFilter}
                includeColleagues={isAdmin}
              />

              <FilterMenu
                label="Sort"
                value={SORT_LABELS[sort]}
                options={(["newest", "oldest", "author"] as SortChoice[]).map((id) => ({
                  id,
                  label: SORT_LABELS[id],
                }))}
                current={sort}
                onChange={(v) => setSort(v as SortChoice)}
              />

              {hasFilters ? (
                <button
                  type="button"
                  onClick={clearFilters}
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
                description="Search looks at the note text, its author, the channel, the niche and the Short title."
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setQuery("");
                      clearFilters();
                    }}
                  >
                    Clear everything
                  </Button>
                }
              />
            </Card>
          ) : (
            // Dimmed, not replaced, while the next answer is in flight: the
            // rows on screen are still true, they are simply about to be
            // answered again.
            <div
              className={cn(
                "flex flex-col gap-3 transition-opacity duration-150",
                isFetching && "opacity-60",
              )}
            >
              {filtered.map((note) => (
                <NoteCard key={note.id} note={note} viewerId={session.user.id} isAdmin={isAdmin} />
              ))}
            </div>
          )}
        </>
      )}

      {/* One dialog for the page, driven by both entry points above — the
          header button and the empty state — so there is a single create path
          however you arrive at it. */}
      <CreateNoteDialog open={composing} onOpenChange={setComposing} />
    </PageContainer>
  );
}

/**
 * Filter the log by who wrote it.
 *
 * The roster comes from the employees endpoint, which needs `users.manage` —
 * so it is only fetched for an admin. Everyone else gets the two options that
 * need no roster: everything they can see, and their own.
 */
function AuthorFilterMenu({
  current,
  onChange,
  includeColleagues,
}: {
  current: string;
  onChange: (value: string) => void;
  includeColleagues: boolean;
}) {
  const { data } = useEmployees({ enabled: includeColleagues });
  const employees = React.useMemo(() => data?.employees ?? [], [data]);

  const options = React.useMemo(
    () => [
      { id: "all", label: "Anyone" },
      { id: AUTHOR_ME, label: "Mine" },
      ...employees.map((employee) => ({
        id: employee.userId,
        label: employee.name ?? employee.email ?? "Unnamed",
      })),
    ],
    [employees],
  );

  const value =
    current === "all"
      ? "Anyone"
      : (options.find((option) => option.id === current)?.label ?? "Anyone");

  return (
    <FilterMenu
      label="Author"
      value={value}
      options={options}
      current={current}
      onChange={onChange}
    />
  );
}

const TYPE_ICON: Record<NoteKind, React.ComponentType<{ className?: string }>> = {
  channel: Tv2,
  niche: Layers,
  video: Video,
  general: StickyNote,
};

function NoteCard({
  note,
  viewerId,
  isAdmin,
}: {
  note: NoteWithContextDTO;
  viewerId: string;
  isAdmin: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(note.body);
  const update = useUpdateNote();
  const remove = useDeleteNote();

  // The log holds the viewer's own notes, the ones colleagues shared into their
  // scope, and — for an admin — the whole team's. Every row that is not theirs
  // says whose it is.
  //
  // EVERY note says who wrote it, including the viewer's own.
  //
  // This used to print a byline only on somebody else's note, on the reasoning
  // that your own name is noise on your own writing. That reasoning was wrong
  // in the place it mattered most: an admin scanning the team's log saw
  // attribution on some rows and nothing on others, and "nothing" is not
  // self-evidently "mine" — it reads as missing data, which is exactly how it
  // was reported. A column that is blank half the time cannot be scanned, and
  // scanning is the whole purpose of this screen.
  //
  // The name comes from the stored `createdBy` relation, never from the
  // session, so it stays correct when somebody renames themselves and stays
  // attached when they leave.
  const isMine = note.createdById === viewerId;
  const byline = note.createdByName ?? UNKNOWN_AUTHOR_LABEL;

  /**
   * Editing, deleting and re-sharing are the AUTHOR'S, plus an admin's.
   *
   * Reading a shared note does not come with a pencil. The server refuses a
   * colleague's edit either way — this hides the controls that were going to be
   * refused, which is the difference between a rule and a trap.
   */
  const canEdit = isMine || isAdmin;

  const Icon = TYPE_ICON[note.targetType];

  // A general note is attached to nothing, so the context row holds only its
  // byline and date. The separator below is drawn from this rather than
  // rendered unconditionally, or every general note would open with a dangling
  // "·" that reads like a link failed to load.
  const hasContext =
    note.targetType !== "general" &&
    Boolean(note.channelId || note.youtubeVideoId || note.niches.length > 0);

  return (
    <Card className="group p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge variant="outline" size="md" className="shrink-0 gap-1.5">
            <Icon className="size-3" />
            {TYPE_LABELS[note.targetType]}
          </Badge>
          <VisibilityBadge visibility={note.visibility} />
        </div>

        {canEdit ? (
          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <NoteVisibilityToggle note={note} />
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
        ) : null}
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

        {hasContext ? (
          <span aria-hidden className="text-border-strong">
            ·
          </span>
        ) : null}
        <span
          className="text-subtle-foreground"
          title={`Created by ${byline} ${formatRelativeTime(note.createdAt)}`}
        >
          {/* "Created by" in full, not a bare name. Next to a date a lone name
              reads as ambiguously as it looks — it could as easily be who the
              note is *about* as who wrote it.

              THE DATE IS ABSOLUTE, and the relative form moved to the tooltip.
              `formatRelativeTime` has no upper bound: a note from last spring
              reads "1 year ago", which is useless for the thing a research log
              is actually for — placing an observation against what the channel
              was doing at the time. A hover is not an answer either; it is
              invisible in a screenshot and to anybody navigating by keyboard. */}
          {`Created by ${byline} · `}
          {formatDate(note.createdAt)}
          {note.updatedAt !== note.createdAt
            ? ` · edited ${formatRelativeTime(note.updatedAt)}`
            : ""}
        </span>
      </div>
    </Card>
  );
}

export { cn };
