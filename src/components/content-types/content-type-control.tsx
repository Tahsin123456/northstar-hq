"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Minus, Plus, Settings2, Tag } from "lucide-react";
import { toast } from "sonner";
import type { ContentTypeDTO } from "@/lib/dto";
import {
  useActiveContentTypes,
  useAssignContentTypeToVideos,
  useContentTypesByIds,
  useCreateContentType,
  useSetVideoContentTypes,
} from "@/hooks/use-content-types";
import { useOptionalSession } from "@/components/providers/session-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContentTypeChips, contentTypeColor } from "./content-type-chip";
import { cn } from "@/lib/utils";

/**
 * THE content-type assignment control.
 *
 * One component, four surfaces — the Shorts table on a channel, Winners,
 * Outliers and Saved. Writing it four times is how the same gesture ends up
 * meaning four slightly different things, and classification only pays off if a
 * director can do it wherever they happen to notice something.
 *
 * THE GESTURE
 * Clicking a type files the Short under that type and nothing else, then
 * closes. That is the whole interaction for the overwhelmingly common case: a
 * Short is one kind of thing. Clicking the type it already carries clears it.
 *
 * Multiple types are supported because the data model allows them, but they are
 * reached through the small +/− button on the right of each row, which leaves
 * the popover open. Nobody is asked up front whether they want single or
 * multiple select — the default gesture answers for them, and the second one is
 * there when it is actually needed.
 *
 * WHAT IT OFFERS
 * The organization's live catalogue, in full. A content type is a flat org-wide
 * tag: any Short may carry any of them, so there is nothing to narrow and no
 * per-Short list to derive. The menu below is the same list everywhere it
 * opens, which is also exactly what the server will accept — the round that
 * narrowed the picker by the channel's niches, and had to keep the client and
 * the server agreeing about it, is over.
 *
 * PERMISSIONS
 * Two different capabilities meet in this one control, and conflating them is
 * how it ends up useless to the people who use it most.
 *
 * APPLYING a tag is `research.write` — the same permission behind writing a
 * note or saving a Short — so every editor can label the Shorts they work on.
 * Without it the control degrades to the chips alone.
 *
 * CREATING a tag from inside the picker is `niches.manage`, because it adds a
 * word to the vocabulary the whole team then argues in. An editor sees the list
 * and can file against it; they do not get to extend it in passing.
 *
 * The routes enforce both regardless; hiding an affordance only spares somebody
 * a control that would answer 403.
 */

/**
 * Upper bound on one bulk run, mirroring `MAX_BULK_VIDEOS` in
 * `content-type-service.ts`. Restated rather than imported because that module
 * is `server-only` and importing the *value* would pull server code into the
 * bundle. The server is still the authority — this only exists so the UI can
 * refuse before spending a round trip on a request it knows will be rejected.
 */
export const MAX_BULK_ASSIGN = 500;

/** Stable identity, so the menu's memo is not invalidated by a fresh literal. */
const NO_SELECTION: readonly string[] = [];

/** May file a Short under a tag the team already has. */
function useCanAssign(): boolean {
  const session = useOptionalSession();
  return session?.can("research.write") ?? false;
}

/** May add a word to the vocabulary — a narrower thing, see the note above. */
function useCanManage(): boolean {
  const session = useOptionalSession();
  return session?.can("niches.manage") ?? false;
}

export function ContentTypeControl({
  videoId,
  contentTypeIds,
  align = "start",
  className,
  /** Shown in place of the chips when nothing is filed and editing is allowed. */
  placeholder = "Type",
  /**
   * Let the empty placeholder recede until the row is hovered or focused.
   *
   * For the feeds and Saved, where the control sits in a dense metadata line
   * beside the channel, the niche and the age: a "+ Type" at full contrast on
   * every unclassified row would be the loudest thing in a list whose job is to
   * rank by outlier multiple.
   *
   * Dimmed rather than hidden, deliberately. The notes button on those same
   * rows fades to nothing, but it sits in a fixed-width action column where its
   * absence costs no layout; this one is inline, so removing it would leave a
   * hole between the niche chip and the date, and the row would twitch on
   * hover. It also stays legible to anybody who is not hovering — including on
   * a touch screen, where nobody ever is.
   *
   * Off in the Shorts table, where "Content type" is a labelled column of its
   * own and a receding affordance inside one would just look broken.
   */
  revealOnHover = false,
  /**
   * What a viewer who cannot classify sees on an unclassified Short.
   *
   * Without it this component renders NOTHING in that case, which is right in a
   * dense table row — an empty cell reads as "no label" perfectly well — and
   * wrong under a heading that says "Content type", where the field would look
   * broken rather than empty.
   */
  emptyLabel,
}: {
  videoId: string;
  contentTypeIds: readonly string[];
  align?: "start" | "center" | "end";
  className?: string;
  placeholder?: string;
  revealOnHover?: boolean;
  emptyLabel?: string;
}) {
  const canAssign = useCanAssign();
  const [open, setOpen] = React.useState(false);
  const assigned = useContentTypesByIds(contentTypeIds);
  const save = useSetVideoContentTypes();

  const commit = (nextIds: readonly string[], closeAfter: boolean) => {
    if (closeAfter) setOpen(false);
    // Nothing to say to the server, and no reason to make the row flicker.
    if (
      nextIds.length === contentTypeIds.length &&
      nextIds.every((id) => contentTypeIds.includes(id))
    ) {
      return;
    }

    save.mutate(
      { videoId, contentTypeIds: nextIds },
      {
        onError: (error) =>
          toast.error("Could not save that content type", {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  if (!canAssign) {
    return assigned.length > 0 || emptyLabel ? (
      <ContentTypeChips
        contentTypes={assigned}
        limit={2}
        size="sm"
        className={className}
        emptyLabel={emptyLabel}
      />
    ) : null;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            assigned.length > 0
              ? `Content types: ${assigned.map((type) => type.name).join(", ")}. Change them.`
              : "File this Short under a content type"
          }
          className={cn(
            "inline-flex max-w-full items-center gap-1 rounded px-1 py-0.5 text-left transition-colors",
            "hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
            save.isPending && "opacity-60",
            revealOnHover &&
              assigned.length === 0 &&
              "opacity-40 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100",
            className,
          )}
        >
          {assigned.length > 0 ? (
            <ContentTypeChips contentTypes={assigned} limit={2} size="sm" />
          ) : (
            <span className="inline-flex items-center gap-1 rounded border border-dashed border-border px-1.5 py-px text-[10px] text-subtle-foreground">
              <Plus className="size-2.5" />
              {placeholder}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent align={align} className="w-[268px] p-0">
        <ContentTypeMenu
          selectedIds={contentTypeIds}
          heading="Content type"
          hint="Click to file it under one. Use + to add another."
          onSelectOnly={(id) =>
            commit(contentTypeIds.length === 1 && contentTypeIds[0] === id ? [] : [id], true)
          }
          onToggle={(id) =>
            commit(
              contentTypeIds.includes(id)
                ? contentTypeIds.filter((existing) => existing !== id)
                : [...contentTypeIds, id],
              false,
            )
          }
          busy={save.isPending}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The bulk action, offered on a selection of Shorts.
 *
 * Separate from the per-row control because the question is genuinely
 * different: one Short is being classified, where a hundred are being
 * *relabelled*, and "does this replace what is already there?" is a decision
 * somebody has to make deliberately once rather than have inferred for them a
 * hundred times. It defaults to adding — the non-destructive answer — and the
 * result reports what actually moved rather than claiming it wrote every row.
 */
export function BulkContentTypeButton({
  videoIds,
  onAssigned,
  className,
}: {
  videoIds: readonly string[];
  /** Called after a successful run, so the caller can clear its selection. */
  onAssigned?: () => void;
  className?: string;
}) {
  const canAssign = useCanAssign();
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<"add" | "replace">("add");
  const assign = useAssignContentTypeToVideos();

  const overLimit = videoIds.length > MAX_BULK_ASSIGN;

  if (!canAssign) return null;

  const run = (contentType: ContentTypeDTO) => {
    if (overLimit) return;

    assign.mutate(
      { videoIds, contentTypeId: contentType.id, mode },
      {
        onSuccess: (result) => {
          setOpen(false);
          onAssigned?.();

          const details: string[] = [];
          if (result.alreadyAssigned > 0) {
            details.push(
              `${result.alreadyAssigned} already ${result.alreadyAssigned === 1 ? "was" : "were"}`,
            );
          }
          if (result.removed > 0) {
            details.push(
              `${result.removed} other ${result.removed === 1 ? "label" : "labels"} removed`,
            );
          }

          // The headline is what changed, not what was asked for: a re-run of
          // the same selection legitimately files nothing, and saying "50
          // Shorts filed" there would be a lie the second time.
          toast.success(
            result.assigned === 0
              ? `Every selected Short was already filed under “${contentType.name}”`
              : `${result.assigned} ${result.assigned === 1 ? "Short" : "Shorts"} filed under “${contentType.name}”`,
            { description: details.length > 0 ? `${details.join(" · ")}.` : undefined },
          );
        },
        onError: (error) =>
          toast.error("Could not assign that content type", {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary" size="sm" className={className} loading={assign.isPending}>
          {assign.isPending ? null : <Tag />}
          Assign content type
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-[292px] p-0">
        <div className="border-b border-border px-3 py-2.5">
          <div className="text-[12px] font-medium text-foreground">
            {videoIds.length} {videoIds.length === 1 ? "Short" : "Shorts"} selected
          </div>

          {overLimit ? (
            <p className="mt-1 text-[11px] leading-relaxed text-danger">
              At most {MAX_BULK_ASSIGN} at a time. Narrow the selection and run it in
              batches.
            </p>
          ) : (
            <div className="mt-2 flex items-center gap-1">
              {(
                [
                  { id: "add", label: "Add" },
                  { id: "replace", label: "Replace" },
                ] as const
              ).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setMode(option.id)}
                  aria-pressed={mode === option.id}
                  className={cn(
                    "rounded border px-2 py-0.5 text-[11px] font-medium transition-colors",
                    mode === option.id
                      ? "border-accent bg-accent-subtle text-foreground"
                      : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              ))}
              <span className="ml-1 text-[10px] leading-tight text-subtle-foreground">
                {mode === "add"
                  ? "keeps existing labels"
                  : "makes it the only label"}
              </span>
            </div>
          )}
        </div>

        <ContentTypeMenu
          // Nothing is pre-selected: a bulk run is a statement about the
          // selection, not a reflection of what any one Short already carries.
          selectedIds={NO_SELECTION}
          heading={null}
          hint={null}
          disabled={overLimit || assign.isPending}
          busy={assign.isPending}
          showToggle={false}
          onSelectOnly={(_id, contentType) => run(contentType)}
          onToggle={(_id, contentType) => run(contentType)}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The list body both controls hang off.
 *
 * ONE NARROWING, and it is not about niches. The catalogue is org-wide, so
 * every option is offered on every Short; what is filtered here is ARCHIVING —
 * a retired type is never offered for new work, but one the current selection
 * already carries stays in the list so it remains removable. A Short filed
 * under a since-retired type keeps its label, and stranding it would be the
 * data loss the whole archive/delete distinction exists to prevent.
 */
function ContentTypeMenu({
  selectedIds,
  heading,
  hint,
  onSelectOnly,
  onToggle,
  busy = false,
  disabled = false,
  showToggle = true,
}: {
  selectedIds: readonly string[];
  heading: string | null;
  hint: string | null;
  onSelectOnly: (id: string, contentType: ContentTypeDTO) => void;
  onToggle: (id: string, contentType: ContentTypeDTO) => void;
  busy?: boolean;
  disabled?: boolean;
  showToggle?: boolean;
}) {
  const available = useActiveContentTypes();
  const assigned = useContentTypesByIds(selectedIds);
  // Only for the inline create at the foot of this menu — everything else in
  // here is assignment, which the caller has already gated on `research.write`.
  const canManage = useCanManage();

  const options = React.useMemo(() => {
    // The archived exception, and only that. Everything active is already in
    // `available`, so this appends the retired types the selection carries and
    // nothing else.
    const archivedAssigned = assigned.filter((type) => !type.isActive);
    return archivedAssigned.length > 0 ? [...available, ...archivedAssigned] : available;
  }, [available, assigned]);

  const [creating, setCreating] = React.useState(false);

  const renderRow = (contentType: ContentTypeDTO) => {
    const selected = selectedIds.includes(contentType.id);
    return (
      <div key={contentType.id} className="flex items-center gap-0.5">
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => onSelectOnly(contentType.id, contentType)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] transition-colors",
            "hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-50",
            selected ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "size-[6px] shrink-0 rounded-[1px]",
              !contentType.isActive && "opacity-50",
            )}
            style={{ background: contentTypeColor(contentType.colorIndex) }}
          />
          <span className="truncate">{contentType.name}</span>
          {!contentType.isActive ? (
            <span className="shrink-0 text-[10px] text-subtle-foreground">archived</span>
          ) : null}
          {selected ? <Check className="ml-auto size-3.5 shrink-0 text-accent" /> : null}
        </button>

        {showToggle ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={disabled || busy}
                onClick={() => onToggle(contentType.id, contentType)}
                aria-label={
                  selected
                    ? `Remove ${contentType.name}`
                    : `Also file under ${contentType.name}`
                }
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded text-subtle-foreground transition-colors",
                  "hover:bg-surface-hover hover:text-foreground",
                  "disabled:pointer-events-none disabled:opacity-50",
                )}
              >
                {selected ? <Minus className="size-3" /> : <Plus className="size-3" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {selected
                ? `Remove ${contentType.name}, keep the rest`
                : `Add ${contentType.name} alongside the current ones`}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex flex-col">
      {heading || hint ? (
        <div className="border-b border-border px-3 py-2">
          {heading ? (
            <div className="text-[11px] font-medium uppercase tracking-wider text-subtle-foreground">
              {heading}
            </div>
          ) : null}
          {hint ? (
            <p className="mt-0.5 text-[11px] leading-tight text-subtle-foreground">{hint}</p>
          ) : null}
        </div>
      ) : null}

      {options.length > 0 ? (
        <div className="max-h-[220px] overflow-y-auto p-1">{options.map(renderRow)}</div>
      ) : !creating ? (
        /*
         * ONE EMPTINESS, with one cause and one fix.
         *
         * The list is org-wide, so a menu with nothing in it means the team has
         * not defined a vocabulary yet — never that this particular Short is
         * ineligible. That used to be two different messages; collapsing them
         * is the point of the flat catalogue.
         */
        <p className="px-3 py-3 text-[11px] leading-relaxed text-subtle-foreground">
          No content types yet. They are whatever vocabulary your team actually argues
          in &mdash; &ldquo;Funny Moment&rdquo;, &ldquo;Ranking&rdquo;,
          &ldquo;Cutscene&rdquo;.
        </p>
      ) : null}

      <div className="border-t border-border p-1">
        {creating ? (
          <InlineCreate
            onCancel={() => setCreating(false)}
            onCreated={(created) => {
              setCreating(false);
              onSelectOnly(created.id, created);
            }}
          />
        ) : (
          <>
            {/*
             * Inline create — the one thing in this menu that is catalogue
             * management rather than use, so it is gated separately. An editor
             * files against the vocabulary; extending it is a heads-and-admin
             * decision, and offering the button to everybody would put a 403
             * behind the most inviting item in the list.
             */}
            {canManage ? (
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => setCreating(true)}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <Plus className="size-3.5 shrink-0" />
              New content type
            </button>
            ) : null}
            <Link
              href="/content-types"
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              <Settings2 className="size-3.5 shrink-0" />
              Manage content types
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Create a type without leaving the Short.
 *
 * Same reasoning as the niche picker's inline create: the moment somebody
 * notices they need a new label is the moment they are looking at the Short
 * that needs it, and a trip to a management screen mid-flow is exactly the
 * friction that stops people classifying at all.
 */
function InlineCreate({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (contentType: ContentTypeDTO) => void;
}) {
  const [name, setName] = React.useState("");
  const create = useCreateContentType();

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;

    create.mutate(
      { name: trimmed },
      {
        onSuccess: ({ contentType }) => {
          toast.success(`Content type “${contentType.name}” created`);
          onCreated(contentType);
        },
        onError: (error) =>
          toast.error("Could not create that content type", {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    // A div rather than a <form>: this renders inside the Shorts table, and a
    // nested form would be invalid HTML there.
    <div className="flex items-center gap-1.5 p-1">
      <Input
        autoFocus
        value={name}
        maxLength={48}
        placeholder="New type — e.g. Ranking"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
          if (event.key === "Escape") onCancel();
        }}
        className="h-8 text-[13px]"
      />
      <Button
        type="button"
        variant="primary"
        size="sm"
        loading={create.isPending}
        disabled={!name.trim()}
        onClick={submit}
      >
        Create
      </Button>
    </div>
  );
}
