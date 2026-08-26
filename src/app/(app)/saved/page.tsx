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
import { NicheChips } from "@/components/niches/niche-chip";
import { ShortNotesDialog } from "@/components/notes/notes-panel";
import { useDataset } from "@/hooks/use-dataset";
import {
  useCreateCollection,
  useDeleteCollection,
  useRenameCollection,
  useUnsaveShort,
} from "@/hooks/use-research";
import type { CollectionDTO, SavedShortDTO } from "@/lib/dto";
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
export default function SavedPage() {
  const { data, isLoading, error, refetch } = useDataset();
  const [query, setQuery] = React.useState("");
  const [activeCollection, setActiveCollection] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [noteTarget, setNoteTarget] = React.useState<SavedShortDTO | null>(null);

  // Memoised so the fallback [] is not a fresh reference on every render,
  // which would defeat the search memo below.
  const saved = React.useMemo(() => data?.savedShorts ?? [], [data]);
  const collections = React.useMemo(() => data?.collections ?? [], [data]);
  const noteCounts = data?.noteCounts.videos ?? {};

  /**
   * Global search across the research library: title, channel, niche,
   * collection name. This is the thing that keeps the library useful once it
   * outgrows a single screen.
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
        <Skeleton className="h-64 w-full rounded-lg" />
      ) : saved.length === 0 ? (
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
                  count={collection.itemCount}
                  active={activeCollection === collection.id}
                  onClick={() =>
                    setActiveCollection(activeCollection === collection.id ? null : collection.id)
                  }
                  collection={collection}
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

          {filtered.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Search />}
                title="Nothing matches"
                description="Search looks at the title, channel, niche and collection name."
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setQuery("");
                      setActiveCollection(null);
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            </Card>
          ) : (
            <Card className="overflow-hidden">
              <div className="flex items-center gap-3 border-b border-border bg-surface-sunken px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
                <span className="w-10 shrink-0" />
                <span className="min-w-0 flex-1">Short</span>
                <span className="hidden w-[140px] shrink-0 text-right sm:block">
                  Views since saved
                </span>
                <span className="hidden w-[80px] shrink-0 text-right md:block">Saved</span>
                <span className="w-[64px] shrink-0" />
              </div>

              <div className="flex flex-col">
                {filtered.map((item) => (
                  <SavedRow
                    key={item.id}
                    item={item}
                    collections={collections}
                    noteCount={noteCounts[item.videoId] ?? 0}
                    onAddNote={() => setNoteTarget(item)}
                  />
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      <CreateCollectionDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ShortNotesDialog
        videoId={noteTarget?.videoId ?? null}
        videoTitle={noteTarget?.title ?? ""}
        open={noteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setNoteTarget(null);
        }}
      />
    </PageContainer>
  );
}

function CollectionChip({
  label,
  count,
  active,
  onClick,
  collection,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  collection?: CollectionDTO;
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
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors duration-150",
            active
              ? "border-accent bg-accent-subtle text-foreground"
              : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
            collection ? "pr-7" : "",
          )}
        >
          {label}
          <span className="tnum text-[11px] text-subtle-foreground">{count}</span>
        </button>

        {collection ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Manage ${collection.name}`}
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

function SavedRow({
  item,
  collections,
  noteCount,
  onAddNote,
}: {
  item: SavedShortDTO;
  collections: readonly CollectionDTO[];
  noteCount: number;
  onAddNote: () => void;
}) {
  const unsave = useUnsaveShort();

  const growth = item.currentViews - item.viewsAtSave;
  const growthPct =
    item.viewsAtSave > 0 ? Math.round((growth / item.viewsAtSave) * 100) : null;

  const itemCollections = collections.filter((c) => item.collectionIds.includes(c.id));

  return (
    <div className="group flex items-center gap-3 border-b border-border px-4 py-3 transition-colors last:border-b-0 hover:bg-surface-hover/40">
      <a
        href={youtubeShortsUrl(item.youtubeVideoId)}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0"
        tabIndex={-1}
        aria-hidden
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={youtubeThumbnailUrl(item.youtubeVideoId)}
          alt=""
          width={40}
          height={54}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="h-[54px] w-10 rounded object-cover ring-1 ring-border"
        />
      </a>

      <div className="min-w-0 flex-1">
        <a
          href={youtubeShortsUrl(item.youtubeVideoId)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex max-w-full items-center gap-1.5 text-[13px] font-medium text-foreground transition-colors hover:text-accent"
          title={item.title}
        >
          <span className="truncate">{item.title}</span>
          <ExternalLink className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-50" />
        </a>

        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-subtle-foreground">
          <Link
            href={`/channels/${item.channelId}`}
            className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-accent"
          >
            <Avatar src={item.channelAvatarUrl} name={item.channelName} size={14} />
            <span className="max-w-[150px] truncate">{item.channelName}</span>
          </Link>

          {item.ownershipType === "own" ? (
            <Badge variant="accent" size="sm" className="tracking-wider">
              Own
            </Badge>
          ) : null}

          <NicheChips niches={item.niches} limit={1} size="sm" />

          <span aria-hidden className="text-border-strong">
            ·
          </span>
          <span>{formatDate(item.publishedAt)}</span>

          {item.outlierMultipleAtSave !== null ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="tnum cursor-default text-muted-foreground">
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

          {itemCollections.length > 0 ? (
            <span className="inline-flex items-center gap-1 text-subtle-foreground">
              <FolderOpen className="size-3" />
              {itemCollections.map((c) => c.name).join(", ")}
            </span>
          ) : null}
        </div>
      </div>

      {/* The journey: what it was worth when found, and what it became. */}
      <div className="hidden w-[140px] shrink-0 flex-col items-end gap-0.5 sm:flex">
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

      <div className="hidden w-[80px] shrink-0 text-right md:block">
        <span className="text-[11px] text-subtle-foreground">
          {formatRelativeTime(item.savedAt)}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onAddNote}
              aria-label="Notes"
              className={cn(
                "transition-opacity",
                noteCount > 0
                  ? "text-accent opacity-100"
                  : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
              )}
            >
              <StickyNote />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {noteCount > 0 ? `${noteCount} ${noteCount === 1 ? "note" : "notes"}` : "Add a note"}
          </TooltipContent>
        </Tooltip>

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Remove from saved"
          loading={unsave.isPending}
          onClick={() =>
            unsave.mutate(item.videoId, {
              onSuccess: () => toast.success("Removed from saved"),
              onError: (e) =>
                toast.error("Could not remove", {
                  description: e instanceof Error ? e.message : undefined,
                }),
            })
          }
          className="text-subtle-foreground opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
        >
          {unsave.isPending ? null : <Trash2 />}
        </Button>
      </div>
    </div>
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
