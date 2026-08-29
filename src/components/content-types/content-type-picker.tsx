"use client";

import * as React from "react";
import { Check, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  useActiveContentTypes,
  useContentTypesByIds,
  useCreateContentType,
} from "@/hooks/use-content-types";
import { Button } from "@/components/ui/button";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { contentTypeColor } from "./content-type-chip";
import { cn } from "@/lib/utils";

/**
 * The multi-select every "tag this thing" surface shares.
 *
 * Extracted because two screens now edit the same set — the dialog off the
 * channel row menu and the block on the channel page — and the awkward half of
 * this picker is the archived rule below. Two copies of that rule is two chances
 * for one of them to quietly drop a tag on save.
 *
 * Deliberately uncontrolled about WHEN it writes: it reports toggles upward and
 * never saves. The channel surfaces batch a whole set behind Save; a per-row
 * Short control commits immediately. That decision belongs to the caller, and
 * the difference is real — a set is one thought, and three toggles should not
 * become three requests and three audit entries.
 */
export function ContentTypePicker({
  selectedIds,
  assignedIds,
  onToggle,
  onCreated,
  disabled = false,
  hint,
  label = "Tags",
}: {
  /** The draft selection — what is ticked right now. */
  selectedIds: readonly string[];
  /**
   * The SAVED set, which is not the same thing as the draft.
   *
   * Only used to decide which archived types stay on offer (see `options`). It
   * has to be the saved set rather than the draft: keyed off the draft, an
   * archived tag would vanish from the list the moment you deselected it, and
   * changing your mind would be impossible without reloading the page.
   */
  assignedIds: readonly string[];
  onToggle: (id: string) => void;
  /** Called with the new type's id once an inline creation succeeds. */
  onCreated?: (contentTypeId: string) => void;
  disabled?: boolean;
  hint?: React.ReactNode;
  label?: string;
}) {
  const catalogue = useActiveContentTypes();
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const create = useCreateContentType();

  /**
   * The live catalogue, plus any ARCHIVED tag this thing already carries.
   *
   * The second half is what keeps an archived tag REMOVABLE. These callers send
   * the complete desired set, so a tag the picker declined to render would be
   * dropped from the payload and silently unassigned by a save the user meant as
   * "leave that alone" — or, if we filtered it back in, stuck there with no way
   * to take it off. Showing it is the only honest option, and it is the same
   * exception the Short-level picker makes.
   */
  const assigned = useContentTypesByIds(assignedIds);
  const options = React.useMemo(() => {
    const archivedAssigned = assigned.filter((type) => !type.isActive);
    return archivedAssigned.length > 0 ? [...catalogue, ...archivedAssigned] : catalogue;
  }, [catalogue, assigned]);

  const submitNew = () => {
    const name = newName.trim();
    if (!name) return;

    create.mutate(
      { name },
      {
        onSuccess: ({ contentType }) => {
          onCreated?.(contentType.id);
          setNewName("");
          setCreating(false);
          toast.success(`Content type “${contentType.name}” created`);
        },
        onError: (error) =>
          toast.error("Could not create that content type", {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label>{label}</Label>
        {!creating ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1 text-[11px] text-accent transition-colors hover:text-accent-hover disabled:opacity-50"
          >
            <Plus className="size-3" />
            New type
          </button>
        ) : null}
      </div>

      {options.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {options.map((contentType) => {
            const selected = selectedIds.includes(contentType.id);
            return (
              <button
                key={contentType.id}
                type="button"
                disabled={disabled}
                onClick={() => onToggle(contentType.id)}
                aria-pressed={selected}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors duration-150",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  selected
                    ? "border-accent bg-accent-subtle text-foreground"
                    : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
                )}
              >
                {/* Squared, matching the chip a content type renders as
                    everywhere else — the niche picker's dot is round. */}
                <span
                  aria-hidden
                  className={cn(
                    "size-[6px] shrink-0 rounded-[1px]",
                    !contentType.isActive && "opacity-50",
                  )}
                  style={{ background: contentTypeColor(contentType.colorIndex) }}
                />
                {contentType.name}
                {!contentType.isActive ? (
                  <span className="text-[10px] text-subtle-foreground">archived</span>
                ) : null}
                {selected ? <Check className="size-3 text-accent" /> : null}
              </button>
            );
          })}
        </div>
      ) : !creating ? (
        <FieldHint>
          No content types yet. They are whatever vocabulary your team actually argues
          in — “Funny Moment”, “Ranking”, “Cutscene”.
        </FieldHint>
      ) : null}

      {creating ? (
        // A div, not a nested <form>: this can sit inside a save form, and
        // nesting forms is invalid HTML.
        <div className="flex items-center gap-1.5">
          <Input
            autoFocus
            value={newName}
            placeholder="e.g. Ranking"
            maxLength={48}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitNew();
              }
              if (event.key === "Escape") {
                setCreating(false);
                setNewName("");
              }
            }}
            className="h-8 text-[13px]"
          />
          <Button
            type="button"
            variant="primary"
            size="sm"
            loading={create.isPending}
            disabled={!newName.trim()}
            onClick={submitNew}
          >
            Create
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setCreating(false);
              setNewName("");
            }}
          >
            Cancel
          </Button>
        </div>
      ) : null}

      {hint ? <FieldHint>{hint}</FieldHint> : null}
    </div>
  );
}
