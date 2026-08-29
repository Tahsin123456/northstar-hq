"use client";

import * as React from "react";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
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
import { FieldHint, Input, Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { contentTypeColor } from "./content-type-chip";
import {
  useCreateContentType,
  useDeleteContentType,
  useRenameContentType,
  useReorderContentTypes,
  useSetContentTypeActive,
} from "@/hooks/use-content-types";
import { ApiError } from "@/lib/api-client";
import type { ContentTypeDTO } from "@/lib/dto";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The catalogue, with every verb that acts on it.
 *
 * ONE CENTRALISED LIST AND ONE EDITING SURFACE. A content type is an org-wide
 * tag now — `[organizationId, slug]`-unique, numbered and coloured once, and
 * reordered as a single complete list — so there is exactly one place it can be
 * managed from and this is it. Two screens that both write a taxonomy are two
 * chances for the rules to drift.
 *
 * A component rather than page-local markup because the page around it owns the
 * search box: reordering has to work against the COMPLETE catalogue even while
 * the reader is looking at three matching rows, so the two halves have to be
 * able to hold different lists. See `reorderable` below.
 */
export function ContentTypeManager({
  contentTypes,
  reorderable = true,
  canManage,
  className,
}: {
  /** What to render — ARCHIVED TYPES INCLUDED, see `move`. */
  contentTypes: readonly ContentTypeDTO[];
  /**
   * Whether the up/down controls are offered.
   *
   * False while a search is active. The server refuses a partial order, and
   * rightly: an order written from filtered rows would have to invent positions
   * for everything the search hid. Rather than reconstruct the full list from a
   * partial one — which is the bug, not the fix — the controls simply go away
   * until the search is cleared.
   */
  reorderable?: boolean;
  canManage: boolean;
  className?: string;
}) {
  const reorder = useReorderContentTypes();
  const [showArchived, setShowArchived] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);

  // The COMPLETE list, in stored order. The rows rendered may be a subset, but
  // every reorder is written against this — the server refuses a partial order,
  // and rightly: appending the hidden archived types would silently drag them
  // all to the bottom of a list nobody was looking at.
  const all = contentTypes;
  const active = React.useMemo(() => all.filter((type) => type.isActive), [all]);
  const archivedCount = all.length - active.length;
  const visible = showArchived ? all : active;

  /**
   * Moves one row within the VISIBLE list, then rebuilds the full order.
   *
   * The visible order is spliced back into the positions the visible rows
   * already occupy, so archived rows keep their place between them. Moving
   * "Ranking" up past a hidden archived type therefore does what it looks like
   * it does — it swaps with the next thing you can see, not the next thing in
   * the array.
   */
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= visible.length) return;

    const reordered = [...visible];
    const [moved] = reordered.splice(index, 1);
    if (!moved) return;
    reordered.splice(target, 0, moved);

    const visibleIds = new Set(visible.map((type) => type.id));
    let cursor = 0;
    const orderedIds = all.map((type) =>
      visibleIds.has(type.id) ? (reordered[cursor++]?.id ?? type.id) : type.id,
    );

    reorder.mutate(
      { orderedIds },
      {
        onError: (error) =>
          toast.error("Could not reorder those content types", {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <section className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-[14px] font-medium text-foreground">Content types</h2>
          <span className="text-[11px] text-subtle-foreground">
            {active.length} {active.length === 1 ? "type" : "types"}
            {archivedCount > 0 ? ` · ${archivedCount} archived` : ""}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {archivedCount > 0 ? (
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground">
              <Switch checked={showArchived} onCheckedChange={setShowArchived} />
              Show archived
            </label>
          ) : null}

          {canManage ? (
            <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus />
              New type
            </Button>
          ) : null}
        </div>
      </div>

      <Card className="divide-y divide-border overflow-hidden">
        {visible.length === 0 ? (
          <div className="px-4 py-6">
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              No content types yet. They are whatever vocabulary your team actually
              argues in &mdash; &ldquo;Funny Moment&rdquo;, &ldquo;Ranking&rdquo;,
              &ldquo;Cutscene&rdquo;. Until there is at least one, Shorts cannot be
              classified at all.
            </p>
            {canManage ? (
              <Button
                variant="secondary"
                size="sm"
                className="mt-3"
                onClick={() => setCreateOpen(true)}
              >
                <Plus />
                Create the first one
              </Button>
            ) : null}
          </div>
        ) : (
          visible.map((contentType, index) => (
            <ContentTypeRow
              key={contentType.id}
              contentType={contentType}
              canManage={canManage}
              onMoveUp={reorderable && index > 0 ? () => move(index, -1) : undefined}
              onMoveDown={
                reorderable && index < visible.length - 1 ? () => move(index, 1) : undefined
              }
              reordering={reorder.isPending}
            />
          ))
        )}
      </Card>

      <p className="px-1 text-[11px] leading-relaxed text-subtle-foreground">
        One list for the whole team. Any channel and any Short can carry any of these
        tags, whichever niche it belongs to. Archiving keeps everything already tagged;
        the label stays, the type simply stops being offered on new work. Deleting is
        only possible when nothing references it at all, because a classification is a
        judgement somebody made that is recorded nowhere else.
      </p>

      <CreateContentTypeDialog open={createOpen} onOpenChange={setCreateOpen} />
    </section>
  );
}

function ContentTypeRow({
  contentType,
  canManage,
  onMoveUp,
  onMoveDown,
  reordering,
}: {
  contentType: ContentTypeDTO;
  canManage: boolean;
  /** Undefined at the ends of the list, which is what disables the control. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  reordering: boolean;
}) {
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const setActive = useSetContentTypeActive();

  const toggleActive = () => {
    setActive.mutate(
      { id: contentType.id, isActive: !contentType.isActive },
      {
        onSuccess: () =>
          toast.success(
            contentType.isActive
              ? `“${contentType.name}” archived`
              : `“${contentType.name}” restored`,
            {
              description: contentType.isActive
                ? "Everything already tagged with it keeps the label."
                : undefined,
            },
          ),
        onError: (error) =>
          toast.error("Could not update that content type", {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <>
      <div
        className={cn(
          "group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-hover/40",
          !contentType.isActive && "opacity-70",
        )}
      >
        {/* The squared dot, matching the chip this type renders as everywhere
            else. A round one would read as a niche. */}
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-[2px]",
            !contentType.isActive && "opacity-50",
          )}
          style={{ background: contentTypeColor(contentType.colorIndex) }}
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13px] font-medium text-foreground">
              {contentType.name}
            </span>
            {!contentType.isActive ? (
              <Badge variant="outline" size="sm">
                Archived
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-[11px] text-subtle-foreground">
            {/* Both counts, always shown — "0 Shorts · 0 channels" is the fact
                that decides whether this type can be deleted, so hiding either
                when zero would hide the answer to the only question this row
                raises. */}
            <span className="tnum">{formatNumber(contentType.videoCount)}</span>{" "}
            {contentType.videoCount === 1 ? "Short" : "Shorts"}
            {" · "}
            <span className="tnum">{formatNumber(contentType.channelCount)}</span>{" "}
            {contentType.channelCount === 1 ? "channel" : "channels"}
          </p>
        </div>

        {canManage && (onMoveUp || onMoveDown) ? (
          /*
           * Up/down rather than drag. These lists are short, so two buttons say
           * exactly what they do, work from a keyboard, and cannot half-commit
           * a drag into a write.
           */
          <div className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Move ${contentType.name} up`}
              disabled={!onMoveUp || reordering}
              onClick={onMoveUp}
            >
              <ChevronUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Move ${contentType.name} down`}
              disabled={!onMoveDown || reordering}
              onClick={onMoveDown}
            >
              <ChevronDown />
            </Button>
          </div>
        ) : null}

        {canManage ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions for ${contentType.name}`}
                className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                <Pencil />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={toggleActive} disabled={setActive.isPending}>
                {contentType.isActive ? <Archive /> : <ArchiveRestore />}
                {contentType.isActive ? "Archive" : "Restore"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem tone="danger" onSelect={() => setDeleteOpen(true)}>
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      <RenameContentTypeDialog
        contentType={contentType}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />
      <DeleteContentTypeDialog
        contentType={contentType}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </>
  );
}

function CreateContentTypeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {open ? <CreateForm onOpenChange={onOpenChange} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CreateForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const [name, setName] = React.useState("");
  const create = useCreateContentType();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) return;
        create.mutate(
          { name: trimmed },
          {
            onSuccess: ({ contentType }) => {
              toast.success(`Content type “${contentType.name}” created`);
              onOpenChange(false);
            },
            onError: (error) =>
              toast.error("Could not create that content type", {
                description: error instanceof Error ? error.message : undefined,
              }),
          },
        );
      }}
    >
      <DialogHeader>
        <DialogTitle>New content type</DialogTitle>
        <DialogDescription>
          Describe the Short itself, not the channel — “Funny Moment”, “Ranking”,
          “Cutscene”. It is available to every channel and every Short straight away.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-2">
        <Label htmlFor="content-type-name">Name</Label>
        <Input
          id="content-type-name"
          autoFocus
          value={name}
          maxLength={48}
          placeholder="e.g. Ranking"
          onChange={(event) => setName(event.target.value)}
        />
        <FieldHint>
          Names are case-insensitive, so “Ranking” and “ranking” are the same type.
        </FieldHint>
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={create.isPending}
          disabled={!name.trim()}
        >
          Create
        </Button>
      </DialogFooter>
    </form>
  );
}

function RenameContentTypeDialog({
  contentType,
  open,
  onOpenChange,
}: {
  contentType: ContentTypeDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {open ? (
          <RenameForm contentType={contentType} onOpenChange={onOpenChange} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({
  contentType,
  onOpenChange,
}: {
  contentType: ContentTypeDTO;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = React.useState(contentType.name);
  const rename = useRenameContentType();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) return;
        rename.mutate(
          { id: contentType.id, name: trimmed },
          {
            onSuccess: () => {
              toast.success("Content type renamed");
              onOpenChange(false);
            },
            onError: (error) =>
              toast.error("Could not rename that content type", {
                description: error instanceof Error ? error.message : undefined,
              }),
          },
        );
      }}
    >
      <DialogHeader>
        <DialogTitle>Rename content type</DialogTitle>
        <DialogDescription>
          Every channel and Short tagged with it keeps the tag. The new name appears
          everywhere at once, including on work classified months ago.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-2">
        <Label htmlFor="rename-content-type">Name</Label>
        <Input
          id="rename-content-type"
          autoFocus
          value={name}
          maxLength={48}
          onChange={(event) => setName(event.target.value)}
        />
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={rename.isPending}
          disabled={!name.trim()}
        >
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Delete, and the refusal that usually replaces it.
 *
 * The server answers a delete of an in-use type with a 400 whose `details`
 * carry the counts and whether archiving is available. Those are surfaced as a
 * second state of this dialog with the archive button right there, rather than
 * as a toast that closes and leaves the user to find the menu again — the
 * refusal is not an error the user made, it is the product telling them which
 * of the two verbs they wanted.
 */
function DeleteContentTypeDialog({
  contentType,
  open,
  onOpenChange,
}: {
  contentType: ContentTypeDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useDeleteContentType();
  const setActive = useSetContentTypeActive();
  const [refusal, setRefusal] = React.useState<{
    message: string;
    canDeactivate: boolean;
  } | null>(null);

  // The server is the only place that knows the true counts (a niche-scoped
  // member cannot see the whole tracker), so the pre-check here is only a hint
  // and the refusal below is what actually decides.
  const looksInUse = contentType.videoCount > 0 || contentType.channelCount > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setRefusal(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete “{contentType.name}”?</DialogTitle>
          <DialogDescription>
            {refusal
              ? "This type is still in use."
              : "This removes the type and its assignments."}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {refusal
              ? refusal.message
              : looksInUse
                ? `“${contentType.name}” is on ${formatNumber(contentType.videoCount)} ${contentType.videoCount === 1 ? "Short" : "Shorts"} and ${formatNumber(contentType.channelCount)} ${contentType.channelCount === 1 ? "channel" : "channels"}. Deleting it destroys those classifications — they are judgements somebody made and are recorded nowhere else. Archiving keeps them and stops the type being offered on new work.`
                : "Nothing carries this type, so nothing is lost. No Short, channel or view count is affected — a content type is only a label."}
          </p>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>

          {(refusal ? refusal.canDeactivate : looksInUse && contentType.isActive) ? (
            <Button
              variant="primary"
              loading={setActive.isPending}
              onClick={() =>
                setActive.mutate(
                  { id: contentType.id, isActive: false },
                  {
                    onSuccess: () => {
                      toast.success(`“${contentType.name}” archived`, {
                        description:
                          "Everything already tagged with it keeps the label.",
                      });
                      onOpenChange(false);
                    },
                    onError: (error) =>
                      toast.error("Could not archive that content type", {
                        description: error instanceof Error ? error.message : undefined,
                      }),
                  },
                )
              }
            >
              <Archive />
              Archive instead
            </Button>
          ) : null}

          {refusal ? null : (
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(contentType.id, {
                  onSuccess: () => {
                    toast.success(`Content type “${contentType.name}” deleted`);
                    onOpenChange(false);
                  },
                  onError: (error) => {
                    // The refusal is data, not a failure: it carries the counts
                    // and whether archiving is possible, so it is rendered in
                    // place rather than thrown away into a toast.
                    if (error instanceof ApiError && error.code === "INVALID_INPUT") {
                      setRefusal({
                        message: error.message,
                        canDeactivate: error.details?.canDeactivate === true,
                      });
                      return;
                    }
                    toast.error("Could not delete that content type", {
                      description: error instanceof Error ? error.message : undefined,
                    });
                  },
                })
              }
            >
              Delete
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
