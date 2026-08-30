"use client";

import * as React from "react";
import { Globe, Link2, Link2Off } from "lucide-react";
import type { ChannelDataSource, OwnershipType } from "@/lib/dto";
import { cn } from "@/lib/utils";

/**
 * =========================================================================
 * "SAY WHICH YOU CHOSE AND MAKE THE SCREEN SAY IT TOO"
 * =========================================================================
 *
 * The owner asked for exactly that about a revoked or expired connection, and
 * this is the screen half of it. The server half — the decision to STOP rather
 * than quietly re-read an own channel through the public API — is in
 * `youtube-oauth-service.resolveChannelCredential`, and the whole argument for
 * it is there.
 *
 * What matters here is that the stop is never silent. A channel whose connection
 * has failed goes on showing its last good figures, which is correct (they were
 * real) and dangerous (they are no longer current), so every surface that shows
 * those numbers shows this line beside them.
 *
 * WHAT IS DELIBERATELY NOT SAID
 * Nothing at all for a competitor on the public API. That is not a compromise or
 * a degraded state — it is the only way a competitor can ever be seen, it will
 * never change, and a "public data" caption on two dozen competitor cards would
 * be noise that trains people to skip the one card where the same words matter.
 * The `public` state speaks only about a channel the studio owns, where it means
 * something actionable: nobody has connected the account yet.
 */

export interface ChannelSourceCopy {
  readonly label: string;
  readonly detail: string;
  readonly tone: "muted" | "warning";
  readonly icon: "connected" | "broken" | "public";
}

/**
 * What to say about one channel's source, or null when there is nothing worth
 * saying.
 *
 * Exported as a pure function so a card, a page header and a tooltip can all
 * render the same judgement without three copies of the conditions — the same
 * reason `youTubeSetupState` exists one level up.
 */
export function channelSourceCopy(
  dataSource: ChannelDataSource,
  ownershipType: OwnershipType,
): ChannelSourceCopy | null {
  if (dataSource === "connection_unavailable") {
    return {
      label: "Connection lost — figures frozen",
      detail:
        "This channel is read with its own Google account's authorisation, and that authorisation " +
        "has stopped working. It is deliberately NOT being read from the public API instead, so " +
        "the numbers here are the last ones successfully synced and are no longer updating. " +
        "Reconnect the account under Admin → YouTube to resume.",
      tone: "warning",
      icon: "broken",
    };
  }

  if (dataSource === "connection") {
    return {
      label: "From your connected account",
      detail:
        "Read with this channel's own Google authorisation rather than the public API, so these " +
        "are the channel's own figures.",
      tone: "muted",
      icon: "connected",
    };
  }

  // Public, and only worth a word when the studio owns the channel — see the
  // note at the top of this file.
  if (ownershipType === "own") {
    return {
      label: "Public figures only",
      detail:
        "Nobody has connected the Google account that owns this channel, so these are the numbers " +
        "YouTube shows the public. Connect the account to read its own figures and its estimated " +
        "revenue.",
      tone: "muted",
      icon: "public",
    };
  }

  return null;
}

const ICONS = {
  connected: Link2,
  broken: Link2Off,
  public: Globe,
} as const;

/**
 * One line, sized to sit in a card footer beside the freshness dot.
 *
 * `title` carries the full explanation rather than a tooltip component: this
 * renders inside a card that is entirely one big link, and a hoverable popover
 * nested in that is a click target fighting the card's own.
 */
export function ChannelSourceLine({
  dataSource,
  ownershipType,
  className,
}: {
  dataSource: ChannelDataSource;
  ownershipType: OwnershipType;
  className?: string;
}) {
  const copy = channelSourceCopy(dataSource, ownershipType);
  if (!copy) return null;

  const Icon = ICONS[copy.icon];

  return (
    <span
      title={copy.detail}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-[11px]",
        copy.tone === "warning" ? "text-warning" : "text-subtle-foreground",
        className,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{copy.label}</span>
    </span>
  );
}
