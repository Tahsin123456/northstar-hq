"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import type { ContentTypeDTO } from "@/lib/dto";
import type { ContentTypeResolution } from "@/lib/content-types/resolve";
import {
  useContentTypesByIds,
  useExcludeContentTypeFromVideo,
  useRestoreInheritedContentType,
  useSetVideoContentTypes,
} from "@/hooks/use-content-types";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ContentTypeChip, type ContentTypeChipRemoveProps } from "./content-type-chip";
import { ContentTypeMenu } from "./content-type-menu";
import { useCanAssignContentTypes } from "./permissions";
import { cn } from "@/lib/utils";

/**
 * ==========================================================================
 * WHERE INHERITANCE BECOMES SOMETHING A PERSON CAN OPERATE
 * ==========================================================================
 *
 * The Short detail dialog is the only surface in the app that shows ONE Short,
 * so it is the only one with room to answer the question the rest of the UI can
 * only hint at: not "what is this tagged?" but "who said so, and what happens if
 * I disagree?".
 *
 * IT READS AS TWO GROUPS AND A QUIET WAY BACK — never as a state machine.
 *
 *     Inherited from this channel   [Memes ×] [Cinematic ×]
 *     Added to this Short           [Reaction ×]
 *     Excluded: Cinematic — restore
 *     + Add content type
 *
 * The underlying model has three states and a tombstone rule. A person has two
 * lists and an undo. That gap is the whole design of this component, and it is
 * held by three decisions:
 *
 * 1. THE GROUPS ARE THE ANSWER, so origin never has to be decoded from a badge.
 *    On a table row the distinction is carried by a dashed border, which is
 *    right when you are scanning and already know the convention. Here you have
 *    stopped to decide something, and the honest presentation of "these came
 *    from the channel, these are yours" is two headings.
 *
 * 2. AN EMPTY GROUP IS NOT SHOWN. Most Shorts have exactly one group — the
 *    inherited one — and no exclusions at all. A permanently visible "Excluded"
 *    line reading "none" is how a simple panel starts looking complicated, and
 *    it would advertise a state most people will never use as though it were
 *    part of the normal shape of a Short.
 *
 * 3. REMOVING AN INHERITED TAG IS AN OVERRIDE, AND SAYS SO. "Remove" would be
 *    wrong twice: there is no row to remove, and the channel is untouched. The
 *    × says "stop applying it to this Short — the channel keeps it", and
 *    afterwards the tag reappears on the excluded line with a restore beside it.
 *    Making somebody re-add it from the picker instead would leave them
 *    wondering whether that is the same thing; it is, but they should not have
 *    to take our word for it.
 *
 * NOTHING HERE IS OPTIMISTIC, DELIBERATELY.
 *
 * This is the fastest place in the product to make a mistake — three write
 * gestures within a hand's width of each other — so a chip must never look as
 * though it worked when it did not. Every group below is derived from the
 * `resolution` prop, which comes from the dataset cache, which is patched only
 * by a mutation's `onSuccess` with the rows the server says it stored. A failed
 * request therefore changes nothing on screen and raises a toast, which is the
 * only pair of outcomes that cannot lie.
 *
 * The same reasoning locks every control while a write is in flight. Two
 * single-tag writes overlapping would each patch the cache with a COMPLETE
 * deviation snapshot taken at its own write time, so the slower response would
 * quietly undo the faster one's edit. These requests are short; the lock is
 * cheaper than the class of bug it removes.
 */

/** Stable identity, so the add menu's memo is not invalidated by a fresh literal. */
const NO_IDS: readonly string[] = [];

export function ShortContentTypePanel({
  videoId,
  resolution,
  className,
}: {
  videoId: string;
  /**
   * This Short's tags, already resolved against its channel.
   *
   * The panel reads `effective` for the two groups and `suppressedIds` for the
   * third. `suppressedIds` rather than every exclusion the Short stores, and the
   * difference matters here more than anywhere: a tombstone for a tag the
   * channel has SINCE DROPPED suppresses nothing, so listing it under "Excluded"
   * would show a refusal that is not doing anything, next to a restore that
   * would visibly do nothing. The resolver already draws that line.
   */
  resolution: ContentTypeResolution;
  className?: string;
}) {
  const canAssign = useCanAssignContentTypes();
  const [adding, setAdding] = React.useState(false);

  const { inheritedIds, manualIds } = React.useMemo(() => {
    const inheritedIds: string[] = [];
    const manualIds: string[] = [];
    for (const entry of resolution.effective) {
      (entry.origin === "inherited" ? inheritedIds : manualIds).push(entry.id);
    }
    return { inheritedIds, manualIds };
  }, [resolution]);

  // Catalogue order inside each group, and archived entries still resolve —
  // a tag somebody applied does not stop being true when the type is retired.
  const inherited = useContentTypesByIds(inheritedIds);
  const manual = useContentTypesByIds(manualIds);
  const excluded = useContentTypesByIds(resolution.suppressedIds);

  const save = useSetVideoContentTypes();
  const exclude = useExcludeContentTypeFromVideo();
  const restore = useRestoreInheritedContentType();
  const busy = save.isPending || exclude.isPending || restore.isPending;

  const onError = (error: unknown) =>
    toast.error("Could not save that content type", {
      description: error instanceof Error ? error.message : undefined,
    });

  /*
   * THE SINGLE-TAG ROUTE FOR BOTH GROUPS, and it is the same click.
   *
   * Whether this writes a tombstone or deletes a manual row is the SERVER's to
   * decide, because it is the side that knows what the channel gives at the
   * instant of the write — this panel's idea of that is however old the dataset
   * cache is. Sending "the whole set, minus this one" instead would make a
   * one-click removal able to revert a colleague's edit to a different tag.
   */
  const removeTag = (id: string) =>
    exclude.mutate({ videoId, contentTypeId: id }, { onError });

  const restoreTag = (id: string) =>
    restore.mutate({ videoId, contentTypeId: id }, { onError });

  /**
   * The chip's "×", or nothing at all for a viewer who cannot classify.
   *
   * A pair, because the chip takes it as one: a remove button with no label is a
   * type error there, and the label is the only place the difference between the
   * two groups is stated in words. Returned rather than inlined twice so that the
   * `canAssign` branch cannot end up applied to one group and not the other —
   * which would be a control that answers 403.
   */
  const removal = (id: string, label: string): ContentTypeChipRemoveProps =>
    canAssign ? { onRemove: () => removeTag(id), removeLabel: label } : {};

  /*
   * Adding splits, and the split is what makes the picker's promise true.
   *
   * The brief asks that the add list still OFFER a tag this Short has excluded,
   * and that choosing it there mean the same thing as the restore link below —
   * so it routes to the same request, rather than to a whole-set write that
   * would happen to produce the same rows under a different name in the audit
   * log. A tag the Short has simply never carried is an ordinary addition.
   */
  const addTag = (contentType: ContentTypeDTO) => {
    setAdding(false);
    if (resolution.suppressedIds.includes(contentType.id)) {
      restoreTag(contentType.id);
      return;
    }
    save.mutate(
      { videoId, contentTypeIds: [...resolution.effectiveIds, contentType.id] },
      { onError },
    );
  };

  const nothingFiled = inherited.length === 0 && manual.length === 0;

  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      <span className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
        Content types
      </span>

      {inherited.length > 0 ? (
        <Group label="Inherited from this channel">
          {inherited.map((contentType) => (
            <ContentTypeChip
              key={contentType.id}
              contentType={contentType}
              inherited
              muted={!contentType.isActive}
              removeDisabled={busy}
              // The override, stated on the control that performs it. Not
              // "Remove": nothing is deleted and the channel does not change,
              // and this is the last moment either fact is cheap to learn.
              {...removal(
                contentType.id,
                `Stop applying ${contentType.name} to this Short — the channel keeps it`,
              )}
            />
          ))}
        </Group>
      ) : null}

      {manual.length > 0 ? (
        <Group label="Added to this Short">
          {manual.map((contentType) => (
            <ContentTypeChip
              key={contentType.id}
              contentType={contentType}
              muted={!contentType.isActive}
              removeDisabled={busy}
              {...removal(
                contentType.id,
                `Remove ${contentType.name} from this Short`,
              )}
            />
          ))}
        </Group>
      ) : null}

      {nothingFiled ? (
        <p className="text-[11px] text-subtle-foreground">
          {/* Said even when an exclusion is the reason, because "this Short
              carries nothing" is the fact somebody came here for; the line
              below explains why. */}
          Not classified
        </p>
      ) : null}

      {excluded.length > 0 ? (
        /*
         * THE WAY BACK, and the only reason it is a line of text rather than a
         * third group of chips.
         *
         * An exclusion is not a tag the Short has — it is the ABSENCE of one,
         * recorded. Drawing it as a chip would put it in the same visual class
         * as the two groups above and invite it to be read as a third kind of
         * label. De-emphasised text says "this is a footnote about something
         * that is not here", which is exactly what it is.
         */
        <p className="text-[11px] leading-relaxed text-subtle-foreground">
          <span className="text-muted-foreground">Excluded:</span>{" "}
          {excluded.map((contentType, index) => (
            <React.Fragment key={contentType.id}>
              {index > 0 ? ", " : null}
              <span className={cn(!contentType.isActive && "opacity-60")}>
                {contentType.name}
              </span>
              {canAssign ? (
                <>
                  {" — "}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => restoreTag(contentType.id)}
                    aria-label={`Restore ${contentType.name} from this channel`}
                    title={`Let ${contentType.name} apply to this Short again`}
                    className="rounded text-accent transition-colors hover:text-accent-hover hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50"
                  >
                    restore
                  </button>
                </>
              ) : null}
            </React.Fragment>
          ))}
        </p>
      ) : null}

      {canAssign ? (
        <Popover open={adding} onOpenChange={setAdding}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={busy}
              className={cn(
                "inline-flex w-fit items-center gap-1 rounded border border-dashed border-border px-2 py-1 text-[11px] transition-colors",
                "text-subtle-foreground hover:border-border-strong hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                "disabled:pointer-events-none disabled:opacity-50",
              )}
            >
              <Plus className="size-3" />
              Add content type
            </button>
          </PopoverTrigger>

          <PopoverContent align="start" className="w-[268px] p-0">
            <ContentTypeMenu
              /*
               * AN ADD LIST, so nothing is ticked and everything this Short
               * already carries is gone from it. Offering a tag that is already
               * in effect would be offering to write a row that changes nothing
               * — and on an inherited tag, a row that must never exist at all.
               *
               * What it DOES still offer is a tag this Short is refusing, marked
               * "excluded". That is the second half of the undo: somebody who
               * reaches for the picker rather than the restore link above ends
               * up in the same place, which is the point.
               */
              selectedIds={NO_IDS}
              suppressedIds={resolution.suppressedIds}
              hiddenIds={resolution.effectiveIds}
              heading={null}
              hint="What this Short already has is left out. Picking an excluded one puts it back."
              showToggle={false}
              busy={busy}
              onSelect={(_id, contentType) => addTag(contentType)}
              onToggle={(_id, contentType) => addTag(contentType)}
            />
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}

/**
 * One labelled run of chips.
 *
 * The label is always rendered when the group is — including when it is the only
 * group, which is the common case. A lone unlabelled run of chips is exactly
 * what the table rows already show; the reason to open this dialog is to find
 * out which of the two things those chips are.
 */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] text-subtle-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}
