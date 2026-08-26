"use client";

import * as React from "react";
import { toast } from "sonner";
import type { ChannelDTO } from "@/lib/dto";
import { useRenameChannel } from "@/hooks/use-dataset";
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
import { FieldHint, Input, Label } from "@/components/ui/input";

/**
 * Rename a channel *in the tracker*.
 *
 * This is a local label, not an edit to anything on YouTube — worth being
 * explicit about in the copy, since "rename" otherwise implies more power than
 * the app has. Clearing the field restores the channel's own title.
 */
export function RenameChannelDialog({
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
      <DialogContent className="max-w-sm">
        {/*
          The form is a separate component rendered only while the dialog is
          open, so its input state initialises fresh from the current label on
          every open. Keeping it mounted and resyncing from an effect would set
          state on each open and cascade a render.
        */}
        {open ? <RenameForm channel={channel} onOpenChange={onOpenChange} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({
  channel,
  onOpenChange,
}: {
  channel: ChannelDTO;
  onOpenChange: (open: boolean) => void;
}) {
  const [label, setLabel] = React.useState(channel.label ?? "");
  const rename = useRenameChannel();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = label.trim();
    rename.mutate(
      { id: channel.id, label: trimmed.length > 0 ? trimmed : null },
      {
        onSuccess: ({ channel: updated }) => {
          toast.success(
            trimmed ? `Renamed to “${updated.displayName}”` : "Label cleared",
          );
          onOpenChange(false);
        },
        onError: (error) =>
          toast.error("Could not rename", {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  return (
    <form onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Rename channel</DialogTitle>
        <DialogDescription>
          Sets a label used only inside your tracker. Nothing on YouTube changes.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-2">
        <Label htmlFor="channel-label">Label</Label>
        <Input
          id="channel-label"
          autoFocus
          value={label}
          maxLength={120}
          placeholder={channel.title}
          onChange={(event) => setLabel(event.target.value)}
        />
        <FieldHint>
          Leave empty to go back to the channel&rsquo;s own name,{" "}
          <span className="text-foreground">{channel.title}</span>.
        </FieldHint>
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={rename.isPending}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
