"use client";

import * as React from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import type { ChannelDTO } from "@/lib/dto";
import {
  useContentTypesByIds,
  useSetChannelContentTypes,
} from "@/hooks/use-content-types";
import { useOptionalSession } from "@/components/providers/session-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ContentTypeChips } from "@/components/content-types/content-type-chip";
import { ContentTypePicker } from "@/components/content-types/content-type-picker";

/**
 * What this channel makes — stated on the channel's own page, and editable there.
 *
 * THE SOURCE ITS SHORTS READ FROM, not a separate opinion beside them.
 *
 * This used to be one of two independent readings — what the team reckons a
 * channel produces, against what its Shorts were individually filed as — and
 * the pair were allowed to disagree. Inheritance collapses that: what is set
 * here IS what every Short on the channel carries, and a Short only differs
 * where somebody deliberately made it differ. Nothing is copied down, so the set
 * below stays the live answer — add a tag and four hundred Shorts have it, drop
 * one and they do not, and a Short imported next week arrives already carrying
 * whatever is here.
 *
 * WHICH IS WHY THE BLOCK HAS TO SAY SO. Tagging a channel used to be a note to
 * the team; it is now an edit with reach, and the number of Shorts it reaches is
 * sitting in memory a component away. Making somebody discover that by watching
 * four hundred rows change is not a reasonable way to learn it.
 *
 * SAVE/CANCEL RATHER THAN LIVE TOGGLES, unlike the per-Short control on the rows
 * below. The natural unit here is the whole set: deciding a channel does
 * Rankings and Tier Lists but not Cutscenes is one thought, and committing it as
 * three requests would leave three audit entries for it and two incoherent
 * intermediate states visible to anyone else reading the channel at the time.
 * A Short is the opposite — one row, one judgement, commit on click.
 */
export function ChannelContentTypes({
  channel,
  shortsCount,
}: {
  channel: ChannelDTO;
  /**
   * Shorts on this channel that these tags reach.
   *
   * The channel's WHOLE stored history, not the selected period — the page's
   * date filter has no bearing on what a tag applies to, and a number that slid
   * around as somebody changed the window would be describing something other
   * than the edit they are about to make.
   */
  shortsCount: number;
}) {
  const session = useOptionalSession();
  // Assigning, not managing — see the note in content-type-control.tsx.
  const canManage = session?.can("research.write") ?? false;

  const [editing, setEditing] = React.useState(false);
  const assigned = useContentTypesByIds(channel.contentTypeIds);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>Content types</CardTitle>
            <CardDescription>
              What this channel makes, as the team reads it.
            </CardDescription>
          </div>

          {canManage && !editing ? (
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
              <Pencil />
              Edit
            </Button>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {editing ? (
          /*
           * Remounted per edit session via `key`, so the draft initialises from
           * the channel's stored tags every time Edit is pressed. No effect
           * resyncing state, and no stale draft surviving a Cancel.
           */
          <ChannelContentTypesEditor
            key={channel.contentTypeIds.join(",")}
            channel={channel}
            onDone={() => setEditing(false)}
          />
        ) : assigned.length > 0 ? (
          <ContentTypeChips contentTypes={assigned} limit={assigned.length} size="md" />
        ) : (
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {canManage
              ? "Not tagged yet. Say what this channel makes and every Short below inherits it."
              : "Not tagged yet."}
          </p>
        )}

        {/*
         * Shown in every state, including mid-edit and to a viewer who cannot
         * edit at all. While editing it is the plainest statement of what Save
         * is about to do; read-only, it is the explanation of why a Short in the
         * table below carries a tag nobody put there.
         */}
        <p className="text-[11px] leading-relaxed text-subtle-foreground">
          Types set here apply to {shortsReached(shortsCount)}, including any that
          arrive later. A Short can add its own on top, or drop one it inherits.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * "all 412 of this channel's Shorts", and the two ways that phrasing falls over.
 *
 * A channel with one Short reads badly as "all 1", and a channel with none — a
 * freshly added one, or a long-form account — has no number worth printing at
 * all, but the sentence is still true and still worth saying: the tags will
 * reach whatever it publishes next.
 */
function shortsReached(count: number): string {
  if (count === 0) return "every Short on this channel";
  if (count === 1) return "this channel's one Short";
  return `all ${count.toLocaleString()} of this channel's Shorts`;
}

function ChannelContentTypesEditor({
  channel,
  onDone,
}: {
  channel: ChannelDTO;
  onDone: () => void;
}) {
  const [selectedIds, setSelectedIds] = React.useState<string[]>(() => [
    ...channel.contentTypeIds,
  ]);
  const save = useSetChannelContentTypes();

  const toggle = (id: string) =>
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((existing) => existing !== id)
        : [...current, id],
    );

  // Nothing to send, so Save is a no-op that closes. The server is idempotent
  // here too — it reads the existing set and subtracts, writing and auditing
  // nothing when the set has not moved — but there is no reason to make the
  // round trip, or to flash a success toast for a change nobody made.
  const unchanged =
    selectedIds.length === channel.contentTypeIds.length &&
    selectedIds.every((id) => channel.contentTypeIds.includes(id));

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (unchanged) {
      onDone();
      return;
    }

    save.mutate(
      { channelId: channel.id, contentTypeIds: selectedIds },
      {
        onSuccess: () => {
          toast.success(
            selectedIds.length === 0
              ? `${channel.displayName} has no content types`
              : `${channel.displayName} updated`,
          );
          onDone();
        },
        onError: (error) =>
          toast.error("Could not save those content types", {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <ContentTypePicker
        selectedIds={selectedIds}
        assignedIds={channel.contentTypeIds}
        onToggle={toggle}
        onCreated={(id) => setSelectedIds((current) => [...current, id])}
        disabled={save.isPending}
        hint="Deselect everything to leave this channel untagged."
      />

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={save.isPending}
          onClick={onDone}
        >
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="sm" loading={save.isPending}>
          Save
        </Button>
      </div>
    </form>
  );
}
