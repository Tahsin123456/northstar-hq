"use client";

import * as React from "react";
import { Plus, Tag } from "lucide-react";
import { toast } from "sonner";
import type { ContentTypeDTO } from "@/lib/dto";
import type { ContentTypeResolution } from "@/lib/content-types/resolve";
import {
  useAssignContentTypeToVideos,
  useContentTypesByIds,
  useExcludeContentTypeFromVideo,
  useRestoreInheritedContentType,
  useSetVideoContentTypes,
} from "@/hooks/use-content-types";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ContentTypeChips } from "./content-type-chip";
import { ContentTypeMenu } from "./content-type-menu";
import { useCanAssignContentTypes } from "./permissions";
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
 * Clicking a type files the Short under that type and closes. That is the whole
 * interaction for the overwhelmingly common case: a Short is one kind of thing.
 * Clicking the manual type it already carries clears it.
 *
 * "And nothing else" is scoped to the Short's OWN tags. Whatever the channel
 * provides is carried through, because refusing an inherited tag is an override
 * that outlives the channel changing its mind, and a click in a list is not
 * where somebody asks for that. The "−" button is, and it says so.
 *
 * Multiple types are supported because the data model allows them, but they are
 * reached through the small +/− button on the right of each row, which leaves
 * the popover open. Nobody is asked up front whether they want single or
 * multiple select — the default gesture answers for them, and the second one is
 * there when it is actually needed.
 *
 * MOST CHIPS HERE WERE NEVER APPLIED TO THIS SHORT
 *
 * A Short's tags are mostly its CHANNEL's tags: `(channel − exclusions) ∪
 * manual`, resolved in `src/lib/content-types/resolve.ts` and handed in as
 * `resolution`. Two things follow, and both are visible in the UI rather than
 * left implicit.
 *
 * Inherited chips are marked as such, because "this Short is a Ranking because
 * somebody said so" and "…because everything on this channel is" are different
 * facts and only one of them is about this Short. The MENU says it too, on the
 * row and in the tooltip of the button that would take it off — a tick beside a
 * name is not the place to discover that removing it is an override.
 *
 * And REMOVING an inherited chip cannot delete a row — there is no row. It
 * writes a refusal, which is why that gesture goes to its own single-tag route
 * instead of through the whole-set write. The undo is offered on the same
 * button, on a tag shown as "excluded".
 *
 * ALL THREE STATES FIT HERE, so none of them is deferred to the detail dialog.
 *
 * The brief allows this control to do the common cases and hand the rest off,
 * and it turned out not to need the escape hatch: inherited, manual and excluded
 * are already three states of ONE row in a list the popover was always going to
 * render, distinguished by a hollow dot and a word, and acted on by the one
 * +/− button that was already there. What the DIALOG adds is not a fourth
 * capability but a different shape of answer — the tags grouped BY ORIGIN under
 * headings, where the question is "what is this Short?" rather than "make it a
 * Ranking". Splitting the capability instead would have meant a director who
 * spotted a wrong inherited tag mid-table could see the problem and not fix it.
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
 * Applying and refusing are `research.write`; creating a type is
 * `niches.manage`. Both hooks and the argument for the split live in
 * `./permissions`.
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

export function ContentTypeControl({
  videoId,
  resolution,
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
  /**
   * This Short's tags, already resolved against its channel.
   *
   * A RESOLUTION RATHER THAN AN ID LIST, and the prop was renamed so that no
   * caller could keep passing the old thing. What used to arrive here was "the
   * ids stored on this Short"; that array is now the Short's DEVIATIONS, and
   * rendering it would show a chip on the handful of Shorts somebody singled out
   * and nothing on the thousands that inherit. The list is resolved once per
   * dataset in `useVideoContentTypeResolutions` and looked up per row.
   */
  resolution: ContentTypeResolution;
  align?: "start" | "center" | "end";
  className?: string;
  placeholder?: string;
  revealOnHover?: boolean;
  emptyLabel?: string;
}) {
  const canAssign = useCanAssignContentTypes();
  const [open, setOpen] = React.useState(false);

  const effectiveIds = resolution.effectiveIds;
  const assigned = useContentTypesByIds(effectiveIds);

  /*
   * Which of the chips came from the channel.
   *
   * Derived from the resolution rather than recomputed, and memoised on the
   * resolution object — which is shared by every Short that does not deviate, so
   * on a typical channel this builds one list for the whole table rather than
   * one per row. Both shapes come out of the single pass: the chips want a Set
   * to test membership per chip, the menu wants the ids.
   */
  const { inheritedIds, inheritedIdSet } = React.useMemo(() => {
    const ids = resolution.effective
      .filter((entry) => entry.origin === "inherited")
      .map((entry) => entry.id);
    return { inheritedIds: ids, inheritedIdSet: new Set(ids) };
  }, [resolution]);

  const save = useSetVideoContentTypes();
  /*
   * THE TWO SINGLE-TAG GESTURES, which deliberately do not go through `commit`.
   *
   * Taking one chip off a Short is one click, and sending the Short's whole
   * state to express it would mean a tab left open for a minute could revert a
   * colleague's edit to a DIFFERENT tag as a side effect. These two requests
   * name one tag and can touch one tag.
   *
   * `exclude` is also the only correct way to remove an INHERITED chip: there is
   * no row to delete, so removing it has to write a refusal. Expressing that as
   * "here is the new set minus one" would work, and would leave the meaning of
   * a one-click removal depending on how the client happened to phrase it.
   */
  const exclude = useExcludeContentTypeFromVideo();
  const restore = useRestoreInheritedContentType();

  const busy = save.isPending || exclude.isPending || restore.isPending;

  const onSingleTagError = (error: unknown) =>
    toast.error("Could not save that content type", {
      description: error instanceof Error ? error.message : undefined,
    });

  /*
   * `nextIds` is the DESIRED EFFECTIVE SET — what this Short should end up
   * carrying, inherited tags included.
   *
   * That is what a person edits, because it is what they can see, and it is what
   * the route takes. Turning it into rows is `planDeviations`' job on the server
   * (and in the cache patch), which is the only place that knows a tag the
   * channel already gives needs no row at all. Sending "the tags I want" rather
   * than "the rows to write" is also why removing an inherited chip works
   * without this component knowing what an exclusion is.
   */
  const commit = (nextIds: readonly string[], closeAfter: boolean) => {
    if (closeAfter) setOpen(false);
    // Nothing to say to the server, and no reason to make the row flicker.
    if (
      nextIds.length === effectiveIds.length &&
      nextIds.every((id) => effectiveIds.includes(id))
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
        inheritedIds={inheritedIdSet}
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
              ? `Content types: ${assigned
                  .map((type) =>
                    inheritedIdSet.has(type.id)
                      ? `${type.name} (from the channel)`
                      : type.name,
                  )
                  .join(", ")}. Change them.`
              : "File this Short under a content type"
          }
          className={cn(
            "inline-flex max-w-full items-center gap-1 rounded px-1 py-0.5 text-left transition-colors",
            "hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
            busy && "opacity-60",
            revealOnHover &&
              assigned.length === 0 &&
              "opacity-40 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100",
            className,
          )}
        >
          {assigned.length > 0 ? (
            <ContentTypeChips
              contentTypes={assigned}
              inheritedIds={inheritedIdSet}
              limit={2}
              size="sm"
            />
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
          // The menu ticks what this Short CARRIES, inherited included. A tick
          // that only appeared for manual rows would tell somebody a Short is
          // not a Ranking while a Ranking chip sits on the row behind the
          // popover. Which of them are the channel's is said beside the name
          // instead, where it does not have to be inferred from a missing tick.
          selectedIds={effectiveIds}
          inheritedIds={inheritedIds}
          suppressedIds={resolution.suppressedIds}
          heading="Content type"
          hint="Click to file it under one. Use + to add another."
          /*
           * A CLICK SETS THIS SHORT'S OWN TAG. IT NEVER OVERRIDES THE CHANNEL'S.
           *
           * This used to narrow the desired set to the single clicked id, which
           * before inheritance meant "replace the one or two rows on this
           * Short" — cheap, and obviously undoable. It now means "and refuse
           * everything the channel gives", so on a channel carrying three tags
           * one click would write three permanent tombstones, each of which
           * outlives the channel dropping and re-adding the tag. That is a
           * heavy, near-invisible consequence for the lightest gesture in the
           * product, and nobody clicking a name in a list is asking for it.
           *
           * So the click owns only the manual half: whatever the channel gives
           * is carried through untouched, and overriding it stays a deliberate
           * act through the "−" button, which says what it does.
           *
           * Clicking a tag the channel already provides therefore changes
           * nothing, and is treated as such rather than as a request to make it
           * the only one.
           */
          onSelect={(id) => {
            const inherited = effectiveIds.filter((current) => inheritedIds.includes(current));
            if (inherited.includes(id)) {
              setOpen(false);
              return;
            }

            const manual = effectiveIds.filter((current) => !inheritedIds.includes(current));
            const clearing = manual.length === 1 && manual[0] === id;
            commit(clearing ? inherited : [...inherited, id], true);
          }}
          /*
           * THREE OUTCOMES, because the "+/−" button has three meanings now.
           *
           * Removing goes through the single-tag DELETE whether the chip was
           * inherited or manual — the server decides which of a tombstone and a
           * row deletion that means, and it is the only side that can, because
           * it is the side that knows what the channel gives right now.
           *
           * Adding splits: a tag this Short is REFUSING is put back with the
           * restore route, which is the honest description of that click and the
           * one the audit log will show. A tag it has simply never carried is an
           * ordinary addition and goes through the whole-set write, which is what
           * `contenttype.video_assigned` is for.
           */
          onToggle={(id) => {
            if (effectiveIds.includes(id)) {
              exclude.mutate({ videoId, contentTypeId: id }, { onError: onSingleTagError });
              return;
            }
            if (resolution.suppressedIds.includes(id)) {
              restore.mutate({ videoId, contentTypeId: id }, { onError: onSingleTagError });
              return;
            }
            commit([...effectiveIds, id], false);
          }}
          busy={busy}
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
  const canAssign = useCanAssignContentTypes();
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
            // Includes Shorts that inherit the tag from their channel and were
            // correctly left alone — which is the common outcome when the
            // selection comes from one tagged channel, and would look like a
            // failure if it were not named.
            details.push(
              `${result.alreadyAssigned} already ${result.alreadyAssigned === 1 ? "was" : "were"}`,
            );
          }
          if (result.restored > 0) {
            // Surfaced because it OVERRODE somebody: these Shorts had an
            // explicit refusal of this tag, and a run that silently reversed
            // that would be the one thing this toast must not do quietly.
            details.push(
              `${result.restored} ${result.restored === 1 ? "refusal" : "refusals"} lifted`,
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
          // Nothing is marked inherited either — there is no single channel to
          // inherit from across a selection.
          selectedIds={NO_SELECTION}
          heading={null}
          hint={null}
          disabled={overLimit || assign.isPending}
          busy={assign.isPending}
          showToggle={false}
          onSelect={(_id, contentType) => run(contentType)}
          onToggle={(_id, contentType) => run(contentType)}
        />
      </PopoverContent>
    </Popover>
  );
}
