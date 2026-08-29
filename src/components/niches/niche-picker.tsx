"use client";

import * as React from "react";
import { Check, Plus } from "lucide-react";
import { toast } from "sonner";
import type { NicheDTO } from "@/lib/dto";
import { useCreateNiche } from "@/hooks/use-niches";
import { Button } from "@/components/ui/button";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { nicheColor } from "./niche-chip";
import { cn } from "@/lib/utils";

/**
 * Niche assignment control.
 *
 * Multi-select is supported because the data model allows a channel in both
 * "Gaming" and "GTA" — but the interaction is deliberately just a row of
 * toggles, not a tag editor with tokens and autocomplete. Selecting nothing is
 * a valid, unremarkable outcome; a channel does not have to be filed to be
 * tracked.
 *
 * Creating a niche happens inline. Forcing a trip to a management screen
 * mid-add is exactly the kind of friction that stops people organising at all.
 */
export function NichePicker({
  niches,
  selectedIds,
  onChange,
  label = "Niche",
  hint,
  className,
}: {
  niches: readonly NicheDTO[];
  selectedIds: readonly string[];
  onChange: (ids: string[]) => void;
  label?: string;
  hint?: React.ReactNode;
  className?: string;
}) {
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const createNiche = useCreateNiche();

  const toggle = (id: string) => {
    onChange(
      selectedIds.includes(id)
        ? selectedIds.filter((existing) => existing !== id)
        : [...selectedIds, id],
    );
  };

  const submitNew = (event: React.FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;

    // Deliberately name-only. This is the inline "create one while assigning
    // channels" path, not the place to configure what a hit means — the niche
    // is created unconfigured and an Admin sets the threshold on the Niches
    // screen, where the consequences of the number are visible.
    createNiche.mutate(
      { name },
      {
        onSuccess: ({ niche }) => {
          onChange([...selectedIds, niche.id]);
          setNewName("");
          setCreating(false);
          toast.success(`Niche “${niche.name}” created`, {
            description:
              "No complete hit rule yet — a hit needs a view threshold and a window. An Admin can set both on the Niches page.",
          });
        },
        onError: (error) =>
          toast.error("Could not create that niche", {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <Label>{label}</Label>
        {!creating ? (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1 text-[11px] text-accent transition-colors hover:text-accent-hover"
          >
            <Plus className="size-3" />
            New niche
          </button>
        ) : null}
      </div>

      {niches.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {niches.map((niche) => {
            const selected = selectedIds.includes(niche.id);
            return (
              <button
                key={niche.id}
                type="button"
                onClick={() => toggle(niche.id)}
                aria-pressed={selected}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors duration-150",
                  selected
                    ? "border-accent bg-accent-subtle text-foreground"
                    : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
                )}
              >
                <span
                  aria-hidden
                  className="size-[6px] shrink-0 rounded-full"
                  style={{ background: nicheColor(niche.colorIndex) }}
                />
                {niche.name}
                {selected ? <Check className="size-3 text-accent" /> : null}
              </button>
            );
          })}
        </div>
      ) : !creating ? (
        <FieldHint>
          No niches yet. Create one to group channels by topic — GTA, Finance,
          Fitness, whatever fits how you work.
        </FieldHint>
      ) : null}

      {creating ? (
        // A nested <form> would be invalid HTML inside the add-channel form, so
        // this is a div that handles Enter itself.
        <div className="flex items-center gap-1.5">
          <Input
            autoFocus
            value={newName}
            placeholder="e.g. GTA"
            maxLength={48}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitNew(event);
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
            loading={createNiche.isPending}
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

/** Radio-style card for the own/competitor choice. */
export function TypeOption({
  label,
  description,
  selected,
  onSelect,
}: {
  label: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors duration-150",
        selected
          ? "border-accent bg-accent-subtle"
          : "border-border hover:border-border-strong hover:bg-surface-hover/50",
      )}
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-foreground">{label}</span>
        {selected ? <Check className="size-3.5 shrink-0 text-accent" /> : null}
      </span>
      <span className="text-[11px] leading-tight text-muted-foreground">{description}</span>
    </button>
  );
}
