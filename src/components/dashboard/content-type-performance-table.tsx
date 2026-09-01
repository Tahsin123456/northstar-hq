"use client";

import * as React from "react";
import { Shapes } from "lucide-react";
import type { ContentTypePerformance } from "@/lib/analytics/content-type-performance";
import { contentTypeColor } from "@/components/content-types/content-type-chip";
import { HitRuleNotConfigured } from "@/components/metrics/hit-rule-not-configured";
import { HitRateBounds } from "@/components/metrics/hit-rate-value";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { InfoTip } from "@/components/ui/tooltip";
import {
  EVIDENCE_LIMITED_EXPLANATION,
  EVIDENCE_LIMITED_LABEL,
  HIT_RATE_DEFINITION,
  NOTHING_DECIDED_SHORT,
  UPLOAD_VIEWS_LABEL,
  UPLOAD_VIEWS_TIP,
} from "@/lib/analytics/constants";
import { resolveHitDisplayState } from "@/lib/analytics/hit-display";
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
  const { rows, totalShorts, taggedAssignments, taggedShorts, hasOverlap } =
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
                {/* A `title` rather than an InfoTip: this is a bare <th> in a
                    scrollable table and a nested info button would cost a
                    column of width the numbers need. Same sentence either
                    way — no surface writes its own. */}
                <th
                  scope="col"
                  className="px-3 py-2 text-right font-medium"
                  title={UPLOAD_VIEWS_TIP}
                >
                  {UPLOAD_VIEWS_LABEL}
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
                      `null` is never "0%", and it now has two causes worth
                      telling apart. Nothing scoreable in the row means no niche
                      rule reached these Shorts — an admin has something to
                      configure, and the cell says so in the same words every
                      other surface uses. Nothing DECIDED means the rules are
                      fine and the windows have not shut; that is a wait, and
                      telling somebody to go configure a niche would send them
                      to fix something that is not broken.
                    */}
                    {(() => {
                      const state = resolveHitDisplayState(row.hits, row.shortsCount);
                      if (state === "notConfigured") {
                        return <HitRuleNotConfigured size="sm" className="justify-end" />;
                      }
                      if (state === "noShorts" || state === "nothingDecided") {
                        return (
                          <span className="text-[12px] text-subtle-foreground">
                            {NOTHING_DECIDED_SHORT}
                          </span>
                        );
                      }
                      if (state === "evidenceLimited") {
                        /*
                          THE RANGE WHERE THE 0.0% WOULD HAVE BEEN, and no
                          fraction beside it.

                          This cell fell through to the measured branch, because
                          an evidence-limited rate is `0` and not `null` — so a
                          content type whose Shorts all cleared their bar
                          unwatched printed a bold "0.0%" and "0/12 decided",
                          with `HitRateBounds` contradicting both on the line
                          underneath. The emphasised number is what a scanning
                          eye takes, and this is the table an editor reads to
                          decide what to make more of: "Skits 0.0%" is an
                          instruction to stop making skits.

                          The fraction goes because its numerator is not the hit
                          count — it is the count of hits somebody happened to
                          observe. The denominator survives in the caption,
                          which is the half that was doing honest work.
                        */
                        return (
                          <span className="inline-flex flex-col items-end gap-0.5">
                            <span
                              className="tnum font-medium text-foreground"
                              aria-label={EVIDENCE_LIMITED_LABEL}
                              title={EVIDENCE_LIMITED_EXPLANATION}
                            >
                              {formatPercent(row.hits.lowerBound, 0)}–
                              {formatPercent(row.hits.upperBound, 0)}
                            </span>
                            <span className="tnum text-[11px] text-subtle-foreground">
                              {row.hits.tally.unknown} unrecorded · {row.hits.judged}{" "}
                              decided
                            </span>
                          </span>
                        );
                      }
                      return (
                      /*
                        The fraction says what the rate is OVER; the bounds say
                        what it had to leave out. A tag whose Shorts mostly went
                        unrecorded reports the same 40% as one measured cleanly,
                        and an editor deciding what to make more of reads them
                        as the same result. The bounds render nothing when there
                        is nothing to disclose, so the common row stays a single
                        line.
                      */
                      <span className="inline-flex flex-col items-end gap-0.5">
                        <span className="tnum font-medium text-foreground">
                          {formatPercent(row.hits.rate)}
                          <span className="ml-1.5 text-[11px] font-normal text-subtle-foreground">
                            {row.hits.hits}/{row.hits.judged} decided
                          </span>
                        </span>
                        <HitRateBounds summary={row.hits} />
                      </span>
                      );
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 ? (
        <p className="border-t border-border px-5 py-2.5 text-[11px] leading-relaxed text-subtle-foreground">
          {/* The footnote used to name one number, which was the whole bug: a
              tag whose Shorts were published last month scored near zero
              against one whose Shorts were two years old, and the sentence
              underneath said nothing about time. Each Short is judged by its
              own niche&rsquo;s rule now, so there is no single figure to print
              here — what there is instead is what the rate is over. */}
          A hit is a Short that reached its niche&rsquo;s view threshold within
          that niche&rsquo;s hit window. Rates are over decided Shorts only:
          Shorts still inside their window, and those published with no view
          history recorded during it, are in neither half.
        </p>
      ) : null}
    </Card>
  );
}
