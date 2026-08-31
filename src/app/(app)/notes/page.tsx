"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
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
import { Skeleton, SkeletonText } from "@/components/ui/skeleton";
import { CreateNoteDialog } from "@/components/notes/create-note-dialog";
import {
  buildNotePatch,
  ExternalShortField,
  ExternalShortPreview,
  useExternalShortField,
} from "@/components/notes/external-short";
import {
  NoteVisibilityToggle,
  VisibilityBadge,
} from "@/components/notes/note-visibility";
import { ShortPlayerDialog } from "@/components/shorts/short-player-dialog";
import {
  SHORT_CARD_ACTION_PLATE,
  SHORT_CARD_BODY,
  SHORT_CARD_META_ROW,
  SHORT_CARD_SHELL,
  ShortCardTitle,
  ShortPoster,
} from "@/components/shorts/short-card-frame";
import { SHORTS_CARD_GRID, SHORTS_POSTER_FRAME } from "@/lib/shorts/feed-layout";
import { notePosterFor } from "@/lib/notes/note-poster";
import { useSession } from "@/components/providers/session-provider";
import { useDeleteNote, useUpdateNote } from "@/hooks/use-research";
import { useDataset } from "@/hooks/use-dataset";
import { useEmployees } from "@/hooks/use-employees";
import { api } from "@/lib/api-client";
import { AUTHOR_ME, UNKNOWN_AUTHOR_LABEL, GENERAL_NOTE_LABEL, NOTE_KINDS } from "@/lib/dto";
import type { NoteKind, NoteWithContextDTO } from "@/lib/dto";
import type { NoteLogQuery } from "@/server/services/research-service";
import { formatDate, formatRelativeTime } from "@/lib/format";
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

/**
 * THE GRID — IMPORTED NOW, NOT DECLARED HERE.
 *
 * This file used to carry its own copy of the class list, character-identical
 * to the one in `feed-layout` and the one on the saved board. `feed-layout`'s
 * own header names the outcome: "this is now the THIRD copy of the same class
 * list ... They drifted apart once already." The owner's request that these
 * screens look alike is the moment to stop having three, so the constant is
 * imported and the local copy is gone.
 *
 * Everything the local comment argued for still holds and now lives beside the
 * constant: columns off Tailwind's own scale, counted against the MAIN COLUMN
 * rather than the window, and `grid-cols-1` at the bottom end as the structural
 * guarantee that nothing scrolls sideways.
 */
const CARD_GRID = SHORTS_CARD_GRID;

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
        // Shaped like the card it replaces — a 9:16 poster, a title, three
        // lines of body, a byline — and laid out on the same grid, so the page
        // does not reflow when the answer arrives. `SHORTS_POSTER_FRAME` is the
        // same string the card draws, which is the whole reason it is a shared
        // constant: a skeleton that predicts a different shape than the thing
        // it stands in for makes the page settle by jumping.
        <div className={CARD_GRID}>
          {Array.from({ length: 6 }, (_, i) => (
            <Card key={i} className="flex flex-col overflow-hidden">
              <Skeleton className={cn(SHORTS_POSTER_FRAME, "rounded-none")} />
              <div className="flex flex-col gap-2 p-3">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3 w-20" />
                <SkeletonText lines={3} />
                <Skeleton className="mt-1 h-3 w-2/3" />
              </div>
            </Card>
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
                CARD_GRID,
                "transition-opacity duration-150",
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
  /*
   * A note has up to two Shorts on it and they are different things: the one it
   * QUOTES from outside the tracker and the tracked Short it is a note ABOUT.
   * `notePosterFor` decides which of them leads the card and whether the other
   * still needs its own strip; this state belongs to whichever one ended up on
   * the poster. The preview strip owns its own player for the other.
   */
  const [playing, setPlaying] = React.useState(false);
  // Seeded from the note so opening the editor shows the Short it already
  // quotes. This card TOGGLES its form rather than unmounting it, so — like
  // `draft` above — it is re-seeded on the way in rather than on mount.
  const link = useExternalShortField(note.externalUrl);
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

  /*
   * WHAT LEADS THE CARD. The whole of the owner's first request for this
   * screen — "display them underneath the Short" — turns on this one call, and
   * on the fact that it always answers. See `notePosterFor` for the four cases
   * and for why a note with no Short still gets a poster-shaped box.
   */
  const poster = notePosterFor(note);

  // A general note is attached to nothing, so its footer holds only the byline
  // and date. Tested rather than left to render as an empty line: on a wide
  // strip an absent context row cost nothing, but on a card it is a visible
  // band of dead space between the body and the byline.
  const hasContext =
    note.targetType !== "general" &&
    Boolean(note.channelId || note.youtubeVideoId || note.niches.length > 0);

  /**
   * =========================================================================
   * THE SAME CARD AS WINNERS, WITH A NOTE UNDER IT
   * =========================================================================
   *
   * WHAT CHANGED AND WHY. This card used to be inverted relative to what the
   * owner asked for: it led with note metadata — a type badge and a visibility
   * badge — and demoted the Short it was about to a text link in the footer.
   * The Short is the object; the note is what somebody said about it. So the
   * poster leads, exactly as it does on Winners and Outliers, and the note text
   * sits underneath it.
   *
   * IT IS THE SHARED CARD, not a copy of it. The shell, the poster box, the
   * title control and the meta row all come from `short-card-frame`, which the
   * feed card uses too — so "almost identical" is now a structural property
   * rather than two files that happen to agree today. The `p-4` this card used
   * to carry moved inward to `SHORT_CARD_BODY`, because a poster cannot bleed
   * to the edge of a padded card.
   *
   * EQUAL HEIGHT SURVIVES, AND STILL FOR THE SAME REASON. `flex flex-col` with
   * the body claiming the slack puts the footer on the floor of the card, and
   * grid tracks stretch, so every byline in a row sits on one line. This screen
   * is scanned down the author and date column. The waste stays bounded because
   * the body is still clamped to five lines — and the poster is a fixed height
   * for every card including the ones with no Short, which is precisely why
   * `ShortPoster` draws a plate rather than nothing.
   *
   * `min-w-0` is not cosmetic: a grid item defaults to `min-width: auto`, so a
   * 300-character unbroken word would widen the track past its share and push
   * the page into horizontal scroll. That, plus `break-words` on the body, is
   * what makes the no-sideways-scrolling promise hold for real input. It is
   * carried by `SHORT_CARD_SHELL` now.
   */
  return (
    <Card className={SHORT_CARD_SHELL}>
      <ShortPoster
        videoId={poster.youtubeVideoId}
        // No play control where there is no Short. A disabled button would be
        // an affordance that lies; the plate simply is not one.
        onPlay={poster.youtubeVideoId ? () => setPlaying(true) : undefined}
        // The note's own kind icon, on the plate, where the play badge would
        // be. A channel note is a screen, a niche note is layers, a general
        // note is a sticky note — the same icon the type badge below carries,
        // so the two agree.
        placeholder={<Icon />}
      >
        {canEdit ? (
          // ON THE POSTER, on the same plate the feed puts its actions on,
          // rather than in a header row above the card. That header row is what
          // the poster replaced. Hover-gated exactly as the feed's is: these
          // are affordances rather than information, and one of them deletes
          // the note.
          <div
            className={cn(
              SHORT_CARD_ACTION_PLATE,
              "opacity-0 focus-within:opacity-100 group-hover:opacity-100",
            )}
          >
            <NoteVisibilityToggle note={note} />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Edit note"
              onClick={() => {
                setDraft(note.body);
                // Beside `setDraft`, for the same reason: an edit that was
                // opened, typed into and abandoned must not still be sitting
                // there — with its error message — the next time it is opened.
                link.reset(note.externalUrl);
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
      </ShortPoster>

      {/* The player for whichever Short took the poster. Mounted only where
          there is one, so a note about a niche does not carry a dialog it can
          never open. */}
      {poster.youtubeVideoId ? (
        <ShortPlayerDialog
          short={{
            youtubeVideoId: poster.youtubeVideoId,
            title: poster.title,
            subtitle: poster.subtitle,
          }}
          open={playing}
          onOpenChange={setPlaying}
        />
      ) : null}

      <div className={SHORT_CARD_BODY}>
        {/* THE SUBJECT, in the title slot the feed card puts a Short's title
            in: the Short's own name where there is one, the channel or niche
            otherwise. Never empty — see `notePosterFor`. */}
        <ShortCardTitle
          title={poster.title}
          onPlay={poster.youtubeVideoId ? () => setPlaying(true) : undefined}
        />

        {/* The note's own metadata, demoted from the top of the card to the
            meta row — the same row the feed card puts a channel, an "Own" badge
            and a niche chip in. It is still all here; it is simply no longer
            the first thing on the card. */}
        <div className={SHORT_CARD_META_ROW}>
          <Badge variant="outline" size="sm" className="shrink-0 gap-1.5">
            <Icon className="size-3" />
            {TYPE_LABELS[note.targetType]}
          </Badge>
          <VisibilityBadge visibility={note.visibility} />

          {hasContext ? <NoteContext note={note} /> : null}
        </div>

      {editing ? (
        <form
          className="flex flex-1 flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const body = draft.trim();
            if (!body) return;
            // A bad link stops the save and says why, rather than saving the
            // note with the link silently dropped.
            if (link.isInvalid) {
              link.markTouched();
              return;
            }
            update.mutate(
              // `buildNotePatch` decides whether the link is even mentioned:
              // it compares parsed video ids, so re-pasting the same Short in
              // another of its URL forms is correctly seen as no change and
              // costs neither a PATCH field nor a metadata lookup.
              { id: note.id, ...buildNotePatch(note, body, link.videoId) },
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
          {/* Changing the attached Short and REMOVING it are the same control:
              clearing the field is what removes the link, which is why the
              field carries its own clear button rather than leaving somebody to
              select a URL and delete it. */}
          <ExternalShortField
            state={link}
            id={`note-log-external-short-${note.id}`}
            compact
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
              disabled={!draft.trim() || link.isInvalid}
            >
              Save
            </Button>
          </div>
        </form>
      ) : (
        // THE NOTE, UNDERNEATH THE SHORT — the owner's request for this screen,
        // in one element. Clamped to five lines: enough that most notes are
        // read in full on the card, and the ones that are not say so by
        // trailing off rather than by being cut mid-glyph. The whole text stays
        // available on hover, since there is nowhere else in this app to send a
        // reader for it — a note has no page of its own.
        <p
          className="line-clamp-5 min-w-0 break-words whitespace-pre-wrap text-[13px] leading-relaxed text-foreground"
          title={note.body}
        >
          {note.body}
        </p>
      )}

      {/* The Short this note quotes from outside the tracker, WHEN IT IS NOT
          ALREADY THE POSTER. That condition is the new half: a note whose only
          Short is an external one now leads with it, so drawing the strip as
          well would show the same Short twice. A note that is about a tracked
          Short AND quotes an outside one still gets both — the tracked one on
          the poster, the quoted one here — because they are the two halves of
          the comparison that prompted the note.

          The shared preview, not a card-sized copy of it: the composer, the
          panel on a channel page and this log all draw the same attachment.

          HIDDEN WHILE EDITING, and that is the whole point of the guard.
          Clearing the field is how a link is removed, and with the stored
          attachment still drawn underneath, the clear looked like it had done
          nothing — the thumbnail was right there, unchanged, until save. Two
          views of one value, one of them stale, is not a preview. */}
      {editing || !poster.hasSeparateExternalShort ? null : (
        <ExternalShortPreview note={note} />
      )}

      {/* The floor of the card: who wrote it and when. `mt-auto` pins it there
          however long the note ran, which is what makes every byline in a row
          sit on one line — the alignment this screen is scanned by. The context
          row moved up into the meta row under the title, where the feed card
          keeps the same class of fact. */}
      <div className="mt-auto flex flex-col gap-1.5 border-t border-border pt-2.5 text-[11px]">
        {/* "Created by" in full, not a bare name. Next to a date a lone name
            reads as ambiguously as it looks — it could as easily be who the
            note is *about* as who wrote it.

            UNCONDITIONAL, INCLUDING ON YOUR OWN NOTES. This was fixed in an
            earlier round and the grid makes it matter more, not less: a blank
            where a byline goes is even harder to read as "mine" when it is a
            gap in a card than when it was a gap in a column.

            THE DATE IS ABSOLUTE, and the relative form stays in the tooltip.
            `formatRelativeTime` has no upper bound: a note from last spring
            reads "1 year ago", which is useless for the thing a research log is
            actually for — placing an observation against what the channel was
            doing at the time. A hover is not an answer either; it is invisible
            in a screenshot and to anybody navigating by keyboard. */}
        <div
          className="flex min-w-0 flex-col gap-0.5 text-subtle-foreground"
          title={`Created by ${byline} ${formatRelativeTime(note.createdAt)}`}
        >
          <span className="min-w-0 truncate">{`Created by ${byline}`}</span>
          <span className="tnum truncate">
            {formatDate(note.createdAt)}
            {note.updatedAt !== note.createdAt
              ? ` · edited ${formatRelativeTime(note.updatedAt)}`
              : ""}
          </span>
        </div>
      </div>
      </div>
    </Card>
  );
}

/**
 * What the note is filed against, in the card's meta row.
 *
 * MOVED UP FROM THE FOOTER, and the move is the point. It used to sit above the
 * byline in a footer that also held the Short — which meant the Short, the
 * channel and the niche were all "context" at the bottom of a card whose top
 * was two badges. Now the Short is the poster and this is the row of small
 * facts under the title, which is exactly where the feed card puts a channel
 * and a niche chip. Same information, same place, across two screens.
 *
 * The tracked Short is deliberately NOT repeated here: it is the poster and the
 * title above, so a third mention would be the card saying one thing three
 * times.
 *
 * Extracted rather than left inline because the card body is long and this is a
 * self-contained question — "what was this about?" — with three independent
 * answers that can each be absent.
 */
function NoteContext({ note }: { note: NoteWithContextDTO }) {
  return (
    <>
      {note.channelId ? (
        <Link
          href={`/channels/${note.channelId}`}
          className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-muted-foreground transition-colors hover:text-accent"
        >
          <Avatar src={note.channelAvatarUrl} name={note.channelName ?? "?"} size={14} />
          <span className="max-w-[140px] truncate">{note.channelName}</span>
        </Link>
      ) : null}

      {note.targetType === "niche" && note.niches[0] ? (
        <Link
          href={`/?niche=${encodeURIComponent(note.niches[0].id)}`}
          className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-muted-foreground transition-colors hover:text-accent"
        >
          <span
            aria-hidden
            className="size-[6px] shrink-0 rounded-full"
            style={{ background: nicheColor(note.niches[0].colorIndex) }}
          />
          <span className="truncate">{note.niches[0].name}</span>
        </Link>
      ) : note.niches.length > 0 ? (
        // One chip rather than two: the card is a third of the width the strip
        // was, and a second chip pushes the "+n" onto its own line.
        <NicheChips niches={note.niches} limit={1} size="sm" />
      ) : null}
    </>
  );
}

export { cn };
