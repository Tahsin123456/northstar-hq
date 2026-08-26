"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Search, Users } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api-client";
import type { ChannelPreviewDTO, OwnershipType } from "@/lib/dto";
import { formatCompactNumber } from "@/lib/format";
import { useAddChannel, useDataset } from "@/hooks/use-dataset";
import { NichePicker, TypeOption } from "@/components/niches/niche-picker";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FieldHint, Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Add-channel flow: paste → preview → confirm.
 *
 * The preview step exists because channel identifiers are easy to get subtly
 * wrong — two channels with near-identical handles, a stale link, a video URL
 * pasted instead of a channel URL. Showing the real avatar, name and
 * subscriber count before anything is written makes a mistake obvious *before*
 * it costs a sync.
 */
export function AddChannelDialog({
  trigger,
  onOpenChange,
}: {
  trigger: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [preview, setPreview] = React.useState<ChannelPreviewDTO | null>(null);
  const [ownershipType, setOwnershipType] = React.useState<OwnershipType>("competitor");
  const [nicheIds, setNicheIds] = React.useState<string[]>([]);

  const { data: dataset } = useDataset();
  const niches = dataset?.niches ?? [];

  const resolve = useMutation({
    mutationFn: (value: string) => api.resolveChannel(value),
    onSuccess: (result) => setPreview(result),
    onError: () => setPreview(null),
  });

  const add = useAddChannel();

  const reset = React.useCallback(() => {
    setInput("");
    setPreview(null);
    // Ownership resets to "competitor" every time: most channels added to a
    // research tracker are competitors, and silently inheriting "own" from a
    // previous add is the kind of stickiness that mislabels data.
    setOwnershipType("competitor");
    setNicheIds([]);
    resolve.reset();
    add.reset();
  }, [resolve, add]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
    if (!next) {
      // Delay so the closing animation is not visibly interrupted by a reset.
      setTimeout(reset, 200);
    }
  };

  const handleLookup = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;
    resolve.mutate(trimmed);
  };

  const handleConfirm = () => {
    if (!preview) return;
    add.mutate(
      { input: preview.youtubeChannelId, ownershipType, nicheIds },
      {
      onSuccess: (result) => {
        const shorts = result.sync.videosUpdated;
        toast.success(
          result.restored
            ? `${result.channel.displayName} restored to your tracker`
            : `${result.channel.displayName} added`,
          {
            description:
              result.sync.status === "error"
                ? `Added, but the first sync failed: ${result.sync.error}`
                : `Synced ${shorts} ${shorts === 1 ? "video" : "videos"} · ${result.sync.quotaUnitsUsed} API units used`,
          },
        );
        handleOpenChange(false);
      },
        onError: (error) => {
          if (error instanceof ApiError && error.code === "CHANNEL_ALREADY_TRACKED") {
            toast.error(error.message);
            return;
          }
          toast.error("Could not add that channel", {
            description: error instanceof Error ? error.message : undefined,
          });
        },
      },
    );
  };

  const resolveError = resolve.error;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>

      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a channel</DialogTitle>
          <DialogDescription>
            Paste a YouTube channel URL, an @handle, or a channel ID. A video
            link works too — we&rsquo;ll resolve it to its channel.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          <form onSubmit={handleLookup} className="flex flex-col gap-2">
            <Label htmlFor="channel-input">Channel</Label>
            <div className="flex items-center gap-2">
              <Input
                id="channel-input"
                autoFocus
                placeholder="youtube.com/@channelname"
                value={input}
                invalid={Boolean(resolveError)}
                onChange={(event) => {
                  setInput(event.target.value);
                  setPreview(null);
                  resolve.reset();
                }}
              />
              <Button
                type="submit"
                variant="secondary"
                loading={resolve.isPending}
                disabled={!input.trim()}
                className="shrink-0"
              >
                {resolve.isPending ? null : <Search />}
                Look up
              </Button>
            </div>

            {resolveError ? (
              <FieldHint tone="danger" className="flex items-start gap-1.5">
                <AlertCircle className="mt-px size-3.5 shrink-0" />
                <span>
                  {resolveError instanceof Error
                    ? resolveError.message
                    : "Could not look up that channel."}
                </span>
              </FieldHint>
            ) : (
              <FieldHint>
                Accepts <code className="text-[11px]">@handle</code>,{" "}
                <code className="text-[11px]">youtube.com/@name</code>,{" "}
                <code className="text-[11px]">/channel/UC…</code>, or a video URL.
              </FieldHint>
            )}
          </form>

          {resolve.isPending ? <PreviewSkeleton /> : null}

          {preview && !resolve.isPending ? (
            <>
              <ChannelPreview preview={preview} />

              {/*
                Categorisation appears only once a channel has actually
                resolved. Showing these upfront would ask the user to classify
                something they have not confirmed yet, and would make the
                dialog look twice as complicated as it is.
              */}
              {!preview.alreadyTracked ? (
                <div className="flex flex-col gap-4 animate-in-rise">
                  <div className="flex flex-col gap-2">
                    <Label>Channel type</Label>
                    <div className="grid grid-cols-2 gap-2">
                      <TypeOption
                        label="Competitor"
                        description="Tracking for research"
                        selected={ownershipType === "competitor"}
                        onSelect={() => setOwnershipType("competitor")}
                      />
                      <TypeOption
                        label="Our channel"
                        description="One we operate"
                        selected={ownershipType === "own"}
                        onSelect={() => setOwnershipType("own")}
                      />
                    </div>
                  </div>

                  <NichePicker
                    niches={niches}
                    selectedIds={nicheIds}
                    onChange={setNicheIds}
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            loading={add.isPending}
            disabled={!preview || preview.alreadyTracked}
          >
            {add.isPending
              ? "Fetching Shorts…"
              : preview?.previouslyRemoved
                ? "Restore to tracker"
                : "Add to tracker"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChannelPreview({ preview }: { preview: ChannelPreviewDTO }) {
  return (
    <div className="animate-in-rise rounded-lg border border-border bg-surface-sunken p-3.5">
      <div className="flex items-start gap-3">
        <Avatar src={preview.avatarUrl} name={preview.title} size={44} />

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-foreground">
                {preview.title}
              </div>
              {preview.handle ? (
                <div className="truncate text-[12px] text-muted-foreground">
                  {preview.handle}
                </div>
              ) : null}
            </div>

            {preview.alreadyTracked ? (
              <Badge variant="accent" size="md" className="shrink-0">
                Already tracked
              </Badge>
            ) : preview.previouslyRemoved ? (
              <Badge variant="neutral" size="md" className="shrink-0">
                Previously removed
              </Badge>
            ) : (
              <CheckCircle2 className="size-4 shrink-0 text-success" />
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
            <span className="tnum inline-flex items-center gap-1.5">
              <Users className="size-3 text-subtle-foreground" />
              {preview.hiddenSubscriberCount
                ? "Subscribers hidden"
                : `${formatCompactNumber(preview.subscriberCount)} subscribers`}
            </span>
            {preview.videoCount !== null ? (
              <span className="tnum">
                {formatCompactNumber(preview.videoCount)} videos total
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {preview.previouslyRemoved ? (
        <p className="mt-3 border-t border-border pt-2.5 text-[12px] leading-relaxed text-muted-foreground">
          This channel was removed from your tracker earlier. Its previously
          collected Shorts and view history are still stored and will come back
          with it.
        </p>
      ) : (
        <p className="mt-3 border-t border-border pt-2.5 text-[12px] leading-relaxed text-muted-foreground">
          Adding will fetch this channel&rsquo;s recent uploads and identify
          which are Shorts. Long-form videos are stored but excluded from every
          Shorts metric.
        </p>
      )}
    </div>
  );
}

function PreviewSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-surface-sunken p-3.5">
      <div className="flex items-start gap-3">
        <Skeleton className="size-11 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-1 h-3 w-52" />
        </div>
      </div>
    </div>
  );
}
