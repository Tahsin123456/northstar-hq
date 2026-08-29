"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import {
  NEEDS_THRESHOLD_LABEL,
  UNCONFIGURED_THRESHOLD_EXPLANATION,
} from "@/lib/analytics/constants";
import type { NicheDTO } from "@/lib/dto";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The two markers a niche that still needs a number wears.
 *
 * Kept together because they are always read together: the badge says there is
 * work to do, and the byline says whose work it is. An admin scanning a list of
 * niches for the ones to chase needs both in the same glance, and separating
 * them into two files would guarantee one screen eventually shows only the
 * warning — which is a task with nobody attached to it.
 */

/** True when this niche has no hit threshold and therefore reports no hit rate. */
export function needsThresholdConfiguration(niche: NicheDTO): boolean {
  return niche.hitThreshold === null;
}

/**
 * Sorts niches so the ones needing a threshold come first.
 *
 * The brief asks for unconfigured niches to be "visible rather than buried",
 * and a list sorted by `sortOrder` buries them by construction: they are
 * usually the newest, so they are usually last. Within each group the existing
 * order is preserved, so an admin's deliberate arrangement still holds for
 * everything that is already configured.
 */
export function unconfiguredFirst(niches: readonly NicheDTO[]): NicheDTO[] {
  return [...niches].sort((a, b) => {
    const aNeeds = needsThresholdConfiguration(a) ? 0 : 1;
    const bNeeds = needsThresholdConfiguration(b) ? 0 : 1;
    if (aNeeds !== bNeeds) return aNeeds - bNeeds;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.name.localeCompare(b.name);
  });
}

/**
 * "Needs hit rate configuration".
 *
 * A warning tone rather than a danger one: nothing is broken and no data is
 * wrong. A decision is outstanding, and the niche works as a filter in the
 * meantime — it simply reports no hit rate.
 */
export function NeedsThresholdBadge({ className }: { className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="near"
          size="sm"
          className={cn("normal-case tracking-normal", className)}
        >
          <AlertTriangle className="size-3" aria-hidden />
          {NEEDS_THRESHOLD_LABEL}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>{UNCONFIGURED_THRESHOLD_EXPLANATION}</TooltipContent>
    </Tooltip>
  );
}

/**
 * "Created by John Smith".
 *
 * Never renders an anonymous row: an author whose account has been deleted
 * reads as "Created by a removed account", because `createdById` is `SetNull`
 * and a niche outlives the person who typed it in. A blank byline would suggest
 * nobody made it.
 */
export function NicheByline({
  niche,
  className,
}: {
  niche: NicheDTO;
  className?: string;
}) {
  return (
    <span className={cn("text-[11px] text-subtle-foreground", className)}>
      Created by {niche.createdByName ?? "a removed account"}
    </span>
  );
}
