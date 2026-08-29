"use client";

import * as React from "react";
import { toast } from "sonner";
import type { ChannelDTO } from "@/lib/dto";
import { useSetChannelContentTypes } from "@/hooks/use-content-types";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ContentTypePicker } from "@/components/content-types/content-type-picker";

/**
 * Tag a channel with what it makes.
 *
 * A SECOND, INDEPENDENT STATEMENT from the niches next door, and from what the
 * channel's Shorts turn out to be. The niche says which slice of the operation
 * a channel belongs to; these say what the team reckons it produces. The Shorts
 * themselves are tagged separately, and the disagreement between the two is
 * often the finding — "we file this as a Rankings channel and 80% of its hits
 * are Character Moments" is a sentence this pairing exists to make sayable.
 *
 * Mounted only while open, so the selection initialises from the channel's
 * current tags each time — no effect resyncing state on open. Same arrangement
 * as `AssignNichesDialog`, deliberately: these are two dialogs off the same
 * menu and they should not behave differently.
 */
export function AssignContentTypesDialog({
  channel,
  open,
  onOpenChange,
}: {
  channel: ChannelDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {open ? <AssignForm channel={channel} onOpenChange={onOpenChange} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AssignForm({
  channel,
  onOpenChange,
}: {
  channel: ChannelDTO;
  onOpenChange: (open: boolean) => void;
}) {
  const [selectedIds, setSelectedIds] = React.useState<string[]>(() => [
    ...channel.contentTypeIds,
  ]);

  const save = useSetChannelContentTypes();

  const toggle = (id: string) => {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((existing) => existing !== id)
        : [...current, id],
    );
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    save.mutate(
      { channelId: channel.id, contentTypeIds: selectedIds },
      {
        onSuccess: () => {
          toast.success(
            selectedIds.length === 0
              ? `${channel.displayName} has no content types`
              : `${channel.displayName} updated`,
          );
          onOpenChange(false);
        },
        onError: (error) =>
          toast.error("Could not save those content types", {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Content types</DialogTitle>
        <DialogDescription>
          What this channel makes. Separate from what its individual Shorts are filed
          under — the two are allowed to disagree.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-sunken p-3">
          <Avatar src={channel.avatarUrl} name={channel.displayName} size={32} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-foreground">
              {channel.displayName}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {channel.handle ?? channel.youtubeChannelId}
            </div>
          </div>
        </div>

        <ContentTypePicker
          selectedIds={selectedIds}
          assignedIds={channel.contentTypeIds}
          onToggle={toggle}
          onCreated={(id) => setSelectedIds((current) => [...current, id])}
          disabled={save.isPending}
          hint="Deselect everything to leave this channel untagged."
        />
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
