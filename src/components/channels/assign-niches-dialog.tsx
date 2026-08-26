"use client";

import * as React from "react";
import { toast } from "sonner";
import type { ChannelDTO } from "@/lib/dto";
import { useDataset } from "@/hooks/use-dataset";
import { useSetChannelNiches } from "@/hooks/use-niches";
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
import { NichePicker } from "@/components/niches/niche-picker";

/**
 * Change which niches a channel belongs to.
 *
 * The form is mounted only while open so its selection initialises from the
 * channel's current niches each time — no effect resyncing state on open.
 */
export function AssignNichesDialog({
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
  const { data } = useDataset();
  const [selectedIds, setSelectedIds] = React.useState<string[]>(() =>
    channel.niches.map((niche) => niche.id),
  );
  const save = useSetChannelNiches();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    save.mutate(
      { channelId: channel.id, nicheIds: selectedIds },
      {
        onSuccess: () => {
          toast.success(
            selectedIds.length === 0
              ? `${channel.displayName} is now uncategorised`
              : `${channel.displayName} updated`,
          );
          onOpenChange(false);
        },
        onError: (error) =>
          toast.error("Could not save those niches", {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Niches</DialogTitle>
        <DialogDescription>
          A channel can belong to more than one — “Gaming” and “GTA”, say.
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

        <NichePicker
          niches={data?.niches ?? []}
          selectedIds={selectedIds}
          onChange={setSelectedIds}
          label="Assigned niches"
          hint="Deselect everything to leave this channel uncategorised."
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
