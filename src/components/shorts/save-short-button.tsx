"use client";

import * as React from "react";
import { Bookmark, BookmarkCheck, Check, FolderPlus, Plus } from "lucide-react";
import { toast } from "sonner";
import type { FeedShort } from "@/hooks/use-shorts-feed";
import { useDataset } from "@/hooks/use-dataset";
import { useDatasetFormat } from "@/hooks/dataset-format-context";
import {
  useCreateCollection,
  useSaveShort,
  useSetSavedCollections,
  useUnsaveShort,
} from "@/hooks/use-research";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSession } from "@/components/providers/session-provider";
import { cn } from "@/lib/utils";

/**
 * Save / unsave a Short, and file it into collections.
 *
 * One click saves — no dialog, no required collection. The whole point of the
 * discovery workflow is that spotting something interesting and keeping it
 * costs nothing; forcing a filing decision at that moment is what stops people
 * saving at all. Collections are a second, optional gesture from the same
 * control.
 *
 * The current view count and outlier multiple are captured at save time so the
 * Saved page can later show how far the Short ran after it was found.
 */
export function SaveShortButton({
  short,
  size = "icon-sm",
}: {
  short: FeedShort;
  size?: "icon-sm" | "sm";
}) {
  const { data } = useDataset();
  // The subtree's product decides the NOUN in this control's labels — the
  // button is mounted on both feeds, and "Save this Short" over a 20-minute
  // video is the pay-attention-to-me kind of wrong. Read from context rather
  // than a prop for the same reason `useDataset` reads it: every existing
  // Shorts call site keeps meaning what it always meant, untouched.
  const format = useDatasetFormat();
  const noun = format === "shorts" ? "Short" : "video";
  const save = useSaveShort();
  const unsave = useUnsaveShort();
  const setCollections = useSetSavedCollections();
  const createCollection = useCreateCollection();

  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");

  const viewerId = useSession().user.id;

  // The viewer's own folders, never the team's. `listCollections` widens to
  // everyone's for an admin, which is right for a read — but filing is not a
  // read. `setSavedShortCollections` scopes to `createdById: ownerId`, so a
  // colleague's folder offered here is a menu item that answers the click with
  // "One or more of those collections no longer exists" while still sitting in
  // the open menu above the toast. Reading somebody's folders and putting a
  // Short in one are different authorities; this control only has the second.
  const collections = React.useMemo(
    () => (data?.collections ?? []).filter((c) => c.createdById === viewerId),
    [data?.collections, viewerId],
  );
  // `savedById`, not just `videoId`. Saves are per person now, so the payload
  // can legitimately hold two rows for one Short — and an admin's holds the
  // whole team's. Matching on the video alone would point this button at
  // somebody else's save: the record it reads collections from, and the one
  // the server would actually mutate, would be different rows.
  const savedRecord = data?.savedShorts.find(
    (s) => s.videoId === short.video.id && s.savedById === viewerId,
  );
  const isSaved = Boolean(savedRecord);
  const pending = save.isPending || unsave.isPending;

  const handleToggle = () => {
    if (isSaved) {
      unsave.mutate(short.video.id, {
        onSuccess: () => toast.success("Removed from saved"),
        onError: (e) =>
          toast.error("Could not unsave", {
            description: e instanceof Error ? e.message : undefined,
          }),
      });
      return;
    }

    save.mutate(
      {
        videoId: short.video.id,
        channelMedianAtSave: short.channelMedianViews,
        outlierMultipleAtSave: short.outlierMultiple,
      },
      {
        onSuccess: () => toast.success("Saved", { description: short.video.title }),
        onError: (e) =>
          toast.error(`Could not save that ${noun}`, {
            description: e instanceof Error ? e.message : undefined,
          }),
      },
    );
  };

  const toggleCollection = (collectionId: string) => {
    if (!savedRecord) return;
    const next = savedRecord.collectionIds.includes(collectionId)
      ? savedRecord.collectionIds.filter((id) => id !== collectionId)
      : [...savedRecord.collectionIds, collectionId];

    setCollections.mutate(
      { videoId: short.video.id, collectionIds: next as string[] },
      {
        onError: (e) =>
          toast.error("Could not update collections", {
            description: e instanceof Error ? e.message : undefined,
          }),
      },
    );
  };

  const submitNewCollection = () => {
    const name = newName.trim();
    if (!name) return;
    createCollection.mutate(name, {
      onSuccess: ({ collection }) => {
        setNewName("");
        setCreating(false);
        if (savedRecord) {
          setCollections.mutate({
            videoId: short.video.id,
            collectionIds: [...savedRecord.collectionIds, collection.id],
          });
        }
        toast.success(`Collection "${collection.name}" created`);
      },
      onError: (e) =>
        toast.error("Could not create that collection", {
          description: e instanceof Error ? e.message : undefined,
        }),
    });
  };

  const saveButton = (
    <Button
      variant="ghost"
      size={size}
      onClick={handleToggle}
      loading={pending}
      aria-label={isSaved ? "Remove from saved" : `Save this ${noun}`}
      aria-pressed={isSaved}
      className={cn(
        "transition-opacity",
        isSaved
          ? "text-accent opacity-100"
          : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
      )}
    >
      {pending ? null : isSaved ? <BookmarkCheck /> : <Bookmark />}
    </Button>
  );

  return (
    <div className="flex items-center">
      <Tooltip>
        <TooltipTrigger asChild>{saveButton}</TooltipTrigger>
        <TooltipContent>{isSaved ? "Saved — click to remove" : `Save this ${noun}`}</TooltipContent>
      </Tooltip>

      {/* Collection filing only appears once a Short is actually saved. */}
      {isSaved ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Add to a collection"
              className="text-subtle-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
            >
              <FolderPlus />
            </Button>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" className="min-w-[220px]">
            <DropdownMenuLabel>Collections</DropdownMenuLabel>

            {collections.length === 0 && !creating ? (
              <div className="px-2 py-1.5 text-[12px] text-muted-foreground">
                No collections yet.
              </div>
            ) : null}

            {collections.map((collection) => {
              const active = savedRecord?.collectionIds.includes(collection.id) ?? false;
              return (
                <DropdownMenuItem
                  key={collection.id}
                  onSelect={(event) => {
                    // Keep the menu open so several collections can be toggled
                    // in one pass.
                    event.preventDefault();
                    toggleCollection(collection.id);
                  }}
                >
                  <span className="flex w-full items-center justify-between gap-3">
                    <span className="truncate">{collection.name}</span>
                    {active ? <Check className="size-3.5 shrink-0 text-accent" /> : null}
                  </span>
                </DropdownMenuItem>
              );
            })}

            <DropdownMenuSeparator />

            {creating ? (
              <div className="flex items-center gap-1.5 px-1 py-1">
                <Input
                  autoFocus
                  value={newName}
                  placeholder="Collection name"
                  maxLength={60}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") submitNewCollection();
                    if (e.key === "Escape") {
                      setCreating(false);
                      setNewName("");
                    }
                  }}
                  className="h-7 text-[12px]"
                />
                <Button
                  variant="primary"
                  size="sm"
                  className="h-7 shrink-0"
                  loading={createCollection.isPending}
                  onClick={submitNewCollection}
                >
                  Add
                </Button>
              </div>
            ) : (
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  setCreating(true);
                }}
              >
                <Plus />
                New collection
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
