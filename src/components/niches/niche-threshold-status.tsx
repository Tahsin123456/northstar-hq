"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import {
  NEEDS_RULE_LABEL,
  UNCONFIGURED_RULE_EXPLANATION,
  UNCONFIGURED_WINDOW_EXPLANATION,
} from "@/lib/analytics/constants";
import { missingHitRuleHalf } from "@/lib/analytics/hit-rate";
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

/**
 * True when this niche is missing EITHER half of its rule.
 *
 * It used to ask only about the threshold, which quietly stopped being the
 * question the day a hit gained a clock: a niche with "1,000,000" and no window
 * looks configured, wears no badge, and reports nothing. That is the precise
 * failure this badge exists to prevent, so the test is the whole rule.
 */
export function needsRuleConfiguration(niche: NicheDTO): boolean {
  return missingHitRuleHalf(niche) !== null;
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
    const aNeeds = needsRuleConfiguration(a) ? 0 : 1;
    const bNeeds = needsRuleConfiguration(b) ? 0 : 1;
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
 *
 * The tooltip names WHICH HALF is missing, because "not configured" sends an
 * admin looking through a form for something that might be either of two
 * fields, and the whole point of surfacing a gap is that somebody can close it
 * without having to ask which one it is.
 */
export function NeedsRuleBadge({
  niche,
  className,
}: {
  niche: NicheDTO;
  className?: string;
}) {
  const missing = missingHitRuleHalf(niche);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="near"
          size="sm"
          className={cn("normal-case tracking-normal", className)}
        >
          <AlertTriangle className="size-3" aria-hidden />
          {NEEDS_RULE_LABEL}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {missing === "window"
          ? UNCONFIGURED_WINDOW_EXPLANATION
          : UNCONFIGURED_RULE_EXPLANATION}
      </TooltipContent>
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
