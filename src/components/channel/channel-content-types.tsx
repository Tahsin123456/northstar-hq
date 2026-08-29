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
 * A SECOND, INDEPENDENT STATEMENT from what the channel's Shorts turn out to be.
 * The niche says which slice of the operation a channel belongs to; this says
 * what the team reckons it produces; the Shorts in the table below say what each
 * one actually was. The two content-type readings are allowed to disagree, and
 * the disagreement is usually the finding — "we file this as a Rankings channel
 * and 80% of its hits are Character Moments" is a sentence this pairing exists
 * to make sayable.
 *
 * SAVE/CANCEL RATHER THAN LIVE TOGGLES, unlike the per-Short control on the rows
 * below. The natural unit here is the whole set: deciding a channel does
 * Rankings and Tier Lists but not Cutscenes is one thought, and committing it as
 * three requests would leave three audit entries for it and two incoherent
 * intermediate states visible to anyone else reading the channel at the time.
 * A Short is the opposite — one row, one judgement, commit on click.
 */
export function ChannelContentTypes({ channel }: { channel: ChannelDTO }) {
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
              What this channel makes, as the team reads it. Separate from what its
              individual Shorts are filed under — the two are allowed to disagree.
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

      <CardContent>
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
              ? "Not tagged yet. Say what this channel makes and it becomes comparable with every other channel making the same thing."
              : "Not tagged yet."}
          </p>
        )}
      </CardContent>
    </Card>
  );
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
