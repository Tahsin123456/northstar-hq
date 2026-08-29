"use client";

import * as React from "react";
import { Shapes } from "lucide-react";
import type { ContentTypePerformance } from "@/lib/analytics/content-type-performance";
import { contentTypeColor } from "@/components/content-types/content-type-chip";
import { ThresholdNotConfigured } from "@/components/metrics/threshold-not-configured";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { InfoTip } from "@/components/ui/tooltip";
import { HIT_RATE_DEFINITION } from "@/lib/analytics/constants";
import { EM_DASH, formatCompactNumber, formatNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * "What kind of content is actually working?"
 *
 * The performance table for the content-type dimension. Every number in it
 * comes from `calculateContentTypePerformance`, which is the same pure function
 * the tests pin — nothing is recomputed here.
 *
 * THE ONE THING THIS UI MUST NOT LET A READER ASSUME
 *
 * A Short can carry several tags, so THE ROWS OVERLAP AND DO NOT SUM TO THE
 * TOTAL. Everybody reads a table like this as a breakdown and adds the first
 * column up; when that produces more Shorts than exist, the reader concludes
 * the tool is broken rather than that the model is different. So the overlap is
 * stated in one short line under the title — present only when there actually
 * is an overlap, because a caveat that appears when it does not apply is how
 * people learn to stop reading caveats.
 *
 * The Untagged row is styled as what it is: not a tag. No colour dot, muted
 * label, always last, separated by a rule. It is there because "how much of the
 * library has nobody classified?" is the question that decides whether the rows
 * above it are trustworthy.
 */
export function ContentTypePerformanceTable({
  performance,
  className,
}: {
  performance: ContentTypePerformance;
  className?: string;
}) {
  const { rows, threshold, totalShorts, taggedAssignments, taggedShorts, hasOverlap } =
    performance;

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          Performance by content type
          <InfoTip>{HIT_RATE_DEFINITION}</InfoTip>
        </CardTitle>
        <CardDescription>
          {hasOverlap ? (
            <>
              A Short can carry more than one tag, so these rows overlap and do
              not add up to {formatNumber(totalShorts)}:{" "}
              {formatNumber(taggedShorts)} tagged Shorts account for{" "}
              {formatNumber(taggedAssignments)} rows below.
            </>
          ) : (
            <>
              Every Short uploaded in the selected period, grouped by the tags
              filed against it.
            </>
          )}
        </CardDescription>
      </CardHeader>

      {rows.length === 0 ? (
        <EmptyState
          icon={<Shapes />}
          title="Nothing to group yet"
          description={
            totalShorts === 0
              ? "No Shorts were uploaded in this period, so there is nothing to break down by content type."
              : "None of this period’s Shorts carry a content type yet. Tag a few from the Shorts table and they will appear here."
          }
        />
      ) : (
        // The one horizontally scrollable region on the page: five numeric
        // columns do not compress below a phone's width without becoming
        // unreadable, and a table that wraps its own cells is worse than one
        // the reader can push sideways.
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-[13px]">
            <thead>
              <tr className="border-y border-border text-[11px] font-medium text-subtle-foreground">
                <th scope="col" className="px-5 py-2 text-left font-medium">
                  Content type
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Shorts
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Median views
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Mean views
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  Total views
                </th>
                <th scope="col" className="px-5 py-2 text-right font-medium">
                  Hit rate
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.contentTypeId ?? "__untagged__"}
                  className={cn(
                    "border-b border-border/60 last:border-b-0",
                    // A rule above the untagged row, because it is a different
                    // kind of thing from every row before it.
                    row.isUntagged && "border-t border-border",
                  )}
                >
                  <th
                    scope="row"
                    className="max-w-[240px] px-5 py-2.5 text-left font-normal"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {row.colorIndex === null ? (
                        // No dot. The absence is the signal: a colour would
                        // make "Untagged" look like one more tag in the list.
                        <span aria-hidden className="size-[6px] shrink-0" />
                      ) : (
                        <span
                          aria-hidden
                          className="size-[6px] shrink-0 rounded-[1px]"
                          style={{ background: contentTypeColor(row.colorIndex) }}
                        />
                      )}
                      <span
                        className={cn(
                          "truncate",
                          row.isUntagged
                            ? "text-muted-foreground"
                            : "text-foreground",
                        )}
                      >
                        {row.name}
                      </span>
                    </span>
                  </th>

                  <td className="tnum px-3 py-2.5 text-right text-foreground">
                    {formatNumber(row.shortsCount)}
                    <span className="ml-1.5 text-[11px] text-subtle-foreground">
                      {formatPercent(row.shareOfShorts * 100, 0)}
                    </span>
                  </td>
                  <td className="tnum px-3 py-2.5 text-right text-foreground">
                    {row.medianViews === null
                      ? EM_DASH
                      : formatCompactNumber(row.medianViews)}
                  </td>
                  <td className="tnum px-3 py-2.5 text-right text-muted-foreground">
                    {row.meanViews === null
                      ? EM_DASH
                      : formatCompactNumber(row.meanViews)}
                  </td>
                  <td className="tnum px-3 py-2.5 text-right text-muted-foreground">
                    {formatCompactNumber(row.totalViews)}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    {/*
                      `null` here is "no threshold configured", never "0%". The
                      aggregate refuses to produce a rate without a definition of
                      a hit, and this cell says so in the same words every other
                      surface uses.
                    */}
                    {row.hitRate === null ? (
                      <ThresholdNotConfigured size="sm" className="justify-end" />
                    ) : (
                      <span className="tnum font-medium text-foreground">
                        {formatPercent(row.hitRate)}
                        <span className="ml-1.5 text-[11px] font-normal text-subtle-foreground">
                          {row.hitCount}/{row.shortsCount}
                        </span>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && threshold !== null ? (
        <p className="border-t border-border px-5 py-2.5 text-[11px] leading-relaxed text-subtle-foreground">
          A hit is a Short with at least {formatCompactNumber(threshold)} views.
        </p>
      ) : null}
    </Card>
  );
}
