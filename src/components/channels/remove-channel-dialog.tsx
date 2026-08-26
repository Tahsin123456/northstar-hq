"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Archive } from "lucide-react";
import { toast } from "sonner";
import type { ChannelDTO } from "@/lib/dto";
import { useRemoveChannel, useRestoreChannel } from "@/hooks/use-dataset";
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

/**
 * Removal confirmation.
 *
 * The copy leads with what actually happens — the channel leaves the tracker,
 * the collected history stays — because that reframes a scary-looking action as
 * a reversible one, and it is the truth: removal is a soft delete. Historical
 * view counts can never be re-collected after the fact, so destroying them to
 * satisfy a UI gesture would be the one genuinely irreversible thing this app
 * could do.
 */
export function RemoveChannelDialog({
  channel,
  open,
  onOpenChange,
  redirectOnSuccess,
}: {
  channel: ChannelDTO;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Send the user somewhere after removal (used from the detail page). */
  redirectOnSuccess?: string;
}) {
  const router = useRouter();
  const remove = useRemoveChannel();
  const restore = useRestoreChannel();

  const handleRemove = () => {
    remove.mutate(channel.id, {
      onSuccess: () => {
        toast.success(`${channel.displayName} removed from your tracker`, {
          description: "Its Shorts history is kept and will return if you add it back.",
          action: {
            label: "Undo",
            onClick: () => {
              restore.mutate(channel.id, {
                onSuccess: () => toast.success(`${channel.displayName} restored`),
                onError: () => toast.error("Could not restore that channel"),
              });
            },
          },
        });
        onOpenChange(false);
        if (redirectOnSuccess) router.push(redirectOnSuccess);
      },
      onError: (error) =>
        toast.error("Could not remove that channel", {
          description: error instanceof Error ? error.message : undefined,
        }),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Remove this channel from your tracker?</DialogTitle>
          <DialogDescription>
            It will disappear from your dashboard and comparisons.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          <div className="flex items-center gap-3 rounded-lg border border-border bg-surface-sunken p-3">
            <Avatar src={channel.avatarUrl} name={channel.displayName} size={36} />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-foreground">
                {channel.displayName}
              </div>
              <div className="truncate text-[12px] text-muted-foreground">
                {channel.handle ?? channel.youtubeChannelId}
              </div>
            </div>
          </div>

          <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-sunken p-3">
            <Archive className="mt-px size-4 shrink-0 text-subtle-foreground" />
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Nothing is deleted. The Shorts, view counts and history already
              collected for this channel stay in the database, and adding the
              channel back later restores all of it. Past view counts cannot be
              re-collected from YouTube, so they are never discarded.
            </p>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleRemove} loading={remove.isPending}>
            Remove from tracker
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
