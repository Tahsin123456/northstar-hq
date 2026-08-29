"use client";

import * as React from "react";
import {
  HIT_RATE_PENDING_EXPLANATION,
  HIT_RATE_UNKNOWN_EXPLANATION,
  HIT_RATE_UNSCOREABLE_EXPLANATION,
} from "@/lib/analytics/constants";
import {
  ageInHours,
  formatHitWindow,
  hitContributionOf,
  windowClosesAt,
  type HitContribution,
  type StoredHitVerdict,
} from "@/lib/analytics/hit-rate";
import { formatCompactNumber, formatNumber } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * =========================================================================
 * ONE SHORT'S VERDICT, ON SCREEN
 * =========================================================================
 *
 * The badge that used to read "Hit" whenever lifetime views cleared the bar.
 * That was the whole bug in one component: it said "Hit" for a Short that
 * crossed 1,000,000 three years after publishing, and said nothing at all for
 * one that crossed it in four hours and has since had views purged.
 *
 * FOUR STATES, NOT TWO, and the two new ones are the point. "Pending" and
 * "Unrecorded" are answers rather than the absence of one, so they get a label
 * each and neither is drawn as a failure — a Short inside its window has not
 * lost anything, and one nobody was recording has arguably won.
 *
 * The tooltip carries the EVIDENCE rather than restating the label. "Reached
 * 1.2M by hour 14 of a 7-day window" is what makes a verdict checkable by the
 * person most likely to question it, and \`observedAtHours\` is the honesty
 * field: a miss read at hour 167 is a far stronger claim than one read at
 * hour 6, and the badge would look identical without it.
 */
export function HitOutcomeBadge({
  verdict,
  publishedAt,
  lifetimeViews,
  size = "sm",
}: {
  verdict: StoredHitVerdict | null;
  /** Epoch ms. Used only to say when a pending window closes. */
  publishedAt: number;
  /** Today's total, for the "nothing was seen inside the window" tooltips. */
  lifetimeViews: number;
  size?: "sm" | "md";
}) {
  const contribution = hitContributionOf(verdict);
  const label = OUTCOME_LABEL[contribution];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={OUTCOME_VARIANT[contribution]} size={size}>
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-[280px]">
        {explain(contribution, verdict, publishedAt, lifetimeViews)}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The word for each contribution.
 *
 * "Unrecorded" rather than "Unknown", deliberately. The stored outcome IS
 * "unknown", and that is the right word in a schema — but on a table row beside
 * a Short with two million views it reads as a system failure, when what
 * actually happened is that nobody was sampling during the window. "Unrecorded"
 * says where the gap is: in the history, not in the Short.
 */
const OUTCOME_LABEL: Record<HitContribution, string> = {
  hit: "Hit",
  miss: "Miss",
  pending: "In window",
  unknown: "Unrecorded",
  unscoreable: "No rule",
};

/**
 * Only a hit is coloured as a win, and only a miss is muted as a loss.
 *
 * The two excluded states are neutral on purpose. Colouring "In window" as a
 * near-miss would tell somebody their Short is failing when its window has four
 * days left, and colouring "Unrecorded" as anything but neutral would take a
 * side on a question nobody can answer.
 */
const OUTCOME_VARIANT: Record<HitContribution, "hit" | "miss" | "neutral" | "outline"> = {
  hit: "hit",
  miss: "miss",
  pending: "outline",
  unknown: "neutral",
  unscoreable: "outline",
};

function explain(
  contribution: HitContribution,
  verdict: StoredHitVerdict | null,
  publishedAt: number,
  lifetimeViews: number,
): React.ReactNode {
  if (contribution === "unscoreable") {
    return verdict === null
      ? "No verdict has been recorded for this Short yet. Evaluation runs with the scheduled sync."
      : HIT_RATE_UNSCOREABLE_EXPLANATION;
  }
  // Narrowing for the compiler and for the reader: every branch below has a
  // rule, because `hitContributionOf` sends a verdict without one to
  // "unscoreable" above.
  if (verdict === null || verdict.thresholdApplied === null || verdict.windowHoursApplied === null) {
    return HIT_RATE_UNSCOREABLE_EXPLANATION;
  }

  const rule = `${formatCompactNumber(verdict.thresholdApplied)} within ${formatHitWindow(verdict.windowHoursApplied)}`;

  if (contribution === "pending") {
    const closesAt = windowClosesAt(publishedAt, verdict.windowHoursApplied);
    const hoursLeft = Math.max(0, ageInHours(Date.now(), closesAt));
    return (
      <>
        Needs {rule} of publishing. Its window is still open
        {hoursLeft > 0 ? ` for about ${formatHitWindow(hoursLeft)}` : ""}, so it is
        neither a hit nor a miss. {HIT_RATE_PENDING_EXPLANATION}
      </>
    );
  }

  if (contribution === "unknown") {
    return (
      <>
        Needs {rule} of publishing, and no view count was recorded inside that
        window. It has {formatNumber(lifetimeViews)} views today.{" "}
        {HIT_RATE_UNKNOWN_EXPLANATION}
      </>
    );
  }

  const { viewsAtWindow, observedAtHours } = verdict;

  if (contribution === "hit") {
    return (
      <>
        Reached {rule} of publishing
        {viewsAtWindow !== null && observedAtHours !== null
          ? ` — ${formatNumber(viewsAtWindow)} views already at hour ${observedAtHours}`
          : ""}
        .
      </>
    );
  }

  // Miss. Two very different kinds, and the tooltip says which: observed short
  // inside the window, or ruled out because the lifetime total has still not
  // reached the bar. The second needs no history at all and is the inference
  // that makes this metric computable on a library nobody was sampling.
  return viewsAtWindow !== null && observedAtHours !== null ? (
    <>
      Needed {rule} of publishing. It had {formatNumber(viewsAtWindow)} views at
      hour {observedAtHours}, the last reading inside the window.
    </>
  ) : (
    <>
      Needed {rule} of publishing. It has only {formatNumber(lifetimeViews)} views
      today, so it cannot have cleared the bar inside a window that has closed.
    </>
  );
}
