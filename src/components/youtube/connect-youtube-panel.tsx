"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Coins, Plug, Plus, RefreshCw, Youtube } from "lucide-react";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/components/providers/session-provider";
import { ConnectScopeFacts } from "@/components/youtube/connect-scope-facts";
import {
  useAddOwnYouTubeChannel,
  useOwnYouTubeChannels,
  useYouTubeConnections,
  YOUTUBE_CONNECT_PATH,
} from "@/hooks/use-youtube-connections";
import type { OwnChannelDTO } from "@/lib/dto";
import {
  ownChannelPickerState,
  youTubeSetupState,
  type YouTubeSetupState,
} from "@/lib/youtube/connection-state";
import { formatCompactNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * =========================================================================
 * "CONNECT YOUR CHANNEL(S)", WHEREVER SOMEBODY FIRST WONDERS
 * =========================================================================
 *
 * The owner's complaint was about findability, and it was fair: this lived only
 * on Admin → YouTube, which is the last place a person looks and the first place
 * they would need it. Their own numbers look thin on the dashboard and on the
 * channels screen, and those are the two places the explanation should be.
 *
 * So this panel is mounted on the channels screen and in the dashboard's empty
 * state as well as behind the admin page, and it renders the SAME state
 * derivation the admin page does — `youTubeSetupState`, which is the single
 * definition of the five states the owner asked to read honestly. Four copies of
 * "reconnect and leave every permission ticked" is three copies that eventually
 * disagree.
 *
 * THE SECOND HALF IS THE POINT. Below the state it lists the channels the
 * connected accounts actually own, each with one button. No channel id, no
 * paste, no lookup step — Google has already said which channels these are.
 * That is what the owner asked for and it is also the safer flow: a typed id is
 * how somebody else's channel gets filed as one of yours.
 *
 * THE CONNECT ACTION IS AN ANCHOR, NEVER A FETCH. /api/youtube/connect answers
 * with a 302 to accounts.google.com; `fetch` would follow that inside the
 * request instead of in the address bar and the consent screen would never
 * appear. Same mechanism, and the same reasoning, as the admin page's button.
 */

/**
 * `full` on the surfaces where connecting is the main event — the dashboard's
 * empty state, and the channels screen when nothing is connected. `compact`
 * once it is working, where the panel should report and get out of the way
 * rather than occupying the top of a screen about something else.
 */
export function ConnectYouTubePanel({
  variant = "full",
  className,
}: {
  variant?: "full" | "compact";
  className?: string;
}) {
  const { can } = useSession();
  // An affordance, not the boundary — every route behind this calls
  // requirePermission("youtube.manage") of its own. Gating here keeps an editor
  // from firing two requests that could only come back 403, and keeps a panel
  // off their screen whose every action they are not permitted to take.
  const mayManage = can("youtube.manage");

  const { data, isLoading } = useYouTubeConnections(mayManage);

  if (!mayManage) return null;

  if (isLoading || !data) {
    // Only in `full`, where the panel is the reason the screen is worth looking
    // at. A compact strip that flashes a skeleton on every navigation is noise
    // about something that is probably fine.
    return variant === "full" ? (
      <Card className={cn("p-5", className)}>
        <Skeleton className="h-4 w-1/3 rounded" />
        <Skeleton className="mt-3 h-3 w-2/3 rounded" />
      </Card>
    ) : null;
  }

  const state = youTubeSetupState({
    configured: data.google.configured,
    connections: data.connections,
  });

  return (
    <Card className={cn("flex flex-col", className)}>
      <StateHeader state={state} variant={variant} />
      {/* Offered whenever anything is connected, including while a state above
          is unhappy: a workspace with one broken grant and two working ones
          still has channels worth adding, and hiding the list would make the
          broken account's problem look like everybody's. */}
      {data.connections.length > 0 ? (
        <OwnChannelList variant={variant} connectionCount={data.connections.length} />
      ) : null}
    </Card>
  );
}

const TONE_CLASSES = {
  danger: "border-danger/25 bg-danger-subtle",
  warning: "border-warning/25 bg-warning-subtle",
  info: "border-border bg-surface-sunken",
  success: "border-success/25 bg-success-subtle",
} as const;

const TONE_ICON_CLASSES = {
  danger: "text-danger",
  warning: "text-warning",
  info: "text-subtle-foreground",
  success: "text-success",
} as const;

function StateHeader({
  state,
  variant,
}: {
  state: YouTubeSetupState;
  variant: "full" | "compact";
}) {
  const Icon = state.tone === "success" ? CheckCircle2 : state.tone === "info" ? Coins : AlertTriangle;

  return (
    <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-start lg:justify-between lg:gap-8">
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border",
            TONE_CLASSES[state.tone],
          )}
        >
          <Icon className={cn("size-4", TONE_ICON_CLASSES[state.tone])} />
        </span>

        <div className="min-w-0">
          <h2 className="text-[15px] font-medium text-foreground">{state.title}</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{state.body}</p>

          {/* The three facts somebody deserves before granting access — the
              shared copy, identical to the admin page's, and only rendered where
              the grant is actually about to happen. */}
          {variant === "full" && state.offerConnect ? (
            <div className="mt-3">
              <ConnectScopeFacts />
            </div>
          ) : null}

          <div className="mt-3">
            <Link
              href="/admin/youtube"
              className="text-[11px] text-subtle-foreground underline-offset-2 hover:text-muted-foreground hover:underline"
            >
              Manage connected accounts
            </Link>
          </div>
        </div>
      </div>

      {state.offerConnect ? (
        <Button asChild variant="primary" size={variant === "full" ? "lg" : "sm"} className="shrink-0 self-start">
          <a href={YOUTUBE_CONNECT_PATH}>
            {state.id === "needs_reauth" ? <RefreshCw /> : <Youtube />}
            {state.connectLabel}
          </a>
        </Button>
      ) : (
        // Still offered, quietly. A studio adding its second channel is the
        // normal case, and a panel that only appears when something is wrong
        // gives them nowhere to start from.
        <Button asChild variant="secondary" size="sm" className="shrink-0 self-start">
          <a href={YOUTUBE_CONNECT_PATH}>
            <Plug />
            Connect another channel
          </a>
        </Button>
      )}
    </div>
  );
}

/**
 * The channels the connection says it owns.
 *
 * Every outcome is stated, including the two that used to render nothing: an
 * account that owns no channel at all, and an account whose channels are all
 * already tracked. The first was the worse of the two — a green "connected and
 * syncing" heading above a blank area, with the actual fact ("this account owns
 * no channel") stated only in the one-time banner right after the callback,
 * which nobody sees twice. The wording lives in `ownChannelPickerState` so it is
 * decided once and testable.
 *
 * A channel filed as a competitor is still offered, with a different verb,
 * because adding it corrects a label rather than creating anything.
 */
function OwnChannelList({
  variant,
  connectionCount,
}: {
  variant: "full" | "compact";
  connectionCount: number;
}) {
  const { data, isLoading, error } = useOwnYouTubeChannels(true);

  if (isLoading) {
    return (
      <div className="border-t border-border p-5">
        <Skeleton className="h-10 w-full rounded" />
      </div>
    );
  }

  // A failure here is not worth a red panel on the channels screen: the
  // connections themselves are fine (the state above says so), and this list is
  // an offer rather than a report. Admin → YouTube is where a broken connection
  // gets diagnosed, and the link to it is already above.
  if (error || !data) return null;

  const channels = data.channels;
  const offerable = channels.filter((channel) => !channel.alreadyTracked);
  const picker = ownChannelPickerState({
    discoveredCount: channels.length,
    offerableCount: offerable.length,
    connectionCount,
  });

  if (picker.id !== "offering") {
    /*
     * "Owns no channel" is stated on both variants, because it is the one that
     * explains why the rest of the screen is empty. "Everything is already
     * tracked" stays on the full variant only: it is a confirmation, and the
     * compact panel sits beside a channel list that already shows the channels
     * it is confirming.
     */
    if (picker.id === "all_tracked" && variant !== "full") return null;

    return (
      <div className="border-t border-border px-5 py-3">
        <h3 className="text-[13px] font-medium text-foreground">{picker.title}</h3>
        <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{picker.body}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col border-t border-border">
      <div className="px-5 pt-4">
        <h3 className="text-[13px] font-medium text-foreground">{picker.title}</h3>
        <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{picker.body}</p>
      </div>

      <div className="mt-2 divide-y divide-border">
        {offerable.map((channel) => (
          <OwnChannelRow key={channel.youtubeChannelId} channel={channel} />
        ))}
      </div>
    </div>
  );
}

function OwnChannelRow({ channel }: { channel: OwnChannelDTO }) {
  const add = useAddOwnYouTubeChannel();

  return (
    <div className="flex items-center gap-3 px-5 py-3">
      <Avatar src={channel.avatarUrl} name={channel.title} size={32} />

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-foreground">{channel.title}</span>
          {channel.trackedAsCompetitor ? (
            <Badge variant="near" size="sm" className="shrink-0 tracking-wider">
              Filed as competitor
            </Badge>
          ) : channel.previouslyRemoved ? (
            <Badge variant="neutral" size="sm" className="shrink-0 tracking-wider">
              Previously removed
            </Badge>
          ) : null}
        </div>
        <div className="truncate text-[11px] text-subtle-foreground">
          {channel.handle ?? channel.youtubeChannelId}
          {channel.hiddenSubscriberCount
            ? " · subscribers hidden"
            : channel.subscriberCount !== null
              ? ` · ${formatCompactNumber(channel.subscriberCount)} subs`
              : ""}
        </div>
      </div>

      <Button
        variant="secondary"
        size="sm"
        loading={add.isPending}
        className="shrink-0"
        onClick={() =>
          add.mutate(
            { connectionId: channel.connectionId, youtubeChannelId: channel.youtubeChannelId },
            {
              onSuccess: (result) => {
                // Three different things can have happened and they are not the
                // same event. Saying "added" over a channel that was already
                // tracked under the wrong label would describe the wrong one.
                const what = result.reclassified
                  ? `${result.title} is now marked as one of yours`
                  : result.restored
                    ? `${result.title} restored to your tracker`
                    : `${result.title} added`;

                if (result.sync.status === "error") {
                  toast.warning(what, {
                    description: `Its first sync did not complete: ${result.sync.error}`,
                    duration: 10_000,
                  });
                  return;
                }

                toast.success(what, {
                  description:
                    result.sync.dataSource === "connection"
                      ? `Synced ${result.sync.videosUpdated} ${result.sync.videosUpdated === 1 ? "video" : "videos"} using this account's own authorisation.`
                      : // Reachable if the grant expired between listing and
                        // adding. Worth saying rather than glossing: the figures
                        // that just arrived did not come from where the button
                        // promised they would.
                        `Synced ${result.sync.videosUpdated} ${result.sync.videosUpdated === 1 ? "video" : "videos"}, but not through the connection. Check the account on Admin → YouTube.`,
                });
              },
              onError: (error) =>
                toast.error("Could not add that channel", {
                  description: error instanceof Error ? error.message : undefined,
                }),
            },
          )
        }
      >
        <Plus />
        {channel.trackedAsCompetitor ? "Mark as ours" : channel.previouslyRemoved ? "Restore" : "Add"}
      </Button>
    </div>
  );
}
