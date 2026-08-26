"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ExternalLink,
  Layers,
  LineChart,
  Pencil,
  RefreshCw,
  Trash2,
  UserCheck,
  UserMinus,
} from "lucide-react";
import { toast } from "sonner";
import type { ChannelDTO } from "@/lib/dto";
import { useRefreshChannel } from "@/hooks/use-dataset";
import { useSetChannelOwnership } from "@/hooks/use-niches";
import { AssignNichesDialog } from "./assign-niches-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RenameChannelDialog } from "./rename-channel-dialog";
import { RemoveChannelDialog } from "./remove-channel-dialog";

/**
 * Per-channel actions.
 *
 * Remove sits behind both a separator and a confirmation dialog. The spec is
 * explicit that accidental deletion must not be easy, and a destructive item
 * adjacent to "Refresh" in a hover menu is exactly how that happens.
 */
export function ChannelRowMenu({
  channel,
  trigger,
}: {
  channel: ChannelDTO;
  trigger: React.ReactNode;
}) {
  const router = useRouter();
  const refresh = useRefreshChannel();
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [removeOpen, setRemoveOpen] = React.useState(false);
  const [nichesOpen, setNichesOpen] = React.useState(false);
  const ownership = useSetChannelOwnership();

  const handleToggleOwnership = () => {
    const next = channel.ownershipType === "own" ? "competitor" : "own";
    ownership.mutate(
      { channelId: channel.id, ownershipType: next },
      {
        onSuccess: () =>
          toast.success(
            next === "own"
              ? `${channel.displayName} marked as one of your channels`
              : `${channel.displayName} marked as a competitor`,
          ),
        onError: (error) =>
          toast.error("Could not update that channel", {
            description: error instanceof Error ? error.message : undefined,
          }),
      },
    );
  };

  const handleRefresh = () => {
    refresh.mutate(channel.id, {
      onSuccess: ({ result }) => {
        if (result.status === "error") {
          toast.error(`Could not refresh ${channel.displayName}`, {
            description: result.error ?? undefined,
          });
          return;
        }
        toast.success(`${channel.displayName} refreshed`, {
          description: `${result.videosUpdated} videos updated · ${result.quotaUnitsUsed} API units used`,
        });
      },
      onError: (error) =>
        toast.error("Refresh failed", {
          description: error instanceof Error ? error.message : undefined,
        }),
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => router.push(`/channels/${channel.id}`)}>
            <LineChart />
            View analytics
          </DropdownMenuItem>

          <DropdownMenuItem onSelect={handleRefresh} disabled={refresh.isPending}>
            <RefreshCw />
            {refresh.isPending ? "Refreshing…" : "Refresh data"}
          </DropdownMenuItem>

          <DropdownMenuItem
            onSelect={() => window.open(channel.channelUrl, "_blank", "noopener,noreferrer")}
          >
            <ExternalLink />
            Open on YouTube
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={() => setNichesOpen(true)}>
            <Layers />
            {channel.niches.length > 0 ? "Change niches" : "Assign niche"}
          </DropdownMenuItem>

          <DropdownMenuItem onSelect={handleToggleOwnership} disabled={ownership.isPending}>
            {channel.ownershipType === "own" ? <UserMinus /> : <UserCheck />}
            {channel.ownershipType === "own"
              ? "Mark as competitor"
              : "Mark as our channel"}
          </DropdownMenuItem>

          <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
            <Pencil />
            Rename label
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem tone="danger" onSelect={() => setRemoveOpen(true)}>
            <Trash2 />
            Remove from tracker
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameChannelDialog
        channel={channel}
        open={renameOpen}
        onOpenChange={setRenameOpen}
      />
      <RemoveChannelDialog
        channel={channel}
        open={removeOpen}
        onOpenChange={setRemoveOpen}
      />
      <AssignNichesDialog
        channel={channel}
        open={nichesOpen}
        onOpenChange={setNichesOpen}
      />
    </>
  );
}
