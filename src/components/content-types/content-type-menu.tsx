"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Minus, Plus, Settings2 } from "lucide-react";
import { toast } from "sonner";
import type { ContentTypeDTO } from "@/lib/dto";
import {
  useActiveContentTypes,
  useContentTypesByIds,
  useCreateContentType,
} from "@/hooks/use-content-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCanManageContentTypes } from "./permissions";
import { contentTypeColor } from "./content-type-chip";
import { cn } from "@/lib/utils";

/**
 * ==========================================================================
 * THE LIST BODY EVERY CONTENT-TYPE MENU HANGS OFF
 * ==========================================================================
 *
 * Three callers now: the per-row assignment popover, the bulk action, and the
 * Short detail panel's "Add content type". They differ in what a click MEANS —
 * file this one and nothing else / run a bulk assignment / add this one to the
 * three already there — and in nothing else. So the meaning is the caller's, and
 * the list, the archived rule, the inline create and the footer are here.
 *
 * Lifted out of `content-type-control.tsx` when the panel became the third
 * caller. Copying it would have been copying the archived rule below, which is
 * the one piece of this that quietly loses data when the two copies drift.
 *
 * ONE NARROWING, and it is not about niches. The catalogue is org-wide, so every
 * option is offered on every Short; what is filtered here is ARCHIVING — a
 * retired type is never offered for new work, but one the current selection
 * already carries stays in the list so it remains removable. A Short filed under
 * a since-retired type keeps its label, and stranding it would be the data loss
 * the whole archive/delete distinction exists to prevent.
 */

/** Stable identity, so a default does not invalidate the memo below every render. */
const NO_IDS: readonly string[] = [];

export function ContentTypeMenu({
  selectedIds,
  /**
   * Which of `selectedIds` come from the CHANNEL rather than from this Short.
   *
   * The menu has to say so, for the same reason the chips do: a tick beside
   * "Ranking" answers "is this Short a Ranking?" but not "did anybody decide
   * that about *this* Short?", and only the second question has an actionable
   * answer. It also changes what the "−" beside it means — an override rather
   * than a deletion — which is worth saying before somebody clicks it.
   *
   * Empty for the bulk control, whose subject is a selection rather than a Short
   * with a channel.
   */
  inheritedIds = NO_IDS,
  /**
   * Channel tags this Short is currently REFUSING.
   *
   * Surfaced rather than left invisible because the alternative is genuinely
   * confusing: the channel is tagged "Ranking", the row shows no Ranking chip,
   * and the menu offers a bare "+" that looks like it would add something new.
   * Labelling it "excluded" says what happened and makes the "+" read as the
   * undo it is.
   */
  suppressedIds = NO_IDS,
  /**
   * Never offered at all.
   *
   * For an ADD list, which is what the Short detail panel opens: a tag already
   * in effect has nothing to add, and offering it would write a row that changes
   * nothing. The row control does not use this — it is a toggle list, where the
   * tags you already have are exactly the ones you need to reach to remove.
   */
  hiddenIds = NO_IDS,
  heading,
  hint,
  /**
   * The ROW itself was clicked. What that means is the caller's business — file
   * this one alone, add it, run a bulk assignment — which is precisely why this
   * module does not decide it.
   */
  onSelect,
  /** The trailing +/− was clicked. Only rendered when `showToggle`. */
  onToggle,
  busy = false,
  disabled = false,
  showToggle = true,
}: {
  selectedIds: readonly string[];
  inheritedIds?: readonly string[];
  suppressedIds?: readonly string[];
  hiddenIds?: readonly string[];
  heading: string | null;
  hint: string | null;
  onSelect: (id: string, contentType: ContentTypeDTO) => void;
  onToggle: (id: string, contentType: ContentTypeDTO) => void;
  busy?: boolean;
  disabled?: boolean;
  showToggle?: boolean;
}) {
  const available = useActiveContentTypes();
  const assigned = useContentTypesByIds(selectedIds);
  // Only for the inline create at the foot of this menu — everything else in
  // here is assignment, which the caller has already gated on `research.write`.
  const canManage = useCanManageContentTypes();

  /**
   * The catalogue this menu offers, and what it would have offered.
   *
   * Both, because "there is nothing to show" has two causes with two different
   * fixes, and the message below has to name the right one. `offerable` is the
   * live vocabulary plus the retired tags the selection carries; `options` is
   * that minus whatever the caller has hidden. When the second is empty and the
   * first is not, the team HAS a vocabulary and this Short has simply used all
   * of it — telling them to go define some types would be nonsense.
   */
  const { options, offerable } = React.useMemo(() => {
    // The archived exception, and only that. Everything active is already in
    // `available`, so this appends the retired types the selection carries and
    // nothing else.
    const archivedAssigned = assigned.filter((type) => !type.isActive);
    const offerable =
      archivedAssigned.length > 0 ? [...available, ...archivedAssigned] : available;

    if (hiddenIds.length === 0) return { options: offerable, offerable };
    const hidden = new Set(hiddenIds);
    return { options: offerable.filter((type) => !hidden.has(type.id)), offerable };
  }, [available, assigned, hiddenIds]);

  const [creating, setCreating] = React.useState(false);

  const renderRow = (contentType: ContentTypeDTO) => {
    const selected = selectedIds.includes(contentType.id);
    const inherited = selected && inheritedIds.includes(contentType.id);
    // Only meaningful when NOT selected: a tag cannot be both carried and
    // refused, so the two states are exclusive by construction.
    const suppressed = !selected && suppressedIds.includes(contentType.id);

    return (
      <div key={contentType.id} className="flex items-center gap-0.5">
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => onSelect(contentType.id, contentType)}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] transition-colors",
            "hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-50",
            selected ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {/*
           * Hollow for inherited, filled otherwise — the same non-colour carrier
           * the chips use, so the menu and the row behind it say "this one came
           * from the channel" in the same visual language rather than in two.
           */}
          <span
            aria-hidden
            className={cn(
              "size-[6px] shrink-0 rounded-[1px]",
              !contentType.isActive && "opacity-50",
            )}
            style={
              inherited
                ? {
                    boxShadow: `inset 0 0 0 1px ${contentTypeColor(contentType.colorIndex)}`,
                  }
                : { background: contentTypeColor(contentType.colorIndex) }
            }
          />
          <span className="truncate">{contentType.name}</span>
          {!contentType.isActive ? (
            <span className="shrink-0 text-[10px] text-subtle-foreground">archived</span>
          ) : null}
          {inherited ? (
            <span className="shrink-0 text-[10px] text-subtle-foreground">
              inherited
              {/* The word alone invites the question "from what?". There is no
                  room for the answer at this width, so it is spoken rather than
                  drawn — and the "−" tooltip below says it in full. */}
              <span className="sr-only"> from this channel</span>
            </span>
          ) : null}
          {suppressed ? (
            <span className="shrink-0 text-[10px] text-subtle-foreground">excluded</span>
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
                  inherited
                    ? `Stop applying ${contentType.name} to this Short`
                    : selected
                      ? `Remove ${contentType.name}`
                      : suppressed
                        ? `Restore ${contentType.name} from the channel`
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
              {inherited
                ? // The whole override, in one sentence, at the moment it is
                  // about to happen. "Remove" here would be a lie twice over:
                  // there is no row to remove, and the channel is untouched.
                  `${contentType.name} comes from this channel. Stop applying it to this Short — the channel keeps it.`
                : selected
                  ? `Remove ${contentType.name}, keep the rest`
                  : suppressed
                    ? `This Short refuses ${contentType.name}, which its channel makes. Let it back through.`
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
        <p className="px-3 py-3 text-[11px] leading-relaxed text-subtle-foreground">
          {offerable.length > 0 ? (
            /*
             * The team has a vocabulary; this Short has used all of it. Only
             * reachable from an ADD list, and the honest thing to say there —
             * the alternative message would send somebody off to define types
             * they already have.
             */
            <>This Short already has every content type.</>
          ) : (
            /*
             * ONE EMPTINESS, with one cause and one fix.
             *
             * The list is org-wide, so a menu with nothing in it means the team
             * has not defined a vocabulary yet — never that this particular
             * Short is ineligible. That used to be two different messages;
             * collapsing them is the point of the flat catalogue.
             */
            <>
              No content types yet. They are whatever vocabulary your team actually
              argues in &mdash; &ldquo;Funny Moment&rdquo;, &ldquo;Ranking&rdquo;,
              &ldquo;Cutscene&rdquo;.
            </>
          )}
        </p>
      ) : null}

      <div className="border-t border-border p-1">
        {creating ? (
          <InlineCreate
            onCancel={() => setCreating(false)}
            onCreated={(created) => {
              setCreating(false);
              onSelect(created.id, created);
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
