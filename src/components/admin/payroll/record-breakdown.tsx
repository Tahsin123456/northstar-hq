"use client";

import * as React from "react";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatHitWindow } from "@/lib/analytics/hit-rate";
import { formatMoney } from "@/lib/finance/money";
import {
  EM_DASH,
  formatCompactNumber,
  formatDate,
  formatNumber,
  formatThreshold,
  pluralize,
  youtubeShortsUrl,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PayrollRecordDTO } from "@/server/services/payroll-service";

/**
 * One person's whole calculation, shown rather than summarised.
 *
 * THE POINT OF THIS COMPONENT
 * A payroll total on its own is unanswerable. "Why is it $4,160?" has to be
 * answerable from the screen, without opening the database and without asking
 * the person who ran it — otherwise the first disputed figure turns into an
 * argument nobody can settle. So every part is here in the order it is
 * computed: the base salary, each niche's hits with the rate they paid AND the
 * threshold they were judged against, any adjustment with the reason somebody
 * typed, and the total those sum to.
 *
 * The threshold is not decoration. It is per-niche and it can differ between
 * niches in the same run, so "12 hits" without "at 500,000 views" is not a
 * checkable claim. The same goes for the rate: the hit payment is the
 * employee's own, set on their profile, and two people can earn different
 * amounts for the identical Short.
 *
 * NOTHING IS RECOMPUTED HERE. Every figure is read straight off the DTO, which
 * for a finalized period is the stored row. If this component ever needs to do
 * arithmetic to render a number, that number belongs on the server instead —
 * a display that computes its own totals is a display that can disagree with
 * the record.
 */
export function RecordBreakdown({
  record,
  className,
}: {
  record: PayrollRecordDTO;
  className?: string;
}) {
  const { currency } = record;
  const hasAdjustment = record.adjustmentMinor !== 0;

  return (
    <div className={cn("flex flex-col gap-5", className)}>
      <section className="flex flex-col gap-1.5">
        <SectionLabel>Calculation</SectionLabel>

        <dl className="flex flex-col">
          <Line
            label="Base salary"
            value={formatMoney(record.baseSalaryMinor, currency)}
          />

          {/* The niche lines sit under the bonus rather than beside the salary,
              because they are the working that produces it. */}
          {record.byNiche.length > 0 ? (
            <>
              {record.byNiche.map((line) => (
                <Line
                  key={line.nicheId ?? line.nicheName}
                  indented
                  label={
                    <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                      <span className="text-foreground">{line.nicheName}</span>
                      <span className="tnum text-subtle-foreground">
                        {formatNumber(line.hitCount)}{" "}
                        {pluralize(line.hitCount, "hit")} ×{" "}
                        {formatMoney(line.hitPaymentMinor, currency)}
                      </span>
                      {/*
                        THE WHOLE RULE, OR AN HONEST HALF OF IT.
                        "500K" stopped being a standard the moment a clock was
                        added: a Short can reach 500,000 views and not be a hit.
                        The window is appended when it is known. When it is not —
                        a period finalized before windows existed, or one whose
                        stored evaluations have gone — the badge shows the bar
                        alone rather than inventing a window, and the title says
                        which of the two this is.
                      */}
                      <Badge
                        variant="neutral"
                        size="sm"
                        className="normal-case tracking-normal"
                        title={
                          line.windowHoursApplied === null
                            ? `Threshold applied: ${formatNumber(line.thresholdApplied)} views. The window this run used was not recorded.`
                            : `Threshold applied: ${formatNumber(line.thresholdApplied)} views within ${formatHitWindow(line.windowHoursApplied)} of publishing`
                        }
                      >
                        {formatThreshold(line.thresholdApplied)}
                        {line.windowHoursApplied === null
                          ? null
                          : ` in ${formatHitWindow(line.windowHoursApplied)}`}
                      </Badge>
                    </span>
                  }
                  value={formatMoney(line.bonusMinor, currency)}
                  muted
                />
              ))}
              <Line
                label={`Hit bonus (${formatNumber(record.hitCount)} ${pluralize(record.hitCount, "hit")})`}
                value={formatMoney(record.hitBonusMinor, currency)}
              />
            </>
          ) : (
            <Line
              label={
                <span className="text-muted-foreground">
                  No qualifying hits in this period
                </span>
              }
              value={formatMoney(0, currency)}
              muted
            />
          )}

          {hasAdjustment ? (
            <Line
              label={
                <span className="flex flex-col gap-0.5">
                  <span>Adjustment</span>
                  {/* The reason is the accountability trail — it is required by
                      the server and it is what lands in the audit log. Showing
                      the amount without it would defeat the point of asking. */}
                  <span className="text-[11px] leading-snug text-subtle-foreground">
                    {record.adjustmentReason ?? "No reason recorded."}
                  </span>
                </span>
              }
              value={formatMoney(record.adjustmentMinor, currency, {
                signDisplay: "always",
              })}
              tone={record.adjustmentMinor < 0 ? "danger" : "success"}
            />
          ) : null}

          <Line
            label="Total"
            value={formatMoney(record.totalMinor, currency, { withCode: true })}
            emphasis
          />
        </dl>

        {/*
          THE QUESTION THIS ANSWERS BEFORE IT IS ASKED.
          `attributeShort` credits a Short to the LOWEST threshold it clears
          when its channel sits in several of this person's niches — so a Short
          that the dashboard, read at the GTA bar, shows as a miss can appear
          here as a paid Last of Us hit. That is deliberate and tested, but from
          this screen it looks like two systems disagreeing, and the person
          holding the disagreement is usually the one whose pay is in it. One
          sentence next to the niche rows is cheaper than the conversation.

          Stated as a rule rather than as a mechanism: nobody needs to know it
          takes the lowest, only that a Short is paid once and against the bar
          it actually cleared. The threshold badge on each row above already
          says which one that was.
        */}
        {record.byNiche.length > 0 ? (
          <p className="pl-3 text-[11px] leading-relaxed text-subtle-foreground">
            A Short on a channel filed under several niches is counted once,
            against the niche whose threshold it clears.
          </p>
        ) : null}
      </section>

      {record.hits.length > 0 ? <HitList record={record} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// THE SHORTS BEHIND THE BONUS
// ---------------------------------------------------------------------------

/**
 * Every Short that earned a hit, with the numbers as they stood when it was
 * counted.
 *
 * `viewCountAtRun` and `thresholdAtRun` are stored on the row for exactly this
 * moment: a Short that has since gained another two million views must still
 * show the count that qualified it, or the evidence stops matching the figure
 * it justifies. That is why these are read from the record rather than from the
 * tracker.
 */
function HitList({ record }: { record: PayrollRecordDTO }) {
  return (
    <section className="flex flex-col gap-1.5">
      <SectionLabel>
        Qualifying Shorts ({formatNumber(record.hits.length)})
      </SectionLabel>

      {/*
        "PUBLISHED INSIDE THE PERIOD" USED TO BE TRUE AND IS NOW WRONG.
        A hit is paid in the period its WINDOW CLOSED in, so this list can
        contain a Short published in December on a January run. Without saying
        so, the Published column below reads as a bug to the one person most
        likely to check it — and the two columns together are the explanation.
      */}
      <p className="text-[11px] leading-relaxed text-subtle-foreground">
        Own channels only, in a niche {record.employeeName} is assigned to, and
        counted in the period their window CLOSED in — which is not always the
        period they were published in. View counts and rules are as they stood
        when the hit was counted, not today&rsquo;s.
      </p>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-[600px] border-collapse text-left">
          <thead>
            <tr className="border-b border-border bg-surface-sunken">
              <th className={HIT_HEAD}>Short</th>
              <th className={HIT_HEAD}>Niche</th>
              <th className={cn(HIT_HEAD, "text-right")}>Views</th>
              <th className={cn(HIT_HEAD, "text-right")}>Threshold</th>
              <th className={cn(HIT_HEAD, "text-right")}>Published</th>
              <th className={cn(HIT_HEAD, "text-right")}>Resolved</th>
            </tr>
          </thead>
          <tbody>
            {record.hits.map((hit) => (
              <tr
                key={hit.videoId}
                className="border-b border-border last:border-b-0 hover:bg-surface-hover/40"
              >
                <td className="max-w-[280px] px-3 py-2">
                  <a
                    href={youtubeShortsUrl(hit.videoId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex items-baseline gap-1 text-[12px] text-foreground hover:text-accent"
                  >
                    <span className="truncate">{hit.videoTitle}</span>
                    <ExternalLink className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                  </a>
                  <span className="block truncate text-[10px] text-subtle-foreground">
                    {hit.channelName}
                  </span>
                </td>
                <td className="px-3 py-2 text-[12px] text-muted-foreground">
                  {hit.nicheName}
                </td>
                <td className="tnum px-3 py-2 text-right text-[12px] text-foreground">
                  {formatNumber(hit.viewCountAtRun)}
                </td>
                <td
                  className="tnum px-3 py-2 text-right text-[12px] text-subtle-foreground"
                  title={
                    hit.windowHoursApplied === null
                      ? "The window this hit was judged under was not recorded."
                      : `${formatNumber(hit.thresholdAtRun)} views within ${formatHitWindow(hit.windowHoursApplied)} of publishing`
                  }
                >
                  {formatCompactNumber(hit.thresholdAtRun)}
                  {hit.windowHoursApplied === null
                    ? null
                    : ` / ${formatHitWindow(hit.windowHoursApplied)}`}
                </td>
                <td className="tnum px-3 py-2 text-right text-[12px] text-subtle-foreground">
                  {formatDate(hit.publishedAt)}
                </td>
                {/*
                  The date this Short stopped being able to change its own
                  answer, and therefore the reason it is on THIS run. Read
                  next to Published, an earlier month stops looking wrong.
                */}
                <td className="tnum px-3 py-2 text-right text-[12px] text-subtle-foreground">
                  {hit.windowClosesAt === null ? EM_DASH : formatDate(hit.windowClosesAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// PIECES
// ---------------------------------------------------------------------------

const HIT_HEAD =
  "px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-subtle-foreground";

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-[10px] font-medium uppercase tracking-wider text-subtle-foreground">
      {children}
    </h4>
  );
}

/**
 * One line of the calculation.
 *
 * A `<dl>` row rather than a table row: this is a list of labelled figures, not
 * a grid of comparable values, and the dotted leader between the two makes a
 * long label still trace to its amount.
 */
function Line({
  label,
  value,
  indented = false,
  muted = false,
  emphasis = false,
  tone,
}: {
  label: React.ReactNode;
  value: string;
  indented?: boolean;
  muted?: boolean;
  emphasis?: boolean;
  tone?: "success" | "danger";
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-3 py-1.5",
        indented && "pl-3",
        emphasis && "mt-1 border-t border-border-strong pt-2.5",
      )}
    >
      <dt
        className={cn(
          "min-w-0 text-[13px]",
          muted ? "text-muted-foreground" : "text-foreground",
          emphasis && "font-medium",
        )}
      >
        {label}
      </dt>
      <dd
        className={cn(
          "tnum shrink-0 text-[13px] tabular-nums",
          emphasis ? "text-[15px] font-semibold text-foreground" : "text-foreground",
          muted && !emphasis && "text-muted-foreground",
          tone === "success" && "text-success",
          tone === "danger" && "text-danger",
        )}
      >
        {value || EM_DASH}
      </dd>
    </div>
  );
}
