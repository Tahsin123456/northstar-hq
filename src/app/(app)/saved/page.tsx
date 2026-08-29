"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  Bookmark,
  ExternalLink,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  StickyNote,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { PageContainer, PageHeader } from "@/components/layout/app-shell";
import { ErrorState } from "@/components/common/error-state";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { SearchInput } from "@/components/dashboard/search-input";
import {
  DATE_FILTER_IDS,
  DATE_FILTER_LABELS,
  FilterMenu,
  resolveDateFilter,
  type DateFilterId,
  type ResolvedDateFilter,
} from "@/components/common/filter-menu";
import { NicheChips } from "@/components/niches/niche-chip";
import { ContentTypeControl } from "@/components/content-types/content-type-control";
import {
  ShortDetailDialog,
  type ShortDetailTarget,
} from "@/components/shorts/short-detail-dialog";
import { useSession } from "@/components/providers/session-provider";
import { useDataset } from "@/hooks/use-dataset";
import { useEmployees } from "@/hooks/use-employees";
import { useVideoContentTypeResolutions } from "@/hooks/use-content-types";
import { EMPTY_RESOLUTION, type ContentTypeResolution } from "@/lib/content-types/resolve";
import {
  useCreateCollection,
  useDeleteCollection,
  useRemoveOrphanedSave,
  useRenameCollection,
  useSavedShorts,
  useUnsaveShort,
} from "@/hooks/use-research";
import {
  AUTHOR_ME,
  UNKNOWN_AUTHOR_LABEL,
  type CollectionDTO,
  type SavedShortDTO,
} from "@/lib/dto";
import type { SavedShortsQuery } from "@/server/services/research-service";
import {
  EM_DASH,
  formatCompactNumber,
  formatDate,
  formatRelativeTime,
  youtubeShortsUrl,
  youtubeThumbnailUrl,
} from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Saved — the research library.
 *
 * The end of the discover → analyse → save → note → revisit loop. Its most
 * important column is the views journey: a Short saved at 1.2M that is now at
 * 4.8M tells a director their instinct was right, which is the feedback loop
 * that makes the whole workflow worth maintaining.
 */
/** What the server is asked to sort the board by, for each choice the menu offers. */
type SortChoice = "newest" | "oldest" | "saver";

const SORT_LABELS: Record<SortChoice, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  saver: "By saver",
};

const SORT_QUERY: Record<SortChoice, Pick<SavedShortsQuery, "sort" | "direction">> = {
  newest: { sort: "saved", direction: "desc" },
  oldest: { sort: "saved", direction: "asc" },
  saver: { sort: "saver", direction: "asc" },
};

/**
 * THE GRID.
 *
 * Identical to the notes log's, deliberately — the two screens are the two ends
 * of the same loop and a reader moving between them should not have to re-learn
 * where things are. Columns come off Tailwind's own scale, and they are counted
 * against the MAIN COLUMN rather than the window, since the shell holds a 212px
 * sidebar from `lg` up.
 *
 * `grid-cols-1` at the bottom end is what makes the no-horizontal-scrolling
 * promise structural rather than hopeful.
 *
 * One string, shared by the cards and by the skeleton that stands in for them,
 * so the loading state cannot settle into a different shape than the thing it
 * was predicting.
 */
const CARD_GRID = "grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4";

export default function SavedPage() {
  // The dataset still supplies the FURNITURE around the board — the
  // collections the chips are drawn from, the note counts behind each row's
  // badge, the live content types. The rows themselves now come from their own
  // request, because they are the part a filter narrows; see `useSavedShorts`.
  const {
    data,
    error: datasetError,
    refetch: refetchDataset,
  } = useDataset();
  // The board is this person's shortlist. An admin's payload also carries the
  // team's, each row already labelled with its owner by the server — so the
  // only thing left to decide here is which rows this person may act on.
  const session = useSession();
  const viewerId = session.user.id;
  const isAdmin = session.can("users.manage");

  const [query, setQuery] = React.useState("");
  const [activeCollection, setActiveCollection] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [openShort, setOpenShort] = React.useState<SavedShortDTO | null>(null);
  const [saverFilter, setSaverFilter] = React.useState<string>("all");
  const [dateFilter, setDateFilter] = React.useState<ResolvedDateFilter>({ id: "all" });
  const [sort, setSort] = React.useState<SortChoice>("newest");

  /**
   * Everything the server is being asked, in one object — the request and the
   * query key both, so the two cannot describe different boards.
   */
  const params = React.useMemo<SavedShortsQuery>(
    () => ({
      savedById: saverFilter === "all" ? undefined : saverFilter,
      savedAfter: dateFilter.since,
      ...SORT_QUERY[sort],
    }),
    [saverFilter, dateFilter, sort],
  );

  const {
    data: savedData,
    isLoading,
    isFetching,
    error: savedError,
    refetch: refetchSaved,
  } = useSavedShorts(params);

  /**
   * Either request failing is a failed page.
   *
   * The board is two reads now, and a half-rendered Saved page is worse than an
   * error: with the dataset down, the collection chips vanish and every row's
   * note badge reads zero — a board that looks complete and quietly
   * under-reports. Retrying refetches both, since whichever one failed, the
   * other is cheap and already cached.
   */
  const error = savedError ?? datasetError;
  const refetch = React.useCallback(() => {
    void refetchSaved();
    void refetchDataset();
  }, [refetchSaved, refetchDataset]);

  // Memoised so the fallback [] is not a fresh reference on every render,
  // which would defeat the search memo below.
  const saved = React.useMemo(() => savedData?.saved ?? [], [savedData]);
  const collections = React.useMemo(() => data?.collections ?? [], [data]);
  const noteCounts = data?.noteCounts.videos ?? {};
  // `SavedShortDTO` is a historical record of a bookmark and carries no content
  // types of its own — nor should it, since a label applied tomorrow is not a
  // fact about the moment the Short was saved. It is resolved live from the
  // dataset instead, by the same index every other surface uses.
  const contentTypeIndex = useVideoContentTypeResolutions();

  // A saved row flattened into what the single-Short view needs. The dialog
  // reads the labels live from the dataset itself, so nothing here goes stale
  // when the content type is changed inside it.
  const detailTarget = React.useMemo<ShortDetailTarget | null>(
    () =>
      openShort
        ? {
            videoId: openShort.videoId,
            youtubeVideoId: openShort.youtubeVideoId,
            title: openShort.title,
            channelId: openShort.channelId,
            channelName: openShort.channelName,
            channelAvatarUrl: openShort.channelAvatarUrl,
            niches: openShort.niches,
          }
        : null,
    [openShort],
  );

  /**
   * Global search across the research library: title, channel, niche,
   * collection name — plus the collection chip. This is the thing that keeps
   * the library useful once it outgrows a single screen.
   *
   * THESE TWO STAY IN THE BROWSER, and deliberately, for the same reason the
   * notes log keeps its text search here. Saver and date decide WHICH ROWS ARE
   * SENT — "Hana's saves" must not arrive as everybody's board with the rest
   * hidden — so they are query parameters. Search and the collection chip only
   * refine rows the server has already decided this person may read, they can
   * never widen that set, and both have to feel instant. If search ever needs to
   * reach text the payload does not carry, it becomes a parameter like the rest.
   */
  const filtered = React.useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const collectionNameById = new Map(collections.map((c) => [c.id, c.name.toLocaleLowerCase()]));

    return saved.filter((item) => {
      if (activeCollection && !item.collectionIds.includes(activeCollection)) return false;
      if (!needle) return true;

      const haystack = [
        item.title,
        item.channelName,
        item.channelHandle ?? "",
        ...item.niches.map((n) => n.name),
        ...item.collectionIds.map((id) => collectionNameById.get(id) ?? ""),
      ]
        .join(" ")
        .toLocaleLowerCase();

      return haystack.includes(needle);
    });
  }, [saved, collections, query, activeCollection]);

  /**
   * How many of the rows ON THE BOARD sit in each collection.
   *
   * Counted from the rows rather than read from `CollectionDTO.itemCount`,
   * which is the whole folder's size. With a saver or date filter on, the two
   * disagree — a chip reading "Ideas 12" above two visible rows is a number
   * that describes a board nobody is looking at. Unfiltered they are the same
   * figure, so this costs nothing and removes the case where it is wrong.
   */
  const countsByCollection = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of saved) {
      for (const id of item.collectionIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [saved]);

  const hasServerFilters = saverFilter !== "all" || dateFilter.id !== "all";

  const clearFilters = React.useCallback(() => {
    setSaverFilter("all");
    setDateFilter({ id: "all" });
    setActiveCollection(null);
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
        title="Saved"
        description="Shorts you kept, and how far they ran after you found them."
        actions={
          <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus />
            New collection
          </Button>
        }
      />

      {isLoading ? (
        // Shaped like the card it replaces — thumbnail, title, a line of
        // channel, a byline — and on the same grid, so nothing reflows when the
        // board arrives.
        <div className={CARD_GRID}>
          {Array.from({ length: 8 }, (_, i) => (
            <Card key={i} className="flex flex-col overflow-hidden">
              <Skeleton className="aspect-video w-full rounded-none" />
              <div className="flex flex-col gap-2 p-3">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="mt-2 h-3 w-1/2" />
              </div>
            </Card>
          ))}
        </div>
      ) : saved.length === 0 && !hasServerFilters ? (
        // Only when the board is GENUINELY empty. With a saver or date filter
        // on, an empty answer has to keep the filter bar on screen — otherwise
        // the controls that produced the emptiness disappear with the rows and
        // the only way back is a page reload.
        <Card>
          <EmptyState
            icon={<Bookmark />}
            title="Nothing saved yet"
            description="Save a Short from Winners or Outliers and it lands here, with the view count it had when you found it."
            action={
              <Button variant="primary" asChild>
                <Link href="/winners">
                  Browse Winners
                  <ArrowRight />
                </Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-1.5">
              <CollectionChip
                label="All saved"
                count={saved.length}
                active={activeCollection === null}
                onClick={() => setActiveCollection(null)}
              />
              {collections.map((collection) => (
                <CollectionChip
                  key={collection.id}
                  label={collection.name}
                  count={countsByCollection.get(collection.id) ?? 0}
                  active={activeCollection === collection.id}
                  onClick={() =>
                    setActiveCollection(activeCollection === collection.id ? null : collection.id)
                  }
                  collection={collection}
                  // ATTRIBUTED, NOT HIDDEN. An admin's board carries the team's
                  // folders, and filtering by one is a genuine read — the rows
                  // it reveals are real and each names who saved it. What made
                  // the chip wrong was silence: a bare "Ideas 12" next to rows
                  // that say "Saved by Hana" claims the folder is yours, and
                  // two people can both have an "Ideas". So the chip says whose
                  // it is, which is the same answer the row beside it gives.
                  owner={
                    collection.createdById === viewerId
                      ? null
                      : (collection.createdByName ?? UNKNOWN_AUTHOR_LABEL)
                  }
                />
              ))}
            </div>

            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Search saved Shorts and notes…"
              resultCount={query ? filtered.length : undefined}
              className="w-full lg:w-72"
            />
          </div>

          {/* Who saved it, when, and in what order — the three questions that
              turn an admin's merged board from a wall into something readable.
              They go to the server; see the note on `filtered`. */}
          <div className="flex flex-wrap items-center gap-2">
            {/* ADMINS ONLY, unlike the notes log's author filter beside it, and
                the difference is real rather than an oversight. A saved Short
                has no shared mode — a member's board is only ever their own —
                so "Anyone" and "Mine" would name the same board and the menu
                would be a control that does nothing. The notes log offers it to
                everybody because a colleague's shared note genuinely can be
                sitting in their list. */}
            {isAdmin ? (
              <SaverFilterMenu current={saverFilter} onChange={setSaverFilter} />
            ) : null}

            <FilterMenu
              label="Saved"
              value={DATE_FILTER_LABELS[dateFilter.id]}
              options={DATE_FILTER_IDS.map((id) => ({ id, label: DATE_FILTER_LABELS[id] }))}
              current={dateFilter.id}
              // Resolved in the handler, never during render, so the cut-off is
              // fixed at the moment the range is chosen — see `resolveDateFilter`.
              onChange={(value) => setDateFilter(resolveDateFilter(value as DateFilterId))}
            />

            <FilterMenu
              label="Sort"
              value={SORT_LABELS[sort]}
              options={(["newest", "oldest", "saver"] as SortChoice[]).map((id) => ({
                id,
                label: SORT_LABELS[id],
              }))}
              current={sort}
              onChange={(value) => setSort(value as SortChoice)}
            />

            {hasServerFilters || activeCollection ? (
              <button
                type="button"
                onClick={clearFilters}
                className="text-[11px] text-accent transition-colors hover:text-accent-hover"
              >
                Clear filters
              </button>
            ) : null}
          </div>

          {filtered.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Search />}
                title="Nothing matches"
                description="Search looks at the title, channel, niche and collection name. The saver and date filters are applied before that, on the server."
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
            // Dimmed rather than replaced while the next answer is in flight:
            // the rows on screen are still true, they are simply about to be
            // asked again with a slightly different question.
            <div
              className={cn(
                CARD_GRID,
                "transition-opacity duration-150",
                isFetching && "opacity-60",
              )}
            >
              {filtered.map((item) => (
                <SavedCard
                  key={item.id}
                  item={item}
                  collections={collections}
                  noteCount={noteCounts[item.videoId] ?? 0}
                  resolution={contentTypeIndex.get(item.videoId) ?? EMPTY_RESOLUTION}
                  isMine={item.savedById === viewerId}
                  onOpenShort={() => setOpenShort(item)}
                />
              ))}
            </div>
          )}
        </>
      )}

      <CreateCollectionDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ShortDetailDialog
        short={detailTarget}
        open={openShort !== null}
        onOpenChange={(open) => {
          if (!open) setOpenShort(null);
        }}
      />
    </PageContainer>
  );
}

/**
 * Filter the board by who saved it — rendered only for an admin.
 *
 * The roster it draws needs `users.manage`, which is the same permission that
 * makes this board hold more than one person's saves in the first place. The
 * caller gates the render; the `enabled` here is what stops the request being
 * made from a mounted-then-hidden copy.
 *
 * A MENU IS AN AFFORDANCE, NOT THE BOUNDARY. `listSavedShorts` ANDs whatever is
 * asked for with the ownership filter, so a member who hand-writes a
 * colleague's id into the query string gets the empty answer that contradiction
 * deserves — not their colleague's library. Pinned in
 * `saved-short-filters.test.ts`.
 *
 * "Mine" resolves against the SESSION server-side, so it cannot be aimed at
 * somebody else however the request is written.
 */
function SaverFilterMenu({
  current,
  onChange,
}: {
  current: string;
  onChange: (value: string) => void;
}) {
  const { data } = useEmployees();
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
      label="Saved by"
      value={value}
      options={options}
      current={current}
      onChange={onChange}
    />
  );
}

function CollectionChip({
  label,
  count,
  active,
  onClick,
  collection,
  owner = null,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  collection?: CollectionDTO;
  /**
   * Whose folder this is — null when it is the viewer's own, which is the case
   * that needs no label. Everything else is somebody named, or `a deleted
   * account` for a folder whose owner has left.
   */
  owner?: string | null;
}) {
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  return (
    <>
      <div className="group/chip relative inline-flex items-center">
        <button
          type="button"
          onClick={onClick}
          aria-pressed={active}
          // Spelled out for the screen reader rather than left to the visible
          // fragments, which read as three unrelated words in a row.
          aria-label={owner ? `${label}, ${owner}, ${count} saved` : undefined}
          title={owner ? `${label} — ${owner}` : undefined}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors duration-150",
            active
              ? "border-accent bg-accent-subtle text-foreground"
              : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
            collection ? "pr-7" : "",
          )}
        >
          {label}
          {owner ? (
            <span
              aria-hidden
              className="max-w-[90px] truncate font-normal text-subtle-foreground"
            >
              · {owner}
            </span>
          ) : null}
          <span className="tnum text-[11px] text-subtle-foreground">{count}</span>
        </button>

        {collection ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                // The owner travels into the label too: renaming or deleting a
                // colleague's folder is oversight an admin has, but not one
                // they should exercise by mistake on a chip they read as their
                // own.
                aria-label={
                  owner ? `Manage ${collection.name} (${owner})` : `Manage ${collection.name}`
                }
                className="absolute right-1 rounded p-0.5 text-subtle-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/chip:opacity-100 data-[state=open]:opacity-100"
              >
                <MoreHorizontal className="size-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                <Pencil />
                Rename
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem tone="danger" onSelect={() => setDeleteOpen(true)}>
                <Trash2 />
                Delete collection
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {collection ? (
        <>
          <RenameCollectionDialog
            collection={collection}
            open={renameOpen}
            onOpenChange={setRenameOpen}
          />
          <DeleteCollectionDialog
            collection={collection}
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
          />
        </>
      ) : null}
    </>
  );
}

function SavedCard({
  item,
  collections,
  noteCount,
  resolution,
  isMine,
  onOpenShort,
}: {
  item: SavedShortDTO;
  collections: readonly CollectionDTO[];
  noteCount: number;
  resolution: ContentTypeResolution;
  /**
   * Whether this card is the viewer's own save.
   *
   * False only on an admin's board, where the server hands back the whole
   * team's. Un-saving is "remove mine" server-side, so offering that button on
   * a colleague's card would be a control that silently does nothing.
   *
   * False is not the same as "somebody else's", though — see `isOrphaned`
   * below. A save whose owner has been deleted is nobody's, and it gets a
   * removal of its own rather than no removal at all.
   */
  isMine: boolean;
  onOpenShort: () => void;
}) {
  const unsave = useUnsaveShort();
  const clearOrphan = useRemoveOrphanedSave();

  // A THIRD CASE, not a variant of "not mine". `savedById` is `SetNull`, so a
  // save whose owner's account has gone arrives with no id and no name — which
  // is a card nobody could read and nobody could clear until both this label
  // and the button below stopped keying off ownership.
  const isOrphaned = item.savedById === null;

  /**
   * WHO SAVED IT — on every card, including your own.
   *
   * This used to print only on somebody else's, on the reasoning that your own
   * name is noise on your own shortlist. In a table that was merely awkward; in
   * a grid it is wrong. A blank line in a fixed byline slot reads as missing
   * data rather than as "mine", and an admin scanning a board that mixes their
   * saves with the team's has to infer ownership from an absence — which is the
   * same mistake the notes log fixed a round earlier.
   *
   * `isMine` still decides what you may DO with the card; it no longer decides
   * whether the card says whose it is.
   */
  const savedBy = item.savedByName ?? UNKNOWN_AUTHOR_LABEL;

  const growth = item.currentViews - item.viewsAtSave;
  const growthPct =
    item.viewsAtSave > 0 ? Math.round((growth / item.viewsAtSave) * 100) : null;

  const itemCollections = collections.filter((c) => item.collectionIds.includes(c.id));

  const removing = unsave.isPending || clearOrphan.isPending;

  return (
    <Card className="group flex min-w-0 flex-col overflow-hidden transition-colors duration-150 hover:border-border-strong">
      {/* THE THUMBNAIL LEADS, and that is the argument for this card existing at
          all. A saved Short is recognised by its frame long before its title —
          you remember the face, the caption, the colour of the hook — so a grid
          of frames is scannable in a way a grid of sentences is not. It takes
          the full width and the actions ride on top of it instead of claiming a
          column beside it.

          16:9 is what `youtubeThumbnailUrl` actually returns, so `object-cover`
          never crops in practice: the frame is shown exactly as YouTube
          generated it, and the ratio is declared so the card reserves its space
          before the image loads rather than jumping when it arrives. */}
      <div className="relative">
        <a
          href={youtubeShortsUrl(item.youtubeVideoId)}
          target="_blank"
          rel="noopener noreferrer"
          className="block"
          // The title below is the same link and is the accessible one. Two tab
          // stops onto one destination is noise for anybody on a keyboard.
          tabIndex={-1}
          aria-hidden
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={youtubeThumbnailUrl(item.youtubeVideoId)}
            alt=""
            width={320}
            height={180}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="aspect-video w-full bg-surface-sunken object-cover"
          />
        </a>

        {/* Says where the frame goes, since a bare image gives no clue that it
            leaves the app. Decorative — the real affordance is the title link
            and the whole thumbnail beneath it. */}
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 rounded border border-border bg-surface/90 px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
          <ExternalLink className="size-2.5" />
          YouTube
        </span>

        {/* The actions sit on a token-coloured plate rather than bare on the
            image: a ghost icon over an arbitrary video frame is legible on some
            Shorts and invisible on others, and it has to work in both themes.

            The plate reveals on hover, EXCEPT when the Short carries notes —
            that is information about the row rather than an affordance, and it
            has always been visible without hovering. The remove button keeps
            its own hover gate inside, so a Short with notes shows the note
            marker at rest and the destructive control only on approach. */}
        <div
          className={cn(
            "absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-md border border-border bg-surface/90 p-0.5 backdrop-blur-sm transition-opacity",
            noteCount > 0
              ? "opacity-100"
              : "opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100",
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onOpenShort}
                // Opens the single-Short view — notes, niche and content type.
                aria-label="Open this Short: notes, niche and content type"
                className={cn(noteCount > 0 && "text-accent")}
              >
                <StickyNote />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {noteCount > 0
                ? `${noteCount} ${noteCount === 1 ? "note" : "notes"} — open the Short`
                : "Open this Short — notes, niche and content type"}
            </TooltipContent>
          </Tooltip>

          {isMine || isOrphaned ? (
            <Button
              variant="ghost"
              size="icon-sm"
              // Two removals behind one button, because they are two different
              // acts. Un-saving takes a Short off the CALLER's own board and is
              // addressed by video. Clearing an orphan deletes a row that belongs
              // to nobody, so it is addressed by its own id: a deleted account can
              // leave several saves of the same Short and `videoId` would name
              // them all. Offering it to an admin is what stops a departed
              // colleague's shortlist sitting on the board for good — the whole
              // reason the card is labelled rather than merely unlabelled.
              aria-label={isOrphaned ? "Clear this save" : "Remove from saved"}
              loading={removing}
              onClick={() => {
                const done = {
                  onSuccess: () => toast.success("Removed from saved"),
                  onError: (e: unknown) =>
                    toast.error("Could not remove", {
                      description: e instanceof Error ? e.message : undefined,
                    }),
                };
                if (isOrphaned) clearOrphan.mutate(item.id, done);
                else unsave.mutate(item.videoId, done);
              }}
              className={cn(
                "text-subtle-foreground transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100",
                // Kept visible while the removal is in flight, or the spinner
                // vanishes the instant the pointer leaves the card and the
                // click looks like it did nothing.
                removing ? "opacity-100" : "opacity-0",
              )}
            >
              {removing ? null : <Trash2 />}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col p-3">
        <a
          href={youtubeShortsUrl(item.youtubeVideoId)}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 text-[13px] font-medium leading-snug text-foreground transition-colors hover:text-accent"
          title={item.title}
        >
          {/* Two lines, then trailing off. A title is the second thing read
              here, after the frame, and clamping it is what keeps every card in
              a row the same shape — the full text is one hover or one click
              away. `break-words` is what stops a pasted title with no spaces in
              it from widening the grid track. */}
          <span className="line-clamp-2 break-words">{item.title}</span>
        </a>

        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-subtle-foreground">
          <Link
            href={`/channels/${item.channelId}`}
            className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-muted-foreground transition-colors hover:text-accent"
          >
            <Avatar src={item.channelAvatarUrl} name={item.channelName} size={14} />
            <span className="truncate">{item.channelName}</span>
          </Link>

          {item.ownershipType === "own" ? (
            <Badge variant="accent" size="sm" className="shrink-0 tracking-wider">
              Own
            </Badge>
          ) : null}

          <NicheChips niches={item.niches} limit={1} size="sm" />

          <ContentTypeControl
            videoId={item.videoId}
            resolution={resolution}
            revealOnHover
            className="-ml-1"
          />

          {/* Everything between the channel and here is optional — the "Own"
              badge, the niche, the content type — so the separator is placed
              last rather than in front of any of them. The channel always
              renders, so there is always something to its left; a "·" with
              nothing before it reads as a link that failed to load. */}
          <span aria-hidden className="shrink-0 text-border-strong">
            ·
          </span>
          {/* When the Short was PUBLISHED — not when it was saved. Two different
              questions, and the second one is answered on the byline below. */}
          <span className="shrink-0">{formatDate(item.publishedAt)}</span>
        </div>

        {/* THE JOURNEY — what it was worth when it was found, and what it became.
            The most important thing on this screen: a Short saved at 1.2M now
            sitting at 4.8M is the feedback that tells a director their instinct
            was right, which is what makes the whole save-and-revisit loop worth
            maintaining. It kept its own column in the old table and it keeps its
            own rule here. */}
        <div className="mt-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-t border-border pt-2.5">
          <span className="tnum text-[13px] text-foreground">
            {formatCompactNumber(item.viewsAtSave)}
            <span className="mx-1 text-subtle-foreground">→</span>
            <span className="font-medium">{formatCompactNumber(item.currentViews)}</span>
          </span>
          <span
            className={cn(
              "tnum text-[10px]",
              growth > 0 ? "text-success" : "text-subtle-foreground",
            )}
          >
            {growth > 0
              ? `+${formatCompactNumber(growth)}${growthPct !== null ? ` (+${growthPct}%)` : ""}`
              : "no change yet"}
          </span>
        </div>

        {item.outlierMultipleAtSave !== null ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="tnum mt-1 w-fit cursor-default text-[11px] text-muted-foreground">
                {item.outlierMultipleAtSave >= 10
                  ? Math.round(item.outlierMultipleAtSave)
                  : item.outlierMultipleAtSave.toFixed(1)}
                × at save
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Its multiple of the channel median at the moment you saved it
              {item.channelMedianAtSave !== null
                ? ` (median was ${formatCompactNumber(item.channelMedianAtSave)})`
                : ""}
              . Kept as a historical fact rather than recomputed.
            </TooltipContent>
          </Tooltip>
        ) : null}

        {/* The floor of the card. `mt-auto` is what makes the grid readable:
            every card in a row ends on the same line, so the byline is always
            the last line and always in the same place, whatever varies above
            it. The collections line goes ABOVE the byline for the same reason —
            it is the optional one, so putting it last would let the byline
            float up and down from card to card. */}
        <div className="mt-auto flex flex-col gap-1 pt-2.5 text-[11px] text-subtle-foreground">
          {itemCollections.length > 0 ? (
            <span
              className="flex min-w-0 items-center gap-1"
              title={itemCollections.map((c) => c.name).join(", ")}
            >
              <FolderOpen className="size-3 shrink-0" />
              <span className="truncate">
                {itemCollections.map((c) => c.name).join(", ")}
              </span>
            </span>
          ) : null}

          {/* The name truncates and the date does not: "Saved by Alexandra
              Konst…" still answers whose card this is, whereas a truncated
              "12 Aug…" answers nothing. The absolute date is the visible one
              and the relative form stays in the tooltip — a saved Short is
              placed against what the channel was doing at the time, and "1 year
              ago" cannot do that. */}
          <span
            className="flex min-w-0 items-center gap-1"
            title={`Saved by ${savedBy} ${formatRelativeTime(item.savedAt)}`}
          >
            <Bookmark className="size-3 shrink-0" />
            <span className="truncate">Saved by {savedBy}</span>
            <span aria-hidden className="shrink-0 text-border-strong">
              ·
            </span>
            <span className="tnum shrink-0">{formatDate(item.savedAt)}</span>
          </span>
        </div>
      </div>
    </Card>
  );
}

function CreateCollectionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {open ? <CreateCollectionForm onOpenChange={onOpenChange} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CreateCollectionForm({ onOpenChange }: { onOpenChange: (o: boolean) => void }) {
  const [name, setName] = React.useState("");
  const create = useCreateCollection();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) return;
        create.mutate(trimmed, {
          onSuccess: ({ collection }) => {
            toast.success(`Collection "${collection.name}" created`);
            onOpenChange(false);
          },
          onError: (e) =>
            toast.error("Could not create that collection", {
              description: e instanceof Error ? e.message : undefined,
            }),
        });
      }}
    >
      <DialogHeader>
        <DialogTitle>New collection</DialogTitle>
        <DialogDescription>
          A folder for saved Shorts — &ldquo;GTA Hooks&rdquo;, &ldquo;Ideas to
          Recreate&rdquo;, whatever fits your process.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-2">
        <Label htmlFor="collection-name">Name</Label>
        <Input
          id="collection-name"
          autoFocus
          value={name}
          maxLength={60}
          placeholder="e.g. GTA Hooks"
          onChange={(event) => setName(event.target.value)}
        />
        <FieldHint>A Short can sit in several collections, or none at all.</FieldHint>
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={create.isPending} disabled={!name.trim()}>
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}

function RenameCollectionDialog({
  collection,
  open,
  onOpenChange,
}: {
  collection: CollectionDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {/* Mounted only while open, so the field initialises from the current
            name each time instead of being resynced from an effect. */}
        {open ? (
          <RenameCollectionForm collection={collection} onOpenChange={onOpenChange} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameCollectionForm({
  collection,
  onOpenChange,
}: {
  collection: CollectionDTO;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = React.useState(collection.name);
  const rename = useRenameCollection();

  return (
    <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if (!trimmed) return;
            rename.mutate(
              { id: collection.id, name: trimmed },
              {
                onSuccess: () => {
                  toast.success("Collection renamed");
                  onOpenChange(false);
                },
                onError: (e) =>
                  toast.error("Could not rename", {
                    description: e instanceof Error ? e.message : undefined,
                  }),
              },
            );
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename collection</DialogTitle>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-2">
            <Label htmlFor="rename-collection">Name</Label>
            <Input
              id="rename-collection"
              autoFocus
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
            />
          </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={rename.isPending}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

function DeleteCollectionDialog({
  collection,
  open,
  onOpenChange,
}: {
  collection: CollectionDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useDeleteCollection();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete &ldquo;{collection.name}&rdquo;?</DialogTitle>
          <DialogDescription>This removes the folder, not the Shorts.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {collection.itemCount === 0
              ? "This collection is empty."
              : `${collection.itemCount} saved ${collection.itemCount === 1 ? "Short" : "Shorts"} will stay saved and simply leave this collection.`}{" "}
            Nothing is removed from your library.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={remove.isPending}
            onClick={() =>
              remove.mutate(collection.id, {
                onSuccess: () => {
                  toast.success(`Collection "${collection.name}" deleted`);
                  onOpenChange(false);
                },
                onError: (e) =>
                  toast.error("Could not delete", {
                    description: e instanceof Error ? e.message : undefined,
                  }),
              })
            }
          >
            Delete collection
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { EM_DASH };
