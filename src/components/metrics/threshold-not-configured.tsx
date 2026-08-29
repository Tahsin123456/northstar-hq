"use client";

import * as React from "react";
import { Target } from "lucide-react";
import {
  UNCONFIGURED_THRESHOLD_EXPLANATION,
  UNCONFIGURED_THRESHOLD_LABEL,
  UNCONFIGURED_THRESHOLD_SHORT,
} from "@/lib/analytics/constants";
import { InfoTip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * What a screen shows where a hit rate would have been.
 *
 * The app used to answer "what is GTA's hit rate?" for a niche nobody had
 * configured by quietly borrowing the organization's 1,000,000 and printing a
 * percentage against it. The percentage was real arithmetic over a number no
 * human had chosen, which makes it a fabrication wearing a measurement's
 * clothes.
 *
 * These two components are the replacement, and they are deliberately the only
 * two: an inline substitute for the figure itself, and a banner for the screens
 * where the figure was the point. Both read from the same constants, so no
 * surface can invent its own wording for the same state — a hit rate that says
 * "Not configured" here and "—" there is a bug report waiting to happen.
 *
 * Neither is styled as an error. Nothing has failed; a decision has not been
 * made yet, and the tone should say so.
 */

/**
 * "Not configured", where a percentage would be.
 *
 * Sized to match `HitRateValue`'s type ramp so a table row keeps its rhythm
 * when one niche is configured and another is not.
 */
export function ThresholdNotConfigured({
  size = "md",
  withTip = true,
  className,
}: {
  size?: "sm" | "md" | "lg" | "xl";
  withTip?: boolean;
  className?: string;
}) {
  const valueClass = {
    sm: "text-[12px]",
    md: "text-[13px]",
    lg: "text-[16px]",
    xl: "text-[20px]",
  }[size];

  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span
        className={cn("font-medium leading-none text-subtle-foreground", valueClass)}
        // The full sentence for a screen reader: "Not configured" alone, read
        // out of the visual context of a "Hit rate" column header, says nothing.
        aria-label={UNCONFIGURED_THRESHOLD_LABEL}
      >
        {UNCONFIGURED_THRESHOLD_SHORT}
      </span>
      {withTip ? <InfoTip>{UNCONFIGURED_THRESHOLD_EXPLANATION}</InfoTip> : null}
    </span>
  );
}

/**
 * The banner for a screen whose whole subject is the hit rate.
 *
 * Named rather than generic: "Hit rate threshold: Not configured" is the exact
 * phrasing the product uses everywhere, and it names the niche so somebody
 * looking at a filtered dashboard knows *which* niche needs the number.
 *
 * `action` is where an admin's "Set threshold" control goes. It is a slot
 * rather than a built-in button because only the caller knows whether the
 * viewer holds `settings.manage` — and offering the control to somebody the
 * server will refuse is exactly the door-that-does-not-open problem the
 * permission table exists to avoid.
 */
export function ThresholdNotConfiguredNotice({
  nicheName,
  action,
  className,
}: {
  nicheName: string | null;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-3 rounded-lg border border-warning/40 bg-warning-subtle/40 px-4 py-3",
        className,
      )}
      role="status"
    >
      <Target className="mt-px size-4 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">
          {UNCONFIGURED_THRESHOLD_LABEL}
          {nicheName ? (
            <span className="font-normal text-muted-foreground"> · {nicheName}</span>
          ) : null}
        </p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
          {UNCONFIGURED_THRESHOLD_EXPLANATION}
        </p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
